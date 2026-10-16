import * as React from "react";
import { LoopStrip } from "@/components/LoopStrip";
import { RevisionPanel } from "@/components/RevisionPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appConfig } from "@/lib/config";
import { describeTargetDirection } from "@/lib/connectivity";
import type { BenchmarkComparison, ExternalSimResult, LoopNode, MetricSet, PassReport, Preset, RunStatus, SandboxCheck, SimResult, Variant } from "@/lib/contracts";
import {
  canConfirmReviewedObjective,
  canTriggerRevision,
  type ExternalImportMode,
  type ObjectiveDraftState,
  validateExternalResultsUpload,
} from "@/lib/state";
import type { StratumError } from "@/lib/utils";

export interface ControlDeckProps {
  readonly runStatus: RunStatus | null;
  readonly presets: readonly Preset[];
  readonly objectiveDraft: ObjectiveDraftState;
  readonly onUpdateDraftText: (text: string, presetId?: string | null) => void;
  readonly onSelectPreset: (preset: Preset) => void;
  readonly onReviewObjective: () => void;
  readonly onConfirmObjective: () => Promise<boolean> | void;
  readonly onExecuteRevision: () => void;
  readonly loopNodes: readonly LoopNode[];
  readonly latestRevision: number;
  readonly activeRevision: number;
  readonly onSelectRevision: (rev: number) => void;
  readonly variants: readonly Variant[];
  readonly passes: readonly PassReport[];
  readonly metrics: MetricSet | null;
  readonly baseMetrics: MetricSet | null;
  readonly sim: SimResult | null;
  readonly baseSim: SimResult | null;
  readonly externalSim?: ExternalSimResult | null;
  readonly sandbox: SandboxCheck | null;
  readonly benchmarks: readonly BenchmarkComparison[];
  readonly onRunMatlabOnline: () => void;
  readonly onDownloadBridgeZip: () => void;
  readonly onImportExternalFiles: (mode: ExternalImportMode, files: readonly File[]) => void;
  readonly onStartNextRound: () => void;
  readonly matlabWaitingExpiry: string | null;
  readonly matlabCommand?: string | null;
  readonly externalImported: boolean;
  readonly errorBanner: StratumError | null;
}

