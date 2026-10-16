"""Deterministic generator for synthetic widget-a CAD and bridge fixtures."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from stratum_bridge.bundle import build_bundle
from stratum_cad.compiler import compile_parts
from stratum_cad.fixtures import make_widget_a_spec
from stratum_cad.metrics import compute_metrics
from stratum_cad.simulator import simulate


def generate_all_widget_a_fixtures(repo_root: Path) -> dict[str, str]:
    """Generate and write widget-a CAD and bridge fixtures under cad/fixtures and bridge/fixtures."""
    cad_fix_dir = repo_root / "cad" / "fixtures"
    bridge_fix_dir = repo_root / "bridge" / "fixtures"
    results_dir = bridge_fix_dir / "widget-a-results"
    meas_dir = bridge_fix_dir / "widget-a-measurement"

    for d in (cad_fix_dir, bridge_fix_dir, results_dir, meas_dir):
        d.mkdir(parents=True, exist_ok=True)

    spec0 = make_widget_a_spec(revision=0, duration_s=120.0)
    spec1 = make_widget_a_spec(revision=1, duration_s=120.0)
    c0 = compile_parts(spec0.parts, run_id="widget-a", revision=0)
    c1 = compile_parts(spec1.parts, run_id="widget-a", revision=1)
    m0 = compute_metrics(spec0, c0.manifest)
    m1 = compute_metrics(spec1, c1.manifest)
    s0 = simulate(spec0, c0.manifest)
    s1 = simulate(spec1, c1.manifest)

    (cad_fix_dir / "widget-a.step").write_bytes(c0.step_bytes)
    (cad_fix_dir / "widget-a.glb").write_bytes(c0.glb_bytes)

    bundle_bytes = build_bundle(
        "widget-a",
        spec0,
        spec1,
        m0,
        m1,
        s0,
        s1,
        {"causal_edges": [["core_heater", "storage_unit"], ["core_heater", "thermal_spreader_plate"]]},
        c0.step_bytes,
        c1.step_bytes,
        manifest_base=c0.manifest,
        manifest_new=c1.manifest,
    )
    (bridge_fix_dir / "widget-a-bundle.zip").write_bytes(bundle_bytes)

    with zipfile.ZipFile(io.BytesIO(bundle_bytes), "r") as zf:
        expected_csv = zf.read("expected_results.csv")
        bman_text = zf.read("bundle_manifest.txt").decode("utf-8")

    b_sha = ""
    for line in bman_text.splitlines():
        if line.startswith("bundle_sha256="):
            b_sha = line.split("=", 1)[1].strip()

    (results_dir / "results.csv").write_bytes(expected_csv)
    (results_dir / "audit.txt").write_text("AUDIT: MATCH (max |dT| = 0.00 C)\n", encoding="utf-8")
    (results_dir / "stratum_results_manifest.txt").write_text(
        f"run_id=widget-a\nbundle_sha256={b_sha}\nmatlab_version=24.2.0.2712019 (R2024b)\n"
        "timestamp=2026-10-16T12:00:00Z\n",
        encoding="utf-8",
    )
    (results_dir / "stratum_results_manifest_tampered.txt").write_text(
        "run_id=widget-a\nbundle_sha256=0000000000000000000000000000000000000000000000000000000000000000\n"
        "matlab_version=24.2.0.2712019 (R2024b)\ntimestamp=2026-10-16T12:00:00Z\n",
        encoding="utf-8",
    )

    meas_lines = ["time_s,part_id,temp_C,current_A,voltage_V"]
    for smp in s1.series:
        if int(smp.time_s) % 10 == 0:
            meas_lines.append(f"{smp.time_s:.1f},{smp.node_id},{smp.temp_c:.4f},1.2500,5.0000")
    (meas_dir / "measurement.csv").write_text("\n".join(meas_lines) + "\n", encoding="utf-8")
    (meas_dir / "measurement_meta.txt").write_text(
        "method=type_k_surface_thermocouple\n"
        "instrument=synthetic_bench_logger_v1\n"
        "ambient_C=25.0\n"
        "sensor_enclosure_shell=top_center_outer\n"
        "sensor_core_heater= geometric_center\n"
        "sensor_thermal_spreader_plate=mid_plate\n"
        "sensor_storage_unit=proximal_face_center\n"
        "notes=Synthetic reference measurement for widget-a rev1\n",
        encoding="utf-8",
    )
    return {"bundle_sha256": b_sha, "step_sha256": c0.manifest.step_sha256, "glb_sha256": c0.manifest.glb_sha256}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    info = generate_all_widget_a_fixtures(root)
    print(info)
