"""Centralized environment configuration for Stratum API."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from stratum_api.errors import ConfigError

GeminiBackend = Literal["vertex", "apikey"]
StateBackend = Literal["firestore", "gcs"]
SandboxCheckMode = Literal["off", "on"]

DEV_SESSION_SECRET = "stratum-local-dev-secret-change-in-prod"
DEV_GCP_PROJECT = "stratum-dev"


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
    k_service: str | None = None


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


def validate_config(config: AppConfig) -> None:
    """Fail at startup if K_SERVICE is set and required prod env vars are missing."""
    if not config.k_service:
        return
    if not config.gcp_project or config.gcp_project == DEV_GCP_PROJECT:
        raise ConfigError(
            code="MISSING_GCP_PROJECT",
            message=(
                "GCP_PROJECT must be set via environment variable when "
                "running in Cloud Run (K_SERVICE is set)."
            ),
            recovery_hint=(
                "Set the GCP_PROJECT environment variable on the Cloud Run service."
            ),
        )
    if not config.session_secret or config.session_secret == DEV_SESSION_SECRET:
        raise ConfigError(
            code="INSECURE_SESSION_SECRET",
            message=(
                "SESSION_SECRET must not be missing or equal to the dev default "
                "when running in Cloud Run (K_SERVICE is set)."
            ),
            recovery_hint=(
                "Configure a strong random SESSION_SECRET environment variable "
                "on the Cloud Run service."
            ),
        )


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
    k_service = env.get("K_SERVICE", "").strip() or None
    raw_secret = env.get("SESSION_SECRET", "").strip()
    session_secret = raw_secret if k_service else (raw_secret or DEV_SESSION_SECRET)
    raw_project = env.get("GCP_PROJECT", "").strip()
    gcp_project = raw_project if k_service else (raw_project or DEV_GCP_PROJECT)
    cfg = AppConfig(
        gcp_project=gcp_project,
        gcp_region=env.get("GCP_REGION", "asia-northeast3").strip(),
        gemini_backend=_parse_gemini_backend(
            env.get("GEMINI_BACKEND", "vertex")
        ),
        gemini_location=env.get("GEMINI_LOCATION", "global").strip(),
        gemini_api_key=api_key,
        orchestrator_model=env.get(
            "ORCHESTRATOR_MODEL", "gemini-4-argon"
        ).strip(),
        subagent_model=env.get("SUBAGENT_MODEL", "gemini-3.8-flash").strip(),
        max_subagents=int(env.get("MAX_SUBAGENTS", "3")),
        max_revision=int(env.get("MAX_REVISION", "3")),
        allowed_orchestrators=allowed or ("gemini-4-argon", "gemini-3.8-flash"),
        sandbox_check=_parse_sandbox_check(env.get("SANDBOX_CHECK", "off")),
        artifact_bucket=env.get("ARTIFACT_BUCKET", "stratum-artifacts").strip(),
        state_backend=_parse_state_backend(
            env.get("STATE_BACKEND", "firestore")
        ),
        session_secret=session_secret,
        app_version=env.get("APP_VERSION", "0.1.0").strip(),
        port=int(env.get("PORT", "8080")),
        web_dist_dir=env.get("WEB_DIST_DIR", "web/dist").strip(),
        k_service=k_service,
    )
    validate_config(cfg)
    return cfg
