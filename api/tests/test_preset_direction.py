"""Every preset target must point in the safer direction for its metric."""

from contracts.generated.python.models import Comparator, MetricSet, MetricStatus, MetricValue

from stratum_api.causal_agent import SAFER_DIRECTION, _build_validated_presets


def _metrics() -> MetricSet:
    values = [
        MetricValue(metric_id="min_gap_heat_to_storage_mm", value=9.0, unit="mm", status=MetricStatus.computed, part_ids=[], note=""),
        MetricValue(metric_id="min_enclosure_wall_mm", value=2.0, unit="mm", status=MetricStatus.computed, part_ids=[], note=""),
        MetricValue(metric_id="heat_path_to_exterior_mm", value=8.0, unit="mm", status=MetricStatus.computed, part_ids=[], note=""),
        MetricValue(metric_id="peak_storage_temp_rise_C", value=14.4, unit="C", status=MetricStatus.computed, part_ids=[], note=""),
    ]
    return MetricSet(run_id="widget-a", revision=0, values=values)


def test_no_preset_target_points_in_unsafe_direction() -> None:
    presets = _build_validated_presets(_metrics(), ["src-1"])
    assert len(presets) == 3
    for preset in presets:
        for target in preset.targets:
            larger_is_safer = SAFER_DIRECTION[target.metric_id]
            expected = Comparator.gte if larger_is_safer else Comparator.lte
            assert target.comparator == expected, (preset.preset_id, target.metric_id, target.comparator)


def test_gap_target_increases_when_chosen() -> None:
    metrics = MetricSet(run_id="widget-a", revision=0, values=[_metrics().values[0]])
    target = _build_validated_presets(metrics, [])[0].targets[0]
    assert target.comparator == Comparator.gte and target.threshold > 9.0
