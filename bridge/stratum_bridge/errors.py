"""Typed error definitions for stratum_bridge."""

from __future__ import annotations


class StratumBridgeError(Exception):
    """Base typed error for deterministic bridge and external result parsing."""

    code: str = "BRIDGE_ERROR"

    def __init__(
        self,
        message: str,
        *,
        recovery_hint: str,
        part_id: str | None = None,
        op_index: int | None = None,
        file: str | None = None,
        line: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.recovery_hint = recovery_hint
        self.part_id = part_id
        self.op_index = op_index
        self.file = file
        self.line = line

    @property
    def repair_hint(self) -> str:
        """Alias for recovery_hint to satisfy both contract conventions."""
        return self.recovery_hint

    def to_dict(self) -> dict[str, object]:
        """Serialize error details for structured logging or API responses."""
        return {
            "code": self.code,
            "message": self.message,
            "recovery_hint": self.recovery_hint,
            "repair_hint": self.recovery_hint,
            "part_id": self.part_id,
            "op_index": self.op_index,
            "file": self.file,
            "line": self.line,
        }


class BundleMismatch(StratumBridgeError):
    """Raised when imported external results do not match the expected run_id or bundle sha256."""

    code = "BUNDLE_MISMATCH"


class ResultsSchemaInvalid(StratumBridgeError):
    """Raised when external simulation or measurement files violate schema, size, or security rules."""

    code = "RESULTS_SCHEMA_INVALID"
