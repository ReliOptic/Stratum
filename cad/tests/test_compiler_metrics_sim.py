"""Comprehensive tests for stratum_cad compiler, metrics, and thermal simulator."""

from __future__ import annotations

import math
import time

import trimesh

from stratum_cad import (
    CadOp,
    CadOpInvalid,
    CheckFailed,
    EngineeringSpec,
    Manifest,
    Part,
    PartManifestEntry,
    Placement,
    build_rc_network,
    compile_parts,
    compute_metrics,
    simulate,
)
from stratum_cad.fixtures import make_widget_a_spec


def test_compiler_primitives_and_modifiers() -> None:
    """Verify box, cylinder, sphere, shell, cut_box, and cut_cylinder operations."""
    parts = [
        Part(
            part_id="outer_can",
            role="enclosure",
            material="aluminum_6061",
            ops=[
                CadOp(op="cylinder", params={"radius_mm": 25.0, "height_mm": 40.0}),
                CadOp(op="shell", params={"wall_mm": 2.0}),
                CadOp(op="cut_cylinder", params={"radius_mm": 3.0, "height_mm": 50.0}),
            ],
        ),
        Part(
            part_id="inner_sphere",
            role="magnetic",
            material="ferrite_ceramic",
            nested_in="outer_can",
            ops=[CadOp(op="sphere", params={"radius_mm": 8.0})],
        ),
    ]
    res = compile_parts(parts, run_id="widget-a", revision=0)
    assert len(res.manifest.parts) == 2
    for chk in res.manifest.checks.values():
        assert chk.passed is True


def test_compiler_rejects_unknown_op_and_thin_wall() -> None:
    """Verify unknown op and wall < 0.2 mm raise CadOpInvalid with actionable LLM repair hints."""
    bad_op = Part("bad_part", "other", [CadOp("eval_code", {"x_mm": 10.0})])
    try:
        compile_parts([bad_op])
    except CadOpInvalid as exc:
        assert exc.part_id == "bad_part" and exc.op_index == 0
        assert "Change part 'bad_part' cad_ops[0].op from 'eval_code' to one of" in exc.recovery_hint
        assert "Repair hint:" in str(exc)
    else:
        raise AssertionError("Expected CadOpInvalid")

    thin = Part(
        "thin_shell",
        "enclosure",
        [CadOp("box", {"x_mm": 20.0, "y_mm": 20.0, "z_mm": 20.0}), CadOp("shell", {"wall_mm": 0.1})],
    )
    try:
        compile_parts([thin])
    except CadOpInvalid as exc:
        assert exc.part_id == "thin_shell" and exc.op_index == 1
        assert "[0.2, 2000.0] mm" in exc.recovery_hint
        assert "wall_mm" in str(exc) and "Repair hint:" in str(exc)
    else:
        raise AssertionError("Expected CadOpInvalid")


def test_pairwise_interference_undeclared_fails_declared_warns() -> None:
    """Undeclared overlap raises CheckFailed with actionable shift hint; declared nested_in passes."""
    p1 = Part("block_a", "structural_frame", [CadOp("box", {"x_mm": 20.0, "y_mm": 20.0, "z_mm": 20.0})])
    p2_bad = Part("block_b", "heat_source", [CadOp("box", {"x_mm": 10.0, "y_mm": 10.0, "z_mm": 10.0})])
    try:
        compile_parts([p1, p2_bad])
    except CheckFailed as exc:
        assert exc.code == "CHECK_FAILED"
        assert "block_a<->block_b" in exc.recovery_hint
        assert "placement." in exc.recovery_hint and "nested_in='block_a'" in exc.recovery_hint
        assert "Repair hint:" in str(exc)
    else:
        raise AssertionError("Expected CheckFailed")

    p2_ok = Part("block_b", "heat_source", [CadOp("box", {"x_mm": 10.0, "y_mm": 10.0, "z_mm": 10.0})], nested_in="block_a")
    res = compile_parts([p1, p2_ok])
    assert res.manifest.checks["pairwise_interference"].passed is True
    assert res.manifest.checks["pairwise_interference"].severity == "warn"



def test_glb_yup_conversion_and_node_names() -> None:
    """Verify GLB export has exact part_id node names and converts Z-up to Y-up."""
    part = Part(
        "tall_z_pillar",
        "structural_frame",
        [CadOp("box", {"x_mm": 10.0, "y_mm": 20.0, "z_mm": 50.0})],
        placement=Placement(z_mm=25.0),
    )
    res = compile_parts([part])
    scene = trimesh.load(trimesh.util.wrap_as_stream(res.glb_bytes), file_type="glb")
    assert isinstance(scene, trimesh.Scene) and "tall_z_pillar" in scene.graph.nodes
    assert abs((scene.bounds[1][1] - scene.bounds[0][1]) - 50.0) < 1e-2


