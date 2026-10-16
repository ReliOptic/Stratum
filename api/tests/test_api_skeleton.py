"""Unit tests for Stratum API config, logging, errors, session, and app."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient

from stratum_api.app import check_cad_engine, create_app
from stratum_api.config import load_config
from stratum_api.errors import RateLimitError, StratumError
from stratum_api.logging_utils import format_log_entry, get_logger
from stratum_api.session import (
    COOKIE_NAME,
    sign_session_id,
    verify_session_token,
)


def test_load_config_defaults_and_overrides() -> None:
    """Verify load_config parses defaults and custom environment values."""
    cfg_default = load_config({})
    assert cfg_default.orchestrator_model == "gemini-4-argon"
    assert cfg_default.subagent_model == "gemini-3.8-flash"
    assert cfg_default.gemini_backend == "vertex"
    assert cfg_default.state_backend == "firestore"
    assert cfg_default.sandbox_check == "off"
    assert cfg_default.max_subagents == 6
    assert cfg_default.max_revision == 3

    cfg_custom = load_config(
        {
            "GCP_PROJECT": "proj-1",
            "GCP_REGION": "europe-west1",
            "GEMINI_BACKEND": "apikey",
            "GEMINI_API_KEY": "test-key",
            "STATE_BACKEND": "gcs",
            "SANDBOX_CHECK": "on",
            "MAX_SUBAGENTS": "4",
            "MAX_REVISION": "2",
            "APP_VERSION": "0.2.0",
        }
    )
    assert cfg_custom.gcp_project == "proj-1"
    assert cfg_custom.gemini_backend == "apikey"
    assert cfg_custom.gemini_api_key == "test-key"
    assert cfg_custom.state_backend == "gcs"
    assert cfg_custom.sandbox_check == "on"
    assert cfg_custom.max_subagents == 4
    assert cfg_custom.max_revision == 2
    assert cfg_custom.app_version == "0.2.0"


def test_structured_logging_format_and_emit() -> None:
    """Verify structured JSON log entries contain required fields."""
    line = format_log_entry(
        "compile_started",
        run_id="run_01",
        part_id="p_base",
        stage="compile",
        level="INFO",
        message="Starting part compilation",
        extra={"attempt": 1},
    )
    parsed = json.loads(line)
    assert parsed["event"] == "compile_started"
    assert parsed["run_id"] == "run_01"
    assert parsed["part_id"] == "p_base"
    assert parsed["stage"] == "compile"
    assert parsed["level"] == "INFO"
    assert parsed["extra"]["attempt"] == 1

    slogger = get_logger("stratum_api.test")
    emitted = slogger.log_event("health_checked", stage="health")
    assert json.loads(emitted)["event"] == "health_checked"


def test_stratum_errors_and_rate_limit_error() -> None:
    """Verify StratumError and RateLimitError serialize code and recovery_hint."""
    err = StratumError(
        code="INVALID_SPEC",
        message="Missing part thickness.",
        recovery_hint="Provide thickness_mm > 0.",
        status_code=422,
        details={"field": "thickness_mm"},
    )
    payload = err.to_dict()
    assert payload["code"] == "INVALID_SPEC"
    assert payload["recovery_hint"] == "Provide thickness_mm > 0."
    assert payload["details"]["field"] == "thickness_mm"

    rl_err = RateLimitError("/api/health/gemini", 42.5)
    assert rl_err.status_code == 429
    assert rl_err.to_dict()["code"] == "RATE_LIMITED"


def test_session_signing_and_verification() -> None:
    """Verify HMAC session token signing and tamper rejection."""
    secret = "unit-test-secret"
    signed = sign_session_id("sess_abc123", secret)
    assert verify_session_token(signed, secret) == "sess_abc123"
    assert verify_session_token(signed + "tamper", secret) is None
    assert verify_session_token("malformed_token", secret) is None
    assert verify_session_token(signed, "wrong-secret") is None


def test_check_cad_engine_with_stub_module(monkeypatch: object) -> None:
    """Verify check_cad_engine succeeds when stratum_cad exports a STEP file."""
    fake_mod = types.ModuleType("stratum_cad")

    def _export_test_box(path: Path, size_mm: float = 10.0) -> None:
        Path(path).write_text(f"ISO-10303-21; BOX {size_mm};\n", encoding="utf-8")

    fake_mod.export_test_box = _export_test_box  # type: ignore[attr-defined]
    sys.modules["stratum_cad"] = fake_mod
    try:
        ok, reason = check_cad_engine()
        assert ok is True
        assert reason is None
    finally:
        sys.modules.pop("stratum_cad", None)


def test_health_endpoint_and_session_cookie(tmp_path: Path) -> None:
    """Verify /api/health response schema, session cookie, and static mount."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>Stratum UI</html>", encoding="utf-8")
    cfg = load_config(
        {
            "APP_VERSION": "0.1.0",
            "STATE_BACKEND": "firestore",
            "SESSION_SECRET": "test-secret",
            "WEB_DIST_DIR": str(dist),
        }
    )
    app = create_app(cfg)
    client = TestClient(app)

    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["version"] == "0.1.0"
    assert isinstance(body["cad_ok"], bool)
    assert body["state_backend"] == "firestore"
    assert COOKIE_NAME in resp.cookies

    index_resp = client.get("/")
    assert index_resp.status_code == 200
    assert "Stratum UI" in index_resp.text
