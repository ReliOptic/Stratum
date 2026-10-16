import * as React from "react";
import { LoopStrip } from "@/components/LoopStrip";
import { RevisionPanel } from "@/components/RevisionPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appConfig } from "@/lib/config";
import type {
  BenchmarkEntry,
  LoopNode,
  MetricDiff,
  ObjectivePreset,
  PassPrediction,
  SandboxCheck,
  SimPoint,
  VariantCard,
} from "@/lib/contracts";
import {
  canTriggerRevision,
  type ExternalImportMode,
  type ObjectiveDraftState,
  validateExternalResultsUpload,
} from "@/lib/state";
import type { StratumError } from "@/lib/utils";

export interface ControlDeckProps {
  readonly presets: readonly ObjectivePreset[];
  readonly objectiveDraft: ObjectiveDraftState;
  readonly onUpdateDraftText: (text: string, presetId?: string | null) => void;
  readonly onRequestConfirmObjective: () => void;
  readonly onExecuteRevision: () => void;
  readonly loopNodes: readonly LoopNode[];
  readonly latestRevision: number;
  readonly activeRevision: number;
  readonly onSelectRevision: (rev: number) => void;
  readonly variants: readonly VariantCard[];
  readonly passes: readonly PassPrediction[];
  readonly metrics: readonly MetricDiff[];
  readonly simPoints: readonly SimPoint[];
  readonly sandbox: SandboxCheck | null;
  readonly benchmarks: readonly BenchmarkEntry[];
  readonly onRunMatlabOnline: () => void;
  readonly onDownloadBridgeZip: () => void;
  readonly onImportExternalFiles: (mode: ExternalImportMode, files: readonly File[]) => void;
  readonly onStartNextRound: () => void;
  readonly matlabWaitingExpiry: string | null;
  readonly externalImported: boolean;
  readonly errorBanner: StratumError | null;
}

export function ControlDeck(props: ControlDeckProps): React.JSX.Element {
  const [confirmModalOpen, setConfirmModalOpen] = React.useState<boolean>(false);
  const [importDrawerOpen, setImportDrawerOpen] = React.useState<boolean>(false);
  const [importMode, setImportMode] = React.useState<ExternalImportMode>("simulink");
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  const reviseAllowed = canTriggerRevision(props.objectiveDraft, appConfig.maxRevision);
  const atMaxRevision = props.latestRevision >= appConfig.maxRevision;

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

  return (
    <footer
      data-testid="control-deck"
      aria-label="Bottom Control Deck"
      className="pointer-events-auto z-20 flex w-full flex-col gap-2 border-t border-hairline bg-panel/95 px-4 py-2.5"
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
      />
      {props.errorBanner && (
        <div
          data-testid="deck-error-banner"
          className="flex items-center justify-between rounded-sm border border-danger bg-danger/15 px-3 py-1.5 font-mono text-xs text-danger"
        >
          <span>[{props.errorBanner.code}] {props.errorBanner.message}</span>
          <span className="text-text">{props.errorBanner.recoveryHint}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {props.presets.map((p) => (
            <Button
              key={p.preset_id}
              size="sm"
              variant={props.objectiveDraft.selectedPresetId === p.preset_id ? "default" : "outline"}
              data-testid={`preset-${p.preset_id}`}
              onClick={() => props.onUpdateDraftText(p.description, p.preset_id)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-1 items-center gap-2">
          <input
            type="text"
            data-testid="objective-input"
            value={props.objectiveDraft.text}
            onChange={(e) => props.onUpdateDraftText(e.target.value, null)}
            placeholder="Specify engineering improvement objective..."
            aria-label="Engineering improvement objective"
            className="h-8 min-w-48 flex-1 rounded-sm border border-hairline bg-bg px-3 font-mono text-xs text-text placeholder:text-dim focus:border-amber focus:outline-none"
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="open-confirm-modal-button"
            disabled={!props.objectiveDraft.text.trim() || atMaxRevision}
            onClick={() => { props.onRequestConfirmObjective(); setConfirmModalOpen(true); }}
          >
            Confirm Objective
          </Button>
          <Button
            size="sm"
            variant="confirm"
            data-testid="revise-button"
            disabled={!reviseAllowed || atMaxRevision}
            onClick={props.onExecuteRevision}
          >
            Revise (V{props.objectiveDraft.baseRevision} → V{props.objectiveDraft.baseRevision + 1})
          </Button>
          {props.externalImported && !atMaxRevision && (
            <Button
              size="sm"
              variant="default"
              data-testid="start-next-round-button"
              onClick={() => { props.onStartNextRound(); setConfirmModalOpen(true); }}
            >
              Start next round
            </Button>
          )}
        </div>
      </div>
      {importDrawerOpen && (
        <div data-testid="import-results-drawer" className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-cyan/50 bg-bg p-2.5 font-mono text-xs">
          <div className="flex items-center gap-2">
            <Button size="sm" variant={importMode === "simulink" ? "cyan" : "outline"} data-testid="import-tab-simulink" onClick={() => setImportMode("simulink")}>Simulink</Button>
            <Button size="sm" variant={importMode === "lab" ? "cyan" : "outline"} data-testid="import-tab-lab" onClick={() => setImportMode("lab")}>Lab measurement</Button>
          </div>
          <input type="file" multiple data-testid="external-results-file-input" onChange={handleFilesSelected} className="font-mono text-xs text-text" />
          {uploadError && <span data-testid="upload-validation-error" className="text-danger">{uploadError}</span>}
        </div>
      )}
      {(props.passes.length > 0 || props.metrics.length > 0 || props.simPoints.length > 0) && (
        <RevisionPanel
          variants={props.variants}
          passes={props.passes}
          metrics={props.metrics}
          simPoints={props.simPoints}
          sandbox={props.sandbox}
          benchmarks={props.benchmarks}
        />
      )}
      {confirmModalOpen && (
        <div data-testid="objective-confirm-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-bg/85 p-4">
          <div className="flex w-full max-w-md flex-col gap-3 rounded-sm border border-amber bg-panel p-4 font-mono text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-amber">Is this what you want to improve?</span>
              <Badge variant="olive">Base: V{props.objectiveDraft.baseRevision}</Badge>
            </div>
            <p className="text-text">{props.objectiveDraft.text}</p>
            <div className="flex flex-col gap-1 border-t border-hairline pt-2">
              {props.objectiveDraft.normalizedTargets.map((t) => <div key={t} className="text-confirm">• {t}</div>)}
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => setConfirmModalOpen(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </footer>
  );
}
