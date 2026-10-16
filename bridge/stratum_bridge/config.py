"""Environment configuration for stratum_bridge."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class BridgeConfig:
    """Immutable configuration for MATLAB/Simulink bridge and parsers."""

    max_upload_bytes: int
    max_json_batch_bytes: int
    audit_tol_c: float
    http_timeout_s: int


def load_bridge_config() -> BridgeConfig:
    """Load bridge configuration from environment variables."""
    return BridgeConfig(
        max_upload_bytes=int(os.environ.get("STRATUM_BRIDGE_MAX_BYTES", str(5 * 1024 * 1024))),
        max_json_batch_bytes=int(os.environ.get("STRATUM_BRIDGE_BATCH_BYTES", str(4 * 1024 * 1024))),
        audit_tol_c=float(os.environ.get("STRATUM_BRIDGE_AUDIT_TOL_C", "0.5")),
        http_timeout_s=int(os.environ.get("STRATUM_BRIDGE_HTTP_TIMEOUT_S", "60")),
    )


BRIDGE_CONFIG: BridgeConfig = load_bridge_config()
