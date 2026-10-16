"""Deterministic CAD operation validator and build123d solid builder."""

from __future__ import annotations

import math

from build123d import Axis, Box, Cylinder, Location, Rotation, Solid, Sphere, offset

from stratum_cad.config import CONFIG
from stratum_cad.errors import CadOpInvalid, CompileFailed
from stratum_cad.types import CadOp, Part, VALID_PART_ROLES

ALLOWED_OPS: frozenset[str] = frozenset(
    {"box", "cylinder", "sphere", "shell", "cut_box", "cut_cylinder"}
)


def _get_dim(
    params: dict[str, float | str],
    keys: tuple[str, ...],
    part_id: str,
    op_index: int,
) -> float:
    """Extract and validate a linear dimension parameter in [0.1, 2000.0] mm."""
    for key in keys:
        if key in params:
            val = float(params[key])
            if not (CONFIG.min_dim_mm <= val <= CONFIG.max_dim_mm):
                raise CadOpInvalid(
                    f"Dimension '{key}'={val} mm out of range "
                    f"[{CONFIG.min_dim_mm}, {CONFIG.max_dim_mm}] mm.",
                    recovery_hint=(
                        f"Set '{key}' between {CONFIG.min_dim_mm} and "
                        f"{CONFIG.max_dim_mm} mm."
                    ),
                    part_id=part_id,
                    op_index=op_index,
                )
            return val
    raise CadOpInvalid(
        f"Missing required dimension parameter (one of {keys}).",
        recovery_hint=f"Provide parameter '{keys[0]}' in mm.",
        part_id=part_id,
        op_index=op_index,
    )


def validate_part_ops(part: Part) -> tuple[float | None, float]:
    """Validate all ops on a part and return (min_wall_mm, vent_open_area_mm2)."""
    if part.role not in VALID_PART_ROLES:
        raise CadOpInvalid(
            f"Unknown part role '{part.role}'.",
            recovery_hint=f"Use one of {sorted(VALID_PART_ROLES)}.",
            part_id=part.part_id,
            op_index=0,
        )
    if not part.ops:
        raise CadOpInvalid(
            "Part must have at least one primitive CadOp.",
            recovery_hint="Start part.ops with 'box', 'cylinder', or 'sphere'.",
            part_id=part.part_id,
            op_index=0,
        )
    min_wall_mm: float | None = None
    vent_area_mm2 = 0.0
    for idx, cad_op in enumerate(part.ops):
        if cad_op.op not in ALLOWED_OPS:
            raise CadOpInvalid(
                f"Unknown CAD operation '{cad_op.op}'.",
                recovery_hint=f"Use only supported operations: {sorted(ALLOWED_OPS)}.",
                part_id=part.part_id,
                op_index=idx,
            )
        p = cad_op.params
        if cad_op.op in {"box", "cut_box"}:
            dx = _get_dim(p, ("x_mm", "length_mm", "dx_mm"), part.part_id, idx)
            dy = _get_dim(p, ("y_mm", "width_mm", "dy_mm"), part.part_id, idx)
            dz = _get_dim(p, ("z_mm", "height_mm", "dz_mm"), part.part_id, idx)
            if cad_op.op == "cut_box":
                dims = sorted((dx, dy, dz))
                vent_area_mm2 += dims[1] * dims[2]
        elif cad_op.op in {"cylinder", "cut_cylinder"}:
            r = _get_dim(p, ("radius_mm", "r_mm"), part.part_id, idx)
            _get_dim(p, ("height_mm", "h_mm", "z_mm"), part.part_id, idx)
            if cad_op.op == "cut_cylinder":
                vent_area_mm2 += math.pi * r * r
        elif cad_op.op == "sphere":
            _get_dim(p, ("radius_mm", "r_mm"), part.part_id, idx)
        elif cad_op.op == "shell":
            w = _get_dim(p, ("wall_mm", "thickness_mm"), part.part_id, idx)
            if w < CONFIG.min_wall_mm:
                raise CadOpInvalid(
                    f"Shell wall {w} mm is below minimum {CONFIG.min_wall_mm} mm.",
                    recovery_hint=f"Increase wall_mm to at least {CONFIG.min_wall_mm} mm.",
                    part_id=part.part_id,
                    op_index=idx,
                )
            min_wall_mm = w if min_wall_mm is None else min(min_wall_mm, w)
    return min_wall_mm, vent_area_mm2


