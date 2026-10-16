"""Public interface for stratum_bridge: MATLAB/Simulink bundle and external result parsers."""

from __future__ import annotations

from stratum_bridge.bundle import build_bundle
from stratum_bridge.errors import (
    BundleMismatch,
    ResultsSchemaInvalid,
    StratumBridgeError,
)
from stratum_bridge.matlab_gen import generate_experiment_script, online_entrypoint
from stratum_bridge.measurement import (
    parse_external_results_json,
    parse_measurement,
)
from stratum_bridge.parsers import parse_external_results
from stratum_bridge.types import AuditOutcome, ExternalSample, ExternalSimResult

__all__ = [
    "AuditOutcome",
    "BundleMismatch",
    "ExternalSample",
    "ExternalSimResult",
    "ResultsSchemaInvalid",
    "StratumBridgeError",
    "build_bundle",
    "generate_experiment_script",
    "online_entrypoint",
    "parse_external_results",
    "parse_external_results_json",
    "parse_measurement",
]
