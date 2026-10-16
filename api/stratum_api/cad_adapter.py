"""Adapter converting between Stratum contract Pydantic models and stratum_cad dataclasses."""

from __future__ import annotations

from typing import Any

from contracts.generated.python.models import (
    EngineeringSpec as ContractSpec,
    Manifest as ContractManifest,
    ManifestCheck,
    ManifestPart,
    MetricSet as ContractMetricSet,
    MetricStatus,
    MetricValue as ContractMetricValue,
    Part as ContractPart,
    PartRole,
    SimModel,
    SimNode,
    SimResult as ContractSimResult,
)
from stratum_cad import (
    CadOp as CadEngineOp,
    CompileResult,
    EngineeringSpec as CadEngineSpec,
    Manifest as CadEngineManifest,
    MetricSet as CadEngineMetricSet,
    Part as CadEnginePart,
    Placement as CadEnginePlacement,
    SimResult as CadEngineSimResult,
    compile_parts,
    compute_metrics,
    simulate,
)


def _resolve_material_key(raw_mat: str | None, primary_role: str) -> str:
    """Map free-text material or role to a canonical stratum_cad MATERIAL_TABLE key."""
    m = (raw_mat or "").lower()
    if "copper" in m or "c110" in m:
        return "copper_c110"
    if "polycarbonate" in m or m == "pc":
        return "polycarbonate"
    if "abs" in m or "plastic" in m or "polymer" in m:
        return "abs_plastic"
    if "fr4" in m or "pcb" in m:
        return "fr4_pcb"
    if "li_ion" in m or "jellyroll" in m or primary_role == "energy_storage":
        return "li_ion_jellyroll"
    if "ferrite" in m or primary_role == "magnetic":
        return "ferrite_mnzn"
    if "steel" in m or primary_role == "fastener":
        return "steel_1018"
    if "silicone" in m or "pad" in m:
        return "silicone_pad"
    return "aluminum_6061"


def _normalize_op_params(
    op_name: str, params: dict[str, float], pl: Any | None
) -> tuple[str, dict[str, float | str]]:
    """Normalize contract CadOp type and parameter names to stratum_cad expected keys."""
    engine_op = "box" if op_name == "rounded_box" else op_name
    out: dict[str, float | str] = {k: float(v) for k, v in params.items()}
    if engine_op in ("box", "cut_box"):
        out.setdefault("x_mm", float(params.get("x_mm") or params.get("dx_mm") or params.get("length_mm") or params.get("x") or 20.0))
        out.setdefault("y_mm", float(params.get("y_mm") or params.get("dy_mm") or params.get("width_mm") or params.get("y") or 20.0))
        out.setdefault("z_mm", float(params.get("z_mm") or params.get("dz_mm") or params.get("height_mm") or params.get("z") or 10.0))
    elif engine_op in ("cylinder", "cut_cylinder"):
        out.setdefault("radius_mm", float(params.get("radius_mm") or params.get("r_mm") or params.get("r") or 5.0))
        out.setdefault("height_mm", float(params.get("height_mm") or params.get("h_mm") or params.get("z_mm") or params.get("h") or 10.0))
    elif engine_op == "shell":
        w = float(params.get("wall_mm") or params.get("thickness_mm") or params.get("t_mm") or 1.5)
        out["wall_mm"] = max(0.5, w)
    if engine_op in ("cut_box", "cut_cylinder") and pl is not None:
        out.setdefault("cx_mm", float(getattr(pl, "x", 0.0)))
        out.setdefault("cy_mm", float(getattr(pl, "y", 0.0)))
        out.setdefault("cz_mm", float(getattr(pl, "z", 0.0)))
    return engine_op, out


def contract_part_to_cad_part(part: ContractPart, enclosure_id: str | None = None) -> CadEnginePart:
    """Convert a Contract Part model into a stratum_cad Part dataclass."""
    primary_role = part.roles[0].value if part.roles else "other"
    ops: list[CadEngineOp] = []
    base_pl = CadEnginePlacement()
    for idx, cop in enumerate(part.cad_ops):
        if idx == 0 and cop.placement is not None:
            base_pl = CadEnginePlacement(
                x_mm=float(cop.placement.x),
                y_mm=float(cop.placement.y),
                z_mm=float(cop.placement.z),
                rx_deg=float(cop.placement.rx),
                ry_deg=float(cop.placement.ry),
                rz_deg=float(cop.placement.rz),
            )
        e_op, e_params = _normalize_op_params(cop.op.value, cop.params, cop.placement if idx > 0 else None)
        ops.append(CadEngineOp(op=e_op, params=e_params))
    power_w = 0.0
    p_status = "ASSUMED"
    p_basis = "model_prior"
    src_ids: list[str] = []
    for param in part.parameters:
        if (param.unit == "W" or "power" in param.name.lower()) and isinstance(param.value, (int, float)):
            power_w = float(param.value)
            p_status = param.status.value
            p_basis = param.basis_type.value
            src_ids = list(param.source_ids)
            break
    nested_in = enclosure_id if (enclosure_id and part.part_id != enclosure_id) else None
    return CadEnginePart(
        part_id=part.part_id,
        role=primary_role,  # type: ignore[arg-type]
        ops=ops,
        placement=base_pl,
        name=part.name,
        material=_resolve_material_key(part.material, primary_role),
        nested_in=nested_in,
        power_w=power_w,
        power_status=p_status,  # type: ignore[arg-type]
        power_basis=p_basis,  # type: ignore[arg-type]
        source_ids=src_ids,
    )


