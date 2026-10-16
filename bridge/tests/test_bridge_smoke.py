"""Smoke tests for stratum_bridge package exports and MATLAB entrypoint generation."""

from __future__ import annotations

import stratum_bridge
from stratum_bridge import online_entrypoint


def test_bridge_public_exports() -> None:
    """Verify all required public functions exist on stratum_bridge."""
    required = (
        "build_bundle",
        "parse_external_results",
        "parse_measurement",
        "online_entrypoint",
        "parse_external_results_json",
    )
    for fn_name in required:
        assert hasattr(stratum_bridge, fn_name)


def test_online_entrypoint_smoke() -> None:
    """Verify online_entrypoint produces valid ASCII MATLAB script with exact endpoints."""
    script = online_entrypoint(
        base_url="https://example.invalid",
        token="tok_widget_a_123",
        members=["bundle_manifest.txt", "run_stratum_experiment.m"],
    )
    assert script.isascii()
    assert "https://example.invalid" in script
    assert "/api/b/%s/files/%s" in script
    assert "/api/b/%s/results" in script
    assert "STRATUM: results posted" in script


def test_bridge_contract_adapters_and_schema() -> None:
    """Verify build_bundle and parse_external_results work with contract models and emit valid ExternalSimResult."""
    import io
    import json
    import zipfile
    from pathlib import Path
    from contracts.generated.python import models as cm
    from stratum_bridge import build_bundle, parse_external_results
    from stratum_cad import compile_parts, compute_metrics, simulate

    root = Path(__file__).resolve().parents[2]
    raw_spec0 = json.loads((root / "contracts/fixtures/widget-a/spec_v0.json").read_text("utf-8"))
    raw_spec1 = dict(raw_spec0, revision=1, base_revision=0)
    c_spec0 = cm.EngineeringSpec.model_validate(raw_spec0)
    c_spec1 = cm.EngineeringSpec.model_validate(raw_spec1)
    c_graph = cm.ComponentGraph.model_validate(
        json.loads((root / "contracts/fixtures/widget-a/graph_v0.json").read_text("utf-8"))
    )

    comp0 = compile_parts(c_spec0.parts, run_id=c_spec0.run_id, revision=0)
    comp1 = compile_parts(c_spec1.parts, run_id=c_spec1.run_id, revision=1)
    c_man0, c_man1 = comp0.manifest.to_contract(), comp1.manifest.to_contract()
    c_m0 = compute_metrics(c_spec0, c_man0).to_contract()
    c_m1 = compute_metrics(c_spec1, c_man1).to_contract()
    sim1_internal = simulate(c_spec1, c_man1)
    c_sim0 = simulate(c_spec0, c_man0).to_contract(c_spec0)
    c_sim1 = sim1_internal.to_contract(c_spec1)

    zip_bytes = build_bundle(
        c_spec0.run_id, c_spec0, c_spec1, c_m0, c_m1, c_sim0, c_sim1,
        c_graph, comp0.step_bytes, comp1.step_bytes,
        manifest_base=c_man0, manifest_new=c_man1,
    )
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        b_man = dict(
            line.split("=", 1)
            for line in zf.read("bundle_manifest.txt").decode("utf-8").strip().splitlines()
        )
        exp_csv = zf.read("expected_results.csv")
    b_sha = b_man["bundle_sha256"]
    ext = parse_external_results(
        {
            "results.csv": exp_csv,
            "audit.txt": b"AUDIT: PASS max_abs_diff_C=0.0000\n",
            "stratum_results_manifest.txt": f"run_id={c_spec0.run_id}\nbundle_sha256={b_sha}\n".encode("utf-8"),
        },
        expected_bundle_sha256=b_sha,
        expected=sim1_internal,
    )
    c_ext = ext.to_contract(revision=1)
    validated = cm.ExternalSimResult.model_validate_json(c_ext.model_dump_json())
    assert validated.audit == cm.AuditStatus.match
    assert validated.max_abs_diff_C == 0.0

