"""Unit tests for SSRF fetcher, evidence discipline, V0 reconstruction, and V0->V1->Bridge->V2 loop."""

from __future__ import annotations

import io
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from contracts.generated.python.models import (
    BasisType,
    EngineeringSpec,
    ParameterStatus,
)
from stratum_api.app import create_app
from stratum_api.config import load_config
from stratum_api.errors import StratumError
from stratum_api.fetcher import crop_image_box, validate_safe_url
from stratum_api.storage import InMemoryStateRepository
from stratum_api.v0_agent import enforce_evidence_discipline


def _make_sample_png(width: int = 400, height: int = 400) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(120, 160, 200)).save(buf, format="PNG")
    return buf.getvalue()


class _FakeHttpResponse:
    def __init__(self, status_code: int, headers: dict[str, str], content: bytes) -> None:
        self.status_code = status_code
        self.headers = headers
        self.content = content


class _FakeHttpClient:
    def __init__(self, png_bytes: bytes) -> None:
        self._png = png_bytes

    def get(self, url: str, headers: dict[str, str] | None = None) -> _FakeHttpResponse:
        _ = headers
        if url.endswith(".png"):
            return _FakeHttpResponse(200, {"content-type": "image/png"}, self._png)
        html = (
            "<html><head><title>Widget-A Assembly</title></head>"
            "<body><h1>Widget-A Specifications</h1>"
            "<table><tr><th>Item</th><th>Value</th></tr><tr><td>Input Power</td><td>6.5 W</td></tr></table>"
            '<img src="https://example.org/teardown.png" />'
            "<p>Compact assembly with enclosure and storage stage.</p></body></html>"
        ).encode("utf-8")
        return _FakeHttpResponse(200, {"content-type": "text/html; charset=utf-8"}, html)


class _FakeLoopInteractions:
    def create(self, **kwargs: Any) -> Any:
        _ = kwargs
        return SimpleNamespace(
            id="inter-loop-1",
            status="completed",
            text="",
            steps=[],
            usage=SimpleNamespace(total_input_tokens=150, total_output_tokens=80),
        )

    def get(self, *, id: str) -> Any:
        return SimpleNamespace(
            id=id,
            status="completed",
            text="",
            steps=[],
            usage=SimpleNamespace(total_input_tokens=150, total_output_tokens=80),
        )


def test_ssrf_guard_blocks_private_and_metadata_ips() -> None:
    """Verify SSRF guard blocks metadata, loopback, private IPs, and non-http schemes."""
    with pytest.raises(StratumError) as e_scheme:
        validate_safe_url("file:///etc/passwd", resolver=lambda _: ["93.184.216.34"])
    assert e_scheme.value.code == "SSRF_INVALID_SCHEME"

    for blocked_ip in ("169.254.169.254", "127.0.0.1", "10.0.0.1", "192.168.1.1", "100.64.0.1", "::1"):
        with pytest.raises(StratumError) as e_ip:
            validate_safe_url("https://example.org/item", resolver=lambda _, ip=blocked_ip: [ip])
        assert e_ip.value.code == "SSRF_BLOCKED_IP"

    safe = validate_safe_url("https://example.org/item", resolver=lambda _: ["93.184.216.34"])
    assert safe == "https://example.org/item"


def test_crop_image_box_and_startup_recovery() -> None:
    """Verify crop_image_box returns valid PNG and startup recovery marks *_RUNNING as PARTIAL."""
    png = _make_sample_png(400, 400)
    cropped = crop_image_box(png, [100, 100, 500, 500])
    assert cropped.startswith(b"\x89PNG\r\n\x1a\n")

    repo = InMemoryStateRepository()
    repo.save_doc("run_active", "run", {"run_id": "run_active", "status": "REVISION_RUNNING"})
    count = repo.recover_interrupted_runs()
    assert count == 1
    recovered_doc = repo.get_doc("run_active", "run")
    assert recovered_doc is not None and recovered_doc["status"] == "PARTIAL"
    assert any(ev["stage"] in ("recovery", "revision") for ev in repo.list_events("run_active"))


