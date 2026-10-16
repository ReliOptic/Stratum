"""Unit tests for Gemini Interactions and Managed Agent health probes."""

from __future__ import annotations

import base64
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from stratum_api.app import create_app
from stratum_api.config import load_config
from stratum_api.probes import (
    ProbeRateLimiter,
    build_genai_client,
    inspect_interaction_response,
    make_tiny_png_b64,
    run_agent_probe,
    run_gemini_probe,
)


class _FakeInteractions:
    """Stub interactions resource for unit testing probes."""

    def __init__(self, should_fail: bool = False) -> None:
        self.should_fail = should_fail
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.should_fail:
            raise RuntimeError("Simulated upstream error")
        return SimpleNamespace(
            steps=[
                SimpleNamespace(
                    type="thought",
                    summary="Checked grounding and 1x1 pixel image.",
                    content=[],
                ),
                SimpleNamespace(
                    type="google_search_call",
                    summary=None,
                    content=[],
                ),
                SimpleNamespace(
                    type="google_search_result",
                    summary=None,
                    content=[],
                ),
                SimpleNamespace(
                    type="model_output",
                    summary=None,
                    content=[
                        SimpleNamespace(
                            annotations=[
                                SimpleNamespace(
                                    type="url_citation",
                                    url="https://example.org",
                                )
                            ]
                        )
                    ],
                ),
            ],
            usage=SimpleNamespace(
                input_tokens=24,
                output_tokens=12,
                thought_tokens=8,
            ),
        )


class _FakeGenAIClient:
    """Stub GenAI client wrapping _FakeInteractions."""

    def __init__(self, should_fail: bool = False) -> None:
        self.interactions = _FakeInteractions(should_fail=should_fail)


def test_make_tiny_png_and_inspect_interaction() -> None:
    """Verify tiny PNG base64 generation and interaction response inspection."""
    png_b64 = make_tiny_png_b64()
    raw = base64.b64decode(png_b64)
    assert raw.startswith(b"\x89PNG\r\n\x1a\n")

    fake_client = _FakeGenAIClient()
    interaction = fake_client.interactions.create(model="gemini-4-argon")
    inspected = inspect_interaction_response(interaction)
    assert inspected["thought_summary_supported"] is True
    assert "google_search_call" in inspected["grounding_fields_present"]
    assert "url_citation" in inspected["grounding_fields_present"]
    assert "input_tokens" in inspected["usage_fields"]


def test_build_genai_client_apikey_mode() -> None:
    """Verify build_genai_client constructs a client in apikey mode."""
    cfg = load_config(
        {"GEMINI_BACKEND": "apikey", "GEMINI_API_KEY": "dummy-api-key"}
    )
    client = build_genai_client(cfg)
    assert client is not None


def test_run_gemini_and_agent_probes_success_and_error() -> None:
    """Verify run_gemini_probe and run_agent_probe handle success and failure."""
    cfg = load_config({})
    ok_client = _FakeGenAIClient(should_fail=False)

    gemini_res = run_gemini_probe(cfg, client=ok_client)
    assert gemini_res["ok"] is True
    assert gemini_res["image_input_ok"] is True
    assert gemini_res["thought_summary_supported"] is True

    agent_res = run_agent_probe(cfg, client=ok_client)
    assert agent_res["available"] is True
    assert isinstance(agent_res["latency_ms"], float)

    fail_client = _FakeGenAIClient(should_fail=True)
    gemini_fail = run_gemini_probe(cfg, client=fail_client)
    assert gemini_fail["ok"] is False
    assert "Simulated upstream error" in gemini_fail["error"]

    agent_fail = run_agent_probe(cfg, client=fail_client)
    assert agent_fail["available"] is False
    assert "Simulated upstream error" in agent_fail["error"]


def test_probe_rate_limiter_and_endpoints() -> None:
    """Verify 1/min rate limiting on /api/health/gemini and /api/health/agent."""
    limiter = ProbeRateLimiter(cooldown_s=60.0)
    limiter.check_and_record("/api/health/gemini", now=100.0)
    limiter.reset()
    limiter.check_and_record("/api/health/gemini", now=100.0)

    cfg = load_config({})
    fake_client = _FakeGenAIClient()
    app = create_app(cfg, probe_cooldown_s=60.0, genai_client=fake_client)
    client = TestClient(app)

    r1 = client.get("/api/health/gemini")
    assert r1.status_code == 200
    assert r1.json()["ok"] is True

    r2 = client.get("/api/health/gemini")
    assert r2.status_code == 429
    assert r2.json()["code"] == "RATE_LIMITED"

    a1 = client.get("/api/health/agent")
    assert a1.status_code == 200
    assert a1.json()["available"] is True

    a2 = client.get("/api/health/agent")
    assert a2.status_code == 429
    assert a2.json()["code"] == "RATE_LIMITED"
