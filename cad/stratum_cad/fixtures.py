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


def make_widget_a_slim_15_parts() -> list[Part]:
    """Return a synthetic 15-part slim assembly (0.8-1.5 mm walls, flat storage, coil heat source, spreader)."""
    return [
        Part("enc_lower", "enclosure", [
            CadOp("rounded_box", {"dx_mm": 92.0, "dy_mm": 58.0, "dz_mm": 9.0, "fillet_mm": 2.0}),
            CadOp("shell", {"wall_mm": 1.2, "open_face": 1.0}),
            CadOp("cut_box", {"dx_mm": 14.0, "dy_mm": 4.0, "dz_mm": 3.0, "cy_mm": 29.0, "cz_mm": 1.0}),
        ], Placement(0.0, 0.0, -0.5), material="abs_plastic"),
        Part("enc_upper", "enclosure", [
            CadOp("rounded_box", {"dx_mm": 92.0, "dy_mm": 58.0, "dz_mm": 0.9, "fillet_mm": 2.0}),
        ], Placement(0.0, 0.0, 4.45), material="polycarbonate", nested_in="enc_lower"),
        Part("contact_pad_top", "user_contact_surface", [
            CadOp("rounded_box", {"dx_mm": 84.0, "dy_mm": 50.0, "dz_mm": 0.8, "fillet_mm": 2.0}),
        ], Placement(0.0, 0.0, 5.35), material="silicone_pad"),
        Part("heat_coil_primary", "heat_source", [
            CadOp("cylinder", {"radius_mm": 15.0, "height_mm": 1.4}),
            CadOp("cut_cylinder", {"radius_mm": 6.0, "height_mm": 2.0}),
        ], Placement(16.0, 0.0, 2.8), material="copper_c110", nested_in="enc_lower", power_w=2.8),
        Part("heat_driver_stage", "heat_source", [
            CadOp("box", {"dx_mm": 10.0, "dy_mm": 8.0, "dz_mm": 1.4}),
        ], Placement(-28.0, 12.0, 2.2), material="copper_fr4", nested_in="enc_lower", power_w=1.4),
        Part("mag_ferrite_shield", "magnetic", [
            CadOp("cylinder", {"radius_mm": 16.0, "height_mm": 0.8}),
        ], Placement(16.0, 0.0, 1.5), material="ferrite_ceramic", nested_in="enc_lower"),
        Part("spreader_sheet_main", "thermal_spreader", [
            CadOp("box", {"dx_mm": 78.0, "dy_mm": 48.0, "dz_mm": 0.4}),
        ], Placement(0.0, 0.0, 0.7), material="graphite_sheet", nested_in="enc_lower"),
        Part("spreader_pad_aux", "thermal_spreader", [
            CadOp("box", {"dx_mm": 22.0, "dy_mm": 16.0, "dz_mm": 0.5}),
        ], Placement(-28.0, 12.0, 1.2), material="copper_c110", nested_in="enc_lower"),
        Part("storage_cell_main", "energy_storage", [
            CadOp("box", {"dx_mm": 52.0, "dy_mm": 44.0, "dz_mm": 2.8}),
        ], Placement(12.0, 0.0, -1.2), material="layered_pouch", nested_in="enc_lower"),
        Part("storage_cell_aux", "energy_storage", [
            CadOp("box", {"dx_mm": 52.0, "dy_mm": 44.0, "dz_mm": 1.2}),
        ], Placement(12.0, 0.0, -3.3), material="layered_pouch", nested_in="enc_lower"),
        Part("pwr_board_main", "power_conversion", [
            CadOp("box", {"dx_mm": 18.0, "dy_mm": 44.0, "dz_mm": 1.2}),
        ], Placement(-28.0, 0.0, -0.2), material="copper_fr4", nested_in="enc_lower", power_w=0.6),
        Part("frame_mid_rib", "structural_frame", [
            CadOp("box", {"dx_mm": 2.0, "dy_mm": 48.0, "dz_mm": 3.0}),
        ], Placement(-15.5, 0.0, -1.8), material="aluminum_6061", nested_in="enc_lower"),
        Part("io_port_housing", "connector", [
            CadOp("box", {"dx_mm": 7.0, "dy_mm": 6.0, "dz_mm": 2.4}),
        ], Placement(-41.0, 0.0, -1.8), material="stainless_steel", nested_in="enc_lower"),
        Part("fastener_post_nw", "fastener", [
            CadOp("cylinder", {"radius_mm": 1.5, "height_mm": 3.0}),
        ], Placement(-41.0, 23.0, -1.8), material="steel_1018", nested_in="enc_lower"),
        Part("fastener_post_se", "fastener", [
            CadOp("cylinder", {"radius_mm": 1.5, "height_mm": 3.0}),
        ], Placement(41.0, -23.0, -1.8), material="steel_1018", nested_in="enc_lower"),
    ]


def make_widget_a_slim_15_spec(duration_s: float = 300.0) -> EngineeringSpec:
    """Build synthetic 15-part slim widget-a EngineeringSpec."""
    return EngineeringSpec(parts=make_widget_a_slim_15_parts(), run_id="widget-a", revision=0, duration_s=duration_s)
