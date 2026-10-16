"""Public and internal data types for stratum_bridge."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

AuditOutcome = Literal["MATCH", "MISMATCH", "not_applicable"]
ExternalToolType = Literal["simulink", "measurement"]


@dataclass(frozen=True)
class ExternalSample:
    """Single external simulation or lab measurement sample."""

    time_s: float
    revision: int
    node_id: str
    temp_c: float
    current_a: float | None = None
    voltage_v: float | None = None


@dataclass(frozen=True)
class ExternalSimResult:
    """Parsed and server-audited external simulation or measurement result."""

    run_id: str
    tool: ExternalToolType
    audit: AuditOutcome
    max_abs_diff_c: float | None
    worst_t_s: float | None
    worst_node_id: str | None
    per_node_peak_c: dict[str, float]
    per_revision_node_peak_c: dict[int, dict[str, float]] = field(default_factory=dict)
    bundle_sha256: str | None = None
    matlab_version: str | None = None
    timestamp: str | None = None
    series: list[ExternalSample] = field(default_factory=list)
    meta: dict[str, str] = field(default_factory=dict)

    def to_contract(self, revision: int | None = None, ambient_c: float = 25.0) -> object:
        """Convert this internal ExternalSimResult to the contract Pydantic model."""
        from stratum_bridge.adapters import to_contract_external_result
        return to_contract_external_result(self, revision=revision, ambient_c=ambient_c)