def test_evidence_discipline_downgrades_unverified_sources() -> None:
    """Verify basis_type=source parameters without retrieved source_ids are downgraded."""
    spec = EngineeringSpec.model_validate(
        {
            "run_id": "run_ev",
            "revision": 0,
            "product_title": "widget-a",
            "summary": "widget-a test",
            "unknowns": [],
            "sources": [],
            "parts": [
                {
                    "part_id": "p1",
                    "name": "Stage",
                    "roles": ["heat_source"],
                    "layer": "kernel",
                    "material": "copper_c110",
                    "cad_ops": [
                        {
                            "op": "box",
                            "params": {"x_mm": 10.0, "y_mm": 10.0, "z_mm": 5.0},
                            "placement": {"x": 0.0, "y": 0.0, "z": 0.0, "rx": 0.0, "ry": 0.0, "rz": 0.0},
                        }
                    ],
                    "parameters": [
                        {
                            "name": "power_w",
                            "value": 5.0,
                            "unit": "W",
                            "status": "DOCUMENTED",
                            "basis_type": "source",
                            "source_ids": ["hallucinated_source_99"],
                            "basis_note": "Claimed from unverified source",
                        }
                    ],
                }
            ],
        }
    )
    events: list[str] = []
    enforce_evidence_discipline(spec, {"src_page_html"}, lambda s, l, m, p, d: events.append(m))
    pr = spec.parts[0].parameters[0]
    assert pr.basis_type == BasisType.model_prior
    assert pr.status == ParameterStatus.INFERRED
    assert "evidence_downgraded" in events


def test_end_to_end_closed_loop_v0_v1_bridge_v2() -> None:
    """Verify full V0 -> Preset -> Confirm V1 -> Bridge -> Callback -> Confirm V2 loop."""
    cfg = load_config({})
    repo = InMemoryStateRepository()
    fake_genai = SimpleNamespace(interactions=_FakeLoopInteractions())
    fake_http = _FakeHttpClient(_make_sample_png())
    app = create_app(
        cfg,
        genai_client=fake_genai,
        repo=repo,
        url_resolver=lambda _: ["93.184.216.34"],
        http_client=fake_http,
    )
    client = TestClient(app)

    r_create = client.post("/api/runs", json={"input_url": "https://example.org/widget-a"})
    assert r_create.status_code == 201
    run_id = r_create.json()["run_id"]
    assert r_create.json()["status"] == "PRESETS_READY"

    assert client.get(f"/api/runs/{run_id}/spec?rev=0").status_code == 200
    assert client.get(f"/api/runs/{run_id}/artifacts/0.glb").status_code == 200
    assert client.get(f"/api/runs/{run_id}/evidence/src_img_01/crop.png").status_code == 200
    presets = client.get(f"/api/runs/{run_id}/presets").json()
    assert len(presets) == 3

    assert client.post(f"/api/runs/{run_id}/revisions", json={"base_revision": 0}).status_code == 409

    r_confirm = client.post(
        f"/api/runs/{run_id}/objective/confirm",
        json={"objective_hash": "abc", "base_revision": 0},
    )
    assert r_confirm.status_code == 200
    tok = r_confirm.json()["token"]

    r_v1 = client.post(
        f"/api/runs/{run_id}/revisions",
        json={"base_revision": 0, "confirm_token": tok},
    )
    assert r_v1.status_code == 200
    assert r_v1.json()["status"] == "V1_READY"
    assert r_v1.json()["revision"] == 1

    r_bridge = client.post(f"/api/runs/{run_id}/matlab-link?base=0&new=1")
    assert r_bridge.status_code == 200
    bundle_uri = r_bridge.json()["bundle_uri"]
    assert client.get(bundle_uri).status_code == 200

    cb_uri = bundle_uri.replace("/bundle.zip", "/results")
    sim_v1 = client.get(f"/api/runs/{run_id}/sim?rev=1").json()
    ext_payload = {
        "node_peaks_C": {n["node_id"]: n["peak_temp_C"] + 0.4 for n in sim_v1["nodes"]},
    }
    r_cb = client.post(cb_uri, content=json.dumps(ext_payload).encode("utf-8"))
    assert r_cb.status_code == 200
    assert client.post(cb_uri, content=b"{}").status_code == 409

    r_v2 = client.post(
        f"/api/runs/{run_id}/revisions",
        json={"base_revision": 1, "confirm_token": tok},
    )
    assert r_v2.status_code == 200
    assert r_v2.json()["status"] == "V2_READY"
    assert r_v2.json()["revision"] == 2
    assert client.get(f"/api/runs/{run_id}/stats").status_code == 200
    assert client.get("/api/benchmarks").status_code == 200


def test_create_app_default_resolver_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify create_app() with default url_resolver=None uses default_resolve_host via socket.getaddrinfo."""
    import socket

    resolved_hosts: list[str] = []

    def _fake_getaddrinfo(host: str, port: Any, proto: int = 0) -> list[Any]:
        _ = (port, proto)
        resolved_hosts.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo)
    cfg = load_config({})
    fake_genai = SimpleNamespace(interactions=_FakeLoopInteractions())
    fake_http = _FakeHttpClient(_make_sample_png())
    app = create_app(cfg, genai_client=fake_genai, http_client=fake_http)
    client = TestClient(app)

    resp = client.post(
        "/api/runs",
        json={"url": "https://www.anker.com/products/a1665-maggo-10000mah-power-bank"},
    )
    assert resp.status_code == 201
    assert "www.anker.com" in resolved_hosts

