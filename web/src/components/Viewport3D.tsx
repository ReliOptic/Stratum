import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { fetchArtifactGlbBuffer } from "@/lib/api";
import type { CausalEdge, CausalKind, Manifest } from "@/lib/contracts";
import {
  computeAssemblyCentroidMm,
  computeExplodedPosition,
  mapManifestToPartByNode,
  parseGlbNodeNames,
} from "@/lib/state";

const EDGE_COLOR_HEX: Readonly<Record<CausalKind, string>> = {
  thermal: "#F2A33A",
  electrical: "#4CC9F0",
  mechanical: "#B8A44C",
};

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
}: Viewport3DProps): React.JSX.Element {
  const [explode, setExplode] = React.useState<number>(0);
  const [hoveredEdge, setHoveredEdge] = React.useState<CausalEdge | null>(null);
  const [glbBuffer, setGlbBuffer] = React.useState<ArrayBuffer | null>(null);
  const [loadedGlbRev, setLoadedGlbRev] = React.useState<number | null>(null);
  const [glbNodeNames, setGlbNodeNames] = React.useState<readonly string[]>([]);

  const webglAvailable = React.useMemo(() => canCreateWebGLContext(), []);
  const parts = manifest?.parts ?? [];
  const nodeMap = React.useMemo(() => mapManifestToPartByNode(manifest), [manifest]);
  const centroid = React.useMemo(() => computeAssemblyCentroidMm(parts), [parts]);
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
    });
    return () => {
      cancelled = true;
    };
  }, [runId, manifest?.run_id, activeRevision, parts.length]);

  return (
    <section
      data-testid="viewport-3d"
      data-active-part={selectedPartId ?? "none"}
      data-glb-rev={loadedGlbRev !== null ? String(loadedGlbRev) : "none"}
      data-glb-nodes={glbNodeNames.join(",")}
      data-mapped-parts={Object.keys(nodeMap).length}
      aria-label="3D Engineering Viewport"
      className="relative h-full w-full overflow-hidden bg-bg"
    >
      {isRunning && (
        <div data-testid="hud-corner-brackets" className="pointer-events-none absolute inset-3 z-10">
          <span className="absolute top-0 left-0 h-3 w-3 border-t border-l border-amber/50" />
          <span className="absolute top-0 right-0 h-3 w-3 border-t border-r border-amber/50" />
          <span className="absolute bottom-0 left-0 h-3 w-3 border-b border-l border-amber/50" />
          <span className="absolute right-0 bottom-0 h-3 w-3 border-r border-b border-amber/50" />
        </div>
      )}
      {webglAvailable && parts.length > 0 ? (
        <React.Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center font-mono text-xs text-dim tabular-nums">
              INITIALIZING 3D VIEWPORT · V{activeRevision}
            </div>
          }
        >
          <LazyViewportCanvas
            parts={parts}
            edges={edges}
            explodeFactor={explode}
            selectedPartId={selectedPartId}
            onSelectPart={onSelectPart}
            onHoverEdge={setHoveredEdge}
            glbBuffer={glbBuffer}
          />
        </React.Suspense>
      ) : parts.length > 0 ? (
        <div className="flex h-full w-full items-center justify-center font-mono text-xs text-dim tabular-nums">
          CAD MANIFEST LOADED · V{activeRevision} ({parts.length} PARTS)
        </div>
      ) : null}
      {parts.length > 0 && (
        <div className="pointer-events-auto absolute top-6 left-6 z-20 flex flex-col gap-2.5 rounded-md bg-panel/90 p-3.5 transition-all duration-200 ease-out">
          <div className="flex items-center justify-between gap-4 text-xs">
            <span data-saira="true" className="text-dim">EXPLODED VIEW · V{activeRevision}</span>
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
            className="w-44 accent-amber"
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {parts.map((p) => {
              const isSelected = selectedPartId === p.part_id;
              const ghost = !isSelected && selectedPartId !== null;
              const [ox, oy, oz] = computeExplodedPosition(p, explode, centroid);
              return (
                <button
                  key={p.glb_node}
                  type="button"
                  data-testid={`viewport-node-${p.part_id}`}
                  data-glb-node={p.glb_node}
                  data-visual-state={isSelected ? "active-amber" : ghost ? "xray-ghost-15" : "default"}
                  data-scanline={isSelected ? "true" : undefined}
                  data-offset-mm={`${ox.toFixed(1)},${oy.toFixed(1)},${oz.toFixed(1)}`}
                  onClick={() => onSelectPart(p.part_id)}
                  className={
                    isSelected
                      ? "rounded-sm bg-amber/20 px-2.5 py-1 font-mono text-xs text-amber tabular-nums transition-colors duration-150"
                      : ghost
                        ? "rounded-sm bg-bg/40 px-2.5 py-1 font-mono text-xs text-dim opacity-60 transition-opacity duration-150 hover:opacity-100"
                        : "rounded-sm bg-bg px-2.5 py-1 font-mono text-xs text-dim transition-colors duration-150 hover:text-text"
                  }
                >
                  {p.part_id}
                </button>
              );
            })}
          </div>
          {edges.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {edges.map((edge, idx) => (
                <button
                  key={`${edge.from_part}-${edge.to_part}-${idx}`}
                  type="button"
                  data-testid={`causal-spline-${edge.from_part}-${edge.to_part}`}
                  data-edge-kind={edge.kind}
                  data-edge-color={EDGE_COLOR_HEX[edge.kind]}
                  onMouseEnter={() => setHoveredEdge(edge)}
                  onMouseLeave={() => setHoveredEdge(null)}
                  onFocus={() => setHoveredEdge(edge)}
                  onClick={() => setHoveredEdge(edge)}
                  className="flex items-center gap-1.5 rounded-sm bg-bg px-2 py-1 font-mono text-xs text-dim transition-colors duration-150 hover:text-text"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: EDGE_COLOR_HEX[edge.kind] }} />
                  <span>{edge.from_part}→{edge.to_part}</span>
                </button>
              ))}
            </div>
          )}
          {hoveredEdge && (
            <div data-testid="spline-tooltip" className="rounded-sm bg-bg p-2.5 font-sans text-xs text-text">
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
