import * as React from "react";
import { ConnectivityTourOverlay } from "@/components/ConnectivityTourOverlay";
import { Badge } from "@/components/ui/badge";
import { fetchArtifactGlbBuffer } from "@/lib/api";
import type { CausalEdge, Manifest } from "@/lib/contracts";
import { mapManifestToPartByNode, parseGlbNodeNames } from "@/lib/state";

const LazyViewportCanvas = React.lazy(async () => {
  const mod = await import("@/components/ViewportCanvas");
  return { default: mod.ViewportCanvas };
});

export interface Viewport3DProps {
  readonly runId?: string | null;
  readonly manifest: Manifest | null;
  readonly edges: readonly CausalEdge[];
  readonly selectedPartId: string | null;
  readonly onSelectPart: (partId: string) => void;
  readonly activeRevision: number;
  readonly highlightedEdgeKeys?: readonly string[];
  readonly tourActive?: boolean;
  readonly tourIndex?: number;
  readonly onStepTour?: (delta: number) => void;
  readonly onStopTour?: () => void;
  readonly onGlbLoaded?: (rev: number) => void;
}

export function canCreateWebGLContext(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function Viewport3D({
  runId = null,
  manifest,
  edges,
  selectedPartId,
  onSelectPart,
  activeRevision,
  highlightedEdgeKeys = [],
  tourActive = false,
  tourIndex = 0,
  onStepTour = () => undefined,
  onStopTour = () => undefined,
  onGlbLoaded,
}: Viewport3DProps): React.JSX.Element {
  const [explode, setExplode] = React.useState<number>(0.6);
  const [hoveredEdge, setHoveredEdge] = React.useState<CausalEdge | null>(null);
  const [glbBuffer, setGlbBuffer] = React.useState<ArrayBuffer | null>(null);
  const [loadedGlbRev, setLoadedGlbRev] = React.useState<number | null>(null);
  const [glbNodeNames, setGlbNodeNames] = React.useState<readonly string[]>([]);

  const webglAvailable = React.useMemo(() => canCreateWebGLContext(), []);
  const parts = manifest?.parts ?? [];
  const nodeMap = React.useMemo(() => mapManifestToPartByNode(manifest), [manifest]);
  const isRunning = Boolean(runId) || parts.length > 0;

  React.useEffect(() => {
    const targetRunId = runId ?? manifest?.run_id ?? null;
    if (!targetRunId || parts.length === 0) return;
    let cancelled = false;
    void fetchArtifactGlbBuffer(targetRunId, activeRevision).then((buf) => {
      if (cancelled || !buf) return;
      setGlbBuffer(buf);
      setLoadedGlbRev(activeRevision);
      setGlbNodeNames(parseGlbNodeNames(buf));
      onGlbLoaded?.(activeRevision);
    });
    return () => {
      cancelled = true;
    };
  }, [runId, manifest?.run_id, activeRevision, parts.length, onGlbLoaded]);

  return (
    <section
      data-testid="viewport-3d"
      data-active-part={selectedPartId ?? "none"}
      data-glb-rev={loadedGlbRev !== null ? String(loadedGlbRev) : "none"}
      data-glb-nodes={glbNodeNames.join(",")}
      data-mapped-parts={Object.keys(nodeMap).length}
      data-highlighted-edges={highlightedEdgeKeys.join(",")}
      aria-label="3D Engineering Viewport"
      className={`relative h-full w-full overflow-hidden bg-bg transition-opacity duration-500 ease-out ${
        isRunning && loadedGlbRev === null && parts.length === 0 ? "opacity-0" : "opacity-100"
      }`}
    >
      {isRunning && (
        <div data-testid="hud-corner-brackets" className="pointer-events-none absolute inset-3 z-10">
          <span className="absolute top-0 left-0 h-3 w-3 border-t border-l border-amber/50" />
          <span className="absolute top-0 right-0 h-3 w-3 border-t border-r border-amber/50" />
          <span className="absolute bottom-0 left-0 h-3 w-3 border-b border-l border-amber/50" />
          <span className="absolute right-0 bottom-0 h-3 w-3 border-r border-b border-amber/50" />
        </div>
      )}
      {webglAvailable && parts.length > 0 && (
        <React.Suspense fallback={null}>
          <LazyViewportCanvas
            parts={parts}
            edges={edges}
            explodeFactor={explode}
            selectedPartId={selectedPartId}
            highlightedEdgeKeys={highlightedEdgeKeys}
            onSelectPart={onSelectPart}
            onHoverEdge={setHoveredEdge}
            glbBuffer={glbBuffer}
          />
        </React.Suspense>
      )}
      <ConnectivityTourOverlay
        parts={parts}
        edges={edges}
        explodeFactor={explode}
        selectedPartId={selectedPartId}
        highlightedEdgeKeys={highlightedEdgeKeys}
        tourActive={tourActive}
        tourIndex={tourIndex}
        onStepTour={onStepTour}
        onStopTour={onStopTour}
        onSelectPart={onSelectPart}
        onHoverEdge={setHoveredEdge}
      />
      {parts.length > 0 && (
        <div className="pointer-events-auto absolute top-6 left-6 z-20 flex flex-col gap-2 rounded-md bg-panel/90 p-3 transition-all duration-200 ease-out">
          <div className="flex items-center justify-between gap-4 text-xs">
            <span data-saira="true" className="text-dim">STRATA EXPLODE · V{activeRevision}</span>
            <span data-testid="explode-percent" className="font-mono text-amber tabular-nums">{Math.round(explode * 100)}%</span>
          </div>
          <input
            data-testid="explode-slider"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={explode}
            onChange={(e) => setExplode(Number.parseFloat(e.target.value))}
            aria-label="Exploded view factor"
            className="w-40 accent-amber"
          />
          {hoveredEdge && (
            <div data-testid="spline-tooltip" className="max-w-xs rounded-sm bg-bg p-2.5 font-sans text-xs text-text">
              <div className="flex items-center gap-2">
                <Badge variant={hoveredEdge.kind === "thermal" ? "amber" : hoveredEdge.kind === "electrical" ? "cyan" : "olive"}>{hoveredEdge.kind}</Badge>
                <span>{hoveredEdge.mechanism}</span>
              </div>
              <div className="mt-1 font-mono text-dim">Sources: {hoveredEdge.source_ids.join(", ") || "physics"}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
