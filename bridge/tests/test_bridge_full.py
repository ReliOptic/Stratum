"""Comprehensive tests for stratum_bridge: bundle generation, .m syntax, eigenvalues, and parsers."""

from __future__ import annotations

import io
import json
import re
import zipfile

import numpy as np

from stratum_bridge import (
    BundleMismatch,
    ResultsSchemaInvalid,
    build_bundle,
    online_entrypoint,
    parse_external_results,
    parse_external_results_json,
    parse_measurement,
)
from stratum_cad import build_rc_network, compile_parts, compute_metrics, simulate
from stratum_cad.fixtures import make_widget_a_spec


def _count_matlab_blocks_and_ends(script: str) -> tuple[int, int]:
    """Count MATLAB block-opening keywords and 'end' keywords outside comments/strings."""
    openers, ends = 0, 0
    block_re = re.compile(r"\b(function|for|while|if|try|switch)\b")
    end_re = re.compile(r"\bend\b")
    for raw_line in script.splitlines():
        code_no_str = re.sub(r'"[^"]*"|\'[^\']*\'', "''", raw_line.split("%", 1)[0])
        openers += len(block_re.findall(code_no_str))
        ends += len(end_re.findall(code_no_str))
    return openers, ends


def test_build_bundle_and_matlab_script_and_eigenvalues() -> None:
    """Verify bundle members, CSV headers, .m ASCII + balanced ends, no [sprintf( vertcat, disp(line), visible figure, and A matrix eigenvalues < 0."""
    spec0 = make_widget_a_spec(revision=0, duration_s=60.0)
    spec1 = make_widget_a_spec(revision=1, duration_s=60.0)
    c0, c1 = compile_parts(spec0.parts, revision=0), compile_parts(spec1.parts, revision=1)
    m0, m1 = compute_metrics(spec0, c0.manifest), compute_metrics(spec1, c1.manifest)
    s0, s1 = simulate(spec0, c0.manifest), simulate(spec1, c1.manifest)

    for spec, comp in ((spec0, c0), (spec1, c1)):
        net = build_rc_network(spec, comp.manifest)
        eigvals = np.linalg.eigvals(-np.diag(1.0 / net.c_vec) @ net.l_mat)
        assert np.all(np.real(eigvals) < 0.0)

    bundle_bytes = build_bundle(
        "widget-a", spec0, spec1, m0, m1, s0, s1,
        {"edges": [["core_heater", "storage_unit"]]},
        c0.step_bytes, c1.step_bytes, manifest_base=c0.manifest, manifest_new=c1.manifest,
    )
    with zipfile.ZipFile(io.BytesIO(bundle_bytes), "r") as zf:
        expected_members = {
            "agent_handoff_spec.txt", "copilot_prompt.txt", "parameters.csv", "stress_scenario_timeseries.csv",
            "expected_results.csv", "bundle_manifest.txt", "run_stratum_experiment.m",
            "rev0.step", "rev1.step", "README_bundle.txt",
        }
        assert expected_members.issubset(set(zf.namelist()))
        copilot_text = zf.read("copilot_prompt.txt").decode("utf-8")
        assert "INPUTS_REQUIRED" in copilot_text
        assert "sensitivity sweep" in copilot_text
        m_script = zf.read("run_stratum_experiment.m").decode("utf-8")
        assert "[sprintf(" not in m_script
        assert 'man = ["run_id=" + string(run_id);' in m_script
        assert "disp(line);" in m_script
        assert 'vis = "on";' in m_script
        assert "fig = figure('Visible', char(vis));" in m_script
        assert "'Interpreter', 'none'" in m_script
        assert " · " in m_script
        assert "Next: attach agent_handoff_spec.txt in Copilot Chat and paste copilot_prompt.txt" in m_script
        assert _count_matlab_blocks_and_ends(m_script)[0] == _count_matlab_blocks_and_ends(m_script)[1]
        assert "INPUTS_REQUIRED:" in zf.read("agent_handoff_spec.txt").decode("utf-8")


def test_online_entrypoint_and_json_roundtrip_and_tamper() -> None:
    """Verify online_entrypoint balanced ends, no [sprintf( vertcat, JSON round-trip, tampered sha, and >5MB rejection."""
    script = online_entrypoint("https://stratum.example.org", "sec_tok_999", ["bundle_manifest.txt", "run_stratum_experiment.m"])
    assert script.isascii()
    assert "[sprintf(" not in script
    assert _count_matlab_blocks_and_ends(script)[0] == _count_matlab_blocks_and_ends(script)[1]

    spec1 = make_widget_a_spec(revision=1, duration_s=10.0)
    c1 = compile_parts(spec1.parts, run_id="widget-a", revision=1)
    s1 = simulate(spec1, c1.manifest)
    b_sha = "a" * 64
    payload = {
        "manifest": {"run_id": "widget-a", "bundle_sha256": b_sha, "matlab_version": "R2024b", "timestamp": "2026-10-16T12:00:00Z"},
        "audit": {"status": "MATCH", "max_abs_diff_C": 0.01, "worst_t_s": 5.0},
        "results": [{"time_s": smp.time_s, "revision": smp.revision, "node_id": smp.node_id, "temp_C": round(smp.temp_c + 0.02, 4)} for smp in s1.series],
    }
    raw_json = json.dumps(payload).encode("utf-8")
    parsed = parse_external_results_json(raw_json, b_sha, s1)
    assert parsed.audit == "MATCH" and parsed.max_abs_diff_c is not None and parsed.max_abs_diff_c <= 0.05

    try:
        parse_external_results_json(raw_json, "b" * 64, s1)
    except BundleMismatch as exc:
        assert exc.code == "BUNDLE_MISMATCH"
    else:
        raise AssertionError("Expected BundleMismatch")

    try:
        parse_external_results_json(b"x" * (5 * 1024 * 1024 + 10), b_sha, s1)
    except ResultsSchemaInvalid as exc:
        assert exc.code == "RESULTS_SCHEMA_INVALID"
    else:
        raise AssertionError("Expected ResultsSchemaInvalid on oversize JSON")


