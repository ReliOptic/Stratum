import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "@/lib/contracts";
import { cn } from "@/lib/utils";

export interface OnboardingHeaderProps {
  readonly docked: boolean;
  readonly runId: string | null;
  readonly status: RunStatus | null;
  readonly sseConnected: boolean;
}

export function OnboardingHeader({
  docked,
  runId,
  status,
  sseConnected,
}: OnboardingHeaderProps): React.JSX.Element {
  return (
    <header
      data-testid="onboarding-header"
      data-docked={docked ? "true" : "false"}
      className={cn(
        "pointer-events-auto z-20 flex items-center justify-between border-b border-hairline bg-panel/90 px-4 py-2.5 transition-all duration-500",
        docked ? "w-full" : "mx-auto mt-6 w-11/12 max-w-3xl rounded-sm border",
      )}
    >
      <div className="flex items-baseline gap-3">
        <h1 className="font-mono text-base font-bold tracking-wider text-amber uppercase">
          Stratum
        </h1>
        <span className="font-mono text-xs text-dim">
          Total Elements layer for Baltam
        </span>
      </div>
      <div className="flex items-center gap-2">
        {runId && (
          <Badge variant="dim" data-testid="active-run-id">
            RUN {runId}
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
