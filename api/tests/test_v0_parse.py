"""V0 parsing never substitutes canned parts: it repairs once via the model or fails."""

from types import SimpleNamespace
from typing import Any

import pytest

from stratum_api import v0_parse
from stratum_api.errors import StratumError


def _events() -> tuple[list[tuple[Any, ...]], Any]:
    log: list[tuple[Any, ...]] = []
    return log, lambda *a: log.append(a)


def test_invalid_output_fails_after_one_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(v0_parse, "create_interaction", lambda client, **kw: calls.append(kw["input"]) or SimpleNamespace())
    monkeypatch.setattr(v0_parse, "extract_interaction_text", lambda inter: "{\"parts\": \"not a list\"}")
    monkeypatch.setattr(v0_parse, "extract_usage_tokens", lambda inter: (1, 1))
    log, emit = _events()
    with pytest.raises(StratumError) as exc:
        v0_parse.parse_spec_with_repair("not json", "run_x", [], client=None, model_name="m", schema_hint="h", emit=emit)
    assert exc.value.code == "V0_SCHEMA_INVALID"
    assert len(calls) == 1
    assert any(e[1] == "error" for e in log)


def test_try_parse_reports_error_instead_of_fallback() -> None:
    spec, err = v0_parse.try_parse_spec("{}", "run_x", [])
    assert spec is None and err