export function ControlDeck(props: ControlDeckProps): React.JSX.Element {
  const [confirmModalOpen, setConfirmModalOpen] = React.useState<boolean>(false);
  const [importDrawerOpen, setImportDrawerOpen] = React.useState<boolean>(false);
  const [importMode, setImportMode] = React.useState<ExternalImportMode>("simulink");
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  const reviewReady = canConfirmReviewedObjective(props.objectiveDraft);
  const reviseAllowed = canTriggerRevision(props.objectiveDraft, appConfig.maxRevision, props.runStatus);
  const atMaxRevision = props.latestRevision >= appConfig.maxRevision;
  const refMetrics = props.metrics ?? props.baseMetrics;

  React.useEffect(() => {
    if (props.errorBanner?.code === "CONFIRMATION_REQUIRED_409") {
      if (!reviewReady && props.objectiveDraft.text.trim()) props.onReviewObjective();
      setConfirmModalOpen(true);
    }
  }, [props.errorBanner, reviewReady, props.objectiveDraft.text, props.onReviewObjective]);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const fileList = e.target.files ? Array.from(e.target.files) : [];
    const check = validateExternalResultsUpload(importMode, fileList.map((f) => f.name));
    if (!check.valid) {
      setUploadError(check.error.message);
      return;
    }
    setUploadError(null);
    props.onImportExternalFiles(importMode, fileList);
  };

  const activeTargets = props.objectiveDraft.targets.length > 0 ? props.objectiveDraft.targets : (props.presets[0]?.targets ?? []);

  return (
    <footer
      data-testid="control-deck"
      data-objective-hash={props.objectiveDraft.objectiveHash ?? "none"}
      aria-label="Bottom Control Deck"
      className="pointer-events-auto z-40 flex w-full flex-col gap-2.5 bg-panel px-5 py-3 transition-all duration-200 ease-out"
    >
      <LoopStrip
        loopNodes={props.loopNodes}
        latestRevision={props.latestRevision}
        activeRevision={props.activeRevision}
        onSelectRevision={props.onSelectRevision}
        onRunMatlabOnline={props.onRunMatlabOnline}
        onDownloadBridgeZip={props.onDownloadBridgeZip}
        onToggleImportDrawer={() => setImportDrawerOpen((prev) => !prev)}
        matlabWaitingExpiry={props.matlabWaitingExpiry}
        matlabCommand={props.matlabCommand}
        externalImported={props.externalImported}
      />
      {props.errorBanner && (
        <div data-testid="deck-error-banner" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-danger/15 px-3 py-1.5 font-sans text-xs text-danger">
          <span className="font-mono">[{props.errorBanner.code}] {props.errorBanner.message}</span>
          <span className="text-text">{props.errorBanner.recoveryHint}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {props.presets.map((p) => {
            const unsafe = p.targets.some((t) => !describeTargetDirection(t, refMetrics).safer);
            return (
              <Button
                key={p.preset_id}
                size="sm"
                variant={props.objectiveDraft.selectedPresetId === p.preset_id ? "default" : "outline"}
                data-testid={`preset-${p.preset_id}`}
                onClick={() => { props.onSelectPreset(p); setConfirmModalOpen(true); }}
                className="flex items-center gap-1.5"
              >
                <span>{p.title}</span>
                {unsafe && <Badge variant="danger" data-testid={`preset-direction-warning-${p.preset_id}`}>direction check</Badge>}
              </Button>
            );
          })}
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <input
            type="text"
            data-testid="objective-input"
            value={props.objectiveDraft.text}
            onChange={(e) => props.onUpdateDraftText(e.target.value, null)}
            placeholder="Specify engineering improvement objective..."
            aria-label="Engineering improvement objective"
            className="h-8 min-w-48 flex-1 rounded-md bg-bg px-3 font-sans text-xs text-text placeholder:text-dim focus:outline-none"
          />
          <Button size="sm" variant="outline" data-testid="open-confirm-modal-button" disabled={!props.objectiveDraft.text.trim() || atMaxRevision} onClick={() => { props.onReviewObjective(); setConfirmModalOpen(true); }}>
            Review Objective
          </Button>
          <Button size="sm" variant="confirm" data-testid="revise-button" disabled={!reviseAllowed || atMaxRevision} onClick={props.onExecuteRevision}>
            Revise (V{props.objectiveDraft.baseRevision} → V{props.objectiveDraft.baseRevision + 1})
          </Button>
          {props.externalImported && !atMaxRevision && (
            <Button size="sm" variant="default" data-testid="start-next-round-button" onClick={() => { props.onStartNextRound(); setConfirmModalOpen(true); }}>
              Start next round
            </Button>
          )}
        </div>
      </div>
      {importDrawerOpen && (
        <div data-testid="import-results-drawer" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-bg p-3 font-sans text-xs">
          <div className="flex items-center gap-2">
            <Button size="sm" variant={importMode === "simulink" ? "cyan" : "outline"} data-testid="import-tab-simulink" onClick={() => setImportMode("simulink")}>Simulink</Button>
            <Button size="sm" variant={importMode === "lab" ? "cyan" : "outline"} data-testid="import-tab-lab" onClick={() => setImportMode("lab")}>Lab measurement</Button>
          </div>
          <input type="file" multiple data-testid="external-results-file-input" onChange={handleFilesSelected} className="font-sans text-xs text-text" />
          {uploadError && <span data-testid="upload-validation-error" className="text-danger">{uploadError}</span>}
        </div>
      )}
      {Boolean(props.passes.length > 0 || props.metrics || props.sim) && (
        <RevisionPanel variants={props.variants} passes={props.passes} metrics={props.metrics} baseMetrics={props.baseMetrics} sim={props.sim} baseSim={props.baseSim} externalSim={props.externalSim} externalImported={props.externalImported} targets={activeTargets} sandbox={props.sandbox} benchmarks={props.benchmarks} />
      )}
      {confirmModalOpen && (
        <div data-testid="objective-confirm-modal" data-objective-hash={props.objectiveDraft.objectiveHash ?? "none"} className="fixed inset-0 z-50 flex items-center justify-center bg-bg/85 p-4">
          <div className="flex w-full max-w-md flex-col gap-3 rounded-md bg-panel p-5 font-sans text-xs">
            <div className="flex items-center justify-between">
              <span data-saira="true" className="font-semibold text-amber">Is this what you want to improve?</span>
              <Badge variant="olive">Base: V{props.objectiveDraft.baseRevision}</Badge>
            </div>
            <p className="text-text">{props.objectiveDraft.text}</p>
            <div data-testid="confirm-targets-list" className="flex flex-col gap-1.5 rounded-md bg-bg p-3 font-mono tabular-nums">
              {props.objectiveDraft.targets.map((t) => {
                const info = describeTargetDirection(t, refMetrics, props.objectiveDraft.baseRevision);
                return (
                  <div key={t.metric_id} data-testid={`target-direction-${t.metric_id}`} className={`flex flex-wrap items-center justify-between gap-2 ${info.safer ? "text-confirm" : "text-danger"}`}>
                    <span>• {info.sentence}</span>
                    {!info.safer && <Badge variant="danger" data-testid="direction-check-warning">direction check</Badge>}
                  </div>
                );
              })}
              <div className="font-sans text-dim">Constraint: Immutable base V{props.objectiveDraft.baseRevision} → V{props.objectiveDraft.baseRevision + 1} (max V{appConfig.maxRevision})</div>
            </div>
            {props.errorBanner?.code === "CONFIRMATION_REQUIRED_409" && (
              <div data-testid="modal-409-recovery" className="rounded-md bg-danger/15 p-2.5 text-danger">{props.errorBanner.recoveryHint}</div>
            )}
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                size="sm"
                variant="confirm"
                data-testid="modal-confirm-button"
                disabled={!reviewReady}
                onClick={async () => {
                  const ok = await props.onConfirmObjective();
                  if (ok) setConfirmModalOpen(false);
                }}
              >
                Confirm &amp; Revise (V{props.objectiveDraft.baseRevision} → V{props.objectiveDraft.baseRevision + 1})
              </Button>
              <Button size="sm" variant="outline" data-testid="modal-close-button" onClick={() => setConfirmModalOpen(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </footer>
  );
}