def _apply_op(current: Solid | None, cad_op: CadOp, part_id: str, idx: int) -> Solid:
    """Apply a single validated CadOp to the current solid."""
    p = cad_op.params
    if cad_op.op == "box":
        dx = _get_dim(p, ("x_mm", "length_mm", "dx_mm"), part_id, idx)
        dy = _get_dim(p, ("y_mm", "width_mm", "dy_mm"), part_id, idx)
        dz = _get_dim(p, ("z_mm", "height_mm", "dz_mm"), part_id, idx)
        prim = Box(dx, dy, dz)
        return prim if current is None else (current + prim).solids()[0]
    if cad_op.op == "cylinder":
        r = _get_dim(p, ("radius_mm", "r_mm"), part_id, idx)
        h = _get_dim(p, ("height_mm", "h_mm", "z_mm"), part_id, idx)
        prim = Cylinder(r, h)
        return prim if current is None else (current + prim).solids()[0]
    if cad_op.op == "sphere":
        r = _get_dim(p, ("radius_mm", "r_mm"), part_id, idx)
        prim = Sphere(r)
        return prim if current is None else (current + prim).solids()[0]
    if current is None:
        raise CadOpInvalid(
            f"Modifier '{cad_op.op}' cannot be the first operation.",
            recovery_hint="Start with a primitive operation before modifiers.",
            part_id=part_id,
            op_index=idx,
        )
    if cad_op.op == "shell":
        w = _get_dim(p, ("wall_mm", "thickness_mm"), part_id, idx)
        open_face = str(p.get("open_face", "none")).lower()
        if open_face == "top":
            top_face = current.faces().sort_by(Axis.Z)[-1]
            shelled = offset(current, amount=-w, openings=[top_face])
        else:
            inner = offset(current, amount=-w)
            shelled = current - inner
        return shelled.solids()[0]
    if cad_op.op == "cut_box":
        dx = _get_dim(p, ("x_mm", "length_mm", "dx_mm"), part_id, idx)
        dy = _get_dim(p, ("y_mm", "width_mm", "dy_mm"), part_id, idx)
        dz = _get_dim(p, ("z_mm", "height_mm", "dz_mm"), part_id, idx)
        cx, cy, cz = float(p.get("cx_mm", 0.0)), float(p.get("cy_mm", 0.0)), float(p.get("cz_mm", 0.0))
        cutter = Location((cx, cy, cz)) * Box(dx, dy, dz)
        return (current - cutter).solids()[0]
    r = _get_dim(p, ("radius_mm", "r_mm"), part_id, idx)
    h = _get_dim(p, ("height_mm", "h_mm", "z_mm"), part_id, idx)
    cx, cy, cz = float(p.get("cx_mm", 0.0)), float(p.get("cy_mm", 0.0)), float(p.get("cz_mm", 0.0))
    axis = str(p.get("axis", "z")).lower()
    rot = Rotation(0, 90, 0) if axis == "x" else (Rotation(90, 0, 0) if axis == "y" else Rotation(0, 0, 0))
    cutter = Location((cx, cy, cz)) * rot * Cylinder(r, h)
    return (current - cutter).solids()[0]


def build_part_solid(part: Part) -> tuple[Solid, float | None, float]:
    """Build and place a part's solid geometry, returning (solid, min_wall_mm, vent_area_mm2)."""
    min_wall_mm, vent_area_mm2 = validate_part_ops(part)
    current: Solid | None = None
    for idx, cad_op in enumerate(part.ops):
        try:
            current = _apply_op(current, cad_op, part.part_id, idx)
        except CadOpInvalid:
            raise
        except Exception as exc:
            raise CompileFailed(
                f"Failed to execute op '{cad_op.op}' on part '{part.part_id}': {exc}",
                recovery_hint="Ensure cut/shell dimensions do not annihilate the solid.",
                part_id=part.part_id,
                op_index=idx,
            ) from exc
    if current is None:
        raise CompileFailed(
            f"Part '{part.part_id}' produced no solid.",
            recovery_hint="Check primitive operations.",
            part_id=part.part_id,
            op_index=0,
        )
    pl = part.placement
    placed = (
        Location((pl.x_mm, pl.y_mm, pl.z_mm))
        * Rotation(pl.rx_deg, pl.ry_deg, pl.rz_deg)
        * current
    )
    placed_solid = placed if isinstance(placed, Solid) else placed.solids()[0]
    placed_solid.label = part.part_id
    return placed_solid, min_wall_mm, vent_area_mm2
