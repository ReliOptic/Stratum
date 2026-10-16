import * as React from "react";
import { formatMmSs } from "@/components/ReasoningStage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appConfig } from "@/lib/config";
import type { LoopNode } from "@/lib/contracts";
import { getAvailableRevisions } from "@/lib/state";

export interface LoopStripProps {
  readonly loopNodes: readonly LoopNode[];
  readonly latestRevision: number;
  readonly activeRevision: number;
  readonly onSelectRevision: (rev: number) => void;
  readonly onRunMatlabOnline: () => void;
  readonly onDownloadBridgeZip: () => void;
  readonly onToggleImportDrawer: () => void;
  readonly matlabWaitingExpiry: string | null;
  readonly matlabCommand?: string | null;
  readonly externalImported?: boolean;
}

export function LoopStrip({
  loopNodes,
  latestRevision,
  activeRevision,
  onSelectRevision,
  onRunMatlabOnline,
  onDownloadBridgeZip,
  onToggleImportDrawer,
  matlabWaitingExpiry,
  matlabCommand = null,
  externalImported = false,
}: LoopStripProps): React.JSX.Element {
  const revisionTabs = getAvailableRevisions(latestRevision);
  const [panelOpen, setPanelOpen] = React.useState<boolean>(false);
  const [copied, setCopied] = React.useState<boolean>(false);
  const [bridgeStage, setBridgeStage] = React.useState<"waiting" | "downloaded" | "received">("waiting");
  const [elapsedSec, setElapsedSec] = React.useState<number>(0);

  React.useEffect(() => {
    if (matlabCommand || matlabWaitingExpiry) setPanelOpen(true);
  }, [matlabCommand, matlabWaitingExpiry]);

  React.useEffect(() => {
    if (externalImported) setBridgeStage("received");
  }, [externalImported]);

  React.useEffect(() => {
    if (!panelOpen || externalImported) return undefined;
    const tokenMatch = (matlabCommand ?? "").match(/\/b\/([^/\s"']+)/);
    const token = tokenMatch?.[1] ?? "tok-matlab";
    const id = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
      void fetch(`${appConfig.apiBaseUrl}/b/${encodeURIComponent(token)}/status`, { credentials: "include" })
        .then(async (r) => (r.ok ? ((await r.json()) as { status?: string }) : null))
        .then((data) => {
          if (!data?.status) return;
          if (data.status === "received" || data.status === "completed" || data.status === "EXTERNAL_RESULTS_IMPORTED") {
            setBridgeStage("received");
          } else if (data.status === "downloaded" || data.status === "BUNDLE_DOWNLOADED") {
            setBridgeStage("downloaded");
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(id);
  }, [panelOpen, externalImported, matlabCommand]);

  const cmdText = matlabCommand ?? "stratum_Bridge_V0_V1";

  return (
    <div data-testid="loop-strip" data-matlab-command={matlabCommand ?? "none"} className="flex flex-col gap-2 pb-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1" data-testid="revision-tabs">
            {revisionTabs.map((tab) => (
              <Button key={tab.revision} size="sm" variant={activeRevision === tab.revision ? "default" : "outline"} data-testid={`revision-tab-V${tab.revision}`} onClick={() => onSelectRevision(tab.revision)}>
                {tab.label}
              </Button>
            ))}
          </div>
          {loopNodes.map((node, idx) => (
            <div key={node.revision} data-testid={`loop-node-V${node.revision}`} className="flex items-center gap-1.5 font-mono text-xs tabular-nums">
              {idx > 0 && <span className="text-dim">→</span>}
              <div className="flex items-center gap-1.5 rounded-md bg-bg px-2.5 py-1">
                <span className="font-semibold text-amber">{node.label}</span>
                <span className="text-confirm">✓{node.confirmed_count}</span>
                <span className="text-danger">✗{node.refuted_count}</span>
                <span className="text-dim">{node.wall_time_s}s</span>
                <span className="text-dim">{node.context_tokens}tok</span>
                {node.badges.map((b) => (
                  <Badge key={b} variant={b === "simulink-audited" ? "confirm" : b === "sandbox-checked" ? "cyan" : "olive"}>{b}</Badge>
                ))}
                {node.audit && node.audit !== "not_applicable" && (
                  <Badge variant={node.audit === "match" ? "confirm" : "danger"} data-testid="audit-badge">
                    {node.audit === "match" ? "AUDIT MATCH" : `AUDIT ${node.audit.toUpperCase()}`}
                    {typeof node.max_abs_diff_C === "number" ? ` · max ΔT ${node.max_abs_diff_C.toFixed(1)}°C` : ""}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>

        {latestRevision >= 1 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {matlabWaitingExpiry && (
              <Badge variant="amber" data-testid="matlab-waiting-badge" data-expires-at={matlabWaitingExpiry}>
                Waiting for MATLAB… (expires {matlabWaitingExpiry})
              </Badge>
            )}
            <Button
              size="sm"
              variant="default"
              data-testid="run-matlab-online-button"
              onClick={() => {
                setPanelOpen(true);
                onRunMatlabOnline();
              }}
            >
              Run in MATLAB Online
            </Button>
            <details className="group relative" data-testid="matlab-fallback-details">
              <summary
                data-testid="import-results-toggle"
                onClick={() => onToggleImportDrawer()}
                className="cursor-pointer list-none rounded-md border border-hairline bg-bg px-2.5 py-1 font-sans text-xs text-dim hover:text-text"
              >
                ZIP &amp; Import fallback ▾
              </summary>
              <div className="mt-1 flex items-center gap-1.5">
                <Button size="sm" variant="outline" data-testid="download-zip-button" onClick={onDownloadBridgeZip}>
                  Download ZIP
                </Button>
              </div>
            </details>
          </div>
        )}
      </div>

      {panelOpen && (
        <div data-testid="matlab-handoff-panel" className="flex flex-col gap-2.5 rounded-md border border-amber/40 bg-bg p-3.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3 font-sans text-text">
              <span><strong className="text-amber">1</strong> <a href="https://matlab.mathworks.com" target="_blank" rel="noreferrer" className="underline hover:text-amber">Open MATLAB Online ↗</a></span>
              <span><strong className="text-amber">2</strong> Paste into the Command Window, press Enter</span>
              <span><strong className="text-amber">3</strong> Results return here automatically</span>
            </div>
            <Badge
              variant={bridgeStage === "received" ? "confirm" : bridgeStage === "downloaded" ? "cyan" : "amber"}
              data-testid="matlab-live-status"
            >
              {bridgeStage === "received"
                ? "Results received ✓ AUDIT MATCH"
                : bridgeStage === "downloaded"
                  ? "Bundle downloaded"
                  : `Waiting for MATLAB… ${formatMmSs(elapsedSec)}`}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-sm bg-panel px-3 py-2 font-mono text-xs text-amber">
            <code data-testid="matlab-command-text" className="truncate">{cmdText}</code>
            <Button
              size="sm"
              variant="default"
              data-testid="btn-copy-matlab-cmd"
              onClick={() => {
                setCopied(true);
                void navigator.clipboard?.writeText(cmdText).catch(() => undefined);
              }}
            >
              {copied ? "Copied ✓" : "Copy command"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
