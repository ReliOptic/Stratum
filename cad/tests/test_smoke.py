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
    for name in ("compile_parts", "compute_metrics", "metric_catalog", "simulate", "export_test_box", "vocabulary"):
        assert hasattr(stratum_cad, name)
    catalog = metric_catalog()
    assert len(catalog) == 8
    for m in catalog:
        assert len(m.description) > 20


def test_vocabulary_spec_complete() -> None:
    """Verify stratum_cad.vocabulary() includes all CadOps, bounds, examples, failures, and metrics."""
    vocab_text = stratum_cad.vocabulary()
    for op_name in ("box", "rounded_box", "cylinder", "sphere", "shell", "cut_box", "cut_cylinder"):
        assert op_name in vocab_text
    assert "Example 1:" in vocab_text and "Example 2:" in vocab_text
    assert "Common failures:" in vocab_text
    for m in metric_catalog():
        assert m.metric_id in vocab_text
        assert m.description in vocab_text


def test_wall_thickness_and_dim_lower_bound_0_2mm() -> None:
    """Verify 0.2 mm lower bound passes and < 0.2 mm raises CadOpInvalid."""
    ok_part = Part(
        part_id="widget_a_shell_02",
        role="enclosure",
        ops=[
            CadOp(op="box", params={"x_mm": 10.0, "y_mm": 10.0, "z_mm": 10.0}),
            CadOp(op="shell", params={"thickness_mm": 0.2}),
        ],
    )
    res = compile_parts([ok_part], run_id="widget-a", revision=0)
    assert res.manifest.checks["valid_solid"].passed is True
    assert res.manifest.parts[0].min_wall_mm == 0.2

    bad_part = Part(
        part_id="widget_a_shell_019",
        role="enclosure",
        ops=[
            CadOp(op="box", params={"x_mm": 10.0, "y_mm": 10.0, "z_mm": 10.0}),
            CadOp(op="shell", params={"thickness_mm": 0.19}),
        ],
    )
    try:
        compile_parts([bad_part], run_id="widget-a", revision=0)
    except CadOpInvalid as exc:
        assert exc.code == "CAD_OP_INVALID"
    else:
        raise AssertionError("Expected CadOpInvalid for 0.19 mm wall (< 0.2 mm lower bound)")


def test_contract_adapter_roundtrip_widget_a() -> None:
    """Compile, compute metrics, and simulate directly from contract EngineeringSpec fixture."""
    import json
    from pathlib import Path
    from contracts.generated.python import models as cm
    from stratum_cad import compute_metrics, simulate

    root = Path(__file__).resolve().parents[2]
    raw_spec = json.loads((root / "contracts/fixtures/widget-a/spec_v0.json").read_text("utf-8"))
    contract_spec = cm.EngineeringSpec.model_validate(raw_spec)

    comp = compile_parts(contract_spec.parts, run_id=contract_spec.run_id, revision=contract_spec.revision)
    c_manifest = comp.manifest.to_contract()
    c_metrics = compute_metrics(contract_spec, c_manifest).to_contract()
    c_sim = simulate(contract_spec, c_manifest).to_contract(contract_spec)

    assert cm.Manifest.model_validate_json(c_manifest.model_dump_json()).run_id == "run-widget-a-001"
    assert len(cm.MetricSet.model_validate_json(c_metrics.model_dump_json()).values) == 8
    assert len(cm.SimResult.model_validate_json(c_sim.model_dump_json()).nodes) == 4


def test_realistic_15_part_slim_assembly_under_5s() -> None:
    """Verify 15-part slim assembly compiles, computes metrics, and simulates under 5 s total."""
    import time
    from stratum_cad import compute_metrics, simulate
    from stratum_cad.fixtures import make_widget_a_slim_15_spec

    spec = make_widget_a_slim_15_spec(duration_s=300.0)
    assert len(spec.parts) == 15
    t0 = time.perf_counter()
    comp = compile_parts(spec.parts, run_id=spec.run_id, revision=spec.revision)
    t_compile = time.perf_counter() - t0
    mset = compute_metrics(spec, comp.manifest)
    t_metrics = time.perf_counter() - t0 - t_compile
    sim_res = simulate(spec, comp.manifest)
    t_total = time.perf_counter() - t0

    assert t_total < 5.0, f"Expected < 5.0 s total, got {t_total:.3f} s"
    assert len(comp.manifest.parts) == 15
    assert mset.metrics["min_enclosure_wall_mm"].value == 0.9
    assert mset.metrics["peak_storage_temp_rise_C"].value is not None
    assert sim_res.peak_storage_temp_rise_c is not None and sim_res.peak_storage_temp_rise_c > 0.0

