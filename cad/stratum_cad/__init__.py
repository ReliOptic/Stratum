"""Public interface for stratum_cad: deterministic geometry, metrics, and simulation."""

from __future__ import annotations

from stratum_cad.compiler import compile_parts
from stratum_cad.errors import (
    CadOpInvalid,
    CheckFailed,
    CompileFailed,
    StratumCadError,
)
from stratum_cad.materials import MATERIAL_TABLE, MaterialProps, get_material_props
from stratum_cad.metrics import compute_metrics, metric_catalog
from stratum_cad.rc_network import (
    RCEdge,
    RCNetwork,
    RCNode,
    build_rc_network,
    generate_stress_scenario,
)
from stratum_cad.simulator import simulate
from stratum_cad.smoke import build_smoke_box_step
from stratum_cad.types import (
    BasisType,
    CadOp,
    CheckResult,
    CompileResult,
    EngineeringSpec,
    EvidenceStatus,
    Manifest,
    MetricDef,
    MetricSet,
    MetricValue,
    Part,
    PartManifestEntry,
    PartRole,
    Placement,
    SimResult,
    SimSample,
    StressPulse,
)

__all__ = [
    "BasisType",
    "CadOp",
    "CadOpInvalid",
    "CheckFailed",
    "CheckResult",
    "CompileFailed",
    "CompileResult",
    "EngineeringSpec",
    "EvidenceStatus",
    "MATERIAL_TABLE",
    "Manifest",
    "MaterialProps",
    "MetricDef",
    "MetricSet",
    "MetricValue",
    "Part",
    "PartManifestEntry",
    "PartRole",
    "Placement",
    "RCEdge",
    "RCNetwork",
    "RCNode",
    "SimResult",
    "SimSample",
    "StratumCadError",
    "StressPulse",
    "build_rc_network",
    "build_smoke_box_step",
    "compile_parts",
    "compute_metrics",
    "generate_stress_scenario",
    "get_material_props",
    "metric_catalog",
    "simulate",
]
