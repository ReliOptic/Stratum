"""FastAPI routes for Simulink bridge, external results, lab measurements, and telemetry."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, Response

from contracts.generated.python.models import EngineeringSpec, SimResult
from stratum_api.audit_service import (
    build_and_store_bridge,
    build_loop_nodes,
    compute_benchmarks_list,
    compute_run_stats_payload,
    ingest_external_results_payload,
    resolve_bridge_token,
)
from stratum_api.errors import StratumError
from stratum_api.loop_engine import run_sandbox_crosscheck
from stratum_api.probes import build_genai_client
from stratum_api.routes import _get_doc_or_404
from stratum_api.run_service import make_emitter


async def _extract_upload_bytes(request: Request, default_name: str) -> tuple[str, bytes, str]:
    """Read raw body or multipart upload bytes without requiring python-multipart at import."""
    ctype = request.headers.get("content-type", "").lower()
    mode = str(request.query_params.get("mode", "simulink"))
    if "multipart/form-data" in ctype:
        try:
            form = await request.form()
            if "mode" in form:
                mode = str(form["mode"])
            for val in form.values():
                if hasattr(val, "read"):
                    fname = getattr(val, "filename", None) or default_name
                    data = await val.read()  # type: ignore[misc]
                    return str(fname), bytes(data), mode
        except Exception:  # noqa: BLE001
            pass
    raw = await request.body()
    fname = request.query_params.get("filename", default_name)
    return fname, raw, mode


def build_audit_router() -> APIRouter:
    """Create the APIRouter for sandbox, Simulink bridge, external audits, stats, and benchmarks."""
    router = APIRouter()

    @router.post("/api/runs/{run_id}/sandbox")
    def trigger_sandbox(run_id: str, request: Request, rev: int = Query(default=1, ge=0)) -> dict[str, Any]:
        state = request.app.state
        spec = EngineeringSpec.model_validate(_get_doc_or_404(state.repo, run_id, f"spec_{rev}", "Spec"))
        sim = SimResult.model_validate(_get_doc_or_404(state.repo, run_id, f"sim_{rev}", "SimResult"))
        client = state.genai_client or build_genai_client(state.config)
        emit = make_emitter(run_id, state.repo, revision=rev)
        sb = run_sandbox_crosscheck(spec, sim, state.config, client, emit)
        payload = sb.model_dump(mode="json")
        state.repo.save_doc(run_id, f"sandbox_{rev}", payload)
        return payload

    @router.get("/api/runs/{run_id}/sandbox")
    def get_sandbox(run_id: str, request: Request, rev: int = Query(default=1, ge=0)) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, f"sandbox_{rev}", "SandboxCheck")

    @router.post("/api/runs/{run_id}/bridge")
    @router.post("/api/runs/{run_id}/matlab-link")
    def create_bridge(
        run_id: str, request: Request, rev: int = Query(default=1, ge=0), new: int | None = Query(default=None)
    ) -> dict[str, Any]:
        target_rev = new if new is not None else rev
        base_url = str(request.base_url).rstrip("/")
        return build_and_store_bridge(run_id, target_rev, base_url, request.app.state.repo)

    @router.get("/api/runs/{run_id}/bridge")
    def get_bridge(run_id: str, request: Request, rev: int = Query(default=1, ge=0)) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, f"bridge_{rev}", "BridgePackage")

    @router.get("/api/b/{token}/bundle.zip")
    def download_bridge_bundle(token: str, request: Request) -> Response:
        repo = request.app.state.repo
        rec = resolve_bridge_token(token, repo)
        blob = repo.get_blob(str(rec["run_id"]), f"bridge_{rec['revision']}.zip")
        if blob is None:
            raise StratumError(code="BUNDLE_NOT_FOUND", message="Bridge zip bundle not found", status_code=404)
        return Response(content=blob, media_type="application/zip")

    @router.post("/api/b/{token}/results")
    async def post_bridge_callback(token: str, request: Request) -> dict[str, Any]:
        repo = request.app.state.repo
        rec = resolve_bridge_token(token, repo)
        if rec.get("used"):
            raise StratumError(code="TOKEN_ALREADY_USED", message="Single-use bridge token already consumed.", status_code=409)
        fname, raw, mode = await _extract_upload_bytes(request, "simulink_results.json")
        res = ingest_external_results_payload(str(rec["run_id"]), int(rec["revision"]), fname, raw, repo, tool_hint=mode)
        rec["used"] = True
        repo.save_bridge_token(str(rec["token_hash"]), rec)
        return res

    @router.post("/api/runs/{run_id}/external-results")
    async def post_external_results(
        run_id: str, request: Request, rev: int = Query(default=1, ge=0)
    ) -> dict[str, Any]:
        fname, raw, mode = await _extract_upload_bytes(request, "simulink_results.json")
        return ingest_external_results_payload(run_id, rev, fname, raw, request.app.state.repo, tool_hint=mode)

    @router.post("/api/runs/{run_id}/measurements")
    async def post_measurements(
        run_id: str, request: Request, rev: int = Query(default=1, ge=0)
    ) -> dict[str, Any]:
        fname, raw, _ = await _extract_upload_bytes(request, "measurement.csv")
        return ingest_external_results_payload(run_id, rev, fname, raw, request.app.state.repo, tool_hint="measurement")

    @router.get("/api/runs/{run_id}/loop")
    def get_loop_evaluation(run_id: str, request: Request) -> list[dict[str, Any]]:
        return build_loop_nodes(run_id, request.app.state.repo)

    @router.get("/api/runs/{run_id}/stats")
    def get_run_stats(run_id: str, request: Request) -> dict[str, Any]:
        return compute_run_stats_payload(run_id, request.app.state.repo)

    @router.get("/api/runs/{run_id}/benchmarks")
    @router.get("/api/benchmarks")
    def get_benchmarks(request: Request, run_id: str | None = None) -> list[dict[str, Any]]:
        _ = run_id
        return compute_benchmarks_list(request.app.state.repo)

    @router.get("/api/matlab-link")
    def get_matlab_link() -> dict[str, bool]:
        return {"configured": False}

    return router