def test_metrics_hand_computed_widget_a_and_na_roles() -> None:
    """Verify hand-computed metrics on widget-a and not_applicable when roles absent."""
    spec0 = make_widget_a_spec(revision=0, duration_s=120.0)
    comp0 = compile_parts(spec0.parts, run_id="widget-a", revision=0)
    m0 = compute_metrics(spec0, comp0.manifest).metrics

    assert m0["min_gap_heat_to_storage_mm"].value == 1.5
    assert set(m0["min_gap_heat_to_storage_mm"].part_ids) == {"core_heater", "storage_unit"}
    assert m0["min_enclosure_wall_mm"].value == 2.0
    assert m0["heat_path_to_exterior_mm"].value == 10.0
    assert m0["spreader_coverage_ratio"].value == 1.5
    assert m0["vent_open_area_mm2"].value == 60.0
    assert m0["assembly_envelope_mm"].value == [100.0, 60.0, 30.0]
    assert m0["assembly_mass_g"].status == "DOCUMENTED"

    mystery = Part("mystery_b", "structural_frame", [CadOp("box", {"x_mm": 10.0, "y_mm": 10.0, "z_mm": 10.0})], material="unobtainium")
    spec_na = EngineeringSpec(parts=[mystery], duration_s=10.0)
    comp_na = compile_parts([mystery])
    m_na = compute_metrics(spec_na, comp_na.manifest).metrics
    assert m_na["min_gap_heat_to_storage_mm"].not_applicable is True
    assert m_na["peak_storage_temp_rise_C"].not_applicable is True
    assert m_na["assembly_mass_g"].status == "ASSUMED" and m_na["assembly_mass_g"].value == 1.5


def test_simulator_single_node_analytic_exponential() -> None:
    """Verify single-node Backward-Euler matches analytic exponential within 1%."""
    part = Part("single_block", "energy_storage", [CadOp("box", {"x_mm": 20.0, "y_mm": 20.0, "z_mm": 20.0})], power_w=10.0)
    spec = EngineeringSpec(parts=[part], ambient_c=25.0, duration_s=300.0, dt_s=1.0, convection_h_w_m2k=50.0)
    comp = compile_parts([part])
    net = build_rc_network(spec, comp.manifest)
    tau = float(net.c_vec[0]) / float(net.l_mat[0, 0])
    analytic_end = 25.0 + (10.0 / float(net.l_mat[0, 0])) * (1.0 - math.exp(-300.0 / tau))
    sim_res = simulate(spec, comp.manifest)
    assert abs(sim_res.per_node_peak_c["single_block"] - analytic_end) / analytic_end < 0.01


def test_simulator_two_node_energy_balance_and_30_node_speed() -> None:
    """Verify two-node conservation of energy and <200 ms runtime for 30 nodes."""
    p_a = Part("heater_a", "heat_source", [CadOp("box", {"x_mm": 20.0, "y_mm": 20.0, "z_mm": 20.0})], material="copper_c110", power_w=8.0)
    p_b = Part("sink_b", "energy_storage", [CadOp("box", {"x_mm": 20.0, "y_mm": 20.0, "z_mm": 20.0})], placement=Placement(x_mm=20.5))
    spec = EngineeringSpec(parts=[p_a, p_b], duration_s=100.0, dt_s=1.0, ambient_c=25.0)
    comp = compile_parts([p_a, p_b])
    net = build_rc_network(spec, comp.manifest)
    sim_res = simulate(spec, comp.manifest)

    stored_j = sum(net.nodes[i].c_j_k * sim_res.per_node_rise_c[net.nodes[i].part_id] for i in range(2))
    dissipated_j = sum(
        next(n for n in net.nodes if n.part_id == s.node_id).g_amb_w_k * (s.temp_c - 25.0)
        for s in sim_res.series
        if s.time_s > 0
    )
    assert abs((stored_j + dissipated_j) - 800.0) / 800.0 < 0.01

    parts_30 = [
        Part(
            f"node_{i:02d}",
            "energy_storage" if i == 29 else "structural_frame",
            [CadOp("box", {"x_mm": 10.0, "y_mm": 10.0, "z_mm": 10.0})],
            placement=Placement(x_mm=float(i * 11.0)),
            power_w=2.0 if i == 0 else 0.0,
        )
        for i in range(30)
    ]
    man_30 = Manifest(
        parts=[
            PartManifestEntry(
                p.part_id, p.role, p.material, 1000.0, 600.0,
                (p.placement.x_mm - 5.0, -5.0, -5.0), (p.placement.x_mm + 5.0, 5.0, 5.0), (p.placement.x_mm, 0.0, 0.0),
            )
            for p in parts_30
        ],
        checks={},
        step_sha256="",
        glb_sha256="",
    )
    t0 = time.perf_counter()
    res_30 = simulate(EngineeringSpec(parts=parts_30, duration_s=600.0, dt_s=1.0), man_30)
    assert (time.perf_counter() - t0) * 1000.0 < 200.0 and len(res_30.per_node_peak_c) == 30
