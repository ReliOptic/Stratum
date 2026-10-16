import type { ReconstructRequestPayload } from "@/components/PromptBar";
import { appConfig } from "@/lib/config";
import type {
  BenchmarkEntry,
  CadManifest,
  ComponentGraph,
  LoopNode,
  MetricDiff,
  ObjectiveConfirmation,
  ObjectivePreset,
  PassPrediction,
  RunStatus,
  SandboxCheck,
  SimPoint,
  VariantCard,
} from "@/lib/contracts";
import type { ExternalImportMode } from "@/lib/state";
import { createStratumError, logStructured } from "@/lib/utils";

export async function requestJson<T>(
  path: string,
  init: RequestInit,
  runId: string | null,
  stage: string,
): Promise<T> {
  const url = `${appConfig.apiBaseUrl}${path}`;
  logStructured("api_request", runId, null, stage, { path, method: init.method ?? "GET" });
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "include" });
  } catch (err: unknown) {
    logStructured("api_network_error", runId, null, stage, { path });
    throw createStratumError(
      "NETWORK_ERROR",
      err instanceof Error ? err.message : "Network request failed",
      "Verify server connectivity and try again.",
    );
  }
  if (response.status === 409) {
    logStructured("api_error_409", runId, null, stage, { path });
    throw createStratumError(
      "CONFIRMATION_REQUIRED_409",
      "Objective confirmation token is required or expired (409)",
      "Click Confirm Objective before triggering a revision.",
      409,
    );
  }
  if (response.status === 422) {
    logStructured("api_error_422", runId, null, stage, { path });
    throw createStratumError(
      "MAX_REVISION_REACHED_422",
      "Maximum design revision reached or invalid request (422)",
      "Inspect existing revisions in the loop strip.",
      422,
    );
  }
  if (!response.ok) {
    logStructured("api_error_status", runId, null, stage, { path, status: response.status });
    throw createStratumError(
      "API_ERROR",
      `Request to ${path} failed with HTTP ${response.status}`,
      "Retry or inspect telemetry logs.",
      response.status,
    );
  }
  return (await response.json()) as T;
}

export interface CreateRunResponse {
  readonly run_id: string;
  readonly status: RunStatus;
  readonly revision: number;
}

export async function createRun(payload: ReconstructRequestPayload): Promise<CreateRunResponse> {
  return requestJson<CreateRunResponse>(
    "/runs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    null,
    "reconstruct",
  );
}

export interface RevisionBundle {
  readonly graph: ComponentGraph | null;
  readonly manifest: CadManifest | null;
  readonly presets: readonly ObjectivePreset[];
  readonly variants: readonly VariantCard[];
  readonly passes: readonly PassPrediction[];
  readonly metrics: readonly MetricDiff[];
  readonly simPoints: readonly SimPoint[];
  readonly sandbox: SandboxCheck | null;
  readonly loopNodes: readonly LoopNode[];
  readonly benchmarks: readonly BenchmarkEntry[];
}

async function safeGet<T>(path: string, runId: string, fallback: T): Promise<T> {
  try {
    return await requestJson<T>(path, { method: "GET" }, runId, "fetch_bundle");
  } catch {
    return fallback;
  }
}

export async function fetchRevisionBundle(runId: string, rev: number): Promise<RevisionBundle> {
  const id = encodeURIComponent(runId);
  const [graph, manifest, presets, variants, passes, metrics, simPoints, sandbox, loopNodes, benchmarks] =
    await Promise.all([
      safeGet<ComponentGraph | null>(`/runs/${id}/graph?rev=${rev}`, runId, null),
      safeGet<CadManifest | null>(`/runs/${id}/manifest?rev=${rev}`, runId, null),
      safeGet<readonly ObjectivePreset[]>(`/runs/${id}/presets?base=${rev}`, runId, []),
      safeGet<readonly VariantCard[]>(`/runs/${id}/variants?rev=${rev}`, runId, []),
      safeGet<readonly PassPrediction[]>(`/runs/${id}/passes?rev=${rev}`, runId, []),
      safeGet<readonly MetricDiff[]>(`/runs/${id}/metrics?rev=${rev}`, runId, []),
      safeGet<readonly SimPoint[]>(`/runs/${id}/sim?rev=${rev}`, runId, []),
      safeGet<SandboxCheck | null>(`/runs/${id}/sandbox?rev=${rev}`, runId, null),
      safeGet<readonly LoopNode[]>(`/runs/${id}/loop`, runId, []),
      safeGet<readonly BenchmarkEntry[]>(`/runs/${id}/benchmarks`, runId, []),
    ]);
  return { graph, manifest, presets, variants, passes, metrics, simPoints, sandbox, loopNodes, benchmarks };
}

export async function confirmObjective(
  runId: string,
  baseRevision: number,
  objectiveText: string,
): Promise<ObjectiveConfirmation> {
  const id = encodeURIComponent(runId);
  const body = JSON.stringify({ base_revision: baseRevision, text: objectiveText });
  const headers = { "Content-Type": "application/json" };
  await requestJson<unknown>(`/runs/${id}/objective`, { method: "POST", headers, body }, runId, "objective");
  return requestJson<ObjectiveConfirmation>(
    `/runs/${id}/objective/confirm`,
    { method: "POST", headers, body },
    runId,
    "objective_confirm",
  );
}

export async function triggerRevision(
  runId: string,
  baseRevision: number,
  confirmToken: string | null,
): Promise<{ readonly revision: number; readonly status: RunStatus }> {
  const id = encodeURIComponent(runId);
  return requestJson<{ readonly revision: number; readonly status: RunStatus }>(
    `/runs/${id}/revisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_revision: baseRevision, confirm_token: confirmToken }),
    },
    runId,
    "revision",
  );
}

export async function createMatlabOnlineLink(
  runId: string,
  baseRev: number,
  newRev: number,
): Promise<{ readonly command: string; readonly expires_at: string }> {
  const id = encodeURIComponent(runId);
  return requestJson<{ readonly command: string; readonly expires_at: string }>(
    `/runs/${id}/matlab-link?base=${baseRev}&new=${newRev}`,
    { method: "POST" },
    runId,
    "matlab_link",
  );
}

export async function uploadExternalResults(
  runId: string,
  mode: ExternalImportMode,
  files: readonly File[],
): Promise<{ readonly status: RunStatus; readonly draft_objective?: string; readonly base_revision?: number }> {
  const id = encodeURIComponent(runId);
  const form = new FormData();
  form.append("mode", mode);
  for (const f of files) {
    form.append("files", f);
  }
  return requestJson(`/runs/${id}/external-results`, { method: "POST", body: form }, runId, "external_results");
}
