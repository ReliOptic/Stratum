"""Typed errors discriminated by code with recovery hints for Stratum API."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class StratumError(Exception):
    """Typed domain error discriminated by code with a recovery hint."""

    def __init__(
        self,
        code: str,
        message: str,
        recovery_hint: str,
        *,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.recovery_hint = recovery_hint
        self.status_code = status_code
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        """Convert error into a JSON-serializable payload."""
        payload: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "recovery_hint": self.recovery_hint,
        }
        if self.details:
            payload["details"] = self.details
        return payload


class ConfigError(StratumError):
    """Raised when required runtime configuration is missing or insecure."""

    def __init__(self, code: str, message: str, recovery_hint: str) -> None:
        super().__init__(
            code=code,
            message=message,
            recovery_hint=recovery_hint,
            status_code=500,
        )


class RateLimitError(StratumError):
    """Raised when an endpoint or probe exceeds its rate limit."""

    def __init__(self, endpoint: str, retry_after_s: float) -> None:
        super().__init__(
            code="RATE_LIMITED",
            message=f"Rate limit exceeded for {endpoint}.",
            recovery_hint=f"Wait {retry_after_s:.1f}s before retrying.",
            status_code=429,
            details={"endpoint": endpoint, "retry_after_s": round(retry_after_s, 2)},
        )


def register_error_handlers(app: FastAPI) -> None:
    """Register typed StratumError exception handler on a FastAPI app."""

    @app.exception_handler(StratumError)
    async def _handle_stratum_error(
        _request: Request, exc: StratumError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.to_dict(),
        )
