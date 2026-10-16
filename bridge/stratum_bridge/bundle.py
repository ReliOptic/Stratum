"""Builder for deterministic MATLAB/Simulink verification ZIP bundles."""

from __future__ import annotations

import hashlib
import io
import zipfile
from typing import Any

from stratum_bridge.logging_utils import log_event
from stratum_bridge.matlab_gen import generate_experiment_script
from stratum_cad.rc_network import RCNetwork, build_rc_network, generate_stress_scenario
from stratum_cad.types import EngineeringSpec, Manifest, MetricSet, SimResult


def _format_parameters_csv(net_base: RCNetwork, net_new: RCNetwork) -> str:
    """Format parameters.csv for both base and new revisions with status columns."""
    header = (
        "node,part_id,role,revision,mass_g,cp_J_per_gK,heat_W,"
        "g_amb_W_per_K,conductance_edges,status,basis_type"
    )
    rows: list[str] = [header]
    for net in (net_base, net_new):
        edge_map: dict[str, list[str]] = {nd.part_id: [] for nd in net.nodes}
        for edge in net.edges:
            edge_map[edge.node_a].append(f"{edge.node_b}:{edge.g_w_k:.6f}")
            edge_map[edge.node_b].append(f"{edge.node_a}:{edge.g_w_k:.6f}")
        for nd in net.nodes:
            edges_str = ";".join(edge_map[nd.part_id]) if edge_map[nd.part_id] else "none"
            rows.append(
                f"N{nd.node_index},{nd.part_id},{nd.role},{net.revision},"
                f"{nd.mass_g:.4f},{nd.cp_j_gk:.4f},{nd.base_power_w:.4f},"
                f"{nd.g_amb_w_k:.6f},{edges_str},{nd.status},{nd.basis_type}"
            )
    return "\n".join(rows) + "\n"


def _format_scenario_csv(spec_base: EngineeringSpec, spec_new: EngineeringSpec) -> str:
    """Format stress_scenario_timeseries.csv with per-heat-source power and derived markers."""
    times_s, q_base = generate_stress_scenario(spec_base)
    _, q_new = generate_stress_scenario(spec_new)
    part_ids: list[str] = []
    for p in list(spec_base.parts) + list(spec_new.parts):
        if p.part_id not in part_ids:
            part_ids.append(p.part_id)

    cols = ["time_s"] + [f"power_{pid}_W" for pid in part_ids] + ["ambient_C", "derived_flag"]
    lines: list[str] = [",".join(cols)]
    base_idx = {p.part_id: i for i, p in enumerate(spec_base.parts)}
    new_idx = {p.part_id: i for i, p in enumerate(spec_new.parts)}

    for step in range(len(times_s)):
        row: list[str] = [f"{float(times_s[step]):.1f}"]
        for pid in part_ids:
            if pid in new_idx:
                val = float(q_new[step, new_idx[pid]])
            else:
                val = float(q_base[step, base_idx[pid]])
            row.append(f"{val:.4f}")
        row.append(f"{spec_new.ambient_c:.2f}")
        row.append("derived_stress_profile")
        lines.append(",".join(row))
    return "\n".join(lines) + "\n"


def _format_expected_csv(sim_base: SimResult, sim_new: SimResult) -> str:
    """Combine server SimResult series for base and new revisions into expected_results.csv."""
    lines: list[str] = ["time_s,revision,node_id,temp_C"]
    for sim_res in (sim_base, sim_new):
        for sample in sim_res.series:
            lines.append(
                f"{sample.time_s:.1f},{sample.revision},{sample.node_id},{sample.temp_c:.4f}"
            )
    return "\n".join(lines) + "\n"


