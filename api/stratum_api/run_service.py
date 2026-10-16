"""Run orchestration service coordinating storage, fetcher, Gemini agents, CAD, and bridge."""

from __future__ import annotations

import datetime as dt
import hashlib
import secrets
import time
from typing import Any

from contracts.generated.python.models import (
    ConfirmResponse,
    EngineeringSpec,
    EventLevel,
    EventStage,
    MetricSet,
    Objective,
    Preset,
    Revision1,
    Run,
    RunEvent,
    RunInputs,
    RunStatus,
    SimResult,
    UsageStat,
)
from stratum_api.causal_agent import run_causal_and_presets, run_v0_pipeline
from stratum_api.config import AppConfig
from stratum_api.errors import StratumError
from stratum_api.fetcher import crop_image_box, default_resolve_host, fetch_page_bundle
from stratum_api.loop_engine import run_revision_pass, run_sandbox_crosscheck
from stratum_api.storage import InMemoryStateRepository

_STAGE_MAP: dict[str, EventStage] = {
    "fetch": EventStage.fetch,
    "v0": EventStage.v0,
    "verify": EventStage.verify,
    "cad": EventStage.cad,
    "graph": EventStage.graph,
    "presets": EventStage.presets,
    "objective": EventStage.objective,
    "revision": EventStage.revision,
    "sim": EventStage.sim,
    "bridge": EventStage.bridge,
    "import": EventStage.import_,
}


def make_emitter(run_id: str, repo: InMemoryStateRepository, revision: int | None = None) -> Any:
    """Create an EventEmitter callback that appends RunEvents to repo."""
    def _emit(
        stage: str, level: str, message: str, part_id: str | None = None, data: dict[str, Any] | None = None
    ) -> None:
        seq = len(repo.list_events(run_id))
        st_enum = _STAGE_MAP.get(stage, EventStage.v0)
        rev_obj = Revision1(revision) if revision is not None else None
        ev = RunEvent(
            seq=seq,
            run_id=run_id,
            at=dt.datetime.now(dt.timezone.utc).isoformat(),
            stage=st_enum,
            revision=rev_obj,
            part_id=part_id,
            level=EventLevel(level),
            message=message,
            data=data or {},
        )
        repo.append_event(run_id, ev.model_dump(mode="json"))

    return _emit


