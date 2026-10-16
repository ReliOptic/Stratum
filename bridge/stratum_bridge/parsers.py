"""External Simulink results parser with server-side re-audit."""

from __future__ import annotations

import csv
import io

from stratum_bridge.config import BRIDGE_CONFIG
from stratum_bridge.errors import BundleMismatch, ResultsSchemaInvalid
from stratum_bridge.logging_utils import log_event
from stratum_bridge.types import AuditOutcome, ExternalSample, ExternalSimResult
from stratum_cad.types import SimResult

REQUIRED_EXTERNAL_FILES: frozenset[str] = frozenset({"results.csv", "audit.txt", "stratum_results_manifest.txt"})
REQUIRED_MEASUREMENT_FILES: frozenset[str] = frozenset({"measurement.csv", "measurement_meta.txt"})
FORMULA_PREFIXES: tuple[str, ...] = ("=", "+", "-", "@")


def _check_not_formula_injected(cell: str, filename: str, line_no: int) -> None:
    """Reject CSV cells starting with =, +, -, @ unless they are valid numeric literals."""
    stripped = cell.strip()
    if stripped and stripped.startswith(FORMULA_PREFIXES):
        try:
            float(stripped)
        except ValueError as exc:
            raise ResultsSchemaInvalid(
                f"Formula injection prefix rejected in {filename}:{line_no}: '{stripped}'",
                recovery_hint="Remove leading '=', '+', '-', or '@' from non-numeric CSV cells.",
                file=filename,
                line=line_no,
            ) from exc


def _decode_and_check_size(files: dict[str, bytes], expected_names: frozenset[str]) -> dict[str, str]:
    """Verify exact file set, total size <= 5 MB, and strict UTF-8 encoding."""
    actual_names = frozenset(files.keys())
    if actual_names != expected_names:
        raise ResultsSchemaInvalid(
            f"Expected exact files {sorted(expected_names)}, got {sorted(actual_names)}.",
            recovery_hint=f"Provide exactly {sorted(expected_names)}.",
        )
    total_bytes = sum(len(raw) for raw in files.values())
    if total_bytes > BRIDGE_CONFIG.max_upload_bytes:
        raise ResultsSchemaInvalid(
            f"Upload size {total_bytes} bytes exceeds limit {BRIDGE_CONFIG.max_upload_bytes} bytes.",
            recovery_hint="Reduce time-series sampling rate so total size is <= 5 MB.",
        )
    decoded: dict[str, str] = {}
    for fname, raw in files.items():
        try:
            decoded[fname] = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ResultsSchemaInvalid(
                f"File '{fname}' is not valid UTF-8.",
                recovery_hint="Encode all result files as UTF-8 text.",
                file=fname,
                line=1,
            ) from exc
    return decoded


def _parse_kv_manifest(text: str, filename: str) -> dict[str, str]:
    """Parse key=value or key: value lines from a manifest or metadata file."""
    out: dict[str, str] = {}
    for idx, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        sep = "=" if "=" in line else (":" if ":" in line else None)
        if sep is None:
            raise ResultsSchemaInvalid(
                f"Malformed metadata line in {filename}:{idx}: '{line}'",
                recovery_hint="Format lines as 'key=value' or 'key: value'.",
                file=filename,
                line=idx,
            )
        k, v = line.split(sep, 1)
        _check_not_formula_injected(v, filename, idx)
        out[k.strip()] = v.strip()
    return out


def _reaudit_against_expected(
    samples: list[ExternalSample],
    expected: SimResult,
) -> tuple[AuditOutcome, float, float, str | None]:
    """Recompute thermal audit server-side against expected SimResult."""
    actual_lookup = {(s.revision, s.node_id, round(s.time_s, 3)): s.temp_c for s in samples}
    target_nodes = set(expected.storage_node_ids) or set(expected.per_node_peak_c.keys())
    max_diff, worst_t, matched_count = 0.0, 0.0, 0
    worst_node: str | None = None

    for exp in expected.series:
        if exp.node_id not in target_nodes:
            continue
        key = (exp.revision, exp.node_id, round(exp.time_s, 3))
        if key not in actual_lookup:
            raise ResultsSchemaInvalid(
                f"Missing expected sample for rev={exp.revision}, node={exp.node_id}, t={exp.time_s}",
                recovery_hint="Ensure results.csv covers all expected timestamps and nodes.",
                file="results.csv",
                line=1,
                part_id=exp.node_id,
            )
        matched_count += 1
        diff = abs(actual_lookup[key] - exp.temp_c)
        if diff > max_diff or worst_node is None:
            max_diff, worst_t, worst_node = diff, exp.time_s, exp.node_id

    if matched_count == 0:
        raise ResultsSchemaInvalid(
            "No matching samples found for expected revision and nodes.",
            recovery_hint="Check that results.csv includes the expected revision.",
            file="results.csv",
            line=1,
        )
    outcome: AuditOutcome = "MATCH" if max_diff <= BRIDGE_CONFIG.audit_tol_c else "MISMATCH"
    return outcome, round(max_diff, 4), round(worst_t, 4), worst_node


