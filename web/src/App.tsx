import * as React from "react";
import { ControlDeck } from "@/components/ControlDeck";
import { HeroTitleSequence } from "@/components/HeroTitleSequence";
import { OnboardingHeader } from "@/components/OnboardingHeader";
import { ReasoningStage } from "@/components/ReasoningStage";
import { TelemetryRail } from "@/components/TelemetryRail";
import { Viewport3D } from "@/components/Viewport3D";
import { appConfig } from "@/lib/config";
import { findTargetLinkedEdges, orderEdgesByStrength } from "@/lib/connectivity";
import { useStratumRun } from "@/lib/useStratumRun";

export function App(): React.JSX.Element {
  const ctrl = useStratumRun();
  const docked = ctrl.runId !== null;
  const [elapsedSeconds, setElapsedSeconds] = React.useState<number>(0);
  const [glbLoaded, setGlbLoaded] = React.useState<boolean>(false);
  const [tourActive, setTourActive] = React.useState<boolean>(false);
  const [tourIndex, setTourIndex] = React.useState<number>(0);
  const autoPlayedTourRef = React.useRef<boolean>(false);

  const edges = ctrl.bundle.graph?.edges ?? [];
  const orderedEdges = React.useMemo(() => orderEdgesByStrength(edges), [edges]);
  const hasParts = (ctrl.bundle.manifest?.parts.length ?? 0) > 0;
  const showReasoningStage = docked && !glbLoaded && !hasParts;

  React.useEffect(() => {
    if (!docked) {
      setElapsedSeconds(0);
      setGlbLoaded(false);
      return undefined;
    }
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [docked]);

  React.useEffect(() => {
    if (docked && orderedEdges.length > 0 && !autoPlayedTourRef.current) {
      autoPlayedTourRef.current = true;
      setTourActive(true);
      setTourIndex(0);
    }
  }, [docked, orderedEdges.length]);

  const highlightedEdgeKeys = React.useMemo(
    () => findTargetLinkedEdges(ctrl.objectiveDraft.targets, edges, ctrl.bundle.metrics ?? ctrl.bundle.baseMetrics),
    [ctrl.objectiveDraft.targets, edges, ctrl.bundle.metrics, ctrl.bundle.baseMetrics],
  );

  const handleStepTour = React.useCallback(
    (delta: number) => {
      if (orderedEdges.length === 0) return;
      setTourIndex((prev) => (prev + delta + orderedEdges.length) % orderedEdges.length);
    },
    [orderedEdges.length],
  );

  return (
    <div className="relative flex min-h-screen w-screen flex-col overflow-x-hidden overflow-y-auto bg-bg font-sans text-text md:h-screen md:overflow-hidden">
      <OnboardingHeader
        docked={docked}
        runId={ctrl.runId}
        status={ctrl.telemetry.status}
        sseConnected={ctrl.telemetry.connected}
        elapsedSeconds={elapsedSeconds}
      />

      <main className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-96 flex-1">
          <Viewport3D
            runId={ctrl.runId}
            manifest={ctrl.bundle.manifest}
            edges={edges}
            selectedPartId={ctrl.selectedPartId}
            onSelectPart={ctrl.setSelectedPartId}
            activeRevision={ctrl.activeRevision}
            highlightedEdgeKeys={highlightedEdgeKeys}
            tourActive={tourActive}
            tourIndex={tourIndex}
            onStepTour={handleStepTour}
            onStopTour={() => setTourActive(false)}
            onGlbLoaded={() => setGlbLoaded(true)}
          />
          {docked && (
            <ReasoningStage
              telemetry={ctrl.telemetry}
              spec={ctrl.bundle.spec}
              elapsedSeconds={elapsedSeconds}
              fadedOut={!showReasoningStage}
            />
          )}
          {!docked && (
            <div className="absolute inset-0 z-20">
              <HeroTitleSequence
                onSubmitRun={(p) => void ctrl.submitRun(p)}
                busy={ctrl.busy}
              />
            </div>
          )}
        </div>

        {docked && (
          <TelemetryRail
            telemetry={ctrl.telemetry}
            spec={ctrl.bundle.spec}
            edges={edges}
            selectedPartId={ctrl.selectedPartId}
            onSelectPart={ctrl.setSelectedPartId}
            onStartTour={() => {
              setTourIndex(0);
              setTourActive(true);
            }}
          />
        )}
      </main>

      {docked && (
        <ControlDeck
          runStatus={ctrl.telemetry.status}
          presets={ctrl.bundle.presets}
          objectiveDraft={ctrl.objectiveDraft}
          onUpdateDraftText={ctrl.updateDraft}
          onSelectPreset={(p) => void ctrl.selectPreset(p)}
          onReviewObjective={() => void ctrl.reviewCurrentObjective()}
          onConfirmObjective={() => ctrl.confirmReviewedObjective()}
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
      )}
    </div>
  );
}
