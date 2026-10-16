"""Agent 1: V0 Reconstructor, server-side evidence validator, and blind deep_verify."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

from contracts.generated.python.models import (
    BasisType,
    CropBox,
    EngineeringSpec,
    EvidenceKind,
    EvidenceSource,
    ParameterStatus,
    Part,
)
from stratum_api.config import AppConfig
from stratum_api.fetcher import FetchedPageBundle
from stratum_api.gemini_client import (
    create_interaction,
    extract_interaction_text,
    extract_json_object,
    extract_usage_tokens,
)

EventEmitter = Callable[[str, str, str, str | None, dict[str, Any] | None], None]

V0_SYSTEM_PROMPT = (
    "You are an evidence-backed hardware safety reconstruction engine. "
    "Reconstruct the physical assembly into JSON matching EngineeringSpec: "
    "{product_title, summary, unknowns:[], sources:[], parts:[{part_id, name, roles, layer, "
    "material, cad_ops:[{op, params, placement:{x,y,z,rx,ry,rz}}], parameters:[{name, value, "
    "unit, status, basis_type, source_ids, basis_note}]}]}. "
    "Key off part roles only (enclosure, heat_source, energy_storage, power_conversion, "
    "thermal_spreader, structural_frame, user_contact_surface, connector, magnetic, fastener). "
    "Every basis_type='source' parameter MUST cite retrieved source_ids. Never invent citations."
)


def build_retrieved_sources(run_id: str, bundle: FetchedPageBundle, interaction: Any) -> list[EvidenceSource]:
    """Build verified EvidenceSource list from fetched HTML, images, and Search grounding."""
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    excerpt = bundle.parsed.combined_text(max_chars=1200) or "Fetched product page"
    sources: list[EvidenceSource] = [
        EvidenceSource(
            source_id="src_page_html",
            kind=EvidenceKind.product_page,
            url=bundle.final_url,
            title=bundle.parsed.title or bundle.final_url,
            retrieved_at=now_iso,
            excerpt=excerpt[:1400],
        )
    ]
    for img in bundle.images:
        sources.append(
            EvidenceSource(
                source_id=img.source_id,
                kind=EvidenceKind.image,
                url=img.url,
                title=f"Image {img.source_id} ({img.width}x{img.height})",
                retrieved_at=now_iso,
                excerpt=f"Image sha256={img.sha256[:16]}",
                parent_source_id="src_page_html",
                image_uri=f"/api/runs/{run_id}/evidence/{img.source_id}/crop.png",
                crop_box=CropBox([0.0, 0.0, 1000.0, 1000.0]),
            )
        )
    idx = 1
    for step in getattr(interaction, "steps", None) or []:
        for block in getattr(step, "content", None) or []:
            for ann in getattr(block, "annotations", None) or []:
                url = getattr(ann, "url", None)
                if url and getattr(ann, "type", None) == "url_citation":
                    sid = f"src_search_{idx:02d}"
                    idx += 1
                    sources.append(
                        EvidenceSource(
                            source_id=sid,
                            kind=EvidenceKind.search_grounding,
                            url=str(url),
                            title=str(getattr(ann, "title", None) or url),
                            retrieved_at=now_iso,
                            excerpt=f"Grounded web source {url}"[:1400],
                        )
                    )
    return sources


def enforce_evidence_discipline(
    spec: EngineeringSpec, valid_source_ids: set[str], emit: EventEmitter
) -> EngineeringSpec:
    """Downgrade any basis_type=source parameter lacking retrieved source_ids."""
    for src in spec.sources:
        if src.crop_box is not None and len(src.crop_box.root) == 4:
            y0, x0, y1, x1 = (max(0.0, min(1000.0, float(v))) for v in src.crop_box.root)
            src.crop_box = CropBox([min(y0, y1), min(x0, x1), max(y0 + 1.0, y1), max(x0 + 1.0, x1)])
    for part in spec.parts:
        for param in part.parameters:
            kept = [sid for sid in param.source_ids if sid in valid_source_ids]
            param.source_ids = kept
            if param.basis_type == BasisType.source and not kept:
                param.basis_type = BasisType.model_prior
                if param.status in (ParameterStatus.OBSERVED, ParameterStatus.DOCUMENTED):
                    param.status = ParameterStatus.INFERRED
                param.basis_note = f"{param.basis_note} (downgraded: unverified source_id)".strip()
                emit("verify", "warn", "evidence_downgraded", part.part_id, {"parameter": param.name})
    return spec


def run_blind_deep_verify(
    spec: EngineeringSpec, config: AppConfig, client: Any, emit: EventEmitter, on_backoff: Any
) -> tuple[int, int]:
    """Run blind deep_verify sub-agent calls on INFERRED/ASSUMED parts."""
    candidates = [
        p
        for p in spec.parts
        if any(pr.status in (ParameterStatus.INFERRED, ParameterStatus.ASSUMED) for pr in p.parameters)
    ][: config.max_subagents]
    in_total, out_total = 0, 0
    for part in candidates:
        param_names = [f"{pr.name} ({pr.unit or ''})" for pr in part.parameters]
        prompt = (
            f"Independently estimate {param_names} for part '{part.name}' "
            f"with roles {[r.value for r in part.roles]} in '{spec.product_title}'. "
            'Return JSON: {"estimates": {"<param_name>": <float>}}'
        )
        try:
            inter = create_interaction(
                client,
                model=config.subagent_model,
                input=prompt,
                generation_config={"thinking_level": "low"},
                on_quota_backoff=on_backoff,
            )
            it, ot = extract_usage_tokens(inter)
            in_total += it
            out_total += ot
            est_map = extract_json_object(extract_interaction_text(inter)).get("estimates", {})
            _reconcile_part_estimates(spec, part, est_map, emit)
        except Exception as exc:  # noqa: BLE001
            emit("verify", "warn", f"deep_verify skipped: {exc}", part.part_id, {})
    return in_total, out_total


def _reconcile_part_estimates(
    spec: EngineeringSpec, part: Part, est_map: dict[str, Any], emit: EventEmitter
) -> None:
    """Compare blind sub-agent estimates against primary parameters."""
    if not isinstance(est_map, dict):
        return
    for param in part.parameters:
        if param.name not in est_map or not isinstance(param.value, (int, float)):
            continue
        try:
            est_val = float(est_map[param.name])
        except (TypeError, ValueError):
            continue
        rel_diff = abs(est_val - float(param.value)) / max(abs(float(param.value)), 1e-6)
        if rel_diff <= 0.20:
            param.basis_note = f"{param.basis_note} [blind_verify: corroborated]".strip()
        elif rel_diff > 0.25:
            spec.unknowns.append(f"{part.part_id}.{param.name}: primary={param.value} vs blind_verify={est_val}")
            emit("verify", "warn", "discrepancy_flagged", part.part_id, {"parameter": param.name, "verifier_value": est_val})