def compute_objective_hash(text: str, targets: list[dict[str, Any]], base_rev: int) -> str:
    """Compute canonical SHA-256 hash of an objective."""
    raw = f"{base_rev}:{text.strip()}:{len(targets)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def execute_new_run(
    run_id: str,
    body: dict[str, Any],
    config: AppConfig,
    repo: InMemoryStateRepository,
    client: Any,
    resolver: Any = default_resolve_host,
    http_client: Any | None = None,
) -> dict[str, Any]:
    """Fetch URL, run Agent 1 V0 + CAD + Sim + Agent 2 Causal/Presets, and persist state."""
    t0 = time.monotonic()
    input_url = str(body.get("input_url") or body.get("url") or "").strip()
    if not input_url:
        raise StratumError(code="MISSING_URL", message="input_url or url is required", status_code=400)
    model_name = str(body.get("orchestrator_model") or body.get("model") or config.orchestrator_model)
    if model_name not in config.allowed_orchestrators:
        raise StratumError(code="DISALLOWED_MODEL", message=f"Model {model_name!r} not in ALLOWED_ORCHESTRATORS", status_code=400)
    deep_verify = bool(body.get("deep_verify", True))
    attachments = [str(a) for a in (body.get("attachment_names") or body.get("attachment_ids") or [])]
    notes = str(body.get("product_notes") or "")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    label = "Gemini 4 Argon" if "argon" in model_name else "Gemini 3.8 Flash"

    run_obj = Run(
        run_id=run_id,
        created_at=now_iso,
        status=RunStatus.REVISION_RUNNING,
        latest_revision=0,
        orchestrator_model=model_name,
        model_label=label,
        deep_verify=deep_verify,
        inputs=RunInputs(urls=[input_url], attachment_ids=attachments),
        usage=UsageStat(context_tokens=0, output_tokens=0, sources=0, images=0, model_calls=0),
    )
    repo.save_doc(run_id, "run", run_obj.model_dump(mode="json"))
    emit = make_emitter(run_id, repo, revision=0)
    emit("fetch", "info", f"Fetching {input_url}", None, {"url": input_url})
    bundle = fetch_page_bundle(input_url, resolver=resolver, http_client=http_client)
    for img in bundle.images:
        repo.save_blob(run_id, f"evidence/{img.source_id}.bin", img.data, img.mime_type)

    spec, glb_b, step_b, manifest, metrics, sim, csv_txt, in1, out1 = run_v0_pipeline(
        run_id, model_name, bundle, notes, config, client, emit
    )
    repo.save_blob(run_id, "0.glb", glb_b, "model/gltf-binary")
    repo.save_blob(run_id, "0.step", step_b, "application/step")
    repo.save_blob(run_id, "sim_0.csv", csv_txt.encode("utf-8"), "text/csv")
    repo.save_doc(run_id, "spec_0", spec.model_dump(mode="json"))
    repo.save_doc(run_id, "manifest_0", manifest.model_dump(mode="json"))
    repo.save_doc(run_id, "metrics_0", metrics.model_dump(mode="json"))
    repo.save_doc(run_id, "sim_0", sim.model_dump(mode="json"))

    graph, presets, in2, out2 = run_causal_and_presets(spec, metrics, model_name, client, emit)
    repo.save_doc(run_id, "graph_0", graph.model_dump(mode="json"))
    repo.save_doc(run_id, "presets", {"presets": [p.model_dump(mode="json") for p in presets]})
    default_obj = _preset_to_objective(presets[0], 0)
    repo.save_doc(run_id, "objective", default_obj.model_dump(mode="json"))

    wall_s = round(time.monotonic() - t0, 3)
    repo.save_doc(run_id, "wall_0", {"wall_time_s": wall_s, "context_tokens": in1 + in2})
    run_obj.status = RunStatus.PRESETS_READY
    run_obj.objective = default_obj
    run_obj.usage = UsageStat(
        context_tokens=in1 + in2,
        output_tokens=out1 + out2,
        sources=len(spec.sources),
        images=len(bundle.images),
        model_calls=2 + min(len(spec.parts), config.max_subagents),
    )
    run_dict = run_obj.model_dump(mode="json")
    repo.save_doc(run_id, "run", run_dict)
    emit("presets", "info", "V0 reconstruction and causal presets ready", None, {"wall_time_s": wall_s})
    return run_dict


def _preset_to_objective(preset: Preset, base_rev: int) -> Objective:
    txt = f"{preset.title}: {preset.rationale}"
    t_dicts = [t.model_dump(mode="json") for t in preset.targets]
    return Objective(
        text=txt,
        targets=preset.targets,
        base_revision=base_rev,
        objective_hash=compute_objective_hash(txt, t_dicts, base_rev),
    )


def issue_confirm_token(run_id: str, body: dict[str, Any], repo: InMemoryStateRepository) -> dict[str, Any]:
    """Validate objective approval and issue a short-lived ConfirmResponse token."""
    if body.get("human_approved") is False:
        raise StratumError(code="APPROVAL_REQUIRED", message="human_approved=true is required", status_code=400)
    run_doc = repo.get_doc(run_id, "run")
    if not run_doc:
        raise StratumError(code="RUN_NOT_FOUND", message=f"Run {run_id} not found", status_code=404)
    obj_doc = repo.get_doc(run_id, "objective")
    if "objective" in body and isinstance(body["objective"], dict):
        raw_o = dict(body["objective"])
        raw_o.setdefault("base_revision", int(run_doc.get("latest_revision", 0)))
        raw_o.setdefault("text", "Approved safety objective")
        raw_o.setdefault("targets", [])
        raw_o.setdefault("objective_hash", compute_objective_hash(str(raw_o["text"]), raw_o["targets"], int(raw_o["base_revision"])))
        obj = Objective.model_validate(raw_o)
        obj_doc = obj.model_dump(mode="json")
        repo.save_doc(run_id, "objective", obj_doc)
    token = secrets.token_urlsafe(18)
    exp = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).isoformat()
    repo.save_doc(run_id, "confirm_token", {"token": token, "expires_at": exp, "objective_hash": (obj_doc or {}).get("objective_hash", "")})
    run_doc["status"] = RunStatus.OBJECTIVE_CONFIRMED.value
    repo.save_doc(run_id, "run", run_doc)
    return ConfirmResponse(token=token, expires_at=exp).model_dump(mode="json")


