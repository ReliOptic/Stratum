"""Shared lumped-RC thermal network builder and stress-scenario generator."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from stratum_cad.materials import get_material_props
from stratum_cad.types import (
    BasisType,
    EngineeringSpec,
    EvidenceStatus,
    Manifest,
    Part,
    PartManifestEntry,
    PartRole,
)


@dataclass(frozen=True)
class RCNode:
    """Single thermal node corresponding to a physical part."""

    node_index: int
    part_id: str
    role: PartRole
    material: str
    mass_g: float
    cp_j_gk: float
    c_j_k: float
    g_amb_w_k: float
    base_power_w: float
    status: EvidenceStatus
    basis_type: BasisType


@dataclass(frozen=True)
class RCEdge:
    """Thermal conductance link between two part nodes."""

    node_a: str
    node_b: str
    g_w_k: float
    gap_mm: float
    contact_area_mm2: float
    status: EvidenceStatus = "INFERRED"
    basis_type: BasisType = "physics"


@dataclass(frozen=True)
class RCNetwork:
    """Complete lumped-RC thermal network for a revision."""

    run_id: str
    revision: int
    ambient_c: float
    nodes: list[RCNode]
    edges: list[RCEdge]
    c_vec: np.ndarray
    l_mat: np.ndarray


def bbox_gap_and_overlap_area(
    a: PartManifestEntry,
    b: PartManifestEntry,
) -> tuple[float, float, float]:
    """Return (gap_mm, effective_area_mm2, char_thickness_mm) between two part bounding boxes."""
    gaps: list[float] = []
    overlaps: list[float] = []
    spans: list[float] = []
    for axis in range(3):
        lo_a, hi_a = a.bbox_min_mm[axis], a.bbox_max_mm[axis]
        lo_b, hi_b = b.bbox_min_mm[axis], b.bbox_max_mm[axis]
        sep = max(0.0, max(lo_a - hi_b, lo_b - hi_a))
        ov = max(0.0, min(hi_a, hi_b) - max(lo_a, lo_b))
        gaps.append(sep)
        overlaps.append(ov)
        spans.append(0.5 * ((hi_a - lo_a) + (hi_b - lo_b)))
    gap_mm = float(np.sqrt(sum(g * g for g in gaps)))
    sorted_ov = sorted(overlaps, reverse=True)
    area_mm2 = max(sorted_ov[0] * sorted_ov[1], 4.0)
    thickness_mm = max(min(spans), 1.0)
    return gap_mm, area_mm2, thickness_mm


def build_rc_network(spec: EngineeringSpec, manifest: Manifest) -> RCNetwork:
    """Construct the deterministic lumped-RC network from EngineeringSpec and Manifest."""
    part_by_id: dict[str, Part] = {p.part_id: p for p in spec.parts}
    mp_by_id: dict[str, PartManifestEntry] = {mp.part_id: mp for mp in manifest.parts}
    nodes: list[RCNode] = []
    for idx, part in enumerate(spec.parts):
        mp = mp_by_id.get(part.part_id)
        mat = get_material_props(part.material)
        vol_mm3 = mp.volume_mm3 if mp is not None else 1000.0
        area_mm2 = mp.surface_area_mm2 if mp is not None else 600.0
        mass_g = max(vol_mm3 * mat.density_g_mm3, 0.01)
        c_j_k = max(mass_g * mat.cp_j_gk, 1e-3)
        g_amb = max(spec.convection_h_w_m2k * (area_mm2 * 1e-6), 1e-5)
        status: EvidenceStatus = (
            "ASSUMED" if (mat.status == "ASSUMED" or part.power_status == "ASSUMED") else "DOCUMENTED"
        )
        nodes.append(
            RCNode(
                node_index=idx,
                part_id=part.part_id,
                role=part.role,
                material=part.material,
                mass_g=round(mass_g, 4),
                cp_j_gk=mat.cp_j_gk,
                c_j_k=c_j_k,
                g_amb_w_k=g_amb,
                base_power_w=part.power_w,
                status=status,
                basis_type=mat.basis_type,
            )
        )

    n = len(nodes)
    l_mat = np.zeros((n, n), dtype=np.float64)
    c_vec = np.array([nd.c_j_k for nd in nodes], dtype=np.float64)
    for i, nd in enumerate(nodes):
        l_mat[i, i] += nd.g_amb_w_k

    edges: list[RCEdge] = []
    for i in range(n):
        for j in range(i + 1, n):
            pa = mp_by_id.get(nodes[i].part_id)
            pb = mp_by_id.get(nodes[j].part_id)
            if pa is None or pb is None:
                continue
            gap_mm, area_mm2, thick_mm = bbox_gap_and_overlap_area(pa, pb)
            if gap_mm > spec.contact_gap_cutoff_mm:
                continue
            mat_a = get_material_props(part_by_id[nodes[i].part_id].material)
            mat_b = get_material_props(part_by_id[nodes[j].part_id].material)
            k_harm = 2.0 * mat_a.k_w_mk * mat_b.k_w_mk / max(mat_a.k_w_mk + mat_b.k_w_mk, 1e-6)
            eff_len_m = (thick_mm + 20.0 * gap_mm) * 1e-3
            g_ij = float((area_mm2 * 1e-6) * k_harm / max(eff_len_m, 1e-5))
            l_mat[i, i] += g_ij
            l_mat[j, j] += g_ij
            l_mat[i, j] -= g_ij
            l_mat[j, i] -= g_ij
            edges.append(
                RCEdge(
                    node_a=nodes[i].part_id,
                    node_b=nodes[j].part_id,
                    g_w_k=round(g_ij, 6),
                    gap_mm=round(gap_mm, 4),
                    contact_area_mm2=round(area_mm2, 4),
                )
            )
    return RCNetwork(
        run_id=spec.run_id,
        revision=spec.revision,
        ambient_c=spec.ambient_c,
        nodes=nodes,
        edges=edges,
        c_vec=c_vec,
        l_mat=l_mat,
    )


def generate_stress_scenario(
    spec: EngineeringSpec,
) -> tuple[np.ndarray, np.ndarray]:
    """Generate time vector t_s (steps,) and power matrix q_w (steps, n_parts)."""
    dt = max(spec.dt_s, 1e-3)
    steps = int(round(spec.duration_s / dt)) + 1
    times_s = np.linspace(0.0, spec.duration_s, steps, dtype=np.float64)
    n_parts = len(spec.parts)
    q_mat = np.zeros((steps, n_parts), dtype=np.float64)
    for idx, part in enumerate(spec.parts):
        q_mat[:, idx] = float(part.power_w)
    for pulse in spec.pulses:
        mask = (times_s >= pulse.start_s) & (times_s <= pulse.end_s)
        q_mat[mask, :] *= pulse.multiplier
    return times_s, q_mat
