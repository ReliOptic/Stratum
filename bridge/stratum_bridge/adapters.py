"""Thin adapters between contracts.generated.python.models and internal stratum_bridge types."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from stratum_bridge.types import ExternalSimResult
from stratum_cad.adapters import adapt_manifest, adapt_spec
from stratum_cad.simulator import simulate
from stratum_cad.types import (
    EngineeringSpec,
    Manifest,
    MetricSet,
    MetricValue,
    SimResult,
    SimSample,
)


def _load_contract_models() -> Any:
    """Import generated contract models lazily."""
    from contracts.generated.python import models as contract_models

    return contract_models


def adapt_metric_set(mset: MetricSet | Any) -> MetricSet:
    """Adapt either a contract MetricSet or internal MetricSet into internal MetricSet."""
    if isinstance(mset, MetricSet):
        return mset
    metrics: dict[str, MetricValue] = {}
    for mv in getattr(mset, "values", []):
        st_raw = getattr(mv.status, "value", str(mv.status)) if hasattr(mv, "status") else "INFERRED"
        not_app = st_raw == "not_applicable"
        ev_status = "INFERRED" if not_app else st_raw
        metrics[str(mv.metric_id)] = MetricValue(
            metric_id=str(mv.metric_id),
            value=mv.value,
            unit=str(mv.unit),
            part_ids=[str(pid) for pid in getattr(mv, "part_ids", [])],
            status=ev_status,  # type: ignore[arg-type]
            not_applicable=not_app,
        )
    return MetricSet(
        metrics=metrics,
        run_id=str(getattr(mset, "run_id", "widget-a")),
        revision=int(getattr(mset, "revision", 0)),
    )


def adapt_sim_result(
    sim: SimResult | Any,
    spec: EngineeringSpec | Any | None = None,
    manifest: Manifest | Any | None = None,
) -> SimResult:
    """Adapt either a contract SimResult or internal SimResult into internal SimResult."""
    if isinstance(sim, SimResult):
        return sim
    if spec is not None:
        s_in = adapt_spec(spec)
        m_in = adapt_manifest(manifest, s_in) if manifest is not None else Manifest(
            parts=[], checks={}, step_sha256="", glb_sha256="", run_id=s_in.run_id, revision=s_in.revision
        )
        return simulate(s_in, m_in)

    run_id = str(getattr(sim, "run_id", "widget-a"))
    rev = int(getattr(sim, "revision", 0))
    dt_s = float(getattr(sim, "dt_s", 1.0))
    peaks: dict[str, float] = {}
    rises: dict[str, float] = {}
    storage_ids: list[str] = []
    samples: list[SimSample] = []
    for nd in getattr(sim, "nodes", []):
        pid = str(getattr(nd, "part_id", getattr(nd, "node_id", "part")))
        pk = float(getattr(nd, "peak_temp_C", 25.0))
        rs = float(getattr(nd, "peak_rise_C", 0.0))
        t_pk = float(getattr(nd, "t_peak_s", 0.0))
        role_val = getattr(nd.role, "value", str(nd.role)) if hasattr(nd, "role") else "other"
        peaks[pid] = pk
        rises[pid] = rs
        if role_val == "energy_storage":
            storage_ids.append(pid)
        samples.append(SimSample(time_s=t_pk, revision=rev, node_id=pid, temp_c=pk))
    return SimResult(
        run_id=run_id,
        revision=rev,
        dt_s=dt_s,
        duration_s=max((s.time_s for s in samples), default=600.0),
        ambient_c=25.0,
        peak_temp_c=max(peaks.values(), default=25.0),
        peak_storage_temp_rise_c=getattr(sim, "storage_peak_rise_C", None),
        per_node_peak_c=peaks,
        per_node_rise_c=rises,
        storage_node_ids=storage_ids,
        series=samples,
        csv_text="",
    )


def to_contract_external_result(
    ext: ExternalSimResult,
    revision: int | None = None,
    ambient_c: float = 25.0,
) -> Any:
    """Convert internal ExternalSimResult to contracts.generated.python.models.ExternalSimResult."""
    cm = _load_contract_models()
    rev = revision if revision is not None else (
        max(ext.per_revision_node_peak_c.keys()) if ext.per_revision_node_peak_c else 1
    )
    node_peaks = ext.per_revision_node_peak_c.get(rev, ext.per_node_peak_c)
    nodes = [
        cm.ExternalSimNode(
            node_id=f"node_{nid}",
            part_id=nid,
            peak_temp_C=round(float(pk), 4),
            peak_rise_C=round(float(pk) - ambient_c, 4),
            t_peak_s=next(
                (s.time_s for s in ext.series if s.node_id == nid and s.revision == rev and abs(s.temp_c - pk) <= 1e-3),
                0.0,
            ),
        )
        for nid, pk in node_peaks.items()
    ]
    audit_map = {
        "MATCH": cm.AuditStatus.match,
        "MISMATCH": cm.AuditStatus.mismatch,
        "not_applicable": cm.AuditStatus.not_applicable,
    }
    return cm.ExternalSimResult(
        run_id=ext.run_id,
        revision=rev,
        tool=cm.ExternalTool(ext.tool),
        bundle_sha256=ext.bundle_sha256,
        audit=audit_map.get(ext.audit, cm.AuditStatus.not_applicable),
        max_abs_diff_C=ext.max_abs_diff_c,
        nodes=nodes,
        method=ext.meta.get("method"),
        instrument=ext.meta.get("instrument"),
        imported_at=ext.timestamp or datetime.now(timezone.utc).isoformat(),
        source_id=ext.meta.get("source_id") or f"src-{ext.tool}-rev{rev}",
    )
