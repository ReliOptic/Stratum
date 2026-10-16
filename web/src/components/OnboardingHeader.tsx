import type * as React from "react";
import { formatMmSs } from "@/components/ReasoningStage";
import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "@/lib/contracts";
import { cn } from "@/lib/utils";

export interface OnboardingHeaderProps {
  readonly docked: boolean;
  readonly runId: string | null;
  readonly status: RunStatus | null;
  readonly sseConnected: boolean;
  readonly elapsedSeconds?: number;
}

export function OnboardingHeader({
  docked,
  runId,
  status,
  sseConnected,
  elapsedSeconds = 0,
}: OnboardingHeaderProps): React.JSX.Element {
  return (
    <header
      data-testid="onboarding-header"
      data-docked={docked ? "true" : "false"}
      className={cn(
        "pointer-events-auto z-30 flex flex-wrap items-center justify-between gap-2 px-5 py-3 transition-colors duration-200 ease-out",
        docked ? "w-full bg-panel/90" : "fixed top-0 left-0 w-full bg-transparent",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span data-saira="true" className="text-sm font-semibold text-amber">
          STRATUM
        </span>
        <span className="font-sans text-xs text-dim">
          Total Elements layer for Baltam
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {runId && (
          <Badge variant="dim" data-testid="active-run-id">
            RUN {runId}
          </Badge>
        )}
        {runId && (
          <Badge variant="dim" data-testid="run-elapsed-timer" className="font-mono tabular-nums">
            {formatMmSs(elapsedSeconds)}
          </Badge>
        )}
        {status && (
          <Badge
            variant={
              status === "FAILED"
                ? "danger"
                : status === "V1_READY" || status === "V2_READY"
                  ? "confirm"
                  : "amber"
            }
            data-testid="run-status-badge"
          >
            {status}
          </Badge>
        )}
        {runId && (
          <Badge variant={sseConnected ? "cyan" : "dim"}>
            {sseConnected ? "TELEMETRY LIVE" : "TELEMETRY IDLE"}
          </Badge>
        )}
      </div>
    </header>
  );
}
