"""FastAPI application factory, health checks, and static asset mounting."""

from __future__ import annotations

import importlib
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from stratum_api.config import AppConfig, load_config, validate_config
from stratum_api.errors import register_error_handlers
from stratum_api.fetcher import default_resolve_host
from stratum_api.logging_utils import get_logger
from stratum_api.probes import (
    ProbeRateLimiter,
    run_agent_probe,
    run_gemini_probe,
)
from stratum_api.routes import build_core_router
from stratum_api.routes_audit import build_audit_router
from stratum_api.session import SessionCookieMiddleware
from stratum_api.storage import create_repository

logger = get_logger("stratum_api.app")


def check_cad_engine() -> tuple[bool, str | None]:
    """Attempt to import stratum_cad and export a 10 mm box to STEP."""
    try:
        cad_mod = importlib.import_module("stratum_cad")
        if hasattr(cad_mod, "build_smoke_box_step"):
            step_bytes = cad_mod.build_smoke_box_step(size_mm=10.0)
            if not step_bytes:
                return False, "STEP export returned empty bytes"
            return True, None
        with tempfile.TemporaryDirectory() as tmp_dir:
            step_path = Path(tmp_dir) / "probe_box.step"
            if hasattr(cad_mod, "export_test_box"):
                cad_mod.export_test_box(step_path, size_mm=10.0)
            else:
                cq = importlib.import_module("cadquery")
                wp = cq.Workplane("XY").box(10.0, 10.0, 10.0)
                cq.exporters.export(wp, str(step_path))
            if not step_path.exists() or step_path.stat().st_size == 0:
                return False, "STEP export produced an empty file"
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def create_app(
    config: AppConfig | None = None,
    *,
    probe_cooldown_s: float = 60.0,
    genai_client: Any | None = None,
    repo: Any | None = None,
    url_resolver: Any | None = None,
    http_client: Any | None = None,
) -> FastAPI:
    """Create and configure the Stratum FastAPI application."""
    cfg = config or load_config()
    validate_config(cfg)
    limiter = ProbeRateLimiter(cooldown_s=probe_cooldown_s)
    state_repo = repo or create_repository(cfg)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        cad_ok, cad_reason = check_cad_engine()
        application.state.cad_ok = cad_ok
        application.state.cad_reason = cad_reason
        recovered = application.state.repo.recover_interrupted_runs()
        logger.log_event(
            "app_startup",
            stage="startup",
            message="Stratum API initialized",
            extra={
                "cad_ok": cad_ok,
                "cad_reason": cad_reason,
                "recovered_runs": recovered,
            },
        )
        yield

    application = FastAPI(
        title="Stratum API",
        version=cfg.app_version,
        lifespan=lifespan,
    )
    application.state.config = cfg
    application.state.rate_limiter = limiter
    application.state.genai_client = genai_client
    application.state.repo = state_repo
    application.state.url_resolver = url_resolver or default_resolve_host
    application.state.http_client = http_client
    cad_ok, cad_reason = check_cad_engine()
    application.state.cad_ok = cad_ok
    application.state.cad_reason = cad_reason

    register_error_handlers(application)
    application.add_middleware(
        SessionCookieMiddleware, secret=cfg.session_secret
    )
    _register_routes(application)
    application.include_router(build_core_router())
    application.include_router(build_audit_router())

    dist_path = Path(cfg.web_dist_dir)
    if dist_path.is_dir():
        application.mount(
            "/", StaticFiles(directory=str(dist_path), html=True), name="web"
        )
    return application


def _register_routes(application: FastAPI) -> None:
    """Register health and probe routes on the FastAPI app."""

    @application.get("/api/health")
    async def get_health(request: Request) -> dict[str, Any]:
        cfg: AppConfig = request.app.state.config
        cad_ok: bool = getattr(request.app.state, "cad_ok", False)
        cad_reason: str | None = getattr(
            request.app.state, "cad_reason", "Not checked"
        )
        payload: dict[str, Any] = {
            "status": "ok",
            "version": cfg.app_version,
            "cad_ok": cad_ok,
            "state_backend": cfg.state_backend,
        }
        if not cad_ok and cad_reason:
            payload["cad_reason"] = cad_reason
        return payload

    @application.get("/api/health/gemini")
    async def get_health_gemini(request: Request) -> dict[str, Any]:
        limiter: ProbeRateLimiter = request.app.state.rate_limiter
        limiter.check_and_record("/api/health/gemini")
        cfg: AppConfig = request.app.state.config
        client = request.app.state.genai_client
        return run_gemini_probe(cfg, client=client)

    @application.get("/api/health/agent")
    async def get_health_agent(request: Request) -> dict[str, Any]:
        limiter: ProbeRateLimiter = request.app.state.rate_limiter
        limiter.check_and_record("/api/health/agent")
        cfg: AppConfig = request.app.state.config
        client = request.app.state.genai_client
        return run_agent_probe(cfg, client=client)


app = create_app()
