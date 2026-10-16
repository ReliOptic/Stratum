"""Guard against canned results: different model outputs must produce different V0 results.

If the pipeline ever substitutes a fixed spec (for example when validation fails), two runs fed
different model answers would return identical parts and metrics. These tests fail in that case.
"""

from __future__ import annotations

import copy
import json
import pathlib
import time
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from stratum_api.app import create_app
from stratum_api.config import load_config
from stratum_api.storage import InMemoryStateRepository

_FIXTURE = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "widget-a" / "spec_v0.json").read_text()
)


def _valid_spec(scale: float, tag: str) -> str:
    """Return the synthetic widget-a spec with every part scaled and renamed (no overlaps)."""
    spec = copy.deepcopy(_FIXTURE)
    spec["product_title"] = f"widget-{tag}"
    for part in spec["parts"]:
        part["part_id"] = f"{part['part_id']}-{tag}"
        for op in part["cad_ops"]:
            op["params"] = {k: v * scale if k != "fillet_mm" else v for k, v in op["params"].items()}
            op["placement"]["x"] = op["placement"]["x"] * scale
        if part["part_id"].startswith("storage-cell"):
            part["cad_ops"][0]["placement"]["x"] = 18.0 * scale
    return json.dumps(spec)


class _FixedAnswer:
    """Fake Interactions API that always answers with one given text."""

    def __init__(self, text: str) -> None:
        self._text = text

    def _reply(self) -> Any:
        return SimpleNamespace(id="i", status="completed", text=self._text, steps=[],
                               usage=SimpleNamespace(total_input_tokens=10, total_output_tokens=10))

    def create(self, **kwargs: Any) -> Any:
        _ = kwargs
        return self._reply()

    def get(self, *, id: str) -> Any:
        _ = id
        return self._reply()


class _Html:
    def get(self, url: str, headers: dict[str, str] | None = None) -> Any:
        _ = (url, headers)
        body = b"<html><head><title>Product</title></head><body><p>spec</p></body></html>"
        return SimpleNamespace(status_code=200, headers={"content-type": "text/html"}, content=body)


def _run(model_text: str) -> tuple[dict[str, Any], TestClient, str]:
    app = create_app(load_config({}), genai_client=SimpleNamespace(interactions=_FixedAnswer(model_text)),
                     repo=InMemoryStateRepository(), url_resolver=lambda _: ["93.184.216.34"], http_client=_Html())
    client = TestClient(app)
    run_id = client.post("/api/runs", json={"input_url": "https://example.org/p"}).json()["run_id"]
    deadline = time.monotonic() + 15
    doc: dict[str, Any] = {}
    while time.monotonic() < deadline:
        doc = client.get(f"/api/runs/{run_id}").json()
        if not str(doc.get("status", "")).endswith("_RUNNING"):
            break
        time.sleep(0.05)
    return doc, client, run_id


def _metrics(client: TestClient, run_id: str) -> dict[str, Any]:
    values = client.get(f"/api/runs/{run_id}/metrics?rev=0").json()["values"]
    return {v["metric_id"]: v.get("value") for v in values}


def test_different_model_answers_give_different_results() -> None:
    doc_a, client_a, run_a = _run(_valid_spec(1.0, "a"))
    doc_b, client_b, run_b = _run(_valid_spec(1.5, "b"))
    assert doc_a["status"] == "PRESETS_READY" and doc_b["status"] == "PRESETS_READY"
    parts_a = [p["part_id"] for p in client_a.get(f"/api/runs/{run_a}/spec?rev=0").json()["parts"]]
    parts_b = [p["part_id"] for p in client_b.get(f"/api/runs/{run_b}/spec?rev=0").json()["parts"]]
    assert parts_a != parts_b, "part list did not follow the model answer"
    assert _metrics(client_a, run_a) != _metrics(client_b, run_b), "metrics identical for different inputs"


def test_unusable_model_answer_fails_instead_of_inventing_parts() -> None:
    doc, client, run_id = _run("I could not determine the parts.")
    assert doc["status"] == "FAILED"
    spec = client.get(f"/api/runs/{run_id}/spec?rev=0")
    assert spec.status_code == 404 or not spec.json().get("parts")
