"""Synthetic widget-a fixture specifications for CAD, metrics, simulation, and bridge tests."""

from __future__ import annotations

from stratum_cad.types import CadOp, EngineeringSpec, Part, Placement


def make_widget_a_parts(revision: int = 0) -> list[Part]:
    """Return synthetic widget-a part definitions for the given revision (0, 1, or 2)."""
    storage_x_mm = 11.5 if revision == 0 else (15.0 if revision == 1 else 18.0)
    spreader_x_mm = 30.0 if revision == 0 else (35.0 if revision == 1 else 40.0)
    enclosure_ops = [
        CadOp(op="box", params={"x_mm": 100.0, "y_mm": 60.0, "z_mm": 30.0}),
        CadOp(op="shell", params={"wall_mm": 2.0}),
        CadOp(
            op="cut_box",
            params={"x_mm": 10.0, "y_mm": 4.0, "z_mm": 6.0, "cx_mm": -15.0, "cy_mm": 0.0, "cz_mm": 14.0},
        ),
    ]
    if revision >= 1:
        enclosure_ops.append(
            CadOp(
                op="cut_box",
                params={"x_mm": 10.0, "y_mm": 4.0, "z_mm": 6.0, "cx_mm": 15.0, "cy_mm": 0.0, "cz_mm": 14.0},
            )
        )
    return [
        Part(
            part_id="enclosure_shell",
            name="Widget-A Outer Shell",
            role="enclosure",
            material="abs_plastic",
            ops=enclosure_ops,
            placement=Placement(x_mm=0.0, y_mm=0.0, z_mm=0.0),
            power_w=0.0,
            power_status="DOCUMENTED",
            power_basis="physics",
        ),
        Part(
            part_id="core_heater",
            name="Widget-A Thermal Core",
            role="heat_source",
            material="aluminum_6061",
            ops=[CadOp(op="box", params={"x_mm": 20.0, "y_mm": 20.0, "z_mm": 10.0})],
            placement=Placement(x_mm=-15.0, y_mm=0.0, z_mm=0.0),
            nested_in="enclosure_shell",
            power_w=5.0,
            power_status="DOCUMENTED",
            power_basis="physics",
        ),
        Part(
            part_id="thermal_spreader_plate",
            name="Widget-A Spreader Plate",
            role="thermal_spreader",
            material="copper_c110",
            ops=[CadOp(op="box", params={"x_mm": spreader_x_mm, "y_mm": 20.0, "z_mm": 2.0})],
            placement=Placement(x_mm=-15.0, y_mm=0.0, z_mm=6.0),
            nested_in="enclosure_shell",
            power_w=0.0,
            power_status="DOCUMENTED",
            power_basis="physics",
        ),
        Part(
            part_id="storage_unit",
            name="Widget-A Energy Storage Block",
            role="energy_storage",
            material="storage_cell_composite",
            ops=[CadOp(op="box", params={"x_mm": 30.0, "y_mm": 20.0, "z_mm": 10.0})],
            placement=Placement(x_mm=storage_x_mm, y_mm=0.0, z_mm=0.0),
            nested_in="enclosure_shell",
            power_w=0.5,
            power_status="INFERRED",
            power_basis="physics",
        ),
    ]


def make_widget_a_spec(revision: int = 0, duration_s: float = 120.0) -> EngineeringSpec:
    """Build synthetic widget-a EngineeringSpec for deterministic tests and fixtures."""
    return EngineeringSpec(
        parts=make_widget_a_parts(revision=revision),
        run_id="widget-a",
        revision=revision,
        ambient_c=25.0,
        duration_s=duration_s,
        dt_s=1.0,
    )
