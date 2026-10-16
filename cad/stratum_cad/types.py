"""Internal and public data structures for stratum_cad."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

PartRole = Literal[
    "heat_source", "energy_storage", "power_conversion", "enclosure",
    "structural_frame", "thermal_spreader", "user_contact_surface",
    "connector", "magnetic", "fastener", "moving_part", "other",
]
EvidenceStatus = Literal["OBSERVED", "DOCUMENTED", "INFERRED", "ASSUMED", "UNKNOWN"]
BasisType = Literal["source", "physics", "model_prior"]

VALID_PART_ROLES: frozenset[str] = frozenset({
    "heat_source", "energy_storage", "power_conversion", "enclosure", "structural_frame", "thermal_spreader",
    "user_contact_surface", "connector", "magnetic", "fastener", "moving_part", "other",
})


@dataclass(frozen=True)
class CadOp:
    """Single deterministic CAD operation in a part's feature stack."""
    op: str
    params: dict[str, float | str] = field(default_factory=dict)


@dataclass(frozen=True)
class Placement:
    """Rigid-body translation (mm) and Euler angles (deg) in CAD Z-up frame."""
    x_mm: float = 0.0
    y_mm: float = 0.0
    z_mm: float = 0.0
    rx_deg: float = 0.0
    ry_deg: float = 0.0
    rz_deg: float = 0.0


@dataclass(frozen=True)
class Part:
    """Engineering part definition with geometry ops, role, and thermal inputs."""
    part_id: str
    role: PartRole
    ops: list[CadOp]
    placement: Placement = field(default_factory=Placement)
    name: str = ""
    material: str = "aluminum_6061"
    nested_in: str | None = None
    power_w: float = 0.0
    power_status: EvidenceStatus = "ASSUMED"
    power_basis: BasisType = "model_prior"
    source_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a single assembly or solid verification check."""
    check_id: str
    passed: bool
    severity: Literal["error", "warn", "info"] = "error"
    part_ids: list[str] = field(default_factory=list)
    value: float | None = None
    details: str = ""


@dataclass(frozen=True)
class PartManifestEntry:
    """Compiled geometric properties of a single part."""
    part_id: str
    role: PartRole
    material: str
    volume_mm3: float
    surface_area_mm2: float
    bbox_min_mm: tuple[float, float, float]
    bbox_max_mm: tuple[float, float, float]
    centroid_mm: tuple[float, float, float]
    min_wall_mm: float | None = None
    vent_open_area_mm2: float = 0.0
    nested_in: str | None = None


@dataclass(frozen=True)
class Manifest:
    """Compiled CAD manifest with per-part geometry and check results."""
    parts: list[PartManifestEntry]
    checks: dict[str, CheckResult]
    step_sha256: str
    glb_sha256: str
    run_id: str = "widget-a"
    revision: int = 0
    coordinate_frame: str = "GLB:Y-up,STEP:Z-up,units:mm"

    def to_contract(self) -> object:
        """Convert this internal Manifest to the contract Pydantic model."""
        from stratum_cad.adapters import to_contract_manifest
        return to_contract_manifest(self)


@dataclass(frozen=True)
class CompileResult:
    """Result of compiling a list of parts into STEP, GLB, and Manifest."""
    step_bytes: bytes
    glb_bytes: bytes
    manifest: Manifest


@dataclass(frozen=True)
class MetricDef:
    """Catalog definition for a deterministic engineering metric."""
    metric_id: str
    title: str
    unit: str
    required_roles: list[PartRole]
    description: str = ""


@dataclass(frozen=True)
class MetricValue:
    """Computed value of a deterministic engineering metric."""
    metric_id: str
    value: float | list[float] | None
    unit: str
    part_ids: list[str]
    status: EvidenceStatus = "INFERRED"
    basis_type: BasisType = "physics"
    not_applicable: bool = False


@dataclass(frozen=True)
class MetricSet:
    """Collection of computed deterministic metrics for a design revision."""
    metrics: dict[str, MetricValue]
    run_id: str = "widget-a"
    revision: int = 0

    def to_contract(self) -> object:
        """Convert this internal MetricSet to the contract Pydantic model."""
        from stratum_cad.adapters import to_contract_metric_set
        return to_contract_metric_set(self)


@dataclass(frozen=True)
class StressPulse:
    """Optional time-windowed power multiplier for stress testing."""
    start_s: float
    end_s: float
    multiplier: float = 1.0


@dataclass(frozen=True)
class EngineeringSpec:
    """Complete engineering specification for metrics and thermal simulation."""
    parts: list[Part]
    run_id: str = "widget-a"
    revision: int = 0
    ambient_c: float = 25.0
    duration_s: float = 600.0
    dt_s: float = 1.0
    convection_h_w_m2k: float = 10.0
    contact_gap_cutoff_mm: float = 2.0
    pulses: list[StressPulse] = field(default_factory=list)


@dataclass(frozen=True)
class SimSample:
    """Single time-step sample for a thermal node."""
    time_s: float
    revision: int
    node_id: str
    temp_c: float
    power_w: float = 0.0


@dataclass(frozen=True)
class SimResult:
    """Result of deterministic lumped-RC backward-Euler thermal simulation."""
    run_id: str
    revision: int
    dt_s: float
    duration_s: float
    ambient_c: float
    peak_temp_c: float
    peak_storage_temp_rise_c: float | None
    per_node_peak_c: dict[str, float]
    per_node_rise_c: dict[str, float]
    storage_node_ids: list[str]
    series: list[SimSample]
    csv_text: str

    def to_contract(self, spec: EngineeringSpec | None = None) -> object:
        """Convert this internal SimResult to the contract Pydantic model."""
        from stratum_cad.adapters import to_contract_sim_result
        return to_contract_sim_result(self, spec)
