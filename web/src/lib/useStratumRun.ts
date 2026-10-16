import * as React from "react";
import type { ReconstructRequestPayload } from "@/components/PromptBar";
import { confirmObjectiveByHash, createMatlabOnlineLink, createRun, fetchRevisionBundle, type RevisionBundle, reviewObjective, triggerRevision, uploadExternalResults } from "@/lib/api";
import type { ExternalSimResult, Preset } from "@/lib/contracts";
import { connectRunEventStream, createInitialTelemetryState, reduceRunEvent, type TelemetryState } from "@/lib/sse";
import { canConfirmReviewedObjective, confirmObjectiveDraft, createObjectiveDraftState, type ExternalImportMode, type ObjectiveDraftState, reviewObjectiveDraft, selectPresetDraft, updateObjectiveDraft } from "@/lib/state";
import { createStratumError, isStratumError, type StratumError } from "@/lib/utils";

const EMPTY_BUNDLE: RevisionBundle = {
  spec: null, graph: null, manifest: null, metrics: null, baseMetrics: null,
  sim: null, baseSim: null, presets: [], variants: [], passes: [],
  sandbox: null, loopNodes: [], benchmarks: [],
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
  readonly matlabCommand: string | null;
  readonly externalImported: boolean;
  readonly externalSim: ExternalSimResult | null;
  readonly errorBanner: StratumError | null;
  readonly setSelectedPartId: (partId: string) => void;
  readonly selectRevision: (rev: number) => void;
  readonly updateDraft: (text: string, presetId?: string | null) => void;
  readonly selectPreset: (preset: Preset) => Promise<void>;
  readonly submitRun: (payload: ReconstructRequestPayload) => Promise<void>;
  readonly reviewCurrentObjective: (overrideText?: string, baseRevOverride?: number) => Promise<void>;
  readonly confirmReviewedObjective: () => Promise<void>;
  readonly executeRevision: () => Promise<void>;
  readonly runMatlabOnline: () => Promise<void>;
  readonly importExternal: (mode: ExternalImportMode, files: readonly File[]) => Promise<void>;
  readonly startNextRound: () => Promise<void>;
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
  const [matlabCommand, setMatlabCommand] = React.useState<string | null>(null);
  const [externalImported, setExternalImported] = React.useState<boolean>(false);
  const [externalSim, setExternalSim] = React.useState<ExternalSimResult | null>(null);
  const [nextRoundObjective, setNextRoundObjective] = React.useState<string>("");
  const [errorBanner, setErrorBanner] = React.useState<StratumError | null>(null);

  const captureError = React.useCallback((err: unknown): void => {
    setErrorBanner(isStratumError(err) ? err : createStratumError("API_ERROR", "Operation failed", "Check input and retry."));
  }, []);

  const refreshBundle = React.useCallback(async (id: string, rev: number): Promise<void> => {
    const data = await fetchRevisionBundle(id, rev);
    setBundle(data);
    if (data.spec && data.spec.parts.length > 0) {
      setSelectedPartId((prev) => prev ?? data.spec?.parts[0]?.part_id ?? null);
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
          } else if (ev.stage === "import" || typeof ev.data.status === "string") {
            void refreshBundle(runId, activeRevision);
          }
          if (ev.stage === "import" || ev.data.status === "EXTERNAL_RESULTS_IMPORTED") {
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
      const rev = created.latest_revision ?? 0;
      setRunId(created.run_id);
      setTelemetry((prev) => ({ ...prev, status: created.status, latestRevision: rev, usage: created.usage ?? prev.usage }));
      setActiveRevision(rev);
      await refreshBundle(created.run_id, rev);
    } catch (err: unknown) {
      captureError(err);
    } finally {
      setBusy(false);
    }
  };

  const reviewCurrentObjective = async (overrideText?: string, baseRevOverride?: number): Promise<void> => {
    const textToSend = (overrideText ?? objectiveDraft.text).trim();
    const baseRev = baseRevOverride ?? activeRevision;
    if (!runId || !textToSend) return;
    setErrorBanner(null);
    try {
      const objective = await reviewObjective(runId, baseRev, textToSend);
      setObjectiveDraft((prev) => reviewObjectiveDraft(prev, objective));
    } catch (err: unknown) {
      captureError(err);
    }
  };

  const confirmReviewedObjective = async (): Promise<void> => {
    if (!runId || !canConfirmReviewedObjective(objectiveDraft) || !objectiveDraft.objectiveHash) return;
    setErrorBanner(null);
    try {
      const confirmation = await confirmObjectiveByHash(runId, objectiveDraft.baseRevision, objectiveDraft.objectiveHash);
      setObjectiveDraft((prev) => confirmObjectiveDraft(prev, confirmation));
      setTelemetry((prev) => ({ ...prev, status: "OBJECTIVE_CONFIRMED" }));
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
      setMatlabCommand(link.command);
      setMatlabWaitingExpiry(link.expires_at);
      void navigator.clipboard?.writeText(link.command).catch(() => undefined);
      window.open("https://matlab.mathworks.com", "_blank", "noopener,noreferrer");
    } catch (err: unknown) {
      captureError(err);
    }
  };

  const importExternal = async (mode: ExternalImportMode, files: readonly File[]): Promise<void> => {
    if (!runId) return;
    try {
      const res = await uploadExternalResults(runId, mode, files);
      setMatlabWaitingExpiry(null);
      setExternalImported(true);
      if (res.external_sim) setExternalSim(res.external_sim);
      if (res.draft_objective) setNextRoundObjective(res.draft_objective);
      if (res.status) setTelemetry((prev) => ({ ...prev, status: res.status ?? prev.status }));
      await refreshBundle(runId, activeRevision);
    } catch (err: unknown) {
      captureError(err);
    }
  };

  return {
    runId, busy, telemetry, activeRevision, selectedPartId, bundle, objectiveDraft,
    matlabWaitingExpiry, matlabCommand, externalImported, externalSim, errorBanner, setSelectedPartId,
    selectRevision: (rev: number) => { setActiveRevision(rev); if (runId) void refreshBundle(runId, rev); },
    updateDraft: (txt: string, pid?: string | null) => {
      setObjectiveDraft((prev) => updateObjectiveDraft(prev, txt, pid));
      setTelemetry((prev) => (prev.status === "OBJECTIVE_CONFIRMED" ? { ...prev, status: "PRESETS_READY" } : prev));
    },
    selectPreset: async (preset: Preset) => {
      setObjectiveDraft((prev) => selectPresetDraft(prev, preset));
      setTelemetry((prev) => (prev.status === "OBJECTIVE_CONFIRMED" ? { ...prev, status: "PRESETS_READY" } : prev));
      await reviewCurrentObjective(preset.rationale, activeRevision);
    },
    submitRun, reviewCurrentObjective, confirmReviewedObjective, executeRevision, runMatlabOnline, importExternal,
    startNextRound: async () => {
      const nextText = nextRoundObjective || "Refine design based on external audit";
      setObjectiveDraft((prev) => ({ ...updateObjectiveDraft(prev, nextText, null), baseRevision: telemetry.latestRevision }));
      await reviewCurrentObjective(nextText, telemetry.latestRevision);
    },
  };
}
