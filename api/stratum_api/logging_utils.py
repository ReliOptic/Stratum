"""Structured JSON logging utilities for Stratum API."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any


def format_log_entry(
    event: str,
    *,
    run_id: str | None = None,
    part_id: str | None = None,
    stage: str | None = None,
    level: str = "INFO",
    message: str = "",
    extra: dict[str, Any] | None = None,
) -> str:
    """Serialize a structured log event into a single-line JSON string."""
    payload: dict[str, Any] = {
        "at": datetime.now(timezone.utc).isoformat(),
        "level": level.upper(),
        "event": event,
        "run_id": run_id,
        "part_id": part_id,
        "stage": stage,
        "message": message,
    }
    if extra:
        payload["extra"] = extra
    return json.dumps(payload, separators=(",", ":"), sort_keys=False)


class StructuredLogger:
    """Structured JSON logger emitting event, run_id, part_id, and stage."""

    def __init__(self, name: str = "stratum_api") -> None:
        self._logger = logging.getLogger(name)
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(logging.Formatter("%(message)s"))
            self._logger.addHandler(handler)
            self._logger.setLevel(logging.INFO)
            self._logger.propagate = False

    def log_event(
        self,
        event: str,
        *,
        run_id: str | None = None,
        part_id: str | None = None,
        stage: str | None = None,
        level: str = "INFO",
        message: str = "",
        extra: dict[str, Any] | None = None,
    ) -> str:
        """Emit a structured JSON log line and return the formatted string."""
        line = format_log_entry(
            event,
            run_id=run_id,
            part_id=part_id,
            stage=stage,
            level=level,
            message=message,
            extra=extra,
        )
        log_level = getattr(logging, level.upper(), logging.INFO)
        self._logger.log(log_level, line)
        return line


def get_logger(name: str = "stratum_api") -> StructuredLogger:
    """Return a configured StructuredLogger instance."""
    return StructuredLogger(name=name)
