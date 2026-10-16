import { appConfig } from "@/lib/config";
import type { CadManifest, ManifestNode, ObjectiveConfirmation } from "@/lib/contracts";
import { createStratumError, type StratumError } from "@/lib/utils";

export interface ObjectiveDraftState {
  readonly baseRevision: number;
  readonly text: string;
  readonly selectedPresetId: string | null;
  readonly confirmToken: string | null;
  readonly normalizedTargets: readonly string[];
}

export function createObjectiveDraftState(baseRevision: number = 0): ObjectiveDraftState {
  return {
    baseRevision,
    text: "",
    selectedPresetId: null,
    confirmToken: null,
    normalizedTargets: [],
  };
}

export function updateObjectiveDraft(
  state: ObjectiveDraftState,
  text: string,
  presetId: string | null = state.selectedPresetId,
): ObjectiveDraftState {
  return {
    ...state,
    text,
    selectedPresetId: presetId,
    confirmToken: null,
    normalizedTargets: [],
  };
}

export function confirmObjectiveDraft(
  state: ObjectiveDraftState,
  confirmation: ObjectiveConfirmation,
): ObjectiveDraftState {
  return {
    ...state,
    baseRevision: confirmation.base_revision,
    text: confirmation.objective_text,
    confirmToken: confirmation.confirm_token,
    normalizedTargets: confirmation.normalized_targets,
  };
}

export function canTriggerRevision(
  state: ObjectiveDraftState,
  maxRevision: number = appConfig.maxRevision,
): boolean {
  return (
    typeof state.confirmToken === "string" &&
    state.confirmToken.trim().length > 0 &&
    state.baseRevision >= 0 &&
    state.baseRevision < maxRevision
  );
}

export function mapManifestToPartByNode(
  manifest: CadManifest | null,
): Readonly<Record<string, ManifestNode>> {
  if (!manifest) {
    return {};
  }
  const map: Record<string, ManifestNode> = {};
  for (const node of manifest.nodes) {
    map[node.node_name] = node;
  }
  return map;
}

export function computeExplodedPosition(
  node: ManifestNode,
  explodeFactor: number,
): readonly [number, number, number] {
  const clamped = Math.max(0, Math.min(1, explodeFactor));
  return [
    node.center[0] + node.explode_vector[0] * clamped,
    node.center[1] + node.explode_vector[1] * clamped,
    node.center[2] + node.explode_vector[2] * clamped,
  ];
}

export interface RevisionTabItem {
  readonly revision: number;
  readonly label: string;
}

export function getAvailableRevisions(
  latestRevision: number,
  maxRevision: number = appConfig.maxRevision,
): readonly RevisionTabItem[] {
  const safeMax = Math.max(0, Math.min(latestRevision, maxRevision));
  const tabs: RevisionTabItem[] = [];
  for (let rev = 0; rev <= safeMax; rev += 1) {
    tabs.push({ revision: rev, label: `V${rev}` });
  }
  return tabs;
}

export type ExternalImportMode = "simulink" | "lab";

const REQUIRED_SIMULINK_FILES = [
  "results.csv",
  "audit.txt",
  "stratum_results_manifest.txt",
] as const;

export function validateExternalResultsUpload(
  mode: ExternalImportMode,
  fileNames: readonly string[],
): { readonly valid: true } | { readonly valid: false; readonly error: StratumError } {
  const normalized = new Set(fileNames.map((n) => n.trim().toLowerCase()));
  if (mode === "simulink") {
    const missing = REQUIRED_SIMULINK_FILES.filter((req) => !normalized.has(req));
    if (missing.length > 0) {
      return {
        valid: false,
        error: createStratumError(
          "VALIDATION_ERROR",
          `Missing required Simulink bundle files: ${missing.join(", ")}`,
          "Upload results.csv, audit.txt, and stratum_results_manifest.txt from the bridge output.",
        ),
      };
    }
    return { valid: true };
  }
  if (!normalized.has("measurement.csv")) {
    return {
      valid: false,
      error: createStratumError(
        "VALIDATION_ERROR",
        "Missing required lab file: measurement.csv",
        "Attach measurement.csv and optional metadata JSON.",
      ),
    };
  }
  return { valid: true };
}
