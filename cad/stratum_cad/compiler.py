"""CAD compiler: builds solids, exports STEP/GLB, and runs geometric checks."""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from build123d import Compound, Solid, export_step, import_step

from stratum_cad.config import CONFIG
from stratum_cad.errors import CheckFailed, CompileFailed
from stratum_cad.logging_utils import log_event
from stratum_cad.ops import build_part_solid
from stratum_cad.types import CheckResult, CompileResult, Manifest, Part, PartManifestEntry


def _solid_to_yup_trimesh(solid: Solid) -> trimesh.Trimesh:
    """Tessellate a Z-up build123d Solid (mm) into a Y-up trimesh.Trimesh (mm)."""
    verts_raw, faces_raw = solid.tessellate(tolerance=0.1)
    verts_zup = np.array([[float(v.X), float(v.Y), float(v.Z)] for v in verts_raw], dtype=np.float64)
    verts_yup = np.column_stack((verts_zup[:, 0], verts_zup[:, 2], -verts_zup[:, 1]))
    return trimesh.Trimesh(vertices=verts_yup, faces=np.array(faces_raw, dtype=np.int64), process=False)


def _export_and_verify_glb(solids: list[tuple[Part, Solid]]) -> tuple[bytes, CheckResult]:
    """Export one GLB scene node per part named exactly part_id and verify round-trip."""
    scene = trimesh.Scene()
    for part, solid in solids:
        scene.add_geometry(_solid_to_yup_trimesh(solid), node_name=part.part_id, geom_name=part.part_id)
    raw_glb = scene.export(file_type="glb")
    glb_bytes = raw_glb if isinstance(raw_glb, bytes) else bytes(raw_glb)

    loaded = trimesh.load(trimesh.util.wrap_as_stream(glb_bytes), file_type="glb")
    node_names = set(loaded.graph.nodes) if isinstance(loaded, trimesh.Scene) else set()
    missing = [p.part_id for p, _ in solids if p.part_id not in node_names]
    passed = len(missing) == 0
    return glb_bytes, CheckResult(
        check_id="glb_nodes_match",
        passed=passed,
        part_ids=missing,
        details="All part_ids present in GLB (Y-up, mm)" if passed else f"Missing GLB nodes: {missing}. Ensure each part produces a non-empty mesh.",
    )


def _export_and_verify_step(solids: list[tuple[Part, Solid]]) -> tuple[bytes, CheckResult]:
    """Export assembly STEP, re-import, and verify part count and per-part volume within 1%."""
    assembly = Compound(label="assembly", children=[s for _, s in solids])
    with tempfile.TemporaryDirectory() as tmp_dir:
        step_path = Path(tmp_dir) / "assembly.step"
        export_step(assembly, str(step_path))
        step_bytes = step_path.read_bytes()
        reimported = import_step(str(step_path))

    imported_solids = list(reimported.solids())
    if len(imported_solids) != len(solids):
        return step_bytes, CheckResult(
            check_id="step_roundtrip",
            passed=False,
            part_ids=[p.part_id for p, _ in solids],
            details=f"STEP solid count mismatch: expected {len(solids)}, got {len(imported_solids)}. Avoid boolean cuts that split a part into disconnected solids.",
        )
    orig_vols = sorted(float(s.volume) for _, s in solids)
    imp_vols = sorted(float(s.volume) for s in imported_solids)
    max_rel_err = max(abs(v_i - v_o) / max(v_o, 1e-9) for v_o, v_i in zip(orig_vols, imp_vols, strict=True))
    passed = max_rel_err <= CONFIG.step_vol_tol_ratio
    return step_bytes, CheckResult(
        check_id="step_roundtrip",
        passed=passed,
        value=round(max_rel_err, 6),
        details=f"Max relative volume error {max_rel_err:.5f} (allowed range: [0.0, {CONFIG.step_vol_tol_ratio}])",
    )


