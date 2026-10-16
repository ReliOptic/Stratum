#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/contracts/stratum.schema.json"
PY_OUT_DIR="$ROOT_DIR/contracts/generated/python"
TS_OUT_DIR="$ROOT_DIR/contracts/generated/ts"

mkdir -p "$PY_OUT_DIR" "$TS_OUT_DIR"

if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  PYTHON_BIN="python"
fi

# 1. Emit individual per-entity Draft 2020-12 schemas from master schema
"$PYTHON_BIN" - "$SCHEMA_FILE" "$ROOT_DIR/contracts" <<'PY'
import json
import pathlib
import sys

master_path = pathlib.Path(sys.argv[1])
contracts_dir = pathlib.Path(sys.argv[2])
master = json.loads(master_path.read_text(encoding="utf-8"))
defs = master["$defs"]

ENTITY_MAP = {
    "evidence_source": "EvidenceSource",
    "parameter": "Parameter",
    "cad_op": "CadOp",
    "part": "Part",
    "engineering_spec": "EngineeringSpec",
    "causal_edge": "CausalEdge",
    "component_graph": "ComponentGraph",
    "metric_value": "MetricValue",
    "metric_set": "MetricSet",
    "manifest": "Manifest",
    "target": "Target",
    "preset": "Preset",
    "objective": "Objective",
    "confirm_response": "ConfirmResponse",
    "prediction": "Prediction",
    "pass_report": "PassReport",
    "sim_result": "SimResult",
    "external_sim_result": "ExternalSimResult",
    "run_stats": "RunStats",
    "benchmark_comparison": "BenchmarkComparison",
    "variant": "Variant",
    "run_event": "RunEvent",
    "usage_stat": "UsageStat",
    "sandbox_check": "SandboxCheck",
    "run": "Run",
}

for file_stem, def_name in ENTITY_MAP.items():
    target_def = defs[def_name]
    doc = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://stratum.local/contracts/{file_stem}.schema.json",
        "title": def_name,
        **target_def,
        "$defs": defs,
    }
    out_path = contracts_dir / f"{file_stem}.schema.json"
    out_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
PY

# 2. Generate Pydantic v2 models
"$PYTHON_BIN" -m datamodel_code_generator \
  --input "$SCHEMA_FILE" \
  --input-file-type jsonschema \
  --output "$PY_OUT_DIR/models.py" \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.12 \
  --use-standard-collections \
  --use-union-operator \
  --field-constraints \
  --formatters builtin \
  --disable-timestamp

cat > "$ROOT_DIR/contracts/__init__.py" <<'EOF'
"""Stratum contract schemas and generated bindings."""
EOF

cat > "$ROOT_DIR/contracts/generated/__init__.py" <<'EOF'
"""Generated contract bindings."""
EOF

cat > "$PY_OUT_DIR/__init__.py" <<'EOF'
"""Generated Pydantic v2 models for Stratum contracts."""

from .models import *  # noqa: F401,F403
EOF

# 3. Generate TypeScript definitions
NODE_BIN="/opt/homebrew/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

if [ -f "/tmp/stratum-ts-codegen/node_modules/json-schema-to-typescript/dist/src/cli.js" ]; then
  "$NODE_BIN" /tmp/stratum-ts-codegen/node_modules/json-schema-to-typescript/dist/src/cli.js \
    -i "$SCHEMA_FILE" -o "$TS_OUT_DIR/index.ts" --unreachableDefinitions
elif [ -x "$ROOT_DIR/node_modules/.bin/json2ts" ]; then
  "$ROOT_DIR/node_modules/.bin/json2ts" -i "$SCHEMA_FILE" -o "$TS_OUT_DIR/index.ts" --unreachableDefinitions
elif [ -x "$ROOT_DIR/web/node_modules/.bin/json2ts" ]; then
  "$ROOT_DIR/web/node_modules/.bin/json2ts" -i "$SCHEMA_FILE" -o "$TS_OUT_DIR/index.ts" --unreachableDefinitions
elif command -v json2ts >/dev/null 2>&1; then
  json2ts -i "$SCHEMA_FILE" -o "$TS_OUT_DIR/index.ts" --unreachableDefinitions
else
  npx --yes json-schema-to-typescript -i "$SCHEMA_FILE" -o "$TS_OUT_DIR/index.ts" --unreachableDefinitions
fi

cat > "$TS_OUT_DIR/models.ts" <<'EOF'
export * from "./index";
EOF
