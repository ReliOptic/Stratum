"""Health probe endpoints for Gemini Interactions API and Managed Agent."""

from __future__ import annotations

import base64
import io
import time
from typing import Any

from google import genai
from PIL import Image

from stratum_api.config import AppConfig
from stratum_api.errors import RateLimitError
from stratum_api.gemini_client import create_interaction
from stratum_api.logging_utils import get_logger

logger = get_logger("stratum_api.probes")


class ProbeRateLimiter:
    """In-memory per-endpoint cooldown rate limiter."""

    def __init__(self, cooldown_s: float = 60.0) -> None:
        self._cooldown_s = cooldown_s
        self._last_called: dict[str, float] = {}

    def check_and_record(
        self, endpoint: str, now: float | None = None
    ) -> None:
        """Raise RateLimitError if called within cooldown window."""
        current = time.monotonic() if now is None else now
        prev = self._last_called.get(endpoint)
        if prev is not None and (current - prev) < self._cooldown_s:
            retry_after = self._cooldown_s - (current - prev)
            raise RateLimitError(endpoint=endpoint, retry_after_s=retry_after)
        self._last_called[endpoint] = current

    def reset(self) -> None:
        """Clear recorded probe timestamps."""
        self._last_called.clear()


def build_genai_client(config: AppConfig) -> genai.Client:
    """Instantiate a Google GenAI client for Vertex AI or API key backend."""
    if config.gemini_backend == "apikey" and config.gemini_api_key:
        return genai.Client(api_key=config.gemini_api_key)
    return genai.Client(
        vertexai=True,
        project=config.gcp_project,
        location=config.gemini_location,
    )


def make_tiny_png_b64() -> str:
    """Generate a tiny 1x1 PNG image encoded as base64."""
    buf = io.BytesIO()
    Image.new("RGB", (1, 1), color=(64, 128, 255)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def inspect_interaction_response(interaction: Any) -> dict[str, Any]:
    """Extract grounding fields, usage fields, and thought summary support."""
    grounding_fields: set[str] = set()
    thought_summary_supported = False
    for step in getattr(interaction, "steps", None) or []:
        step_type = getattr(step, "type", None)
        if step_type in ("google_search_call", "google_search_result"):
            grounding_fields.add(str(step_type))
        if step_type == "thought" and getattr(step, "summary", None):
            thought_summary_supported = True
        for block in getattr(step, "content", None) or []:
            for ann in getattr(block, "annotations", None) or []:
                if getattr(ann, "type", None) == "url_citation":
                    grounding_fields.add("url_citation")
    usage_obj = getattr(interaction, "usage", None)
    usage_fields: list[str] = []
    if usage_obj is not None:
        dump = (
            usage_obj.model_dump(exclude_none=True)
            if hasattr(usage_obj, "model_dump")
            else vars(usage_obj)
        )
        usage_fields = sorted(k for k, v in dump.items() if v is not None)
    return {
        "grounding_fields_present": sorted(grounding_fields),
        "usage_fields": usage_fields,
        "thought_summary_supported": thought_summary_supported,
    }


def run_gemini_probe(
    config: AppConfig, client: Any | None = None
) -> dict[str, Any]:
    """Run a low-thinking gemini-4-argon Interactions probe with Search + PNG."""
    start = time.monotonic()
    png_b64 = make_tiny_png_b64()
    prompt_input = [
        {"type": "text", "text": "Verify search and 1x1 image in one phrase."},
        {"type": "image", "data": png_b64, "mime_type": "image/png"},
    ]
    try:
        active_client = client or build_genai_client(config)
        interaction = create_interaction(
            active_client,
            model=config.orchestrator_model,
            input=prompt_input,
            tools=[{"type": "google_search"}],
            generation_config={
                "thinking_level": "low",
                "thinking_summaries": "auto",
            },
        )
        latency_ms = round((time.monotonic() - start) * 1000.0, 2)
        return {
            "ok": True,
            "latency_ms": latency_ms,
            **inspect_interaction_response(interaction),
            "image_input_ok": True,
        }
    except Exception as exc:  # noqa: BLE001
        latency_ms = round((time.monotonic() - start) * 1000.0, 2)
        logger.log_event(
            "gemini_probe_error",
            stage="health_probe",
            level="WARNING",
            message=str(exc),
        )
        return {
            "ok": False,
            "latency_ms": latency_ms,
            "grounding_fields_present": [],
            "usage_fields": [],
            "thought_summary_supported": False,
            "image_input_ok": False,
            "error": str(exc),
        }


def run_agent_probe(
    config: AppConfig, client: Any | None = None
) -> dict[str, Any]:
    """Run a minimal Managed Agent probe computing 2+2 in remote sandbox."""
    start = time.monotonic()
    try:
        active_client = client or build_genai_client(config)
        create_interaction(
            active_client,
            agent="antigravity-preview-09-2026",
            agent_config={
                "type": "antigravity",
                "model": config.orchestrator_model,
            },
            environment="remote",
            background=True,
            input="Compute 2+2 in Python and return only the integer result.",
        )
        latency_ms = round((time.monotonic() - start) * 1000.0, 2)
        return {"available": True, "latency_ms": latency_ms}
    except Exception as exc:  # noqa: BLE001
        latency_ms = round((time.monotonic() - start) * 1000.0, 2)
        logger.log_event(
            "agent_probe_error",
            stage="health_probe",
            level="WARNING",
            message=str(exc),
        )
        return {"available": False, "latency_ms": latency_ms, "error": str(exc)}
