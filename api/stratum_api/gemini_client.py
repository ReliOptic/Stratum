"""Gemini Interactions API client wrapper with quota backoff and background polling."""

from __future__ import annotations

import json
import random
import re
import time
from collections.abc import Callable
from typing import Any

from stratum_api.errors import StratumError
from stratum_api.logging_utils import get_logger

logger = get_logger("stratum_api.gemini_client")

QuotaBackoffCallback = Callable[[int, float, str], None]

TERMINAL_OK_STATUSES = {"completed", "succeeded", "done"}
TERMINAL_ERR_STATUSES = {"failed", "cancelled", "canceled", "errored", "error"}


def is_quota_error(exc: Exception) -> bool:
    """Return True if the exception indicates a 429 or RESOURCE_EXHAUSTED quota error."""
    msg = str(exc).upper()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code == 429 or str(code) == "429":
        return True
    return "429" in msg or "RESOURCE_EXHAUSTED" in msg or "QUOTA" in msg


def _call_with_backoff(
    fn: Callable[[], Any],
    *,
    max_retries: int = 4,
    base_delay_s: float = 1.0,
    max_delay_s: float = 16.0,
    sleep_fn: Callable[[float], None] = time.sleep,
    on_quota_backoff: QuotaBackoffCallback | None = None,
) -> Any:
    """Execute a callable with bounded exponential backoff + jitter on 429 errors."""
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as exc:
            if not is_quota_error(exc) or attempt >= max_retries:
                raise
            attempt += 1
            jitter = random.uniform(0.0, 0.4 * base_delay_s)
            delay_s = min(max_delay_s, (base_delay_s * (2 ** (attempt - 1))) + jitter)
            delay_s = round(delay_s, 3)
            logger.log_event(
                "quota_backoff",
                stage="gemini_call",
                level="WARNING",
                message=str(exc),
                extra={"attempt": attempt, "delay_s": delay_s},
            )
            if on_quota_backoff is not None:
                on_quota_backoff(attempt, delay_s, str(exc))
            sleep_fn(delay_s)


def poll_background_interaction(
    client: Any,
    interaction: Any,
    *,
    poll_interval_s: float = 1.0,
    timeout_s: float = 900.0,
    sleep_fn: Callable[[float], None] = time.sleep,
    on_quota_backoff: QuotaBackoffCallback | None = None,
) -> Any:
    """Poll client.interactions.get(id=...) until background interaction finishes."""
    status = str(getattr(interaction, "status", "") or "").lower()
    interaction_id = getattr(interaction, "id", None)
    if not status or status in TERMINAL_OK_STATUSES or not interaction_id:
        return interaction
    deadline = time.monotonic() + timeout_s
    current = interaction
    while time.monotonic() < deadline:
        status = str(getattr(current, "status", "") or "").lower()
        if not status or status in TERMINAL_OK_STATUSES:
            return current
        if status in TERMINAL_ERR_STATUSES:
            err = getattr(current, "error", None) or f"Interaction status={status}"
            raise StratumError(
                code="INTERACTION_FAILED",
                message=f"Background interaction {interaction_id} failed: {err}",
                status_code=502,
                recovery_hint="Retry the pass or inspect upstream Gemini logs.",
            )
        sleep_fn(poll_interval_s)
        current = _call_with_backoff(
            lambda: client.interactions.get(id=interaction_id),
            sleep_fn=sleep_fn,
            on_quota_backoff=on_quota_backoff,
        )
    raise StratumError(
        code="INTERACTION_TIMEOUT",
        message=f"Background interaction {interaction_id} timed out after {timeout_s}s.",
        status_code=504,
        recovery_hint="Retry with a simpler input or check Gemini service latency.",
    )


def create_interaction(
    client: Any,
    *,
    max_retries: int = 4,
    base_delay_s: float = 1.0,
    poll_interval_s: float = 1.0,
    timeout_s: float = 900.0,
    sleep_fn: Callable[[float], None] = time.sleep,
    on_quota_backoff: QuotaBackoffCallback | None = None,
    **kwargs: Any,
) -> Any:
    """Create a Gemini interaction with 429 backoff and optional background polling."""
    interaction = _call_with_backoff(
        lambda: client.interactions.create(**kwargs),
        max_retries=max_retries,
        base_delay_s=base_delay_s,
        sleep_fn=sleep_fn,
        on_quota_backoff=on_quota_backoff,
    )
    if kwargs.get("background"):
        return poll_background_interaction(
            client,
            interaction,
            poll_interval_s=poll_interval_s,
            timeout_s=timeout_s,
            sleep_fn=sleep_fn,
            on_quota_backoff=on_quota_backoff,
        )
    return interaction


def extract_usage_tokens(interaction: Any) -> tuple[int, int]:
    """Return (input_tokens, output_tokens) from an interaction usage object."""
    usage = getattr(interaction, "usage", None)
    if usage is None:
        return (0, 0)
    in_tok = (
        getattr(usage, "total_input_tokens", None)
        or getattr(usage, "input_tokens", None)
        or 0
    )
    out_tok = (
        getattr(usage, "total_output_tokens", None)
        or getattr(usage, "output_tokens", None)
        or 0
    )
    return (int(in_tok), int(out_tok))


def extract_interaction_text(interaction: Any) -> str:
    """Extract concatenated model output text from an interaction object."""
    direct_text = getattr(interaction, "text", None) or getattr(
        interaction, "output_text", None
    )
    if isinstance(direct_text, str) and direct_text.strip():
        return direct_text.strip()
    chunks: list[str] = []
    for step in getattr(interaction, "steps", None) or []:
        if getattr(step, "type", None) == "thought":
            continue
        step_text = getattr(step, "text", None)
        if isinstance(step_text, str) and step_text.strip():
            chunks.append(step_text.strip())
        for block in getattr(step, "content", None) or []:
            b_text = getattr(block, "text", None)
            if isinstance(b_text, str) and b_text.strip():
                chunks.append(b_text.strip())
    return "\n".join(chunks).strip()


def extract_json_object(text: str) -> dict[str, Any]:
    """Parse a JSON object from model text, stripping markdown code fences if present."""
    cleaned = text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1)
    else:
        brace_start = cleaned.find("{")
        brace_end = cleaned.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            cleaned = cleaned[brace_start : brace_end + 1]
    parsed = json.loads(cleaned)
    if not isinstance(parsed, dict):
        raise ValueError("Expected JSON object at root")
    return parsed
