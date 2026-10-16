"""Environment configuration for stratum_cad."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class CadConfig:
    """Immutable configuration loaded from environment variables."""

    max_revision: int
    min_dim_mm: float
    max_dim_mm: float
    min_wall_mm: float
    step_vol_tol_ratio: float
    sim_dt_s: float
    sim_duration_s: float
    sim_ambient_c: float
    log_level: str


def load_config() -> CadConfig:
    """Load CAD configuration from environment variables."""
    return CadConfig(
        max_revision=int(os.environ.get("MAX_REVISION", "3")),
        min_dim_mm=float(os.environ.get("STRATUM_CAD_MIN_DIM_MM", "0.1")),
        max_dim_mm=float(os.environ.get("STRATUM_CAD_MAX_DIM_MM", "2000.0")),
        min_wall_mm=float(os.environ.get("STRATUM_CAD_MIN_WALL_MM", "0.2")),
        step_vol_tol_ratio=float(os.environ.get("STRATUM_STEP_VOL_TOL", "0.01")),
        sim_dt_s=float(os.environ.get("STRATUM_SIM_DT_S", "1.0")),
        sim_duration_s=float(os.environ.get("STRATUM_SIM_DURATION_S", "600.0")),
        sim_ambient_c=float(os.environ.get("STRATUM_SIM_AMBIENT_C", "25.0")),
        log_level=os.environ.get("STRATUM_LOG_LEVEL", "INFO"),
    )


CONFIG: CadConfig = load_config()
