import type * as React from "react";
import { BaltamPlanet } from "@/components/BaltamPlanet";
import { ControlDeck } from "@/components/ControlDeck";
import { OnboardingHeader } from "@/components/OnboardingHeader";
import { PromptBar } from "@/components/PromptBar";
import { TelemetryRail } from "@/components/TelemetryRail";
import { Viewport3D } from "@/components/Viewport3D";
import { appConfig } from "@/lib/config";
import { useStratumRun } from "@/lib/useStratumRun";

export function App(): React.JSX.Element {
  const ctrl = useStratumRun();
  const docked = ctrl.runId !== null;

  return (
    <div className="relative flex min-h-screen w-screen flex-col overflow-x-hidden overflow-y-auto bg-bg text-text md:h-screen md:overflow-hidden">
      <OnboardingHeader
        docked={docked}
        runId={ctrl.runId}
        status={ctrl.telemetry.status}
        sseConnected={ctrl.telemetry.connected}
      />

      <main className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative h-64 shrink-0 md:h-auto md:min-h-0 md:flex-1 md:shrink">
          <Viewport3D
            runId={ctrl.runId}
            manifest={ctrl.bundle.manifest}
            edges={ctrl.bundle.graph?.edges ?? []}
            selectedPartId={ctrl.selectedPartId}
            onSelectPart={ctrl.setSelectedPartId}
            activeRevision={ctrl.activeRevision}
          />
          {!docked && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 p-4">
              <BaltamPlanet />
              <PromptBar
                onSubmitRun={(p) => void ctrl.submitRun(p)}
                busy={ctrl.busy}
              />
            </div>
          )}
        </div>

        <TelemetryRail
          telemetry={ctrl.telemetry}
          spec={ctrl.bundle.spec}
          selectedPartId={ctrl.selectedPartId}
          onSelectPart={ctrl.setSelectedPartId}
        />
      </main>

      <ControlDeck
        runStatus={ctrl.telemetry.status}
        presets={ctrl.bundle.presets}
        objectiveDraft={ctrl.objectiveDraft}
        onUpdateDraftText={ctrl.updateDraft}
        onSelectPreset={(p) => void ctrl.selectPreset(p)}
        onReviewObjective={() => void ctrl.reviewCurrentObjective()}
        onConfirmObjective={() => void ctrl.confirmReviewedObjective()}
        onExecuteRevision={() => void ctrl.executeRevision()}
        loopNodes={ctrl.bundle.loopNodes}
        latestRevision={ctrl.telemetry.latestRevision}
        activeRevision={ctrl.activeRevision}
        onSelectRevision={ctrl.selectRevision}
        variants={ctrl.bundle.variants}
        passes={ctrl.bundle.passes}
        metrics={ctrl.bundle.metrics}
        baseMetrics={ctrl.bundle.baseMetrics}
        sim={ctrl.bundle.sim}
        baseSim={ctrl.bundle.baseSim}
        externalSim={ctrl.externalSim}
        sandbox={ctrl.bundle.sandbox}
        benchmarks={ctrl.bundle.benchmarks}
        onRunMatlabOnline={() => void ctrl.runMatlabOnline()}
        onDownloadBridgeZip={() => {
          if (ctrl.runId) {
            const baseRev = Math.max(0, ctrl.activeRevision - 1);
            window.open(
              `${appConfig.apiBaseUrl}/runs/${encodeURIComponent(ctrl.runId)}/bridge?base=${baseRev}&new=${ctrl.activeRevision}`,
              "_blank",
            );
          }
        }}
        onImportExternalFiles={(m, f) => void ctrl.importExternal(m, f)}
        onStartNextRound={() => void ctrl.startNextRound()}
        matlabWaitingExpiry={ctrl.matlabWaitingExpiry}
        matlabCommand={ctrl.matlabCommand}
        externalImported={ctrl.externalImported}
        errorBanner={ctrl.errorBanner}
      />
    </div>
  );
}
