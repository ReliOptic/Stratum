"""JSON external results parser and empirical measurement parser."""

from __future__ import annotations

import csv
import io
import json

from typing import Any

from stratum_bridge.adapters import adapt_sim_result
from stratum_bridge.config import BRIDGE_CONFIG
from stratum_bridge.errors import BundleMismatch, ResultsSchemaInvalid
from stratum_bridge.logging_utils import log_event
from stratum_bridge.parsers import (
    REQUIRED_MEASUREMENT_FILES,
    _check_not_formula_injected,
    _decode_and_check_size,
    _parse_kv_manifest,
    _reaudit_against_expected,
)
from stratum_bridge.types import ExternalSample, ExternalSimResult
from stratum_cad.adapters import adapt_spec
from stratum_cad.types import EngineeringSpec, SimResult


def parse_external_results_json(
    payload: bytes,
    expected_bundle_sha256: str,
    expected: SimResult | Any,
) -> ExternalSimResult:
    """Validate and server-audit JSON payload posted by MATLAB Online stratum.m."""
    expected = adapt_sim_result(expected)
    if len(payload) > BRIDGE_CONFIG.max_upload_bytes:
        raise ResultsSchemaInvalid(
            f"JSON payload size {len(payload)} exceeds {BRIDGE_CONFIG.max_upload_bytes} bytes.",
            recovery_hint="Batch results payload to <= 4 MB per request.",
            file="payload.json",
            line=1,
        )
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResultsSchemaInvalid(
            f"Invalid UTF-8 JSON payload: {exc}",
            recovery_hint="Ensure MATLAB webwrite sends valid UTF-8 JSON.",
            file="payload.json",
            line=1,
        ) from exc

    if not isinstance(data, dict):
        raise ResultsSchemaInvalid("JSON root must be an object.", recovery_hint="Provide {manifest, audit, results}.", file="payload.json", line=1)
    man, rows = data.get("manifest"), data.get("results")
    if not isinstance(man, dict) or not isinstance(rows, list) or not rows:
        raise ResultsSchemaInvalid("Missing 'manifest' or 'results'.", recovery_hint="Include manifest and results.", file="payload.json", line=1)
    run_id, b_sha = str(man.get("run_id", "")), str(man.get("bundle_sha256", ""))
    if run_id != expected.run_id or b_sha != expected_bundle_sha256:
        raise BundleMismatch(
            f"JSON manifest mismatch: got (run_id='{run_id}', sha='{b_sha}'), "
            f"expected (run_id='{expected.run_id}', sha='{expected_bundle_sha256}').",
            recovery_hint="Verify token and bundle_sha256 match the active run.",
            file="payload.json",
            line=1,
        )

    samples: list[ExternalSample] = []
    peaks: dict[str, float] = {}
    rev_peaks: dict[int, dict[str, float]] = {}
    for idx, item in enumerate(rows, start=1):
        if not isinstance(item, dict):
            raise ResultsSchemaInvalid("Row is not an object.", recovery_hint="Format row as object.", file="payload.json", line=idx)
        node_id = str(item.get("node_id", "")).strip()
        _check_not_formula_injected(node_id, "payload.json", idx)
        try:
            t_s, rev, temp_c = float(item["time_s"]), int(item["revision"]), float(item["temp_C"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ResultsSchemaInvalid(
                f"Invalid fields in JSON results[{idx}]: {exc}",
                recovery_hint="Provide numeric time_s, revision, temp_C and string node_id.",
                file="payload.json",
                line=idx,
            ) from exc
        if not node_id:
            raise ResultsSchemaInvalid("Empty node_id.", recovery_hint="Provide node_id.", file="payload.json", line=idx)
        samples.append(ExternalSample(time_s=t_s, revision=rev, node_id=node_id, temp_c=temp_c))
        peaks[node_id] = max(peaks.get(node_id, -1e9), round(temp_c, 4))
        rev_map = rev_peaks.setdefault(rev, {})
        rev_map[node_id] = max(rev_map.get(node_id, -1e9), round(temp_c, 4))

    audit, max_diff, worst_t, worst_node = _reaudit_against_expected(samples, expected)
    log_event("parse_external_json_ok", run_id=run_id, stage="bridge", audit=audit, max_diff=max_diff)
    return ExternalSimResult(
        run_id=run_id,
        tool="simulink",
        audit=audit,
        max_abs_diff_c=max_diff,
        worst_t_s=worst_t,
        worst_node_id=worst_node,
        per_node_peak_c=peaks,
        per_revision_node_peak_c=rev_peaks,
        bundle_sha256=b_sha,
        matlab_version=str(man.get("matlab_version", "")),
        timestamp=str(man.get("timestamp", "")),
        series=samples,
    )


def parse_measurement(
    files: dict[str, bytes],
    run_id: str,
    spec: EngineeringSpec | Any,
) -> ExternalSimResult:
    """Parse lab measurement.csv and measurement_meta.txt to upgrade evidence to OBSERVED."""
    spec = adapt_spec(spec)
    decoded = _decode_and_check_size(files, REQUIRED_MEASUREMENT_FILES)
    meta = _parse_kv_manifest(decoded["measurement_meta.txt"], "measurement_meta.txt")
    for req_key in ("method", "instrument", "ambient_C"):
        if req_key not in meta:
            raise ResultsSchemaInvalid(
                f"Missing required metadata key '{req_key}' in measurement_meta.txt.",
                recovery_hint="Include method, instrument, ambient_C in measurement_meta.txt.",
                file="measurement_meta.txt",
                line=1,
            )

    known_parts = {p.part_id for p in spec.parts}
    rows = list(csv.reader(io.StringIO(decoded["measurement.csv"])))
    if not rows:
        raise ResultsSchemaInvalid("measurement.csv is empty.", recovery_hint="Provide header.", file="measurement.csv", line=1)
    header = [c.strip() for c in rows[0]]
    if header[:3] != ["time_s", "part_id", "temp_C"]:
        raise ResultsSchemaInvalid(
            f"Invalid measurement.csv header {header}.",
            recovery_hint="Start header with time_s,part_id,temp_C.",
            file="measurement.csv",
            line=1,
        )
    curr_idx = header.index("current_A") if "current_A" in header else -1
    volt_idx = header.index("voltage_V") if "voltage_V" in header else -1

    samples: list[ExternalSample] = []
    peaks: dict[str, float] = {}
    for line_no, row in enumerate(rows[1:], start=2):
        if not row or all(not c.strip() for c in row):
            continue
        if len(row) != len(header):
            raise ResultsSchemaInvalid("Column count mismatch.", recovery_hint="Match header columns.", file="measurement.csv", line=line_no)
        for cell in row:
            _check_not_formula_injected(cell, "measurement.csv", line_no)
        part_id = row[1].strip()
        if part_id not in known_parts:
            raise ResultsSchemaInvalid(
                f"Unknown part_id '{part_id}' at measurement.csv:{line_no}.",
                recovery_hint=f"Use a valid part_id from spec: {sorted(known_parts)}.",
                file="measurement.csv",
                line=line_no,
                part_id=part_id,
            )
        try:
            t_s, temp_c = float(row[0]), float(row[2])
            curr_a = float(row[curr_idx]) if curr_idx >= 0 and row[curr_idx].strip() else None
            volt_v = float(row[volt_idx]) if volt_idx >= 0 and row[volt_idx].strip() else None
        except ValueError as exc:
            raise ResultsSchemaInvalid(
                f"Invalid numeric value at measurement.csv:{line_no}: {exc}",
                recovery_hint="Ensure time_s, temp_C, current_A, voltage_V are numeric.",
                file="measurement.csv",
                line=line_no,
                part_id=part_id,
            ) from exc
        samples.append(ExternalSample(t_s, spec.revision, part_id, temp_c, curr_a, volt_v))
        peaks[part_id] = max(peaks.get(part_id, -1e9), round(temp_c, 4))

    if not samples:
        raise ResultsSchemaInvalid("No data rows.", recovery_hint="Add measurement rows.", file="measurement.csv", line=1)
    log_event("parse_measurement_ok", run_id=run_id, stage="bridge", part_count=len(peaks))
    return ExternalSimResult(
        run_id=run_id,
        tool="measurement",
        audit="not_applicable",
        max_abs_diff_c=None,
        worst_t_s=None,
        worst_node_id=None,
        per_node_peak_c=peaks,
        per_revision_node_peak_c={spec.revision: peaks},
        series=samples,
        meta=meta,
    )
