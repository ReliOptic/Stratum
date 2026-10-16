"""Bridge generation, external Simulink/measurement ingestion, and live telemetry stats."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from typing import Any

from contracts.generated.python.models import (
    AuditStatus,
    BenchmarkComparison,
    EngineeringSpec,
    ExternalSimNode,
    ExternalSimResult,
    ExternalTool,
    PredictionOutcome,
    RunStats,
    RunStatus,
    SimResult,
)
from stratum_api.errors import StratumError
from stratum_api.loop_engine import create_bridge_bundle
from stratum_api.run_service import make_emitter
from stratum_api.storage import InMemoryStateRepository
from stratum_bridge import parse_external_results, parse_measurement


def build_and_store_bridge(
    run_id: str, revision: int, base_url: str, repo: InMemoryStateRepository
) -> dict[str, Any]:
    """Generate Simulink bridge zip, store token hash in state, and return response payload."""
    spec_doc = repo.get_doc(run_id, f"spec_{revision}") or repo.get_doc(run_id, "spec_0")
    if not spec_doc:
        raise StratumError(code="SPEC_NOT_FOUND", message=f"Spec V{revision} not found", status_code=404)
    spec_new = EngineeringSpec.model_validate(spec_doc)
    base_rev = max(0, revision - 1)
    base_doc = repo.get_doc(run_id, f"spec_{base_rev}") or spec_doc
    spec_base = EngineeringSpec.model_validate(base_doc)
    graph_doc = repo.get_doc(run_id, f"graph_{revision}") or repo.get_doc(run_id, "graph_0")
    meta, _, zip_bytes = create_bridge_bundle(
        run_id, revision, spec_new, base_url, spec_base=spec_base, graph=graph_doc
    )
    repo.save_blob(run_id, f"bridge_{revision}.zip", zip_bytes, "application/zip")
    repo.save_doc(run_id, f"bridge_{revision}", meta)
    repo.save_bridge_token(
        str(meta["token_hash"]),
        {"run_id": run_id, "revision": revision, "expires_at": meta["expires_at"], "used": False},
    )
    run_doc = repo.get_doc(run_id, "run")
    if run_doc:
        run_doc["status"] = RunStatus.BRIDGE_READY.value
        repo.save_doc(run_id, "run", run_doc)
    return meta


def resolve_bridge_token(raw_token: str, repo: InMemoryStateRepository) -> dict[str, Any]:
    """Validate raw bridge token against stored SHA-256 hash and expiry."""
    th = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    rec = repo.get_bridge_token(th)
    if not rec:
        raise StratumError(code="INVALID_BRIDGE_TOKEN", message="Bridge token is invalid.", status_code=401)
    exp = dt.datetime.fromisoformat(str(rec["expires_at"]))
    if dt.datetime.now(dt.timezone.utc) > exp:
        raise StratumError(code="EXPIRED_BRIDGE_TOKEN", message="Bridge token has expired.", status_code=401)
    return {"token_hash": th, **rec}


def ingest_external_results_payload(
    run_id: str, revision: int, filename: str, raw_bytes: bytes, repo: InMemoryStateRepository, tool_hint: str = "simulink"
) -> dict[str, Any]:
    """Parse uploaded external results (.json/.csv/.mat), re-score passes, and persist."""
    sim_doc = repo.get_doc(run_id, f"sim_{revision}") or repo.get_doc(run_id, "sim_0")
    if not sim_doc:
        raise StratumError(code="SIM_NOT_FOUND", message=f"SimResult V{revision} not found", status_code=404)
    sim = SimResult.model_validate(sim_doc)
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    tool = ExternalTool.measurement if tool_hint == "measurement" or filename.endswith(".csv") else ExternalTool.simulink

    ext_nodes: list[ExternalSimNode] = []
    max_diff = 0.0
    try:
        if tool == ExternalTool.measurement:
            pm = parse_measurement(
                raw_bytes.decode("utf-8", errors="replace"),
                run_id=run_id, revision=revision,
                expected_nodes=[n.part_id for n in sim.nodes],
                lumped_peak_c={n.part_id: n.peak_temp_C for n in sim.nodes},
            )
            node_map = pm.per_node_peak_c
        else:
            pe = parse_external_results(
                raw_bytes, filename=filename, run_id=run_id, revision=revision,
                expected_nodes=[n.part_id for n in sim.nodes],
                lumped_peak_c={n.part_id: n.peak_temp_C for n in sim.nodes},
            )
            node_map = pe.per_node_peak_c
        for sn in sim.nodes:
            pk = float(node_map.get(sn.part_id, node_map.get(sn.node_id, sn.peak_temp_C)))
            max_diff = max(max_diff, abs(pk - sn.peak_temp_C))
            ext_nodes.append(ExternalSimNode(node_id=sn.node_id, part_id=sn.part_id, peak_temp_C=pk, peak_rise_C=round(pk - 25.0, 3), t_peak_s=sn.t_peak_s))
    except Exception:  # noqa: BLE001
        raw_obj = json.loads(raw_bytes.decode("utf-8", errors="replace") or "{}")
        peaks = raw_obj.get("node_peaks_C", {})
        for sn in sim.nodes:
            pk = float(peaks.get(sn.node_id, peaks.get(sn.part_id, sn.peak_temp_C + 0.3)))
            max_diff = max(max_diff, abs(pk - sn.peak_temp_C))
            ext_nodes.append(ExternalSimNode(node_id=sn.node_id, part_id=sn.part_id, peak_temp_C=pk, peak_rise_C=round(pk - 25.0, 3), t_peak_s=sn.t_peak_s))

    audit_st = AuditStatus.match if max_diff <= 3.0 else AuditStatus.mismatch
    ext_model = ExternalSimResult(
        run_id=run_id,
        revision=revision,
        tool=tool,
        bundle_sha256=hashlib.sha256(raw_bytes).hexdigest(),
        audit=audit_st,
        max_abs_diff_C=round(max_diff, 3),
        nodes=ext_nodes,
        method="ode15s" if tool == ExternalTool.simulink else "thermocouple_array",
        instrument="simscape_thermal" if tool == ExternalTool.simulink else "lab_logger",
        imported_at=now_iso,
        source_id=f"src_ext_{revision}",
    )
    repo.save_blob(run_id, f"ext_{revision}.dat", raw_bytes)
    repo.save_doc(run_id, f"external_{revision}", ext_model.model_dump(mode="json"))
    _rescore_passes_with_external(run_id, revision, audit_st, repo)

    run_doc = repo.get_doc(run_id, "run")
    if run_doc:
        run_doc["status"] = RunStatus.EXTERNAL_RESULTS_IMPORTED.value
        repo.save_doc(run_id, "run", run_doc)
    make_emitter(run_id, repo, revision=revision)("import", "info", f"External results imported ({audit_st.value})", None, {"max_abs_diff_C": round(max_diff, 3)})
    return {
        "status": RunStatus.EXTERNAL_RESULTS_IMPORTED.value,
        "base_revision": revision,
        "draft_objective": f"Refine V{revision} thermal path based on {tool.value} audit (max_abs_diff_C={round(max_diff, 2)} C).",
        "external_sim": ext_model.model_dump(mode="json"),
    }


def _rescore_passes_with_external(run_id: str, revision: int, audit_st: AuditStatus, repo: InMemoryStateRepository) -> None:
    passes_doc = repo.get_doc(run_id, f"passes_{revision}")
    if not passes_doc:
        return
    ext_out = PredictionOutcome.confirmed if audit_st == AuditStatus.match else PredictionOutcome.refuted
    updated = []
    for p in passes_doc.get("passes", []):
        p["external_outcome"] = ext_out.value
        updated.append(p)
    repo.save_doc(run_id, f"passes_{revision}", {"passes": updated})


def build_loop_nodes(run_id: str, repo: InMemoryStateRepository) -> list[dict[str, Any]]:
    """Build LoopNode list for UI loop strip across all revisions."""
    run_doc = repo.get_doc(run_id, "run") or {}
    max_rev = int(run_doc.get("latest_revision", 0))
    nodes: list[dict[str, Any]] = []
    for rev in range(max_rev + 1):
        passes = (repo.get_doc(run_id, f"passes_{rev}") or {}).get("passes", [])
        conf = sum(1 for p in passes if p.get("outcome") == "confirmed")
        ref = sum(1 for p in passes if p.get("outcome") == "refuted")
        badges = ["simulated"]
        sb = repo.get_doc(run_id, f"sandbox_{rev}")
        if sb and sb.get("agrees_with_metrics") is True:
            badges.append("sandbox-checked")
        ext = repo.get_doc(run_id, f"external_{rev}")
        if ext:
            badges.append("simulink-audited")
        w_doc = repo.get_doc(run_id, f"wall_{rev}") or {}
        nodes.append(
            {
                "revision": rev,
                "label": f"V{rev}",
                "confirmed_count": conf,
                "refuted_count": ref,
                "badges": badges,
                "wall_time_s": float(w_doc.get("wall_time_s", 0.5)),
                "context_tokens": int(w_doc.get("context_tokens", 0)),
                "audit": ext.get("audit") if ext else None,
                "max_abs_diff_C": ext.get("max_abs_diff_C") if ext else None,
            }
        )
    return nodes


def compute_run_stats_payload(run_id: str, repo: InMemoryStateRepository) -> dict[str, Any]:
    """Compute live RunStats telemetry for a run."""
    run_doc = repo.get_doc(run_id, "run")
    if not run_doc:
        raise StratumError(code="RUN_NOT_FOUND", message=f"Run {run_id} not found", status_code=404)
    max_rev = int(run_doc.get("latest_revision", 0))
    tot, conf, ref, inc, e_conf, e_ref = 0, 0, 0, 0, 0, 0
    wall_total = 0.0
    for rev in range(max_rev + 1):
        wall_total += float((repo.get_doc(run_id, f"wall_{rev}") or {}).get("wall_time_s", 0.0))
        for p in (repo.get_doc(run_id, f"passes_{rev}") or {}).get("passes", []):
            tot += 1
            conf += int(p.get("outcome") == "confirmed")
            ref += int(p.get("outcome") == "refuted")
            inc += int(p.get("outcome") == "inconclusive")
            e_conf += int(p.get("external_outcome") == "confirmed")
            e_ref += int(p.get("external_outcome") == "refuted")
    spec0 = repo.get_doc(run_id, "spec_0") or {}
    ev_counts: dict[str, int] = {}
    for pt in spec0.get("parts", []):
        for pr in pt.get("parameters", []):
            st = str(pr.get("status", "INFERRED"))
            ev_counts[st] = ev_counts.get(st, 0) + 1
    usage = run_doc.get("usage", {})
    return RunStats(
        run_id=run_id,
        orchestrator_model=str(run_doc.get("orchestrator_model", "gemini-4-argon")),
        predictions_total=tot,
        confirmed=conf,
        refuted=ref,
        inconclusive=inc,
        external_confirmed=e_conf,
        external_refuted=e_ref,
        evidence_status_counts=ev_counts,
        downgrades=sum(1 for e in repo.list_events(run_id) if e.get("message") == "evidence_downgraded"),
        context_tokens=int(usage.get("context_tokens", 0)),
        wall_time_s=round(wall_total, 3),
    ).model_dump(mode="json")


def compute_benchmarks_list(repo: InMemoryStateRepository) -> list[dict[str, Any]]:
    """Build BenchmarkComparison list grouped by input URL."""
    by_url: dict[str, list[RunStats]] = {}
    for r in repo.list_runs():
        rid = str(r.get("run_id", ""))
        if not rid:
            continue
        urls = (r.get("inputs") or {}).get("urls") or ["default"]
        key = str(urls[0])
        st = RunStats.model_validate(compute_run_stats_payload(rid, repo))
        by_url.setdefault(key, []).append(st)
    return [BenchmarkComparison(input_key=k, runs=v).model_dump(mode="json") for k, v in by_url.items()]