def _format_handoff_spec(
    run_id: str,
    net_base: RCNetwork,
    net_new: RCNetwork,
    m_base: MetricSet,
    m_new: MetricSet,
    graph: Any,
) -> str:
    """Format agent_handoff_spec.txt with intent, nodes, assumptions, and INPUTS_REQUIRED."""
    lines: list[str] = [
        "STRATUM AGENT HANDOFF SPECIFICATION",
        f"run_id: {run_id}",
        f"revisions: rev{net_base.revision} (base) -> rev{net_new.revision} (new)",
        "",
        "1. INTENT",
        "Verify whether the geometry and thermal-network changes between base and new revisions",
        "reduce peak temperature rise on energy_storage nodes under the stress scenario.",
        "NOTE: Agreement between Simulink State-Space and expected_results.csv proves the",
        "numerical ODE implementation, not the underlying physics.",
        "",
        "2. NODES & ASSUMPTIONS",
    ]
    inputs_required: list[str] = []
    for net in (net_base, net_new):
        for nd in net.nodes:
            lines.append(
                f"- rev{net.revision} {nd.part_id} (role={nd.role}, material={nd.material}): "
                f"mass={nd.mass_g:.3f} g, cp={nd.cp_j_gk:.3f} J/gK, Q={nd.base_power_w:.2f} W "
                f"[status={nd.status}, basis={nd.basis_type}]"
            )
            if nd.status in {"ASSUMED", "UNKNOWN", "INFERRED"}:
                inputs_required.append(
                    f"INPUTS_REQUIRED: part_id={nd.part_id}, variable=thermal_mass_and_power, unit=J_per_K_and_W"
                )
    lines.extend(
        [
            "",
            "3. WHAT EACH PLOT PROVES",
            "- results.png overlays transient temperature trajectories for energy_storage nodes",
            f"  across rev{net_base.revision} and rev{net_new.revision}.",
            f"- Base peak_storage_temp_rise_C: {m_base.metrics.get('peak_storage_temp_rise_C')}",
            f"- New peak_storage_temp_rise_C: {m_new.metrics.get('peak_storage_temp_rise_C')}",
            f"- Causal graph reference: {graph if graph is not None else 'lumped_rc_adjacency'}",
            "",
            "4. INPUTS_REQUIRED",
        ]
    )
    if inputs_required:
        lines.extend(sorted(set(inputs_required)))
    else:
        lines.append("INPUTS_REQUIRED: part_id=ambient_boundary, variable=convection_h, unit=W_per_m2K")
    return "\n".join(lines) + "\n"


def build_bundle(
    run: str | Any,
    base: EngineeringSpec,
    new: EngineeringSpec,
    m_base: MetricSet,
    m_new: MetricSet,
    sim_base: SimResult,
    sim_new: SimResult,
    graph: Any,
    step_base: bytes,
    step_new: bytes,
    *,
    manifest_base: Manifest | None = None,
    manifest_new: Manifest | None = None,
) -> bytes:
    """Build deterministic MATLAB/Simulink handoff ZIP bundle for any adjacent revisions."""
    run_id = run if isinstance(run, str) else str(getattr(run, "run_id", base.run_id))
    man_b = manifest_base or Manifest(parts=[], checks={}, step_sha256="", glb_sha256="", run_id=run_id, revision=base.revision)
    man_n = manifest_new or Manifest(parts=[], checks={}, step_sha256="", glb_sha256="", run_id=run_id, revision=new.revision)
    net_base = build_rc_network(base, man_b)
    net_new = build_rc_network(new, man_n)

    members: dict[str, bytes] = {
        "agent_handoff_spec.txt": _format_handoff_spec(run_id, net_base, net_new, m_base, m_new, graph).encode("utf-8"),
        "parameters.csv": _format_parameters_csv(net_base, net_new).encode("utf-8"),
        "stress_scenario_timeseries.csv": _format_scenario_csv(base, new).encode("utf-8"),
        "expected_results.csv": _format_expected_csv(sim_base, sim_new).encode("utf-8"),
        "run_stratum_experiment.m": generate_experiment_script(base.revision, new.revision).encode("ascii"),
        f"rev{base.revision}.step": step_base,
        f"rev{new.revision}.step": step_new,
        "README_bundle.txt": (
            f"Stratum Verification Bundle (run_id={run_id}, rev{base.revision}->rev{new.revision})\n"
            "Run `run_stratum_experiment` in MATLAB or use `stratum.m` in MATLAB Online.\n"
        ).encode("utf-8"),
    }

    member_hashes = [
        f"{name}={hashlib.sha256(data).hexdigest()}" for name, data in sorted(members.items())
    ]
    tree_hash = hashlib.sha256("\n".join(member_hashes).encode("utf-8")).hexdigest()
    manifest_lines = [
        f"run_id={run_id}",
        f"base_revision={base.revision}",
        f"new_revision={new.revision}",
        f"bundle_sha256={tree_hash}",
        *member_hashes,
    ]
    members["bundle_manifest.txt"] = ("\n".join(manifest_lines) + "\n").encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(members.keys()):
            info = zipfile.ZipInfo(filename=name, date_time=(2026, 10, 16, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, members[name])
    zip_bytes = buf.getvalue()
    log_event(
        "build_bundle_ok",
        run_id=run_id,
        stage="bridge",
        base_revision=base.revision,
        new_revision=new.revision,
        bundle_sha256=hashlib.sha256(zip_bytes).hexdigest(),
        content_sha256=tree_hash,
    )
    return zip_bytes
