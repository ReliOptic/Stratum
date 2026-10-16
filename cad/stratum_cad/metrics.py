"""Deterministic role-based engineering metrics catalog and computation."""

from __future__ import annotations

import math

from typing import Any

from stratum_cad.adapters import adapt_manifest, adapt_spec
from stratum_cad.logging_utils import log_event
from stratum_cad.materials import get_material_props
from stratum_cad.rc_network import bbox_gap_and_overlap_area
from stratum_cad.simulator import simulate
from stratum_cad.types import (
    EngineeringSpec,
    EvidenceStatus,
    Manifest,
    MetricDef,
    MetricSet,
    MetricValue,
    PartManifestEntry,
)

METRIC_CATALOG: tuple[MetricDef, ...] = (
    MetricDef("min_gap_heat_to_storage_mm", "Minimum Gap: Heat Source to Energy Storage", "mm", ["heat_source", "energy_storage"],
              "Minimum 3D bounding-box clearance between any heat_source and energy_storage part; increase separation to reduce thermal coupling."),
    MetricDef("min_enclosure_wall_mm", "Minimum Enclosure Wall Thickness", "mm", ["enclosure"],
              "Smallest shell wall_mm or thin dimension across enclosure parts (>= 0.2 mm); increase for structural stiffness."),
    MetricDef("heat_path_to_exterior_mm", "Shortest Heat Source Path to Exterior", "mm", ["heat_source", "enclosure"],
              "Shortest face-to-face distance from a heat_source bounding box to the outer enclosure boundary."),
    MetricDef("spreader_coverage_ratio", "Thermal Spreader Area Coverage Ratio", "ratio", ["heat_source", "thermal_spreader"],
              "Ratio of thermal_spreader XY footprint area to heat_source XY footprint area; increase spreader dx_mm/dy_mm to improve heat spreading."),
    MetricDef("vent_open_area_mm2", "Enclosure Vent Open Area", "mm2", ["enclosure"],
              "Total cross-sectional area of cut_box and cut_cylinder openings on enclosure parts; add cuts to increase convective cooling."),
    MetricDef("assembly_mass_g", "Total Assembly Mass", "g", [],
              "Sum of part volume_mm3 * material density_g_mm3 across all compiled solids."),
    MetricDef("assembly_envelope_mm", "Assembly Bounding Envelope (X, Y, Z)", "mm", [],
              "Overall assembly [dx, dy, dz] bounding envelope in mm (contract scalar value uses max span)."),
    MetricDef("peak_storage_temp_rise_C", "Peak Energy Storage Temperature Rise", "C", ["energy_storage"],
              "Maximum temperature rise above ambient (C) across energy_storage nodes in the lumped-RC backward-Euler thermal simulation."),
)


def metric_catalog() -> list[MetricDef]:
    """Return the deterministic catalog of engineering metrics."""
    return list(METRIC_CATALOG)


def _na(metric_id: str, unit: str) -> MetricValue:
    """Construct a not_applicable MetricValue when required roles are absent."""
    return MetricValue(metric_id=metric_id, value=None, unit=unit, part_ids=[], not_applicable=True)


