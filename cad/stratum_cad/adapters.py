"""Thin adapters between contracts.generated.python.models and stratum_cad internal types."""

from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

from stratum_cad.types import (
    BasisType,
    CadOp,
    CheckResult,
    EngineeringSpec,
    EvidenceStatus,
    Manifest,
    MetricSet,
    Part,
    PartManifestEntry,
    PartRole,
    Placement,
    SimResult,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from contracts.generated.python import models as cm  # noqa: E402

_PRIORITY_ROLES: tuple[PartRole, ...] = (
    "heat_source", "energy_storage", "enclosure", "thermal_spreader",
    "power_conversion", "structural_frame", "user_contact_surface",
    "connector", "magnetic", "fastener", "moving_part", "other",
)
_POWER_PARAM_NAMES: frozenset[str] = frozenset(
    {"power_dissipation", "power_w", "power", "heat_w", "thermal_power"}
)


def _select_primary_role(roles: Sequence[Any]) -> PartRole:
    """Pick the highest-priority thermal/structural role from a contract part's roles list."""
    role_strs = [r.value if hasattr(r, "value") else str(r) for r in roles]
    for prio in _PRIORITY_ROLES:
        if prio in role_strs:
            return prio
    return cast(PartRole, role_strs[0] if role_strs else "other")


def from_contract_part(part: Any) -> Part:
    """Adapt a contracts.generated.python.models.Part (or dict) into an internal Part."""
    if isinstance(part, Part):
        return part
    c_part = cm.Part.model_validate(part) if isinstance(part, dict) else part
    primary_role = _select_primary_role(c_part.roles)
    pl0 = c_part.cad_ops[0].placement if c_part.cad_ops else None
    placement = (
        Placement(float(pl0.x), float(pl0.y), float(pl0.z), float(pl0.rx), float(pl0.ry), float(pl0.rz))
        if pl0 is not None
        else Placement()
    )
    ops: list[CadOp] = []
    for idx, cop in enumerate(c_part.cad_ops):
        op_name = cop.op.value if hasattr(cop.op, "value") else str(cop.op)
        params: dict[str, float | str] = {k: float(v) for k, v in cop.params.items()}
        if idx > 0 and cop.placement is not None:
            params.setdefault("cx_mm", float(cop.placement.x) - placement.x_mm)
            params.setdefault("cy_mm", float(cop.placement.y) - placement.y_mm)
            params.setdefault("cz_mm", float(cop.placement.z) - placement.z_mm)
        ops.append(CadOp(op=op_name, params=params))

    power_w, power_status, power_basis, source_ids = 0.0, "ASSUMED", "model_prior", []
    for param in c_part.parameters:
        if param.name.lower() in _POWER_PARAM_NAMES and isinstance(param.value, (int, float)):
            power_w = float(param.value)
            power_status, power_basis = param.status.value, param.basis_type.value
            source_ids = list(param.source_ids)
            break

    return Part(
        part_id=c_part.part_id,
        role=primary_role,
        ops=ops,
        placement=placement,
        name=c_part.name,
        material=c_part.material or "abs_plastic",
        nested_in="*",
        power_w=power_w,
        power_status=cast(EvidenceStatus, power_status),
        power_basis=cast(BasisType, power_basis),
        source_ids=source_ids,
    )


def adapt_parts(parts: Sequence[Any]) -> list[Part]:
    """Adapt a sequence of contract or internal Part objects into internal Part instances."""
    return [from_contract_part(p) for p in parts]


def adapt_spec(spec: Any) -> EngineeringSpec:
    """Adapt a contracts.generated.python.models.EngineeringSpec (or dict) into internal EngineeringSpec."""
    if isinstance(spec, EngineeringSpec):
        return spec
    c_spec = cm.EngineeringSpec.model_validate(spec) if isinstance(spec, dict) else spec
    return EngineeringSpec(parts=adapt_parts(c_spec.parts), run_id=c_spec.run_id, revision=int(c_spec.revision))


def adapt_manifest(manifest: Any, spec: EngineeringSpec | Any | None = None) -> Manifest:
    """Adapt a contracts.generated.python.models.Manifest (or dict) into internal Manifest."""
    if isinstance(manifest, Manifest):
        return manifest
    spec_in = adapt_spec(spec) if spec is not None else None
    c_man = cm.Manifest.model_validate(manifest) if isinstance(manifest, dict) else manifest
    part_map = {p.part_id: p for p in spec_in.parts} if spec_in is not None else {}
    entries: list[PartManifestEntry] = []
    for mp in c_man.parts:
        p_ref = part_map.get(mp.part_id)
        bmin = (float(mp.bbox_mm[0]), float(mp.bbox_mm[1]), float(mp.bbox_mm[2]))
        bmax = (float(mp.bbox_mm[3]), float(mp.bbox_mm[4]), float(mp.bbox_mm[5]))
        dx, dy, dz = bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]
        area = max(2.0 * (dx * dy + dy * dz + dz * dx), 1.0)
        cent = (0.5 * (bmin[0] + bmax[0]), 0.5 * (bmin[1] + bmax[1]), 0.5 * (bmin[2] + bmax[2]))
        entries.append(
            PartManifestEntry(
                part_id=mp.part_id,
                role=p_ref.role if p_ref is not None else "other",
                material=p_ref.material if p_ref is not None else "abs_plastic",
                volume_mm3=float(mp.volume_mm3),
                surface_area_mm2=round(area, 4),
                bbox_min_mm=bmin,
                bbox_max_mm=bmax,
                centroid_mm=cent,
            )
        )
    checks = {c.check_id: CheckResult(c.check_id, c.passed, details=c.detail) for c in c_man.checks}
    return Manifest(entries, checks, "0" * 64, "0" * 64, run_id=c_man.run_id, revision=int(c_man.revision))


