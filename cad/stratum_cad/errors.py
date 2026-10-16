"""Typed error definitions for stratum_cad."""

from __future__ import annotations


class StratumCadError(Exception):
    """Base typed error for deterministic CAD and simulation operations."""

    code: str = "CAD_ERROR"

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
        """Serialize error details for structured logging or API payloads."""
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


class CadOpInvalid(StratumCadError):
    """Raised when a CAD operation is unknown or violates geometric bounds."""

    code = "CAD_OP_INVALID"


class CompileFailed(StratumCadError):
    """Raised when solid construction, STEP export, or GLB export fails."""

    code = "COMPILE_FAILED"


class CheckFailed(StratumCadError):
    """Raised when post-compilation geometric or round-trip checks fail."""

    code = "CHECK_FAILED"
