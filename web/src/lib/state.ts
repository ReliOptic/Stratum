import { appConfig } from "@/lib/config";
import type { ConfirmResponse, Manifest, ManifestPart, Objective, Target } from "@/lib/contracts";
import { createStratumError, type StratumError } from "@/lib/utils";

export interface ObjectiveDraftState {
  readonly baseRevision: number;
  readonly text: string;
  readonly selectedPresetId: string | null;
  readonly confirmToken: string | null;
  readonly expiresAt: string | null;
  readonly targets: readonly Target[];
  readonly objectiveHash: string | null;
}

export function createObjectiveDraftState(baseRevision: number = 0): ObjectiveDraftState {
  return {
    baseRevision,
    text: "",
    selectedPresetId: null,
    confirmToken: null,
    expiresAt: null,
    targets: [],
    objectiveHash: null,
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
    expiresAt: null,
    targets: [],
    objectiveHash: null,
  };
}

export function confirmObjectiveDraft(
  state: ObjectiveDraftState,
  objective: Objective,
  confirmation: ConfirmResponse,
): ObjectiveDraftState {
  return {
    ...state,
    baseRevision: objective.base_revision,
    text: objective.text,
    confirmToken: confirmation.token,
    expiresAt: confirmation.expires_at,
    targets: objective.targets,
    objectiveHash: objective.objective_hash,
  };
}

export function formatTargetSummary(target: Target): string {
  const op =
    target.comparator === "lte"
      ? "<="
      : target.comparator === "lt"
        ? "<"
        : target.comparator === "gte"
          ? ">="
          : ">";
  const unitSuffix = target.unit ? ` ${target.unit}` : "";
  return `${target.metric_id} ${op} ${target.threshold}${unitSuffix}`;
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
  manifest: Manifest | null,
): Readonly<Record<string, ManifestPart>> {
  if (!manifest) {
    return {};
  }
  const map: Record<string, ManifestPart> = {};
  for (const part of manifest.parts) {
    map[part.glb_node] = part;
  }
  return map;
}

export function computePartCenterMm(part: ManifestPart): readonly [number, number, number] {
  const [x0, y0, z0, x1, y1, z1] = part.bbox_mm;
  return [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
}

export function computePartSizeMm(part: ManifestPart): readonly [number, number, number] {
  const [x0, y0, z0, x1, y1, z1] = part.bbox_mm;
  return [Math.max(1, x1 - x0), Math.max(1, y1 - y0), Math.max(1, z1 - z0)];
}

export function computeExplodedPosition(
  part: ManifestPart,
  explodeFactor: number,
): readonly [number, number, number] {
  const clamped = Math.max(0, Math.min(1, explodeFactor));
  const [cx, cy, cz] = computePartCenterMm(part);
  const mag = Math.hypot(cx, cy, cz);
  const [dx, dy, dz] = mag > 0.001 ? [cx * 0.8, cy * 0.8 + 8, cz * 0.8 + 12] : [0, 15, 15];
  return [cx + dx * clamped, cy + dy * clamped, cz + dz * clamped];
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
        "Attach measurement.csv and optional metadata.",
      ),
    };
  }
  return { valid: true };
}
