import type { ReconstructRequestPayload } from "@/components/PromptBar";
import { appConfig } from "@/lib/config";
import type { BenchmarkComparison, ComponentGraph, ConfirmResponse, EngineeringSpec, LoopNode, Manifest, MetricSet, Objective, PassReport, Preset, Run, RunStatus, SandboxCheck, SimResult, Variant } from "@/lib/contracts";
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

export async function createRun(payload: ReconstructRequestPayload): Promise<Run> {
  return requestJson<Run>(
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
  readonly spec: EngineeringSpec | null;
  readonly graph: ComponentGraph | null;
  readonly manifest: Manifest | null;
  readonly metrics: MetricSet | null;
  readonly baseMetrics: MetricSet | null;
  readonly sim: SimResult | null;
  readonly baseSim: SimResult | null;
  readonly presets: readonly Preset[];
  readonly variants: readonly Variant[];
  readonly passes: readonly PassReport[];
  readonly sandbox: SandboxCheck | null;
  readonly loopNodes: readonly LoopNode[];
  readonly benchmarks: readonly BenchmarkComparison[];
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
  const baseRev = Math.max(0, rev - 1);
  const [spec, graph, manifest, metrics, baseMetrics, sim, baseSim, presets, variants, passes, sandbox, loopNodes, benchmarks] =
    await Promise.all([
      safeGet<EngineeringSpec | null>(`/runs/${id}/spec?rev=${rev}`, runId, null),
      safeGet<ComponentGraph | null>(`/runs/${id}/graph?rev=${rev}`, runId, null),
      safeGet<Manifest | null>(`/runs/${id}/manifest?rev=${rev}`, runId, null),
      safeGet<MetricSet | null>(`/runs/${id}/metrics?rev=${rev}`, runId, null),
      rev > 0 ? safeGet<MetricSet | null>(`/runs/${id}/metrics?rev=${baseRev}`, runId, null) : Promise.resolve(null),
      safeGet<SimResult | null>(`/runs/${id}/sim?rev=${rev}`, runId, null),
      rev > 0 ? safeGet<SimResult | null>(`/runs/${id}/sim?rev=${baseRev}`, runId, null) : Promise.resolve(null),
      safeGet<readonly Preset[]>(`/runs/${id}/presets?base=${rev}`, runId, []),
      safeGet<readonly Variant[]>(`/runs/${id}/variants?rev=${rev}`, runId, []),
      safeGet<readonly PassReport[]>(`/runs/${id}/passes?rev=${rev}`, runId, []),
      safeGet<SandboxCheck | null>(`/runs/${id}/sandbox?rev=${rev}`, runId, null),
      safeGet<readonly LoopNode[]>(`/runs/${id}/loop`, runId, []),
      safeGet<readonly BenchmarkComparison[]>(`/runs/${id}/benchmarks`, runId, []),
    ]);
  return { spec, graph, manifest, metrics, baseMetrics, sim, baseSim, presets, variants, passes, sandbox, loopNodes, benchmarks };
}

export async function confirmObjective(
  runId: string,
  baseRevision: number,
  objectiveText: string,
): Promise<{ readonly objective: Objective; readonly confirmation: ConfirmResponse }> {
  const id = encodeURIComponent(runId);
  const body = JSON.stringify({ base_revision: baseRevision, text: objectiveText });
  const headers = { "Content-Type": "application/json" };
  const objective = await requestJson<Objective>(`/runs/${id}/objective`, { method: "POST", headers, body }, runId, "objective");
  const confirmation = await requestJson<ConfirmResponse>(
    `/runs/${id}/objective/confirm`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        objective_hash: objective.objective_hash,
        base_revision: baseRevision,
        confirmed_by_user: true,
      }),
    },
    runId,
    "objective_confirm",
  );
  return { objective, confirmation };
}

export function buildArtifactGlbUrl(runId: string, rev: number): string {
  return `${appConfig.apiBaseUrl}/runs/${encodeURIComponent(runId)}/artifacts/${rev}.glb`;
}

export async function fetchArtifactGlbBuffer(runId: string, rev: number): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(buildArtifactGlbUrl(runId, rev), { method: "GET", credentials: "include" });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

export async function triggerRevision(
  runId: string,
  baseRevision: number,
  confirmToken: string | null,
): Promise<{ readonly revision: number; readonly status: RunStatus }> {
  const id = encodeURIComponent(runId);
  const res = await requestJson<{ readonly revision?: number; readonly latest_revision?: number; readonly status: RunStatus }>(
    `/runs/${id}/revisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_revision: baseRevision, confirm_token: confirmToken }),
    },
    runId,
    "revision",
  );
  return { revision: res.revision ?? res.latest_revision ?? baseRevision + 1, status: res.status };
}

export async function createMatlabOnlineLink(
  runId: string,
  baseRev: number,
  newRev: number,
): Promise<{ readonly command: string; readonly expires_at: string }> {
  const id = encodeURIComponent(runId);
  return requestJson(`/runs/${id}/matlab-link?base=${baseRev}&new=${newRev}`, { method: "POST" }, runId, "matlab_link");
}

export async function uploadExternalResults(
  runId: string,
  mode: ExternalImportMode,
  files: readonly File[],
): Promise<{ readonly status: RunStatus; readonly draft_objective?: string; readonly base_revision?: number }> {
  const id = encodeURIComponent(runId);
  const form = new FormData();
  form.append("mode", mode);
  for (const f of files) form.append("files", f);
  return requestJson(`/runs/${id}/external-results`, { method: "POST", body: form }, runId, "external_results");
}
