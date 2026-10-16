import * as React from "react";
import type { ReconstructRequestPayload } from "@/components/PromptBar";
import {
  confirmObjective,
  createMatlabOnlineLink,
  createRun,
  fetchRevisionBundle,
  type RevisionBundle,
  triggerRevision,
  uploadExternalResults,
} from "@/lib/api";
import {
  connectRunEventStream,
  createInitialTelemetryState,
  reduceRunEvent,
  type TelemetryState,
} from "@/lib/sse";
import {
  confirmObjectiveDraft,
  createObjectiveDraftState,
  type ExternalImportMode,
  type ObjectiveDraftState,
  updateObjectiveDraft,
} from "@/lib/state";
import { createStratumError, isStratumError, type StratumError } from "@/lib/utils";

const EMPTY_BUNDLE: RevisionBundle = {
  graph: null,
  manifest: null,
  presets: [],
  variants: [],
  passes: [],
  metrics: [],
  simPoints: [],
  sandbox: null,
  loopNodes: [],
  benchmarks: [],
};

export interface StratumRunController {
  readonly runId: string | null;
  readonly busy: boolean;
  readonly telemetry: TelemetryState;
  readonly activeRevision: number;
  readonly selectedPartId: string | null;
  readonly bundle: RevisionBundle;
  readonly objectiveDraft: ObjectiveDraftState;
  readonly matlabWaitingExpiry: string | null;
  readonly externalImported: boolean;
  readonly errorBanner: StratumError | null;
  readonly setSelectedPartId: (partId: string) => void;
  readonly selectRevision: (rev: number) => void;
  readonly updateDraft: (text: string, presetId?: string | null) => void;
  readonly submitRun: (payload: ReconstructRequestPayload) => Promise<void>;
  readonly confirmCurrentObjective: () => Promise<void>;
  readonly executeRevision: () => Promise<void>;
  readonly runMatlabOnline: () => Promise<void>;
  readonly importExternal: (mode: ExternalImportMode, files: readonly File[]) => Promise<void>;
  readonly startNextRound: () => void;
}

export function useStratumRun(): StratumRunController {
  const [runId, setRunId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [telemetry, setTelemetry] = React.useState<TelemetryState>(() => createInitialTelemetryState());
  const [activeRevision, setActiveRevision] = React.useState<number>(0);
  const [selectedPartId, setSelectedPartId] = React.useState<string | null>(null);
  const [bundle, setBundle] = React.useState<RevisionBundle>(EMPTY_BUNDLE);
  const [objectiveDraft, setObjectiveDraft] = React.useState<ObjectiveDraftState>(() => createObjectiveDraftState(0));
  const [matlabWaitingExpiry, setMatlabWaitingExpiry] = React.useState<string | null>(null);
  const [externalImported, setExternalImported] = React.useState<boolean>(false);
  const [nextRoundObjective, setNextRoundObjective] = React.useState<string>("");
  const [errorBanner, setErrorBanner] = React.useState<StratumError | null>(null);

  const captureError = React.useCallback((err: unknown): void => {
    setErrorBanner(
      isStratumError(err) ? err : createStratumError("API_ERROR", "Operation failed", "Check input and retry."),
    );
  }, []);

  const refreshBundle = React.useCallback(async (id: string, rev: number): Promise<void> => {
    const data = await fetchRevisionBundle(id, rev);
    setBundle(data);
    if (data.graph && data.graph.parts.length > 0) {
      setSelectedPartId((prev) => prev ?? data.graph?.parts[0]?.part_id ?? null);
    }
  }, []);

  React.useEffect(() => {
    if (!runId) return undefined;
    return connectRunEventStream(runId, 0, {
      onEvent: (ev) => {
        setTelemetry((prev) => {
          const next = reduceRunEvent(prev, ev);
          if (next.latestRevision !== prev.latestRevision) {
            setActiveRevision(next.latestRevision);
            void refreshBundle(runId, next.latestRevision);
          } else if (ev.type === "status" || ev.type === "external_results") {
            void refreshBundle(runId, activeRevision);
          }
          if (ev.type === "external_results") {
            setMatlabWaitingExpiry(null);
            setExternalImported(true);
          }
          return next;
        });
      },
      onConnectionChange: (connected) => setTelemetry((prev) => ({ ...prev, connected })),
      onError: (err) => setErrorBanner(err),
    });
  }, [runId, activeRevision, refreshBundle]);

  const submitRun = async (payload: ReconstructRequestPayload): Promise<void> => {
    setBusy(true);
    setErrorBanner(null);
    try {
      const created = await createRun(payload);
      setRunId(created.run_id);
      setTelemetry((prev) => ({ ...prev, status: created.status, latestRevision: created.revision }));
      setActiveRevision(created.revision);
      await refreshBundle(created.run_id, created.revision);
    } catch (err: unknown) {
      captureError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmCurrentObjective = async (): Promise<void> => {
    if (!runId || !objectiveDraft.text.trim()) return;
    setErrorBanner(null);
    try {
      const conf = await confirmObjective(runId, activeRevision, objectiveDraft.text);
      setObjectiveDraft((prev) => confirmObjectiveDraft(prev, conf));
    } catch (err: unknown) {
      captureError(err);
    }
  };

  const executeRevision = async (): Promise<void> => {
    if (!runId) return;
    setErrorBanner(null);
    try {
      const res = await triggerRevision(runId, objectiveDraft.baseRevision, objectiveDraft.confirmToken);
      setTelemetry((prev) => ({ ...prev, status: res.status, latestRevision: Math.max(prev.latestRevision, res.revision) }));
      setActiveRevision(res.revision);
      await refreshBundle(runId, res.revision);
    } catch (err: unknown) {
      captureError(err);
    }
  };

  const runMatlabOnline = async (): Promise<void> => {
    if (!runId) return;
    try {
      const link = await createMatlabOnlineLink(runId, Math.max(0, activeRevision - 1), activeRevision);
      await navigator.clipboard?.writeText(link.command);
      setMatlabWaitingExpiry(link.expires_at);
      window.open("https://matlab.mathworks.com", "_blank", "noopener,noreferrer");
    } catch (err: unknown) {
      captureError(err);
    }
  };

  const importExternal = async (mode: ExternalImportMode, files: readonly File[]): Promise<void> => {
    if (!runId) return;
    try {
      const res = await uploadExternalResults(runId, mode, files);
      setExternalImported(true);
      if (res.draft_objective) setNextRoundObjective(res.draft_objective);
      await refreshBundle(runId, activeRevision);
    } catch (err: unknown) {
      captureError(err);
    }
  };

  return {
    runId, busy, telemetry, activeRevision, selectedPartId, bundle, objectiveDraft,
    matlabWaitingExpiry, externalImported, errorBanner, setSelectedPartId,
    selectRevision: (rev: number) => { setActiveRevision(rev); if (runId) void refreshBundle(runId, rev); },
    updateDraft: (txt: string, pid?: string | null) => setObjectiveDraft((prev) => updateObjectiveDraft(prev, txt, pid)),
    submitRun, confirmCurrentObjective, executeRevision, runMatlabOnline, importExternal,
    startNextRound: () => setObjectiveDraft({
      baseRevision: telemetry.latestRevision,
      text: nextRoundObjective || "Refine design based on external audit",
      selectedPresetId: null, confirmToken: null, normalizedTargets: [],
    }),
  };
}
