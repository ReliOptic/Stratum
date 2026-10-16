"""Smoke tests for stratum_cad: 10 mm box build and STEP export."""

from __future__ import annotations

import stratum_cad
from stratum_cad import (
    CadOp,
    CadOpInvalid,
    Part,
    build_smoke_box_step,
    compile_parts,
    metric_catalog,
)


def test_smoke_box_10mm_exports_step() -> None:
    """Build a deterministic 10 mm box and verify valid STEP export bytes."""
    step_bytes = build_smoke_box_step(size_mm=10.0, run_id="widget-a-smoke")
    assert len(step_bytes) > 200
    text = step_bytes.decode("utf-8", errors="ignore")
    assert "ISO-10303-21;" in text
    assert "END-ISO-10303-21;" in text


def test_compile_single_10mm_box_part() -> None:
    """Compile a single 10 mm box Part via compile_parts and verify volume and checks."""
    part = Part(
        part_id="widget_a_core",
        role="heat_source",
        ops=[CadOp(op="box", params={"x_mm": 10.0, "y_mm": 10.0, "z_mm": 10.0})],
        material="aluminum_6061",
        power_w=2.0,
    )
    res = compile_parts([part], run_id="widget-a", revision=0)
    assert len(res.step_bytes) > 200
    assert len(res.glb_bytes) > 100
    assert len(res.manifest.parts) == 1
    assert abs(res.manifest.parts[0].volume_mm3 - 1000.0) < 1e-2
    for check in res.manifest.checks.values():
        assert check.passed is True


def test_invalid_box_dim_raises_typed_error() -> None:
    """Ensure out-of-range dimension raises CadOpInvalid with recovery_hint."""
    try:
        build_smoke_box_step(size_mm=0.01)
    except CadOpInvalid as exc:
        assert exc.code == "CAD_OP_INVALID"
        assert exc.part_id == "smoke_box"
        assert len(exc.recovery_hint) > 5
    else:
        raise AssertionError("Expected CadOpInvalid for 0.01 mm box")


def test_public_interface_exports() -> None:
    """Verify all required public functions and catalog entries exist."""
    for name in ("compile_parts", "compute_metrics", "metric_catalog", "simulate"):
        assert hasattr(stratum_cad, name)
    catalog = metric_catalog()
    assert len(catalog) == 8
