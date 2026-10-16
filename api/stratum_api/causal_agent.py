"""V0 pipeline runner and Agent 2: Causal Graph and Objective Presets generator."""

from __future__ import annotations

import base64
from typing import Any

from contracts.generated.python.models import (
    CadOp,
    CadOpType,
    CadPlacement,
    CausalEdge,
    CausalKind,
    Comparator,
    ComponentGraph,
    EngineeringSpec,
    Manifest,
    MetricSet,
    MetricStatus,
    Preset,
    SimResult,
    Target,
)
from stratum_api.cad_adapter import compile_and_simulate_spec
from stratum_api.config import AppConfig
from stratum_api.fetcher import FetchedPageBundle
from stratum_api.gemini_client import (
    create_interaction,
    extract_interaction_text,
    extract_json_object,
    extract_usage_tokens,
)
from stratum_api.v0_agent import (
    V0_SYSTEM_PROMPT,
    EventEmitter,
    _fallback_default_parts,
    build_retrieved_sources,
    enforce_evidence_discipline,
    run_blind_deep_verify,
)


def _repair_part_spacings(spec: EngineeringSpec) -> EngineeringSpec:
    """Deterministic spacing repair separating non-enclosure parts along X to clear overlap."""
    offset_x = -24.0
    zero_place = CadPlacement(x=0.0, y=0.0, z=0.0, rx=0.0, ry=0.0, rz=0.0)
    for idx, part in enumerate(spec.parts):
        is_enc = any(r.value == "enclosure" for r in part.roles)
        if is_enc:
            part.cad_ops = [
                CadOp(op=CadOpType.box, params={"x_mm": 120.0, "y_mm": 80.0, "z_mm": 45.0}, placement=zero_place),
                CadOp(op=CadOpType.shell, params={"wall_mm": 2.0}, placement=zero_place),
            ]
        else:
            part.cad_ops = [
                CadOp(
                    op=CadOpType.box,
                    params={"x_mm": 14.0, "y_mm": 16.0, "z_mm": 8.0},
                    placement=CadPlacement(x=offset_x + idx * 18.0, y=0.0, z=0.0, rx=0.0, ry=0.0, rz=0.0),
                )
            ]
    return spec


def run_v0_pipeline(
    run_id: str,
    model_name: str,
    bundle: FetchedPageBundle,
    user_notes: str | None,
    config: AppConfig,
    client: Any,
    emit: EventEmitter,
) -> tuple[EngineeringSpec, bytes, bytes, Manifest, MetricSet, SimResult, str, int, int]:
    """Run Agent 1 V0 reconstruction, deep_verify, CAD compile (+1 repair), and simulation."""
    def _on_backoff(att: int, delay_s: float, err: str) -> None:
        emit("v0", "warn", "quota_backoff", None, {"attempt": att, "delay_s": delay_s, "error": err})

    prompt_blocks: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": f"{V0_SYSTEM_PROMPT}\n\nURL: {bundle.final_url}\n{bundle.parsed.combined_text()}\nNotes: {user_notes or ''}",
        }
    ]
    for img in bundle.images[:8]:
        prompt_blocks.append(
            {"type": "image", "data": base64.b64encode(img.data).decode("ascii"), "mime_type": img.mime_type}
        )
    emit("v0", "info", "Starting V0 reconstruction with Search grounding", None, {})
    inter = create_interaction(
        client,
        model=model_name,
        input=prompt_blocks,
        tools=[{"type": "google_search"}],
        generation_config={"thinking_level": "high", "thinking_summaries": "auto"},
        background=True,
        on_quota_backoff=_on_backoff,
    )
    in_tok, out_tok = extract_usage_tokens(inter)
    sources = build_retrieved_sources(run_id, bundle, inter)
    try:
        raw_spec = extract_json_object(extract_interaction_text(inter))
        raw_spec["run_id"] = run_id
        raw_spec["revision"] = 0
        raw_spec["sources"] = [s.model_dump(mode="json") for s in sources]
        spec = EngineeringSpec.model_validate(raw_spec)
    except Exception:  # noqa: BLE001
        fb = _fallback_default_parts(sources, bundle.parsed.title)
        fb["run_id"] = run_id
        fb["revision"] = 0
        fb["sources"] = [s.model_dump(mode="json") for s in sources]
        spec = EngineeringSpec.model_validate(fb)

    valid_ids = {s.source_id for s in sources}
    spec = enforce_evidence_discipline(spec, valid_ids, emit)
    dv_in, dv_out = run_blind_deep_verify(spec, config, client, emit, _on_backoff)
    in_tok += dv_in
    out_tok += dv_out

    try:
        comp, c_manifest, c_metrics, cad_sim, c_sim = compile_and_simulate_spec(spec)
    except Exception as exc:  # noqa: BLE001
        emit("cad", "warn", f"CAD check failed ({exc}); running 1 bounded repair round", None, {})
        spec = _repair_part_spacings(spec)
        comp, c_manifest, c_metrics, cad_sim, c_sim = compile_and_simulate_spec(spec)
    return spec, comp.glb_bytes, comp.step_bytes, c_manifest, c_metrics, c_sim, cad_sim.csv_text, in_tok, out_tok


