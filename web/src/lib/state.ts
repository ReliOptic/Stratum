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
  presetId: string | null = state.selectedPresetId,
  targets: readonly Target[] = [],
): ObjectiveDraftState {
  return {
    ...state,
    text,
    selectedPresetId: presetId,
    confirmToken: null,
    expiresAt: null,
    targets,
    objectiveHash: null,
  };
}

export function selectPresetDraft(state: ObjectiveDraftState, preset: Preset): ObjectiveDraftState {
  return updateObjectiveDraft(state, preset.rationale, preset.preset_id, preset.targets);
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
  const op = target.comparator === "lte" ? "<=" : target.comparator === "lt" ? "<" : target.comparator === "gte" ? ">=" : ">";
  const unitSuffix = target.unit ? ` ${target.unit}` : "";
  return `${target.metric_id} ${op} ${target.threshold}${unitSuffix}`;
}

export function canTriggerRevision(
  state: ObjectiveDraftState,
  maxRevision: number = appConfig.maxRevision,
  runStatus?: RunStatus | null,
): boolean {
  const statusOk = runStatus === undefined || runStatus === null || runStatus === "OBJECTIVE_CONFIRMED";
  return (
    statusOk &&
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
  const magic = view.getUint32(0, true);
  const jsonLen = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (magic !== 0x46546c67 || chunkType !== 0x4e4f534a || 20 + jsonLen > buffer.byteLength) return [];
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
  const [ax, ay, az] = assemblyCentroid;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const mag = Math.hypot(vx, vy, vz);
  const [dx, dy, dz] = mag > 0.001 ? [vx * 0.85, vy * 0.85 + 6, vz * 0.85 + 10] : [0, 12, 16];
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
    if (missing.length > 0) {
      return { valid: false, error: createStratumError("VALIDATION_ERROR", `Missing required Simulink bundle files: ${missing.join(", ")}`, "Upload results.csv, audit.txt, and stratum_results_manifest.txt.") };
    }
    return { valid: true };
  }
  if (!normalized.has("measurement.csv")) {
    return { valid: false, error: createStratumError("VALIDATION_ERROR", "Missing required lab file: measurement.csv", "Attach measurement.csv and optional metadata.") };
  }
  return { valid: true };
}