def test_parse_external_results_and_measurement_validation() -> None:
    """Verify external results file parser, server re-audit override, and measurement parser."""
    spec1 = make_widget_a_spec(revision=1, duration_s=10.0)
    c1 = compile_parts(spec1.parts, run_id="widget-a", revision=1)
    s1 = simulate(spec1, c1.manifest)
    b_sha = "c" * 64
    files = {
        "results.csv": s1.csv_text.encode("utf-8"),
        "audit.txt": b"AUDIT: MATCH (max |dT| = 0.00 C)\n",
        "stratum_results_manifest.txt": f"run_id=widget-a\nbundle_sha256={b_sha}\nmatlab_version=R2024b\ntimestamp=2026-10-16T12:00:00Z\n".encode("utf-8"),
    }
    res = parse_external_results(files, b_sha, s1)
    assert res.audit == "MATCH" and res.max_abs_diff_c == 0.0

    meas_files = {
        "measurement.csv": b"time_s,part_id,temp_C,current_A,voltage_V\n0.0,storage_unit,25.0,1.2,5.0\n10.0,storage_unit,28.4,1.2,5.0\n",
        "measurement_meta.txt": b"method=thermocouple_k\ninstrument=daq_01\nambient_C=25.0\nsensor_storage_unit=top\nnotes=ok\n",
    }
    m_res = parse_measurement(meas_files, "widget-a", spec1)
    assert m_res.tool == "measurement" and m_res.audit == "not_applicable" and m_res.per_node_peak_c["storage_unit"] == 28.4

    for bad_csv in (
        b"time_s,part_id,temp_C\n0.0,nonexistent_part,25.0\n",
        b"time_s,part_id,temp_C\n0.0,=CMD|' /C calc'!A0,25.0\n",
    ):
        try:
            parse_measurement({"measurement.csv": bad_csv, "measurement_meta.txt": meas_files["measurement_meta.txt"]}, "widget-a", spec1)
        except ResultsSchemaInvalid as exc:
            assert exc.code == "RESULTS_SCHEMA_INVALID"
        else:
            raise AssertionError("Expected ResultsSchemaInvalid")


def test_full_widget_a_closed_loop_rescore_v0_v1_v2() -> None:
    """Verify full widget-a loop: V0 -> V1 -> bundle -> parse_external_results_json -> re-score -> V2."""
    spec0 = make_widget_a_spec(revision=0, duration_s=120.0)
    spec1 = make_widget_a_spec(revision=1, duration_s=120.0)
    spec2 = make_widget_a_spec(revision=2, duration_s=120.0)
    c0, c1, c2 = compile_parts(spec0.parts, revision=0), compile_parts(spec1.parts, revision=1), compile_parts(spec2.parts, revision=2)
    m0, m1, m2 = compute_metrics(spec0, c0.manifest), compute_metrics(spec1, c1.manifest), compute_metrics(spec2, c2.manifest)
    s0, s1, s2 = simulate(spec0, c0.manifest), simulate(spec1, c1.manifest), simulate(spec2, c2.manifest)

    bundle_bytes = build_bundle(
        "widget-a", spec0, spec1, m0, m1, s0, s1,
        {"edges": [["core_heater", "storage_unit"]]},
        c0.step_bytes, c1.step_bytes, manifest_base=c0.manifest, manifest_new=c1.manifest,
    )
    with zipfile.ZipFile(io.BytesIO(bundle_bytes), "r") as zf:
        b_sha = dict(line.split("=", 1) for line in zf.read("bundle_manifest.txt").decode("utf-8").strip().splitlines())["bundle_sha256"]

    json_payload = json.dumps({
        "manifest": {"run_id": "widget-a", "bundle_sha256": b_sha, "matlab_version": "R2024b", "timestamp": "2026-10-16T12:30:00Z"},
        "audit": {"status": "MATCH", "raw": "AUDIT: MATCH (max |dT| = 0.00 C)", "max_abs_diff_C": 0.0, "worst_t_s": 0.0},
        "results": [{"time_s": smp.time_s, "revision": smp.revision, "node_id": smp.node_id, "temp_C": smp.temp_c} for smp in s1.series],
    }).encode("utf-8")
    ext = parse_external_results_json(json_payload, b_sha, s1)
    assert ext.audit == "MATCH" and ext.per_node_peak_c["storage_unit"] == s1.per_node_peak_c["storage_unit"]
    assert m0.metrics["peak_storage_temp_rise_C"].value > m1.metrics["peak_storage_temp_rise_C"].value > m2.metrics["peak_storage_temp_rise_C"].value

