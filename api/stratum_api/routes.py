"""Core FastAPI routes for G2 (V0 reconstruction, artifacts, presets) and G3 (objective, revisions)."""

from __future__ import annotations

import asyncio
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import APIRouter, Body, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from contracts.generated.python.models import Objective, Target
from stratum_api.errors import StratumError
from stratum_api.fetcher import default_resolve_host
from stratum_api.probes import build_genai_client
from stratum_api.run_service import (
    compute_objective_hash,
    execute_revision_step,
    get_evidence_crop_png,
    initialize_new_run,
    issue_confirm_token,
    run_new_run_background,
)

_BG_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="stratum-v0")


def _get_doc_or_404(repo: Any, run_id: str, key: str, label: str) -> dict[str, Any]:
    doc = repo.get_doc(run_id, key)
    if doc is None:
        raise StratumError(
            code=f"{label.upper()}_NOT_FOUND",
            message=f"{label} not found for run {run_id} ({key}).",
            status_code=404,
        )
    return doc


def build_core_router() -> APIRouter:
    """Create the APIRouter for V0 runs, specs, artifacts, evidence crops, presets, and revisions."""
    router = APIRouter()

    @router.post("/api/runs")
    def create_run(request: Request, body: dict[str, Any] = Body(...)) -> JSONResponse:
        state = request.app.state
        run_id = f"run_{uuid.uuid4().hex[:10]}"
        resolver = getattr(state, "url_resolver", None) or default_resolve_host
        http_client = getattr(state, "http_client", None)
        run_dict = initialize_new_run(
            run_id=run_id,
            body=body,
            config=state.config,
            repo=state.repo,
            resolver=resolver,
        )
        client = getattr(state, "genai_client", None) or build_genai_client(state.config)
        _BG_POOL.submit(
            run_new_run_background,
            run_id,
            body,
            state.config,
            state.repo,
            client,
            resolver,
            http_client,
        )
        return JSONResponse(status_code=201, content=run_dict)

    @router.get("/api/runs")
    def list_runs(request: Request) -> list[dict[str, Any]]:
        return request.app.state.repo.list_runs()

    @router.get("/api/runs/{run_id}")
    def get_run(run_id: str, request: Request) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, "run", "Run")

    @router.get("/api/runs/{run_id}/events")
    async def get_run_events(
        run_id: str,
        request: Request,
        after: int = Query(default=0, ge=0),
        fmt: str | None = Query(default=None, alias="format"),
    ) -> Response:
        repo = request.app.state.repo
        accept = request.headers.get("accept", "")
        if fmt == "json" or "application/json" in accept:
            events = [ev for ev in repo.list_events(run_id) if int(ev.get("seq", 0)) > after]
            return JSONResponse(content=events)

        async def _event_stream() -> Any:
            cursor = after
            for _ in range(1200):
                for ev in repo.list_events(run_id):
                    seq = int(ev.get("seq", 0))
                    if seq > cursor:
                        cursor = seq
                        yield f"data: {json.dumps(ev)}\n\n"
                run_doc = repo.get_doc(run_id, "run")
                status = str((run_doc or {}).get("status", ""))
                if not status.endswith("_RUNNING"):
                    for ev in repo.list_events(run_id):
                        seq = int(ev.get("seq", 0))
                        if seq > cursor:
                            cursor = seq
                            yield f"data: {json.dumps(ev)}\n\n"
                    break
                await asyncio.sleep(0.2)

        return StreamingResponse(
            _event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.get("/api/runs/{run_id}/spec")
    def get_spec(run_id: str, request: Request, rev: int = Query(default=0, ge=0)) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, f"spec_{rev}", "EngineeringSpec")

    @router.get("/api/runs/{run_id}/graph")
    def get_graph(run_id: str, request: Request, rev: int = Query(default=0, ge=0)) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, f"graph_{rev}", "ComponentGraph")

    @router.get("/api/runs/{run_id}/metrics")
    def get_metrics(run_id: str, request: Request, rev: int = Query(default=0, ge=0)) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, f"metrics_{rev}", "MetricSet")

    @router.get("/api/runs/{run_id}/manifest")
    def get_manifest(run_id: str, request: Request, rev: int = Query(default=0, ge=0)) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, f"manifest_{rev}", "Manifest")

    @router.get("/api/runs/{run_id}/sim")
    def get_sim(run_id: str, request: Request, rev: int = Query(default=0, ge=0)) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, f"sim_{rev}", "SimResult")

    @router.get("/api/runs/{run_id}/artifacts/{artifact_name}")
    def get_artifact(run_id: str, artifact_name: str, request: Request) -> Response:
        blob = request.app.state.repo.get_blob(run_id, artifact_name)
        if blob is None:
            raise StratumError(code="ARTIFACT_NOT_FOUND", message=f"Artifact {artifact_name} not found", status_code=404)
        media = "model/gltf-binary" if artifact_name.endswith(".glb") else "application/step"
        return Response(content=blob, media_type=media)

    @router.get("/api/runs/{run_id}/evidence/{source_id}/crop.png")
    def get_evidence_crop(
        run_id: str, source_id: str, request: Request, part_id: str | None = Query(default=None)
    ) -> Response:
        png = get_evidence_crop_png(run_id, source_id, part_id, request.app.state.repo)
        return Response(content=png, media_type="image/png")

    @router.get("/api/runs/{run_id}/presets")
    def get_presets(run_id: str, request: Request, base: int = Query(default=0, ge=0)) -> list[dict[str, Any]]:
        _ = base
        doc = _get_doc_or_404(request.app.state.repo, run_id, "presets", "Presets")
        return list(doc.get("presets", []))

    @router.get("/api/runs/{run_id}/variants")
    def get_variants(run_id: str, request: Request, rev: int = Query(default=0, ge=0)) -> list[dict[str, Any]]:
        doc = request.app.state.repo.get_doc(run_id, f"variants_{rev}")
        return list(doc.get("variants", [])) if doc else []

    @router.get("/api/runs/{run_id}/passes")
    def get_passes(run_id: str, request: Request, rev: int | None = Query(default=None)) -> list[dict[str, Any]]:
        repo = request.app.state.repo
        if rev is not None:
            doc = repo.get_doc(run_id, f"passes_{rev}")
            return list(doc.get("passes", [])) if doc else []
        run_doc = _get_doc_or_404(repo, run_id, "run", "Run")
        max_rev = int(run_doc.get("latest_revision", 0))
        out: list[dict[str, Any]] = []
        for r in range(0, max_rev + 1):
            if (d := repo.get_doc(run_id, f"passes_{r}")) is not None:
                out.extend(d.get("passes", []))
        return out

    @router.get("/api/runs/{run_id}/objective")
    def get_objective(run_id: str, request: Request) -> dict[str, Any]:
        return _get_doc_or_404(request.app.state.repo, run_id, "objective", "Objective")

    @router.post("/api/runs/{run_id}/objective")
    @router.put("/api/runs/{run_id}/objective")
    def save_objective(run_id: str, request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        repo = request.app.state.repo
        existing = repo.get_doc(run_id, "objective") or {}
        text = str(body.get("text") or existing.get("text") or "Optimize safety margin")
        base_rev = int(body.get("base_revision", existing.get("base_revision", 0)))
        raw_targets = body.get("targets") if "targets" in body else existing.get("targets", [])
        targets = [Target.model_validate(t) for t in raw_targets]
        obj = Objective(
            text=text,
            targets=targets,
            base_revision=base_rev,
            objective_hash=compute_objective_hash(text, [t.model_dump(mode="json") for t in targets], base_rev),
        )
        payload = obj.model_dump(mode="json")
        repo.save_doc(run_id, "objective", payload)
        return payload

    @router.post("/api/runs/{run_id}/objective/confirm")
    def confirm_objective(run_id: str, request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        state = request.app.state
        return issue_confirm_token(run_id, body, state.repo)

    @router.post("/api/runs/{run_id}/revisions")
    def trigger_revision(run_id: str, request: Request, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        state = request.app.state
        client = state.genai_client or build_genai_client(state.config)
        return execute_revision_step(run_id, body, state.config, state.repo, client)

    @router.get("/api/runs/{run_id}/revisions")
    def list_revisions(run_id: str, request: Request) -> list[dict[str, Any]]:
        repo = request.app.state.repo
        run_doc = _get_doc_or_404(repo, run_id, "run", "Run")
        max_rev = int(run_doc.get("latest_revision", 0))
        return [d for r in range(1, max_rev + 1) if (d := repo.get_doc(run_id, f"passes_{r}")) is not None]

    return router
