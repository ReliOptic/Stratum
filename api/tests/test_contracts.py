from __future__ import annotations

import json
import pathlib
from typing import Any

import jsonschema
import pytest

from contracts.generated.python import models as m

ROOT_DIR = pathlib.Path(__file__).resolve().parents[2]
CONTRACTS_DIR = ROOT_DIR / "contracts"
FIXTURES_DIR = CONTRACTS_DIR / "fixtures" / "widget-a"


def _load_json(path: pathlib.Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_widget_a_fixtures_validate_against_schemas() -> None:
    fixture_to_schema = {
        "spec_v0.json": "engineering_spec.schema.json",
        "graph_v0.json": "component_graph.schema.json",
        "metrics_v0.json": "metric_set.schema.json",
        "manifest_v0.json": "manifest.schema.json",
        "sim_v0.json": "sim_result.schema.json",
        "run.json": "run.schema.json",
    }
    for fixture_name, schema_name in fixture_to_schema.items():
        data = _load_json(FIXTURES_DIR / fixture_name)
        schema = _load_json(CONTRACTS_DIR / schema_name)
        jsonschema.validate(instance=data, schema=schema)


def test_widget_a_structure_requirements() -> None:
    spec = m.EngineeringSpec.model_validate(_load_json(FIXTURES_DIR / "spec_v0.json"))
    assert spec.product_title == "widget-a"
    assert spec.revision == 0
    assert len(spec.parts) == 4
    roles = {role.value for part in spec.parts for role in part.roles}
    for required_role in ("enclosure", "heat_source", "energy_storage", "connector"):
        assert required_role in roles

    graph = m.ComponentGraph.model_validate(_load_json(FIXTURES_DIR / "graph_v0.json"))
    assert graph.revision == 0
    assert len(graph.edges) == 2

    metrics = m.MetricSet.model_validate(_load_json(FIXTURES_DIR / "metrics_v0.json"))
    assert metrics.revision == 0
    assert len(metrics.values) >= 1


def test_pydantic_codegen_roundtrip_fixtures() -> None:
    pairs: list[tuple[str, type[Any], str]] = [
        ("spec_v0.json", m.EngineeringSpec, "engineering_spec.schema.json"),
        ("graph_v0.json", m.ComponentGraph, "component_graph.schema.json"),
        ("metrics_v0.json", m.MetricSet, "metric_set.schema.json"),
        ("manifest_v0.json", m.Manifest, "manifest.schema.json"),
        ("sim_v0.json", m.SimResult, "sim_result.schema.json"),
        ("run.json", m.Run, "run.schema.json"),
    ]
    for fixture_name, model_cls, schema_name in pairs:
        raw = _load_json(FIXTURES_DIR / fixture_name)
        instance = model_cls.model_validate(raw)
        dumped = instance.model_dump(mode="json")
        schema = _load_json(CONTRACTS_DIR / schema_name)
        jsonschema.validate(instance=dumped, schema=schema)
        reparsed = model_cls.model_validate(dumped)
        assert reparsed == instance


def test_additional_contract_models_roundtrip() -> None:
    samples: list[tuple[Any, str]] = [
        (
            m.Preset(
                preset_id="preset-thermal",
                title="Reduce heat_source peak temperature",
                rationale="Lower steady thermal stress on adjacent storage",
                source_ids=["src-page-1"],
                targets=[
                    m.Target(
                        metric_id="peak_temp_C",
                        comparator=m.Comparator.lte,
                        threshold=60.0,
                        unit="C",
                    )
                ],
            ),
            "preset.schema.json",
        ),
        (
            m.Objective(
                text="Keep storage rise under 15 C",
                targets=[
                    m.Target(
                        metric_id="storage_peak_rise_C",
                        comparator=m.Comparator.lt,
                        threshold=15.0,
                        unit="C",
                    )
                ],
                base_revision=0,
                objective_hash="sha256-abc123",
            ),
            "objective.schema.json",
        ),
        (
            m.ConfirmResponse(
                token="tok-123",
                expires_at="2026-10-16T01:00:00Z",
            ),
            "confirm_response.schema.json",
        ),
        (
            m.PassReport(
                revision=1,
                part_id="core-stage",
                pass_no=1,
                action="Increase clearance and add spreader path",
                prediction=m.Prediction(
                    metric_id="peak_temp_C",
                    expected_direction=m.ExpectedDirection.decrease,
                    expected_delta=-5.0,
                    falsified_if="peak_temp_C >= 68.4",
                    registered_at="2026-10-16T00:05:00Z",
                ),
                metric_deltas=[
                    m.MetricDelta(
                        metric_id="peak_temp_C",
                        before=68.4,
                        after=62.1,
                        delta=-6.3,
                        unit="C",
                    )
                ],
                verdict=m.PassVerdict.improved,
                outcome=m.PredictionOutcome.confirmed,
                external_outcome=None,
                suspicious=False,
                suspicious_reason=None,
                fitted_adjustment=False,
                at="2026-10-16T00:06:00Z",
            ),
            "pass_report.schema.json",
        ),
    ]
    for instance, schema_name in samples:
        dumped = instance.model_dump(mode="json")
        jsonschema.validate(instance=dumped, schema=_load_json(CONTRACTS_DIR / schema_name))
        assert type(instance).model_validate(dumped) == instance


def test_external_audit_and_telemetry_models_roundtrip() -> None:
    ext = m.ExternalSimResult(
        run_id="run-widget-a-001",
        revision=1,
        tool=m.ExternalTool.simulink,
        bundle_sha256="deadbeef",
        audit=m.AuditStatus.match,
        max_abs_diff_C=0.4,
        nodes=[
            m.ExternalSimNode(
                node_id="node_core-stage",
                part_id="core-stage",
                peak_temp_C=62.3,
                peak_rise_C=37.3,
                t_peak_s=535.0,
            )
        ],
        method="ode15s",
        instrument=None,
        imported_at="2026-10-16T00:10:00Z",
        source_id="src-ext-1",
    )
    jsonschema.validate(
        instance=ext.model_dump(mode="json"),
        schema=_load_json(CONTRACTS_DIR / "external_sim_result.schema.json"),
    )

    stats = m.RunStats(
        run_id="run-widget-a-001",
        orchestrator_model="gemini-4-argon",
        predictions_total=2,
        confirmed=2,
        refuted=0,
        inconclusive=0,
        external_confirmed=2,
        external_refuted=0,
        evidence_status_counts={"OBSERVED": 1, "DOCUMENTED": 3, "INFERRED": 2},
        downgrades=0,
        context_tokens=24000,
        wall_time_s=18.5,
    )
    bench = m.BenchmarkComparison(input_key="widget-a", runs=[stats])
    jsonschema.validate(
        instance=bench.model_dump(mode="json"),
        schema=_load_json(CONTRACTS_DIR / "benchmark_comparison.schema.json"),
    )


def test_status_and_revision_constraints() -> None:
    status_values = {s.value for s in m.RunStatus}
    assert "SIMULINK_EXECUTED" not in status_values
    assert "V0_READY" in status_values
    assert "V2_READY" in status_values

    ts_index = (CONTRACTS_DIR / "generated" / "ts" / "index.ts").read_text(encoding="utf-8")
    for expected_name in ("EngineeringSpec", "SimResult", "ExternalSimResult", "Run"):
        assert f"export interface {expected_name}" in ts_index

    with pytest.raises(Exception):
        m.ComponentGraph(run_id="run-widget-a-001", revision=4, edges=[])