def _check_pairwise_interference(solids: list[tuple[Part, Solid]]) -> CheckResult:
    """Compute pairwise solid overlap volume; warn (not fail) for declared nesting."""
    undeclared: list[str] = []
    declared: list[str] = []
    hints: list[str] = []
    max_overlap = 0.0
    bbs = [s.bounding_box() for _, s in solids]
    for i, (p_a, s_a) in enumerate(solids):
        bb_a = bbs[i]
        for j in range(i + 1, len(solids)):
            p_b, s_b, bb_b = solids[j][0], solids[j][1], bbs[j]
            ox = min(bb_a.max.X, bb_b.max.X) - max(bb_a.min.X, bb_b.min.X)
            oy = min(bb_a.max.Y, bb_b.max.Y) - max(bb_a.min.Y, bb_b.min.Y)
            oz = min(bb_a.max.Z, bb_b.max.Z) - max(bb_a.min.Z, bb_b.min.Z)
            if ox <= 1e-3 or oy <= 1e-3 or oz <= 1e-3:
                continue
            is_decl = p_a.nested_in in (p_b.part_id, "*") or p_b.nested_in in (p_a.part_id, "*")
            tag = f"{p_a.part_id}<->{p_b.part_id}"
            if is_decl:
                declared.append(tag)
                max_overlap = max(max_overlap, min(ox * oy * oz, float(s_a.volume), float(s_b.volume)))
                continue
            common = s_a.intersect(s_b)
            ov = sum(float(s.volume) for s in common.solids()) if common else 0.0
            if ov > 1e-3:
                max_overlap = max(max_overlap, ov)
                undeclared.append(tag)
                axis, shift = min(("x", ox), ("y", oy), ("z", oz), key=lambda t: t[1])
                hints.append(
                    f"{tag} overlap={ov:.2f} mm3 (allowed: 0.0 mm3): shift '{p_b.part_id}' placement.{axis} by >= {shift:.2f} mm "
                    f"(clearance >= 0.0 mm) or set nested_in='{p_a.part_id}'"
                )
    if undeclared:
        return CheckResult(
            check_id="pairwise_interference",
            passed=False,
            part_ids=undeclared,
            value=round(max_overlap, 4),
            details="Undeclared solid interference: " + "; ".join(hints),
        )
    return CheckResult(
        check_id="pairwise_interference",
        passed=True,
        severity="warn" if declared else "info",
        part_ids=declared,
        value=round(max_overlap, 4),
        details=f"Declared nesting overlaps: {declared}" if declared else "No interference",
    )


def compile_parts(parts: list[Part], *, run_id: str = "widget-a", revision: int = 0) -> CompileResult:
    """Compile a list of Part definitions into STEP bytes, GLB bytes, and a checked Manifest."""
    if not parts:
        raise CompileFailed(
            "Cannot compile empty parts list (got 0 parts, allowed: >= 1).",
            recovery_hint="Provide at least one Part in parts list (allowed part count: >= 1).",
        )
    from stratum_cad.adapters import adapt_parts

    internal_parts = adapt_parts(parts)
    solids: list[tuple[Part, Solid]] = []
    manifest_parts: list[PartManifestEntry] = []
    invalid_ids: list[str] = []
    zero_vol_ids: list[str] = []

    for part in internal_parts:
        solid, min_wall_mm, vent_area_mm2 = build_part_solid(part)
        vol, area = float(solid.volume), float(solid.area)
        if not solid.is_valid:
            invalid_ids.append(part.part_id)
        if vol <= 0.0:
            zero_vol_ids.append(part.part_id)
        bb, c = solid.bounding_box(), solid.center()
        manifest_parts.append(
            PartManifestEntry(
                part_id=part.part_id,
                role=part.role,
                material=part.material,
                volume_mm3=round(vol, 4),
                surface_area_mm2=round(area, 4),
                bbox_min_mm=(round(float(bb.min.X), 4), round(float(bb.min.Y), 4), round(float(bb.min.Z), 4)),
                bbox_max_mm=(round(float(bb.max.X), 4), round(float(bb.max.Y), 4), round(float(bb.max.Z), 4)),
                centroid_mm=(round(float(c.X), 4), round(float(c.Y), 4), round(float(c.Z), 4)),
                min_wall_mm=min_wall_mm,
                vent_open_area_mm2=round(vent_area_mm2, 4),
                nested_in=part.nested_in,
            )
        )
        solids.append((part, solid))

    step_bytes, step_check = _export_and_verify_step(solids)
    glb_bytes, glb_check = _export_and_verify_glb(solids)
    checks: dict[str, CheckResult] = {
        "valid_solid": CheckResult(
            check_id="valid_solid",
            passed=not invalid_ids,
            part_ids=invalid_ids,
            details=f"Invalid solids: {invalid_ids}. Ensure cuts do not self-intersect." if invalid_ids else "All solids valid",
        ),
        "nonzero_volume": CheckResult(
            check_id="nonzero_volume",
            passed=not zero_vol_ids,
            part_ids=zero_vol_ids,
            details=f"Zero-volume parts: {zero_vol_ids} (allowed volume: > 0.0 mm3). Reduce cut_box/cut_cylinder dimensions." if zero_vol_ids else "All volumes > 0",
        ),
        "step_roundtrip": step_check,
        "glb_nodes_match": glb_check,
        "pairwise_interference": _check_pairwise_interference(solids),
    }
    failed = [cid for cid, chk in checks.items() if not chk.passed]
    if failed:
        detail_msgs = "; ".join(f"{cid}: {checks[cid].details}" for cid in failed)
        raise CheckFailed(
            f"CAD verification checks failed ({failed}): {detail_msgs}",
            recovery_hint=detail_msgs,
            part_id=checks[failed[0]].part_ids[0] if checks[failed[0]].part_ids else None,
        )
    manifest = Manifest(
        parts=manifest_parts,
        checks=checks,
        step_sha256=hashlib.sha256(step_bytes).hexdigest(),
        glb_sha256=hashlib.sha256(glb_bytes).hexdigest(),
        run_id=run_id,
        revision=revision,
    )
    log_event("compile_parts_ok", run_id=run_id, stage="compile", part_count=len(parts))
    return CompileResult(step_bytes=step_bytes, glb_bytes=glb_bytes, manifest=manifest)