def _compute_role_geometry_metrics(by_role: dict[str, list[PartManifestEntry]]) -> dict[str, MetricValue]:
    """Compute geometric role-based metrics (gaps, wall, heat path, spreader, vents)."""
    out: dict[str, MetricValue] = {}
    heats = by_role.get("heat_source", [])
    storages = by_role.get("energy_storage", [])
    enclosures = by_role.get("enclosure", [])
    spreaders = by_role.get("thermal_spreader", [])

    if heats and storages:
        best_gap, best_pair = math.inf, []
        for h in heats:
            for s in storages:
                gap, _, _ = bbox_gap_and_overlap_area(h, s)
                if gap < best_gap:
                    best_gap, best_pair = gap, [h.part_id, s.part_id]
        out["min_gap_heat_to_storage_mm"] = MetricValue("min_gap_heat_to_storage_mm", round(best_gap, 4), "mm", best_pair)
    else:
        out["min_gap_heat_to_storage_mm"] = _na("min_gap_heat_to_storage_mm", "mm")

    if enclosures:
        walls = [
            (
                enc.min_wall_mm if enc.min_wall_mm is not None else min(enc.bbox_max_mm[i] - enc.bbox_min_mm[i] for i in range(3)),
                enc.part_id,
            )
            for enc in enclosures
        ]
        min_w, pid = min(walls, key=lambda item: item[0])
        out["min_enclosure_wall_mm"] = MetricValue("min_enclosure_wall_mm", round(min_w, 4), "mm", [pid])
        vent_sum = sum(enc.vent_open_area_mm2 for enc in enclosures)
        out["vent_open_area_mm2"] = MetricValue(
            "vent_open_area_mm2", round(vent_sum, 4), "mm2", [enc.part_id for enc in enclosures]
        )
    else:
        out["min_enclosure_wall_mm"] = _na("min_enclosure_wall_mm", "mm")
        out["vent_open_area_mm2"] = _na("vent_open_area_mm2", "mm2")

    if heats and enclosures:
        best_dist, pair_ids = math.inf, []
        for h in heats:
            for enc in enclosures:
                dists = [abs(enc.bbox_max_mm[i] - h.bbox_max_mm[i]) for i in range(3)] + [
                    abs(h.bbox_min_mm[i] - enc.bbox_min_mm[i]) for i in range(3)
                ]
                if min(dists) < best_dist:
                    best_dist, pair_ids = min(dists), [h.part_id, enc.part_id]
        out["heat_path_to_exterior_mm"] = MetricValue("heat_path_to_exterior_mm", round(best_dist, 4), "mm", pair_ids)
    else:
        out["heat_path_to_exterior_mm"] = _na("heat_path_to_exterior_mm", "mm")

    if heats and spreaders:
        h_area = sum((h.bbox_max_mm[0] - h.bbox_min_mm[0]) * (h.bbox_max_mm[1] - h.bbox_min_mm[1]) for h in heats)
        s_area = sum((s.bbox_max_mm[0] - s.bbox_min_mm[0]) * (s.bbox_max_mm[1] - s.bbox_min_mm[1]) for s in spreaders)
        out["spreader_coverage_ratio"] = MetricValue(
            "spreader_coverage_ratio",
            round(s_area / max(h_area, 1e-6), 4),
            "ratio",
            [p.part_id for p in heats + spreaders],
        )
    else:
        out["spreader_coverage_ratio"] = _na("spreader_coverage_ratio", "ratio")
    return out


def compute_metrics(spec: EngineeringSpec | Any, manifest: Manifest | Any) -> MetricSet:
    """Compute all 8 deterministic engineering metrics for an assembly."""
    spec = adapt_spec(spec)
    manifest = adapt_manifest(manifest, spec)
    by_role: dict[str, list[PartManifestEntry]] = {}
    for mp in manifest.parts:
        by_role.setdefault(mp.role, []).append(mp)

    metrics = _compute_role_geometry_metrics(by_role)
    total_mass_g = 0.0
    mass_status: EvidenceStatus = "DOCUMENTED"
    all_pids = [mp.part_id for mp in manifest.parts]
    for mp in manifest.parts:
        mat = get_material_props(mp.material)
        if mat.status == "ASSUMED":
            mass_status = "ASSUMED"
        total_mass_g += mp.volume_mm3 * mat.density_g_mm3
    metrics["assembly_mass_g"] = MetricValue(
        metric_id="assembly_mass_g",
        value=round(total_mass_g, 4),
        unit="g",
        part_ids=all_pids,
        status=mass_status,
        basis_type="model_prior" if mass_status == "ASSUMED" else "physics",
    )

    if manifest.parts:
        envelope = [
            round(max(mp.bbox_max_mm[i] for mp in manifest.parts) - min(mp.bbox_min_mm[i] for mp in manifest.parts), 4)
            for i in range(3)
        ]
        metrics["assembly_envelope_mm"] = MetricValue("assembly_envelope_mm", envelope, "mm", all_pids)
    else:
        metrics["assembly_envelope_mm"] = _na("assembly_envelope_mm", "mm")

    sim_res = simulate(spec, manifest)
    if sim_res.peak_storage_temp_rise_c is not None:
        metrics["peak_storage_temp_rise_C"] = MetricValue(
            "peak_storage_temp_rise_C", sim_res.peak_storage_temp_rise_c, "C", sim_res.storage_node_ids
        )
    else:
        metrics["peak_storage_temp_rise_C"] = _na("peak_storage_temp_rise_C", "C")

    log_event("compute_metrics_ok", run_id=spec.run_id, stage="metrics", revision=spec.revision)
    return MetricSet(metrics=metrics, run_id=spec.run_id, revision=spec.revision)
