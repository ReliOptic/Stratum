"""Structured JSON logging utilities for stratum_bridge."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

_LOGGER = logging.getLogger("stratum_bridge")
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
    stage: str = "bridge",
    level: int = logging.INFO,
    **fields: object,
) -> None:
    """Emit a structured JSON log line without leaking tokens or secrets."""
    safe_fields = {k: v for k, v in fields.items() if "token" not in k.lower()}
    payload: dict[str, object] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "run_id": run_id,
        "part_id": part_id,
        "stage": stage,
        **safe_fields,
    }
    _LOGGER.log(level, json.dumps(payload, default=str, sort_keys=True))
