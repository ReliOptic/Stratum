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


_STATUS = {"OBSERVED", "DOCUMENTED", "INFERRED", "ASSUMED", "UNKNOWN"}
_BASIS = {"source", "physics", "model_prior"}
_LAYER = {"surface", "internal", "kernel"}
_ROLES = {"heat_source", "energy_storage", "power_conversion", "enclosure", "structural_frame", "thermal_spreader",
          "user_contact_surface", "connector", "magnetic", "fastener", "moving_part", "other"}


def normalize_labels(raw: dict[str, Any]) -> int:
    """Map unknown evidence labels to the WEAKEST valid label (never upgrade evidence). Returns count changed."""
    changed = 0
    for part in raw.get("parts") or []:
        if not isinstance(part, dict):
            continue
        if str(part.get("layer", "")).lower() not in _LAYER:
            part["layer"], changed = "internal", changed + 1
        else:
            part["layer"] = str(part["layer"]).lower()
        roles = [str(r).lower() for r in part.get("roles") or [] if str(r).lower() in _ROLES]
        if len(roles) != len(part.get("roles") or []):
            changed += 1
        part["roles"] = roles or ["other"]
        for prm in part.get("parameters") or []:
            if not isinstance(prm, dict):
                continue
            status = str(prm.get("status", "")).upper()
            if status not in _STATUS:
                prm["status"], changed = "ASSUMED", changed + 1
            else:
                prm["status"] = status
            basis = str(prm.get("basis_type", "")).lower()
            if basis not in _BASIS:
                prm["basis_type"], changed = "model_prior", changed + 1
            else:
                prm["basis_type"] = basis
    return changed


def _parse(text: str, run_id: str, sources: list[EvidenceSource]) -> tuple[EngineeringSpec | None, str, int]:
    try:
        raw = extract_json_object(text)
        changed = normalize_labels(raw)
        raw["run_id"] = run_id
        raw["revision"] = 0
        raw["sources"] = [s.model_dump(mode="json") for s in sources]
        return EngineeringSpec.model_validate(raw), "", changed
    except Exception as exc:  # noqa: BLE001 - validation errors are reported, not hidden
        return None, str(exc)[:1800], 0


def try_parse_spec(text: str, run_id: str, sources: list[EvidenceSource]) -> tuple[EngineeringSpec | None, str]:
    """Return (spec, "") on success or (None, error message) on failure."""
    spec, err, _ = _parse(text, run_id, sources)
    return spec, err


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
    spec, err, changed = _parse(text, run_id, sources)
    if spec is not None:
        if changed:
            emit("v0", "warn", f"{changed} evidence labels were not in the allowed set and were downgraded", None, {"downgraded_labels": changed})
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
    spec, err2, changed = _parse(extract_interaction_text(inter), run_id, sources)
    if spec is not None and changed:
        emit("v0", "warn", f"{changed} evidence labels were not in the allowed set and were downgraded", None, {"downgraded_labels": changed})
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
