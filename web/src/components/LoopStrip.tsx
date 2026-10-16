import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
}: LoopStripProps): React.JSX.Element {
  const revisionTabs = getAvailableRevisions(latestRevision);

  return (
    <div
      data-testid="loop-strip"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1" data-testid="revision-tabs">
          {revisionTabs.map((tab) => (
            <Button
              key={tab.revision}
              size="sm"
              variant={activeRevision === tab.revision ? "default" : "outline"}
              data-testid={`revision-tab-V${tab.revision}`}
              onClick={() => onSelectRevision(tab.revision)}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {loopNodes.map((node, idx) => (
          <div
            key={node.revision}
            data-testid={`loop-node-V${node.revision}`}
            className="flex items-center gap-1.5 font-mono text-xs"
          >
            {idx > 0 && <span className="text-dim">→</span>}
            <div className="flex items-center gap-1.5 rounded-sm border border-hairline bg-bg px-2 py-1">
              <span className="font-semibold text-amber">{node.label}</span>
              <span className="text-confirm">✓{node.confirmed_count}</span>
              <span className="text-danger">✗{node.refuted_count}</span>
              <span className="text-dim">{node.wall_time_s}s</span>
              <span className="text-dim">{node.context_tokens}tok</span>
              {node.badges.map((b) => (
                <Badge
                  key={b}
                  variant={
                    b === "simulink-audited"
                      ? "confirm"
                      : b === "sandbox-checked"
                        ? "cyan"
                        : "olive"
                  }
                >
                  {b}
                </Badge>
              ))}
              {node.audit && node.audit !== "not_applicable" && (
                <Badge
                  variant={node.audit === "match" ? "confirm" : "danger"}
                  data-testid="audit-badge"
                >
                  {node.audit === "match" ? "AUDIT MATCH" : `AUDIT ${node.audit.toUpperCase()}`}
                  {typeof node.max_abs_diff_C === "number"
                    ? ` · max ΔT ${node.max_abs_diff_C.toFixed(1)}°C`
                    : ""}
                </Badge>
              )}
            </div>
          </div>
        ))}
      </div>

      {latestRevision >= 1 && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          {matlabWaitingExpiry && (
            <Badge variant="amber" data-testid="matlab-waiting-badge">
              Waiting for MATLAB… (exp {matlabWaitingExpiry})
            </Badge>
          )}
          <Button
            size="sm"
            variant="default"
            data-testid="run-matlab-online-button"
            onClick={onRunMatlabOnline}
          >
            Run in MATLAB Online
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="download-zip-button"
            title="Runs in MATLAB/Simulink — execution is performed by you"
            onClick={onDownloadBridgeZip}
          >
            Download ZIP
          </Button>
          <span className="hidden text-dim xl:inline">
            Runs in MATLAB/Simulink — execution is performed by you
          </span>
          <Button
            size="sm"
            variant="cyan"
            data-testid="import-results-toggle"
            onClick={onToggleImportDrawer}
          >
            Import results
          </Button>
        </div>
      )}
    </div>
  );
}
