import { appConfig } from "@/lib/config";
import type { ConfirmResponse, Manifest, ManifestPart, Objective, Preset, RunStatus, Target } from "@/lib/contracts";
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
  presetId: string | null = null,
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

export function selectPresetDraft(state: ObjectiveDraftState, preset: Preset): ObjectiveDraftState {
  return updateObjectiveDraft(state, preset.rationale, preset.preset_id);
}

export function reviewObjectiveDraft(state: ObjectiveDraftState, objective: Objective): ObjectiveDraftState {
  return {
    ...state,
    baseRevision: objective.base_revision,
    text: objective.text,
    confirmToken: null,
    expiresAt: null,
    targets: objective.targets,
    objectiveHash: objective.objective_hash,
  };
}

export function canConfirmReviewedObjective(state: ObjectiveDraftState): boolean {
  return typeof state.objectiveHash === "string" && state.objectiveHash.trim().length > 0 && state.targets.length > 0;
}

export function confirmObjectiveDraft(state: ObjectiveDraftState, confirmation: ConfirmResponse): ObjectiveDraftState {
  if (!canConfirmReviewedObjective(state)) return state;
  return { ...state, confirmToken: confirmation.token, expiresAt: confirmation.expires_at };
}

export function formatTargetSummary(target: Target, baseRevision?: number): string {
  const op = target.comparator === "lte" ? "<=" : target.comparator === "lt" ? "<" : target.comparator === "gte" ? ">=" : ">";
  const unitSuffix = target.unit ? ` ${target.unit}` : "";
  const baseSuffix = typeof baseRevision === "number" ? ` [base V${baseRevision}]` : "";
  return `${target.metric_id} (${target.comparator} / ${op}) ${target.threshold}${unitSuffix}${baseSuffix}`;
}

export function isTargetMet(value: number | null | undefined, target: Target | undefined): boolean | null {
  if (typeof value !== "number" || !target) return null;
  if (target.comparator === "lt") return value < target.threshold;
  if (target.comparator === "lte") return value <= target.threshold;
  if (target.comparator === "gt") return value > target.threshold;
  return value >= target.threshold;
}

export function canTriggerRevision(
  state: ObjectiveDraftState,
  maxRevision: number = appConfig.maxRevision,
  runStatus?: RunStatus | null,
): boolean {
  const statusOk = runStatus === undefined || runStatus === null || runStatus === "OBJECTIVE_CONFIRMED";
  return (
    statusOk &&
    canConfirmReviewedObjective(state) &&
    typeof state.confirmToken === "string" &&
    state.confirmToken.trim().length > 0 &&
    state.baseRevision >= 0 &&
    state.baseRevision < maxRevision
  );
}

export function mapManifestToPartByNode(manifest: Manifest | null): Readonly<Record<string, ManifestPart>> {
  if (!manifest) return {};
  const map: Record<string, ManifestPart> = {};
  for (const part of manifest.parts) map[part.glb_node] = part;
  return map;
}

export function parseGlbNodeNames(buffer: ArrayBuffer): readonly string[] {
  if (buffer.byteLength < 20) return [];
  const view = new DataView(buffer);
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLen > buffer.byteLength) return [];
  try {
    const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen));
    const parsed = JSON.parse(jsonText) as { readonly nodes?: readonly { readonly name?: string }[] };
    return (parsed.nodes ?? []).map((n, idx) => n.name ?? `node_${idx}`);
  } catch {
    return [];
  }
}

export function computePartCenterMm(part: ManifestPart): readonly [number, number, number] {
  const [x0, y0, z0, x1, y1, z1] = part.bbox_mm;
  return [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
}

export function computePartSizeMm(part: ManifestPart): readonly [number, number, number] {
  const [x0, y0, z0, x1, y1, z1] = part.bbox_mm;
  return [Math.max(1, x1 - x0), Math.max(1, y1 - y0), Math.max(1, z1 - z0)];
}

export function computeAssemblyCentroidMm(parts: readonly ManifestPart[]): readonly [number, number, number] {
  if (parts.length === 0) return [0, 0, 0];
  let sx = 0, sy = 0, sz = 0;
  for (const p of parts) {
    const [cx, cy, cz] = computePartCenterMm(p);
    sx += cx; sy += cy; sz += cz;
  }
  return [sx / parts.length, sy / parts.length, sz / parts.length];
}

export function computeExplodedPosition(
  part: ManifestPart,
  explodeFactor: number,
  assemblyCentroid: readonly [number, number, number] = [0, 0, 0],
): readonly [number, number, number] {
  const clamped = Math.max(0, Math.min(1, explodeFactor));
  const [cx, cy, cz] = computePartCenterMm(part);
  const vx = cx - assemblyCentroid[0], vy = cy - assemblyCentroid[1], vz = cz - assemblyCentroid[2];
  const [dx, dy, dz] = Math.hypot(vx, vy, vz) > 0.001 ? [vx * 0.85, vy * 0.85 + 6, vz * 0.85 + 10] : [0, 12, 16];
  return [cx + dx * clamped, cy + dy * clamped, cz + dz * clamped];
}

export interface RevisionTabItem {
  readonly revision: number;
  readonly label: string;
}

export function getAvailableRevisions(latestRevision: number, maxRevision: number = appConfig.maxRevision): readonly RevisionTabItem[] {
  const safeMax = Math.max(0, Math.min(latestRevision, maxRevision));
  const tabs: RevisionTabItem[] = [];
  for (let rev = 0; rev <= safeMax; rev += 1) tabs.push({ revision: rev, label: `V${rev}` });
  return tabs;
}

export type ExternalImportMode = "simulink" | "lab";
const REQUIRED_SIMULINK_FILES = ["results.csv", "audit.txt", "stratum_results_manifest.txt"] as const;

export function validateAttachments(
  fileNames: readonly string[],
  maxCount: number = appConfig.maxAttachments,
): { readonly accepted: readonly string[]; readonly error: StratumError | null } {
  if (fileNames.length <= maxCount) return { accepted: fileNames, error: null };
  return {
    accepted: fileNames.slice(0, maxCount),
    error: createStratumError("VALIDATION_ERROR", `Attachment limit is ${maxCount} files (selected ${fileNames.length})`, `Only the first ${maxCount} files were attached.`),
  };
}

export function validateExternalResultsUpload(
  mode: ExternalImportMode,
  fileNames: readonly string[],
): { readonly valid: true } | { readonly valid: false; readonly error: StratumError } {
  const normalized = new Set(fileNames.map((n) => n.trim().toLowerCase()));
  if (mode === "simulink") {
    const missing = REQUIRED_SIMULINK_FILES.filter((req) => !normalized.has(req));
    if (missing.length > 0) return { valid: false, error: createStratumError("VALIDATION_ERROR", `Missing required Simulink bundle files: ${missing.join(", ")}`, "Upload results.csv, audit.txt, and stratum_results_manifest.txt.") };
    return { valid: true };
  }
  if (!normalized.has("measurement.csv")) return { valid: false, error: createStratumError("VALIDATION_ERROR", "Missing required lab file: measurement.csv", "Attach measurement.csv and optional metadata.") };
  return { valid: true };
}
