"""Centralized environment configuration for Stratum API."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

GeminiBackend = Literal["vertex", "apikey"]
StateBackend = Literal["firestore", "gcs"]
SandboxCheckMode = Literal["off", "on"]


@dataclass(frozen=True, slots=True)
class AppConfig:
    """Immutable application settings loaded from environment variables."""

    gcp_project: str
    gcp_region: str
    gemini_backend: GeminiBackend
    gemini_location: str
    gemini_api_key: str | None
    orchestrator_model: str
    subagent_model: str
    max_subagents: int
    max_revision: int
    allowed_orchestrators: tuple[str, ...]
    sandbox_check: SandboxCheckMode
    artifact_bucket: str
    state_backend: StateBackend
    session_secret: str
    app_version: str
    port: int
    web_dist_dir: str


def _parse_gemini_backend(raw: str) -> GeminiBackend:
    val = raw.strip().lower()
    if val == "apikey":
        return "apikey"
    return "vertex"


def _parse_state_backend(raw: str) -> StateBackend:
    val = raw.strip().lower()
    if val == "gcs":
        return "gcs"
    return "firestore"


def _parse_sandbox_check(raw: str) -> SandboxCheckMode:
    val = raw.strip().lower()
    if val == "on":
        return "on"
    return "off"


def load_config(environ: dict[str, str] | None = None) -> AppConfig:
    """Load application configuration from environment variables."""
    env = environ if environ is not None else dict(os.environ)
    raw_allowed = env.get(
        "ALLOWED_ORCHESTRATORS", "gemini-4-argon,gemini-3.8-flash"
    )
    allowed = tuple(
        item.strip() for item in raw_allowed.split(",") if item.strip()
    )
    api_key = env.get("GEMINI_API_KEY", "").strip() or None
    return AppConfig(
        gcp_project=env.get("GCP_PROJECT", "stratum-dev").strip(),
        gcp_region=env.get("GCP_REGION", "us-central1").strip(),
        gemini_backend=_parse_gemini_backend(
            env.get("GEMINI_BACKEND", "vertex")
        ),
        gemini_location=env.get("GEMINI_LOCATION", "global").strip(),
        gemini_api_key=api_key,
        orchestrator_model=env.get(
            "ORCHESTRATOR_MODEL", "gemini-4-argon"
        ).strip(),
        subagent_model=env.get("SUBAGENT_MODEL", "gemini-3.8-flash").strip(),
        max_subagents=int(env.get("MAX_SUBAGENTS", "6")),
        max_revision=int(env.get("MAX_REVISION", "3")),
        allowed_orchestrators=allowed or ("gemini-4-argon", "gemini-3.8-flash"),
        sandbox_check=_parse_sandbox_check(env.get("SANDBOX_CHECK", "off")),
        artifact_bucket=env.get("ARTIFACT_BUCKET", "stratum-artifacts").strip(),
        state_backend=_parse_state_backend(
            env.get("STATE_BACKEND", "firestore")
        ),
        session_secret=env.get(
            "SESSION_SECRET", "stratum-local-dev-secret-change-in-prod"
        ),
        app_version=env.get("APP_VERSION", "0.1.0").strip(),
        port=int(env.get("PORT", "8080")),
        web_dist_dir=env.get("WEB_DIST_DIR", "web/dist").strip(),
    )