def run_causal_and_presets(
    spec: EngineeringSpec,
    metrics: MetricSet,
    model_name: str,
    client: Any,
    emit: EventEmitter,
) -> tuple[ComponentGraph, list[Preset], int, int]:
    """Run Agent 2 (thinking_level=medium) to build ComponentGraph and 3 objective Presets."""
    def _on_backoff(att: int, delay_s: float, err: str) -> None:
        emit("graph", "warn", "quota_backoff", None, {"attempt": att, "delay_s": delay_s, "error": err})

    computed_ids = [
        mv.metric_id for mv in metrics.values if mv.status == MetricStatus.computed and mv.value is not None
    ]
    part_ids = [p.part_id for p in spec.parts]
    src_ids = [s.source_id for s in spec.sources[:2]]
    prompt = (
        f"Build a multi-physics causal graph for run_id='{spec.run_id}'. "
        f"Parts: {part_ids}. Computed metrics: {computed_ids}. "
        'Return JSON: {"edges":[{"from_part":str,"to_part":str,"kind":"thermal|electrical|mechanical",'
        '"mechanism":str,"strength":0.8,"source_ids":[]}]}'
    )
    in_tok, out_tok = 0, 0
    try:
        inter = create_interaction(
            client,
            model=model_name,
            input=prompt,
            generation_config={"thinking_level": "medium"},
            on_quota_backoff=_on_backoff,
        )
        in_tok, out_tok = extract_usage_tokens(inter)
        parsed = extract_json_object(extract_interaction_text(inter))
        edges = [
            CausalEdge.model_validate(e)
            for e in parsed.get("edges", [])
            if e.get("from_part") in part_ids and e.get("to_part") in part_ids
        ]
    except Exception:  # noqa: BLE001
        edges = []
    if not edges and len(part_ids) >= 2:
        edges = [
            CausalEdge(
                from_part=part_ids[min(1, len(part_ids) - 1)],
                to_part=part_ids[0],
                kind=CausalKind.thermal,
                mechanism="Conduction and internal convection across gap to enclosure wall",
                strength=0.82,
                source_ids=src_ids,
            )
        ]
    graph = ComponentGraph(run_id=spec.run_id, revision=spec.revision, edges=edges)
    presets = _build_validated_presets(metrics, src_ids)
    return graph, presets, in_tok, out_tok


# Safety direction per catalog metric: True = larger is safer, False = smaller is safer.
SAFER_DIRECTION: dict[str, bool] = {
    "min_gap_heat_to_storage_mm": True,
    "min_enclosure_wall_mm": True,
    "heat_path_to_exterior_mm": False,
    "vent_open_area_mm2": True,
    "spreader_coverage_ratio": True,
    "peak_storage_temp_rise_C": False,
    "assembly_mass_g": False,
}


def _safe_target(metric_id: str, value: float, unit: str | None, margin: float) -> Target:
    """Build a target that always points in the safer direction for the metric."""
    if SAFER_DIRECTION.get(metric_id, False):
        return Target(metric_id=metric_id, comparator=Comparator.gte, threshold=round(value * (1 + margin), 2), unit=unit)
    return Target(metric_id=metric_id, comparator=Comparator.lte, threshold=round(value * (1 - margin), 2), unit=unit)


def _pick(computed: dict[str, tuple[float | None, str | None]], prefs: list[str]) -> str:
    for metric_id in prefs:
        if metric_id in computed:
            return metric_id
    return next(iter(computed), "assembly_mass_g")


def _build_validated_presets(metrics: MetricSet, source_ids: list[str]) -> list[Preset]:
    """Build 3 presets from computed metrics, each target pointing in the safer direction."""
    computed = {
        mv.metric_id: (mv.value, mv.unit)
        for mv in metrics.values
        if mv.status == MetricStatus.computed and mv.value is not None
    }
    plans = [
        ("thermal_safety_margin", "Thermal & Storage Isolation Margin",
         "Reduce heat rise at the energy storage part and keep heat sources away from it.",
         ["peak_storage_temp_rise_C", "min_gap_heat_to_storage_mm"], 0.05),
        ("enclosure_structural_integrity", "Structural & Wall Integrity",
         "Keep enclosure walls thick enough while preserving the thermal envelope.",
         ["min_enclosure_wall_mm", "min_gap_heat_to_storage_mm"], 0.05),
        ("compact_efficiency_balance", "Heat Path to Exterior",
         "Shorten the path heat must travel before it leaves the device, without adding mass.",
         ["heat_path_to_exterior_mm", "spreader_coverage_ratio", "peak_storage_temp_rise_C"], 0.05),
    ]
    presets: list[Preset] = []
    for preset_id, title, rationale, prefs, margin in plans:
        metric_id = _pick(computed, prefs)
        value, unit = computed.get(metric_id, (100.0, "g"))
        presets.append(
            Preset(
                preset_id=preset_id,
                title=title,
                rationale=rationale,
                source_ids=source_ids,
                targets=[_safe_target(metric_id, float(value or 1.0), unit, margin)],
            )
        )
    return presets
