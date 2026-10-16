"""Backward-Euler thermal simulator for lumped-RC networks."""

from __future__ import annotations

from typing import Any

import numpy as np

from stratum_cad.adapters import adapt_manifest, adapt_spec
from stratum_cad.logging_utils import log_event
from stratum_cad.rc_network import build_rc_network, generate_stress_scenario
from stratum_cad.types import EngineeringSpec, Manifest, SimResult, SimSample


def simulate(spec: EngineeringSpec | Any, manifest: Manifest | Any) -> SimResult:
    """Simulate transient node temperatures using unconditionally stable Backward Euler.

    Governing discrete equation for temperature rise theta(t) = T(t) - T_ambient:
        (C + dt * L) * theta_{k+1} = C * theta_k + dt * Q(t_{k+1})
    """
    spec = adapt_spec(spec)
    manifest = adapt_manifest(manifest, spec)
    net = build_rc_network(spec, manifest)
    times_s, q_mat = generate_stress_scenario(spec)
    dt = float(spec.dt_s)
    n_nodes = len(net.nodes)
    steps = len(times_s)

    c_mat = np.diag(net.c_vec)
    lhs = c_mat + dt * net.l_mat
    lhs_inv = np.linalg.inv(lhs)

    temps_c = np.full((steps, n_nodes), float(spec.ambient_c), dtype=np.float64)
    theta = np.zeros(n_nodes, dtype=np.float64)

    for step_idx in range(1, steps):
        rhs = net.c_vec * theta + dt * q_mat[step_idx, :]
        theta = lhs_inv @ rhs
        temps_c[step_idx, :] = float(spec.ambient_c) + theta

    per_node_peak_c: dict[str, float] = {}
    per_node_rise_c: dict[str, float] = {}
    storage_node_ids: list[str] = []

    for idx, node in enumerate(net.nodes):
        peak_c = float(np.max(temps_c[:, idx]))
        rise_c = peak_c - float(spec.ambient_c)
        per_node_peak_c[node.part_id] = round(peak_c, 4)
        per_node_rise_c[node.part_id] = round(rise_c, 4)
        if node.role == "energy_storage":
            storage_node_ids.append(node.part_id)

    peak_temp_c = round(float(np.max(temps_c)), 4) if n_nodes > 0 else float(spec.ambient_c)
    peak_storage_rise_c: float | None = None
    if storage_node_ids:
        peak_storage_rise_c = round(
            max(per_node_rise_c[nid] for nid in storage_node_ids), 4
        )

    series: list[SimSample] = []
    csv_lines: list[str] = ["time_s,revision,node_id,temp_C"]
    for step_idx in range(steps):
        t_val = round(float(times_s[step_idx]), 4)
        for idx, node in enumerate(net.nodes):
            temp_val = round(float(temps_c[step_idx, idx]), 4)
            pwr_val = round(float(q_mat[step_idx, idx]), 4)
            series.append(
                SimSample(
                    time_s=t_val,
                    revision=spec.revision,
                    node_id=node.part_id,
                    temp_c=temp_val,
                    power_w=pwr_val,
                )
            )
            csv_lines.append(f"{t_val:.1f},{spec.revision},{node.part_id},{temp_val:.4f}")

    csv_text = "\n".join(csv_lines) + "\n"
    log_event(
        "simulate_completed",
        run_id=spec.run_id,
        stage="simulate",
        revision=spec.revision,
        node_count=n_nodes,
        steps=steps,
        peak_temp_c=peak_temp_c,
        peak_storage_rise_c=peak_storage_rise_c,
    )
    return SimResult(
        run_id=spec.run_id,
        revision=spec.revision,
        dt_s=dt,
        duration_s=float(spec.duration_s),
        ambient_c=float(spec.ambient_c),
        peak_temp_c=peak_temp_c,
        peak_storage_temp_rise_c=peak_storage_rise_c,
        per_node_peak_c=per_node_peak_c,
        per_node_rise_c=per_node_rise_c,
        storage_node_ids=storage_node_ids,
        series=series,
        csv_text=csv_text,
    )
