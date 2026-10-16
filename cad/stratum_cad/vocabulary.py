"""LLM-facing product-agnostic CAD operation vocabulary and metric catalog specification."""

from __future__ import annotations

from stratum_cad.config import CONFIG
from stratum_cad.metrics import metric_catalog
from stratum_cad.types import VALID_PART_ROLES


def _op_specs_text() -> str:
    """Return the compact specification of all supported CAD operations."""
    lo, hi, w_lo = CONFIG.min_dim_mm, CONFIG.max_dim_mm, CONFIG.min_wall_mm
    return (
        "=== STRATUM DETERMINISTIC CAD VOCABULARY (Z-up CAD frame, exported Y-up GLB, units: mm / deg) ===\n"
        f"Part roles (select 1+): {', '.join(sorted(VALID_PART_ROLES))}\n"
        f"Linear dimension bounds: [{lo}, {hi}] mm | Minimum shell wall thickness: {w_lo} mm\n"
        "Rule 1: Every part's cad_ops list MUST start with a primitive ('box', 'rounded_box', 'cylinder', 'sphere').\n"
        "Rule 2: Modifiers ('shell', 'cut_box', 'cut_cylinder') apply sequentially to the current part solid.\n"
        "Rule 3: All contract CadOp.params values MUST be numeric floats (mm).\n\n"
        "1. box (primitive)\n"
        f"   Fields: dx_mm (aliases: x_mm, length_mm), dy_mm (y_mm, width_mm), dz_mm (z_mm, height_mm) in [{lo}, {hi}] mm\n"
        "   Placement: x, y, z (center in mm), rx, ry, rz (Euler angles in deg)\n"
        '   Example 1: {"op":"box","params":{"dx_mm":40.0,"dy_mm":30.0,"dz_mm":4.0},"placement":{"x":0,"y":0,"z":0,"rx":0,"ry":0,"rz":0}}\n'
        '   Example 2: {"op":"box","params":{"dx_mm":12.0,"dy_mm":12.0,"dz_mm":2.5},"placement":{"x":5,"y":0,"z":3,"rx":0,"ry":0,"rz":0}}\n'
        f"   Common failures: Dimension 'dx_mm'=0.05 mm out of range [{lo}, {hi}] mm; Missing required dimension parameter.\n\n"
        "2. rounded_box (primitive)\n"
        f"   Fields: dx_mm, dy_mm, dz_mm in [{lo}, {hi}] mm; optional fillet_mm (alias: radius_mm) in [0.0, 0.45*min(dx_mm,dy_mm)] mm\n"
        '   Example 1: {"op":"rounded_box","params":{"dx_mm":80.0,"dy_mm":50.0,"dz_mm":14.0,"fillet_mm":3.0},"placement":{"x":0,"y":0,"z":0,"rx":0,"ry":0,"rz":0}}\n'
        '   Example 2: {"op":"rounded_box","params":{"dx_mm":60.0,"dy_mm":40.0,"dz_mm":1.2,"fillet_mm":2.0},"placement":{"x":0,"y":0,"z":-6,"rx":0,"ry":0,"rz":0}}\n'
        f"   Common failures: Dimension out of range [{lo}, {hi}] mm; fillet_mm negative.\n\n"
        "3. cylinder (primitive)\n"
        f"   Fields: radius_mm (alias: r_mm), height_mm (aliases: h_mm, z_mm) in [{lo}, {hi}] mm\n"
        '   Example 1: {"op":"cylinder","params":{"radius_mm":15.0,"height_mm":1.5},"placement":{"x":0,"y":0,"z":2,"rx":0,"ry":0,"rz":0}}\n'
        '   Example 2: {"op":"cylinder","params":{"radius_mm":3.0,"height_mm":10.0},"placement":{"x":-20,"y":10,"z":0,"rx":0,"ry":0,"rz":0}}\n'
        f"   Common failures: Dimension 'radius_mm' out of range [{lo}, {hi}] mm; Missing 'height_mm'.\n\n"
        "4. sphere (primitive)\n"
        f"   Fields: radius_mm (alias: r_mm) in [{lo}, {hi}] mm\n"
        '   Example 1: {"op":"sphere","params":{"radius_mm":4.0},"placement":{"x":0,"y":0,"z":0,"rx":0,"ry":0,"rz":0}}\n'
        '   Example 2: {"op":"sphere","params":{"radius_mm":1.5},"placement":{"x":10,"y":-10,"z":2,"rx":0,"ry":0,"rz":0}}\n'
        f"   Common failures: Dimension 'radius_mm' out of range [{lo}, {hi}] mm.\n\n"
        "5. shell (modifier - hollows preceding solid; sets min_enclosure_wall_mm on 'enclosure' parts)\n"
        f"   Fields: wall_mm (alias: thickness_mm) in [{w_lo}, 0.5*min(dx,dy,dz)-0.1] mm; optional open_face (1.0 for +Z top opening, 0.0 for closed cavity)\n"
        '   Example 1: {"op":"shell","params":{"wall_mm":1.2},"placement":{"x":0,"y":0,"z":0,"rx":0,"ry":0,"rz":0}}\n'
        '   Example 2: {"op":"shell","params":{"wall_mm":0.8,"open_face":1.0},"placement":{"x":0,"y":0,"z":0,"rx":0,"ry":0,"rz":0}}\n'
        f"   Common failures: Shell wall < {w_lo} mm; Modifier 'shell' cannot be the first operation; wall_mm >= 0.5*min_dim annihilates inner cavity.\n\n"
        "6. cut_box (modifier - boolean subtraction; adds cross-section to vent_open_area_mm2 on 'enclosure' parts)\n"
        f"   Fields: dx_mm, dy_mm, dz_mm in [{lo}, {hi}] mm; optional local offset cx_mm, cy_mm, cz_mm (or set via placement x, y, z)\n"
        '   Example 1: {"op":"cut_box","params":{"dx_mm":12.0,"dy_mm":2.0,"dz_mm":4.0,"cx_mm":0.0,"cy_mm":24.0,"cz_mm":0.0},"placement":{"x":0,"y":24,"z":0,"rx":0,"ry":0,"rz":0}}\n'
        '   Example 2: {"op":"cut_box","params":{"dx_mm":6.0,"dy_mm":6.0,"dz_mm":3.0},"placement":{"x":15,"y":0,"z":6,"rx":0,"ry":0,"rz":0}}\n'
        "   Common failures: Modifier 'cut_box' cannot be the first operation; cut box completely removes parent solid leaving 0 volume.\n\n"
        "7. cut_cylinder (modifier - cylindrical subtraction; adds pi*radius_mm^2 to vent_open_area_mm2 on 'enclosure' parts)\n"
        f"   Fields: radius_mm, height_mm in [{lo}, {hi}] mm; optional cx_mm, cy_mm, cz_mm; optional axis (0.0=X, 1.0=Y, 2.0=Z)\n"
        '   Example 1: {"op":"cut_cylinder","params":{"radius_mm":2.0,"height_mm":6.0,"axis":2.0},"placement":{"x":10,"y":10,"z":6,"rx":0,"ry":0,"rz":0}}\n'
        '   Example 2: {"op":"cut_cylinder","params":{"radius_mm":1.5,"height_mm":8.0,"axis":0.0},"placement":{"x":39,"y":0,"z":0,"rx":0,"ry":90,"rz":0}}\n'
        "   Common failures: Modifier 'cut_cylinder' cannot be the first operation; cut removes entire solid.\n"
    )


def _metric_specs_text() -> str:
    """Return the compact specification of all deterministic engineering metrics."""
    lines = ["\n=== STRATUM DETERMINISTIC METRIC CATALOG ==="]
    for m in metric_catalog():
        roles_str = ", ".join(m.required_roles) if m.required_roles else "any"
        lines.append(
            f"- {m.metric_id} [{m.unit}] (roles: {roles_str}): {m.title} — {m.description}"
        )
    return "\n".join(lines) + "\n"


def vocabulary() -> str:
    """Return compact product-agnostic LLM reference for all CadOps and deterministic metrics."""
    return _op_specs_text() + _metric_specs_text()