def execute_revision_step(
    run_id: str, body: dict[str, Any], config: AppConfig, repo: InMemoryStateRepository, client: Any
) -> dict[str, Any]:
    """Verify confirmation token and execute next design revision pass (V1..V_MAX)."""
    run_doc = repo.get_doc(run_id, "run")
    if not run_doc:
        raise StratumError(code="RUN_NOT_FOUND", message=f"Run {run_id} not found", status_code=404)
    tok_doc = repo.get_doc(run_id, "confirm_token")
    req_tok = body.get("confirm_token")
    if not tok_doc or (req_tok is not None and req_tok != tok_doc.get("token")):
        raise StratumError(code="CONFIRMATION_REQUIRED", message="Valid objective confirmation token required", status_code=409)
    cur_rev = int(body.get("base_revision", run_doc.get("latest_revision", 0)))
    next_rev = cur_rev + 1
    if next_rev > config.max_revision:
        raise StratumError(code="MAX_REVISION_REACHED", message=f"Cannot exceed MAX_REVISION={config.max_revision}", status_code=422)

    t0 = time.monotonic()
    emit = make_emitter(run_id, repo, revision=next_rev)
    obj = Objective.model_validate(repo.get_doc(run_id, "objective"))
    prev_spec = EngineeringSpec.model_validate(repo.get_doc(run_id, f"spec_{cur_rev}"))
    prev_metrics = MetricSet.model_validate(repo.get_doc(run_id, f"metrics_{cur_rev}"))
    prev_sim = SimResult.model_validate(repo.get_doc(run_id, f"sim_{cur_rev}"))

    new_spec, glb_b, step_b, manifest, metrics, sim, csv_txt, reports, variants, in_t, out_t = run_revision_pass(
        run_id, next_rev, prev_spec, prev_metrics, prev_sim, obj, config, client, emit
    )
    sb_check = run_sandbox_crosscheck(new_spec, sim, config, client, emit)
    repo.save_blob(run_id, f"{next_rev}.glb", glb_b, "model/gltf-binary")
    repo.save_blob(run_id, f"{next_rev}.step", step_b, "application/step")
    repo.save_blob(run_id, f"sim_{next_rev}.csv", csv_txt.encode("utf-8"), "text/csv")
    repo.save_doc(run_id, f"spec_{next_rev}", new_spec.model_dump(mode="json"))
    repo.save_doc(run_id, f"manifest_{next_rev}", manifest.model_dump(mode="json"))
    repo.save_doc(run_id, f"metrics_{next_rev}", metrics.model_dump(mode="json"))
    repo.save_doc(run_id, f"sim_{next_rev}", sim.model_dump(mode="json"))
    repo.save_doc(run_id, f"passes_{next_rev}", {"passes": [r.model_dump(mode="json") for r in reports]})
    repo.save_doc(run_id, f"variants_{next_rev}", {"variants": [v.model_dump(mode="json") for v in variants]})
    repo.save_doc(run_id, f"sandbox_{next_rev}", sb_check.model_dump(mode="json"))
    prev_graph = repo.get_doc(run_id, f"graph_{cur_rev}") or repo.get_doc(run_id, "graph_0")
    if prev_graph:
        repo.save_doc(run_id, f"graph_{next_rev}", {**prev_graph, "revision": next_rev})

    wall_s = round(time.monotonic() - t0, 3)
    repo.save_doc(run_id, f"wall_{next_rev}", {"wall_time_s": wall_s, "context_tokens": in_t})
    target_status = RunStatus.V1_READY if next_rev == 1 else RunStatus.V2_READY
    run_doc["latest_revision"] = next_rev
    run_doc["status"] = target_status.value
    usage = run_doc.get("usage", {})
    usage["context_tokens"] = int(usage.get("context_tokens", 0)) + in_t
    usage["output_tokens"] = int(usage.get("output_tokens", 0)) + out_t
    usage["model_calls"] = int(usage.get("model_calls", 0)) + 1
    run_doc["usage"] = usage
    repo.save_doc(run_id, "run", run_doc)
    return {"revision": next_rev, "latest_revision": next_rev, "status": target_status.value, "passes": [r.model_dump(mode="json") for r in reports]}


def get_evidence_crop_png(run_id: str, source_id: str, part_id: str | None, repo: InMemoryStateRepository) -> bytes:
    """Crop evidence image for source_id using optional part or source crop_box."""
    raw = repo.get_blob(run_id, f"evidence/{source_id}.bin")
    if raw is None:
        raise StratumError(code="EVIDENCE_NOT_FOUND", message=f"Source {source_id} image not found", status_code=404)
    _ = part_id
    return crop_image_box(raw, None)
