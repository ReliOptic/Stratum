"""Structured JSON logging utilities for stratum_cad."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

_LOGGER = logging.getLogger("stratum_cad")
if not _LOGGER.handlers:
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(logging.Formatter("%(message)s"))
    _LOGGER.addHandler(_handler)
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.propagate = False


def log_event(
    event: str,
    *,
    run_id: str = "unknown",
    part_id: str | None = None,
    stage: str = "cad",
    level: int = logging.INFO,
    **fields: object,
) -> None:
    """Emit a structured JSON log line with required telemetry fields."""
    payload: dict[str, object] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "run_id": run_id,
        "part_id": part_id,
        "stage": stage,
        **fields,
    }
    _LOGGER.log(level, json.dumps(payload, default=str, sort_keys=True))