def contract_spec_to_cad_spec(spec: ContractSpec) -> CadEngineSpec:
    """Convert a Contract EngineeringSpec into a stratum_cad EngineeringSpec."""
    enclosure_id: str | None = None
    for p in spec.parts:
        if any(r.value == "enclosure" for r in p.roles):
            enclosure_id = p.part_id
            break
    cad_parts = [contract_part_to_cad_part(p, enclosure_id=enclosure_id) for p in spec.parts]
    return CadEngineSpec(parts=cad_parts, run_id=spec.run_id, revision=spec.revision)


def cad_manifest_to_contract(cad_manifest: CadEngineManifest) -> ContractManifest:
    """Convert stratum_cad Manifest into Contract Manifest model."""
    parts = [
        ManifestPart(
            part_id=p.part_id,
            glb_node=p.part_id,
            bbox_mm=[*p.bbox_min_mm, *p.bbox_max_mm],
            volume_mm3=p.volume_mm3,
        )
        for p in cad_manifest.parts
    ]
    checks = [
        ManifestCheck(check_id=cid, passed=chk.passed, detail=chk.details or "ok")
        for cid, chk in cad_manifest.checks.items()
    ]
    return ContractManifest(
        run_id=cad_manifest.run_id,
        revision=cad_manifest.revision,
        parts=parts,
        checks=checks,
    )


def cad_metrics_to_contract(cad_metrics: CadEngineMetricSet) -> ContractMetricSet:
    """Convert stratum_cad MetricSet into Contract MetricSet model."""
    values: list[ContractMetricValue] = []
    for mid, mv in cad_metrics.metrics.items():
        val_float: float | None = None
        note = "computed from geometry and thermal spec"
        if isinstance(mv.value, list):
            val_float = float(max(mv.value)) if mv.value else None
            note = f"envelope_mm={mv.value}"
        elif mv.value is not None:
            val_float = float(mv.value)
        m_status = MetricStatus.not_applicable if mv.not_applicable else MetricStatus.computed
        values.append(
            ContractMetricValue(
                metric_id=mid,
                value=val_float,
                unit=mv.unit,
                status=m_status,
                part_ids=list(mv.part_ids),
                note=note,
            )
        )
    return ContractMetricSet(run_id=cad_metrics.run_id, revision=cad_metrics.revision, values=values)


def compile_and_simulate_spec(
    spec: ContractSpec,
) -> tuple[CompileResult, ContractManifest, ContractMetricSet, CadEngineSimResult, ContractSimResult]:
    """Compile CAD, compute metrics, and run thermal simulation for a ContractSpec."""
    cad_spec = contract_spec_to_cad_spec(spec)
    comp = compile_parts(cad_spec.parts, run_id=spec.run_id, revision=spec.revision)
    cad_mset = compute_metrics(cad_spec, comp.manifest)
    cad_sim = simulate(cad_spec, comp.manifest)
    c_manifest = cad_manifest_to_contract(comp.manifest)
    c_metrics = cad_metrics_to_contract(cad_mset)
    role_by_id = {p.part_id: (p.roles[0] if p.roles else PartRole.other) for p in spec.parts}
    nodes = [
        SimNode(
            node_id=nid,
            part_id=nid,
            role=role_by_id.get(nid, PartRole.other),
            peak_temp_C=peak_c,
            peak_rise_C=cad_sim.per_node_rise_c.get(nid, round(peak_c - cad_sim.ambient_c, 4)),
            t_peak_s=cad_sim.duration_s,
        )
        for nid, peak_c in cad_sim.per_node_peak_c.items()
    ]
    c_sim = ContractSimResult(
        run_id=spec.run_id,
        revision=spec.revision,
        model=SimModel.lumped_rc_v1,
        dt_s=cad_sim.dt_s,
        nodes=nodes,
        storage_peak_rise_C=cad_sim.peak_storage_temp_rise_c,
        series_uri=f"runs/{spec.run_id}/sim_{spec.revision}.csv",
        assumptions=[f"ambient_C={cad_sim.ambient_c}", f"duration_s={cad_sim.duration_s}"],
    )
    return comp, c_manifest, c_metrics, cad_sim, c_sim
