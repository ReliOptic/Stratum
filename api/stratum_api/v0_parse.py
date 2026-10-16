"""Parse the model's V0 JSON into an EngineeringSpec, with one model-driven repair round.

There is no hard-coded fallback: if the model cannot produce a valid spec, the run fails honestly.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from contracts.generated.python.models import EngineeringSpec, EvidenceSource
from stratum_api.errors import StratumError
from stratum_api.gemini_client import (
    create_interaction,
    extract_interaction_text,
    extract_json_object,
    extract_usage_tokens,
)

EmitFn = Callable[[str, str, str, str | None, dict[str, Any]], None]


def try_parse_spec(text: str, run_id: str, sources: list[EvidenceSource]) -> tuple[EngineeringSpec | None, str]:
    """Return (spec, "") on success or (None, error message) on failure."""
    try:
        raw = extract_json_object(text)
        raw["run_id"] = run_id
        raw["revision"] = 0
        raw["sources"] = [s.model_dump(mode="json") for s in sources]
        return EngineeringSpec.model_validate(raw), ""
    except Exception as exc:  # noqa: BLE001 - validation errors are reported, not hidden
        return None, str(exc)[:1800]


def parse_spec_with_repair(
    text: str,
    run_id: str,
    sources: list[EvidenceSource],
    *,
    client: Any,
    model_name: str,
    schema_hint: str,
    emit: EmitFn,
    on_backoff: Any = None,
) -> tuple[EngineeringSpec, int, int]:
    """Validate the model output; on failure ask the same model once to fix it, else raise."""
    spec, err = try_parse_spec(text, run_id, sources)
    if spec is not None:
        return spec, 0, 0
    emit("v0", "warn", "Model output failed schema validation; asking the model to repair it", None, {"error": err[:600]})
    prompt = (
        f"{schema_hint}\n\nYour previous JSON failed validation with this error:\n{err}\n\n"
        f"Previous output:\n{text[:12000]}\n\nReturn ONLY the corrected JSON object. Keep the same parts and values; fix structure only."
    )
    inter = create_interaction(
        client,
        model=model_name,
        input=prompt,
        generation_config={"thinking_level": "low"},
        on_quota_backoff=on_backoff,
    )
    in_tok, out_tok = extract_usage_tokens(inter)
    spec, err2 = try_parse_spec(extract_interaction_text(inter), run_id, sources)
    if spec is None:
        emit("v0", "error", "Reconstruction failed: model output still invalid after one repair", None, {"error": err2[:600]})
        raise StratumError(
            code="V0_SCHEMA_INVALID",
            message="The model could not produce a valid part list for this product.",
            recovery_hint="Retry, or try the other orchestrator model.",
            status_code=502,
            details={"error": err2[:600]},
        )
    emit("v0", "info", "Model repaired its output; spec validated", None, {})
    return spec, in_tok, out_tok


def repair_cad_with_model(
    spec: EngineeringSpec,
    cad_error: str,
    sources: list[EvidenceSource],
    *,
    client: Any,
    model_name: str,
    schema_hint: str,
    emit: EmitFn,
    on_backoff: Any = None,
) -> tuple[EngineeringSpec, int, int]:
    """Send the CAD checker's error back to the model once and return its corrected spec."""
    emit("cad", "warn", "CAD checks failed; asking the model to fix its geometry", None, {"error": cad_error[:600]})
    body = spec.model_dump(mode="json", exclude={"sources"})
    prompt = (
        f"{schema_hint}\n\nThe CAD kernel rejected this assembly:\n{cad_error[:2000]}\n\n"
        f"Assembly JSON:\n{json.dumps(body)[:14000]}\n\n"
        "Return ONLY the corrected JSON. Move or resize parts so no undeclared parts overlap; keep values and evidence."
    )
    inter = create_interaction(
        client, model=model_name, input=prompt, generation_config={"thinking_level": "low"}, on_quota_backoff=on_backoff
    )
    in_tok, out_tok = extract_usage_tokens(inter)
    fixed, err = try_parse_spec(extract_interaction_text(inter), spec.run_id, sources)
    if fixed is None:
        raise StratumError(code="V0_CAD_REPAIR_INVALID", message="Model geometry repair was not valid JSON.", status_code=502, details={"error": err[:600]})
    return fixed, in_tok, out_tok
