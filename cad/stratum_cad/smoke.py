"""Smoke test helper for building a 10 mm box and exporting STEP."""

from __future__ import annotations

import tempfile
from pathlib import Path

from build123d import Box, export_step

from stratum_cad.config import CONFIG
from stratum_cad.errors import CadOpInvalid, CompileFailed
from stratum_cad.logging_utils import log_event


def build_smoke_box_step(size_mm: float = 10.0, run_id: str = "smoke") -> bytes:
    """Build a deterministic cube in build123d and return STEP file bytes."""
    if not (CONFIG.min_dim_mm <= size_mm <= CONFIG.max_dim_mm):
        log_event(
            "smoke_box_invalid_dim",
            run_id=run_id,
            part_id="smoke_box",
            stage="smoke",
            size_mm=size_mm,
        )
        raise CadOpInvalid(
            f"Box dimension {size_mm} mm outside valid range "
            f"[{CONFIG.min_dim_mm}, {CONFIG.max_dim_mm}] mm.",
            recovery_hint="Specify size_mm between 0.2 mm and 2000.0 mm.",
            part_id="smoke_box",
            op_index=0,
        )
    try:
        solid = Box(size_mm, size_mm, size_mm)
        with tempfile.TemporaryDirectory() as tmp_dir:
            step_path = Path(tmp_dir) / "smoke_box.step"
            export_step(solid, str(step_path))
            step_bytes = step_path.read_bytes()
    except Exception as exc:
        log_event(
            "smoke_box_compile_failed",
            run_id=run_id,
            part_id="smoke_box",
            stage="smoke",
            error=str(exc),
        )
        raise CompileFailed(
            f"Failed to build or export smoke box STEP: {exc}",
            recovery_hint="Verify build123d/OCP installation and write permissions.",
            part_id="smoke_box",
            op_index=0,
        ) from exc

    log_event(
        "smoke_box_compiled",
        run_id=run_id,
        part_id="smoke_box",
        stage="smoke",
        size_mm=size_mm,
        step_bytes=len(step_bytes),
    )
    return step_bytes


def export_test_box(step_path: str | Path, size_mm: float = 10.0) -> bytes:
    """Export a deterministic test box STEP to step_path and return its bytes."""
    step_bytes = build_smoke_box_step(size_mm=size_mm)
    Path(step_path).write_bytes(step_bytes)
    return step_bytes