def to_contract_manifest(manifest: Manifest) -> cm.Manifest:
    """Convert an internal Manifest into contracts.generated.python.models.Manifest."""
    parts = [
        cm.ManifestPart(part_id=mp.part_id, glb_node=mp.part_id, bbox_mm=[*mp.bbox_min_mm, *mp.bbox_max_mm], volume_mm3=mp.volume_mm3)
        for mp in manifest.parts
    ]
    checks = [cm.ManifestCheck(check_id=c.check_id, passed=c.passed, detail=c.details or c.check_id) for c in manifest.checks.values()]
    return cm.Manifest(run_id=manifest.run_id, revision=manifest.revision, parts=parts, checks=checks)


def to_contract_metric_set(metric_set: MetricSet) -> cm.MetricSet:
    """Convert an internal MetricSet into contracts.generated.python.models.MetricSet."""
    values: list[cm.MetricValue] = []
    for mv in metric_set.metrics.values():
        val = (float(max(mv.value)) if mv.value else None) if isinstance(mv.value, list) else (float(mv.value) if mv.value is not None else None)
        note = f"Envelope {mv.value} ({mv.basis_type}, {mv.status})" if isinstance(mv.value, list) else f"{mv.basis_type} ({mv.status})"
        st = cm.MetricStatus.not_applicable if mv.not_applicable else cm.MetricStatus.computed
        values.append(cm.MetricValue(metric_id=mv.metric_id, value=val, unit=mv.unit, status=st, part_ids=mv.part_ids, note=note))
    return cm.MetricSet(run_id=metric_set.run_id, revision=metric_set.revision, values=values)


def to_contract_sim_result(sim_result: SimResult, spec: EngineeringSpec | Any | None = None) -> cm.SimResult:
    """Convert an internal SimResult into contracts.generated.python.models.SimResult."""
    spec_in = adapt_spec(spec) if spec is not None else None
    role_map = {p.part_id: p.role for p in spec_in.parts} if spec_in is not None else {}
    nodes: list[cm.SimNode] = []
    for pid, peak_c in sim_result.per_node_peak_c.items():
        t_peak = next((s.time_s for s in sim_result.series if s.node_id == pid and abs(s.temp_c - peak_c) <= 1e-3), sim_result.duration_s)
        role_str = role_map.get(pid, "energy_storage" if pid in sim_result.storage_node_ids else "other")
        nodes.append(cm.SimNode(node_id=f"node_{pid}", part_id=pid, role=cm.PartRole(role_str), peak_temp_C=peak_c, peak_rise_C=sim_result.per_node_rise_c[pid], t_peak_s=t_peak))
    return cm.SimResult(
        run_id=sim_result.run_id,
        revision=sim_result.revision,
        model=cm.SimModel.lumped_rc_v1,
        dt_s=sim_result.dt_s,
        nodes=nodes,
        storage_peak_rise_C=sim_result.peak_storage_temp_rise_c,
        series_uri=f"runs/{sim_result.run_id}/rev_{sim_result.revision}/sim_series.json",
        assumptions=[f"Ambient temperature {sim_result.ambient_c:.1f} C", "Backward-Euler lumped-RC network"],
    )
