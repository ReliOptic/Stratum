"""Smoke tests for stratum_bridge package exports and MATLAB entrypoint generation."""

from __future__ import annotations

import stratum_bridge
from stratum_bridge import online_entrypoint


def test_bridge_public_exports() -> None:
    """Verify all required public functions exist on stratum_bridge."""
    required = (
        "build_bundle",
        "parse_external_results",
        "parse_measurement",
        "online_entrypoint",
        "parse_external_results_json",
    )
    for fn_name in required:
        assert hasattr(stratum_bridge, fn_name)


def test_online_entrypoint_smoke() -> None:
    """Verify online_entrypoint produces valid ASCII MATLAB script with exact endpoints."""
    script = online_entrypoint(
        base_url="https://example.invalid",
        token="tok_widget_a_123",
        members=["bundle_manifest.txt", "run_stratum_experiment.m"],
    )
    assert script.isascii()
    assert "https://example.invalid" in script
    assert "/api/b/%s/files/%s" in script
    assert "/api/b/%s/results" in script
    assert "STRATUM: results posted" in script