def parse_external_results(
    files: dict[str, bytes],
    expected_bundle_sha256: str,
    expected: SimResult | object,
) -> ExternalSimResult:
    """Validate and server-audit Simulink output files (results.csv, audit.txt, manifest)."""
    from stratum_bridge.adapters import adapt_sim_result
    expected = adapt_sim_result(expected)
    decoded = _decode_and_check_size(files, REQUIRED_EXTERNAL_FILES)
    man = _parse_kv_manifest(decoded["stratum_results_manifest.txt"], "stratum_results_manifest.txt")
    run_id, b_sha = man.get("run_id", ""), man.get("bundle_sha256", "")
    if run_id != expected.run_id or b_sha != expected_bundle_sha256:
        raise BundleMismatch(
            f"Manifest mismatch: got (run_id='{run_id}', sha='{b_sha}'), "
            f"expected (run_id='{expected.run_id}', sha='{expected_bundle_sha256}').",
            recovery_hint="Import results generated from the current revision's bundle.",
            file="stratum_results_manifest.txt",
            line=1,
        )

    rows = list(csv.reader(io.StringIO(decoded["results.csv"])))
    if not rows or [c.strip() for c in rows[0]] != ["time_s", "revision", "node_id", "temp_C"]:
        raise ResultsSchemaInvalid(
            "Invalid header in results.csv; expected 'time_s,revision,node_id,temp_C'.",
            recovery_hint="Export results.csv with columns: time_s,revision,node_id,temp_C.",
            file="results.csv",
            line=1,
        )
    samples: list[ExternalSample] = []
    peaks: dict[str, float] = {}
    rev_peaks: dict[int, dict[str, float]] = {}
    for line_no, row in enumerate(rows[1:], start=2):
        if not row or all(not c.strip() for c in row):
            continue
        if len(row) != 4:
            raise ResultsSchemaInvalid(
                f"Expected 4 columns at results.csv:{line_no}, got {len(row)}.",
                recovery_hint="Ensure every row has time_s,revision,node_id,temp_C.",
                file="results.csv",
                line=line_no,
            )
        for cell in row:
            _check_not_formula_injected(cell, "results.csv", line_no)
        try:
            t_s, rev, node_id, temp_c = float(row[0]), int(row[1]), row[2].strip(), float(row[3])
        except ValueError as exc:
            raise ResultsSchemaInvalid(
                f"Numeric parse error at results.csv:{line_no}: {exc}",
                recovery_hint="Ensure time_s and temp_C are floats and revision is an integer.",
                file="results.csv",
                line=line_no,
            ) from exc
        if not node_id:
            raise ResultsSchemaInvalid("Empty node_id.", recovery_hint="Provide node_id.", file="results.csv", line=line_no)
        samples.append(ExternalSample(time_s=t_s, revision=rev, node_id=node_id, temp_c=temp_c))
        peaks[node_id] = max(peaks.get(node_id, -1e9), round(temp_c, 4))
        rev_map = rev_peaks.setdefault(rev, {})
        rev_map[node_id] = max(rev_map.get(node_id, -1e9), round(temp_c, 4))

    audit, max_diff, worst_t, worst_node = _reaudit_against_expected(samples, expected)
    log_event("parse_external_results_ok", run_id=run_id, stage="bridge", audit=audit, max_diff=max_diff)
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
        matlab_version=man.get("matlab_version"),
        timestamp=man.get("timestamp"),
        series=samples,
        meta={"client_audit_line": decoded["audit.txt"].strip()},
    )
