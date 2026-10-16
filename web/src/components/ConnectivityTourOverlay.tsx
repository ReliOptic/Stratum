import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { countEdgesByKind, edgeKey, orderEdgesByStrength } from "@/lib/connectivity";
import type { CausalEdge, CausalKind, ManifestPart } from "@/lib/contracts";
import { computeAssemblyCentroidMm, computeExplodedPosition } from "@/lib/state";

export const EDGE_COLOR_HEX: Readonly<Record<CausalKind, string>> = {
  thermal: "#F2A33A",
  electrical: "#4CC9F0",
  mechanical: "#B8A44C",
};

export interface ConnectivityTourOverlayProps {
  readonly parts: readonly ManifestPart[];
  readonly edges: readonly CausalEdge[];
  readonly explodeFactor: number;
  readonly selectedPartId: string | null;
  readonly highlightedEdgeKeys: readonly string[];
  readonly tourActive: boolean;
  readonly tourIndex: number;
  readonly onStepTour: (delta: number) => void;
  readonly onStopTour: () => void;
  readonly onSelectPart: (partId: string) => void;
  readonly onHoverEdge: (edge: CausalEdge | null) => void;
}

export function ConnectivityTourOverlay({
  parts,
  edges,
  explodeFactor,
  selectedPartId,
  highlightedEdgeKeys,
  tourActive,
  tourIndex,
  onStepTour,
  onStopTour,
  onSelectPart,
  onHoverEdge,
}: ConnectivityTourOverlayProps): React.JSX.Element {
  const ordered = React.useMemo(() => orderEdgesByStrength(edges), [edges]);
  const centroid = React.useMemo(() => computeAssemblyCentroidMm(parts), [parts]);
  const activeTourEdge = tourActive && ordered.length > 0 ? ordered[tourIndex % ordered.length] ?? null : null;
  const counts = React.useMemo(() => countEdgesByKind(edges), [edges]);
  const highlightSet = React.useMemo(() => {
    const s = new Set(highlightedEdgeKeys);
    if (activeTourEdge) s.add(edgeKey(activeTourEdge));
    return s;
  }, [highlightedEdgeKeys, activeTourEdge]);

  React.useEffect(() => {
    if (!tourActive) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onStopTour();
    };
    window.addEventListener("keydown", onKey);
    const timer = window.setInterval(() => onStepTour(1), 4000);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearInterval(timer);
    };
  }, [tourActive, onStepTour, onStopTour]);

  const partCoords = React.useMemo(() => {
    const map: Record<string, { readonly x: number; readonly y: number }> = {};
    const total = Math.max(1, parts.length);
    const spread = 32 + explodeFactor * 36;
    parts.forEach((p, idx) => {
      const norm = total === 1 ? 0 : idx / (total - 1) - 0.5;
      map[p.part_id] = { x: 50 + (idx % 2 === 0 ? -7 : 7), y: 50 + norm * spread };
    });
    return map;
  }, [parts, explodeFactor]);

  return (
    <>
      {parts.length > 0 && (
        <div
          data-testid="strata-connectivity-scene"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <svg viewBox="0 0 100 100" className="h-full w-full max-w-3xl overflow-visible">
            {edges.map((edge, idx) => {
              const from = partCoords[edge.from_part] ?? { x: 44, y: 35 };
              const to = partCoords[edge.to_part] ?? { x: 56, y: 65 };
              const eKey = edgeKey(edge);
              const matchesPart = !selectedPartId || edge.from_part === selectedPartId || edge.to_part === selectedPartId;
              const isHighlighted = highlightSet.size > 0 ? highlightSet.has(eKey) : matchesPart;
              const dimmed = !isHighlighted && (Boolean(selectedPartId) || highlightSet.size > 0);
              const cx = (from.x + to.x) / 2 + (idx % 2 === 0 ? 14 : -14);
              const cy = (from.y + to.y) / 2;
              const pathD = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
              const color = EDGE_COLOR_HEX[edge.kind];
              const strokeW = (0.45 + edge.strength * 1.1) * (isHighlighted ? 1.25 : 0.85);
              return (
                <g
                  key={`${eKey}-${idx}`}
                  data-testid={`causal-spline-${edge.from_part}-${edge.to_part}`}
                  data-edge-kind={edge.kind}
                  data-edge-color={color}
                  data-edge-strength={edge.strength}
                  data-edge-highlighted={isHighlighted ? "true" : "false"}
                  className="pointer-events-auto cursor-pointer"
                  style={{ opacity: dimmed ? 0.16 : 0.96 }}
                  onMouseEnter={() => onHoverEdge(edge)}
                  onMouseLeave={() => onHoverEdge(null)}
                  onClick={() => onHoverEdge(edge)}
                >
                  <path d={pathD} fill="none" stroke={color} strokeWidth={strokeW * 2.2} strokeOpacity={0.22} />
                  <path d={pathD} fill="none" stroke={color} strokeWidth={strokeW} strokeLinecap="round" />
                  <circle r={isHighlighted ? 1.1 : 0.7} fill={color}>
                    <animateMotion dur={`${(2.4 - edge.strength * 0.9).toFixed(2)}s`} repeatCount="indefinite" path={pathD} />
                  </circle>
                </g>
              );
            })}
          </svg>
          {parts.map((p) => {
            const coord = partCoords[p.part_id] ?? { x: 50, y: 50 };
            const isSelected = selectedPartId === p.part_id;
            const ghost = !isSelected && selectedPartId !== null;
            const [ox, oy, oz] = computeExplodedPosition(p, explodeFactor, centroid);
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
                style={{ left: `${coord.x}%`, top: `${coord.y}%` }}
                className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border px-2.5 py-1 font-mono text-xs tabular-nums transition-all duration-200 ${
                  isSelected
                    ? "border-amber bg-amber/20 text-amber shadow-md"
                    : ghost
                      ? "border-hairline bg-panel/60 text-dim opacity-45"
                      : "border-hairline bg-panel/90 text-text hover:border-amber/60"
                }`}
              >
                {p.part_id}
              </button>
            );
          })}
        </div>
      )}

      {edges.length > 0 && (
        <div
          data-testid="edge-kind-legend"
          className="pointer-events-auto absolute top-6 right-6 z-20 flex items-center gap-2.5 rounded-md bg-panel/90 px-3 py-1.5 font-mono text-xs tabular-nums"
        >
          <span className="flex items-center gap-1 text-amber">
            <span className="inline-block h-2 w-2 rounded-full bg-amber" />
            Thermal {counts.thermal}
          </span>
          <span className="flex items-center gap-1 text-cyan">
            <span className="inline-block h-2 w-2 rounded-full bg-cyan" />
            Electrical {counts.electrical}
          </span>
          <span className="flex items-center gap-1 text-olive">
            <span className="inline-block h-2 w-2 rounded-full bg-olive" />
            Mechanical {counts.mechanical}
          </span>
        </div>
      )}

      {activeTourEdge && (
        <div
          data-testid="connectivity-tour-card"
          className="pointer-events-auto absolute bottom-5 left-1/2 z-30 flex w-full max-w-xl -translate-x-1/2 flex-col gap-2 rounded-md border border-amber/40 bg-panel/95 p-3.5 font-sans text-xs shadow-xl"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-text">
              <span className="font-semibold text-amber">{activeTourEdge.from_part}</span>
              <span className="text-dim">→</span>
              <span className="font-semibold text-amber">{activeTourEdge.to_part}</span>
              <span className="text-dim">·</span>
              <Badge variant={activeTourEdge.kind === "thermal" ? "amber" : activeTourEdge.kind === "electrical" ? "cyan" : "olive"}>
                {activeTourEdge.kind.toUpperCase()}
              </Badge>
              <span className="text-dim">·</span>
              <span className="text-text">strength {activeTourEdge.strength.toFixed(2)}</span>
            </div>
            <span className="font-mono text-dim tabular-nums">
              {tourIndex + 1}/{ordered.length}
            </span>
          </div>
          <p className="text-text">{activeTourEdge.mechanism}</p>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <div className="flex flex-wrap items-center gap-1 font-mono text-xs text-dim">
              <span>sources:</span>
              {activeTourEdge.source_ids.length > 0 ? (
                activeTourEdge.source_ids.map((sid) => (
                  <Badge key={sid} variant="dim" data-testid={`tour-source-${sid}`}>
                    {sid}
                  </Badge>
                ))
              ) : (
                <Badge variant="dim">physics</Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" data-testid="tour-prev-btn" onClick={() => onStepTour(-1)}>
                Prev
              </Button>
              <Button size="sm" variant="default" data-testid="tour-next-btn" onClick={() => onStepTour(1)}>
                Next
              </Button>
              <Button size="sm" variant="outline" data-testid="tour-stop-btn" onClick={onStopTour}>
                Esc
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
