import { Line, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import type { CausalEdge, CausalKind, Manifest, ManifestPart } from "@/lib/contracts";
import { computeExplodedPosition, computePartSizeMm } from "@/lib/state";

const EDGE_COLOR_HEX: Readonly<Record<CausalKind, string>> = {
  thermal: "#F2A33A",
  electrical: "#4CC9F0",
  mechanical: "#B8A44C",
};

const MM_TO_SCENE = 0.025;

interface SceneNodesProps {
  readonly parts: readonly ManifestPart[];
  readonly edges: readonly CausalEdge[];
  readonly explodeFactor: number;
  readonly selectedPartId: string | null;
  readonly onSelectPart: (partId: string) => void;
}

function SceneNodes({
  parts,
  edges,
  explodeFactor,
  selectedPartId,
  onSelectPart,
}: SceneNodesProps): React.JSX.Element {
  const posByPart = React.useMemo(() => {
    const map: Record<string, readonly [number, number, number]> = {};
    for (const p of parts) {
      const [x, y, z] = computeExplodedPosition(p, explodeFactor);
      map[p.part_id] = [x * MM_TO_SCENE, z * MM_TO_SCENE, y * MM_TO_SCENE];
    }
    return map;
  }, [parts, explodeFactor]);

  return (
    <group>
      <ambientLight intensity={0.65} />
      <directionalLight position={[4, 6, 4]} intensity={1.1} />
      {parts.map((part) => {
        const pos = posByPart[part.part_id] ?? [0, 0, 0];
        const [sx, sy, sz] = computePartSizeMm(part);
        const isSelected = selectedPartId === part.part_id;
        const ghost = !isSelected && selectedPartId !== null;
        return (
          <mesh
            key={part.glb_node}
            position={[pos[0], pos[1], pos[2]]}
            onClick={(e) => {
              e.stopPropagation();
              onSelectPart(part.part_id);
            }}
          >
            <boxGeometry args={[sx * MM_TO_SCENE, sz * MM_TO_SCENE, sy * MM_TO_SCENE]} />
            <meshStandardMaterial
              color={isSelected ? "#F2A33A" : "#7B8594"}
              wireframe={ghost}
              transparent={ghost}
              opacity={ghost ? 0.15 : 0.92}
            />
          </mesh>
        );
      })}
      {edges.map((edge, idx) => {
        const from = posByPart[edge.from_part];
        const to = posByPart[edge.to_part];
        if (!from || !to) return null;
        const mid: [number, number, number] = [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + 0.45, (from[2] + to[2]) / 2];
        return (
          <Line
            key={`${edge.from_part}-${edge.to_part}-${idx}`}
            points={[[from[0], from[1], from[2]], mid, [to[0], to[1], to[2]]]}
            color={EDGE_COLOR_HEX[edge.kind]}
            lineWidth={2}
          />
        );
      })}
      <OrbitControls makeDefault enablePan enableZoom />
    </group>
  );
}

export interface Viewport3DProps {
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
  manifest,
  edges,
  selectedPartId,
  onSelectPart,
  activeRevision,
}: Viewport3DProps): React.JSX.Element {
  const [explode, setExplode] = React.useState<number>(0);
  const [hoveredEdge, setHoveredEdge] = React.useState<CausalEdge | null>(null);
  const webglAvailable = React.useMemo(() => canCreateWebGLContext(), []);
  const parts = manifest?.parts ?? [];

  return (
    <section
      data-testid="viewport-3d"
      aria-label="3D Engineering Viewport"
      className="relative h-full w-full overflow-hidden bg-bg"
    >
      {webglAvailable && parts.length > 0 ? (
        <Canvas camera={{ position: [2.8, 2.2, 2.8], fov: 45 }}>
          <SceneNodes parts={parts} edges={edges} explodeFactor={explode} selectedPartId={selectedPartId} onSelectPart={onSelectPart} />
        </Canvas>
      ) : (
        <div className="flex h-full w-full items-center justify-center font-mono text-xs text-dim">
          {parts.length > 0 ? `CAD MANIFEST LOADED · V${activeRevision} (${parts.length} PARTS)` : "AWAITING RECONSTRUCTION MANIFEST"}
        </div>
      )}
      {parts.length > 0 && (
        <div className="pointer-events-auto absolute top-16 left-4 flex flex-col gap-2 rounded-sm border border-hairline bg-panel/90 p-3">
          <div className="flex items-center justify-between gap-4 font-mono text-xs text-dim">
            <span>EXPLODED VIEW · V{activeRevision}</span>
            <span className="text-amber">{Math.round(explode * 100)}%</span>
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
            {parts.map((p) => (
              <button
                key={p.glb_node}
                type="button"
                data-testid={`viewport-node-${p.part_id}`}
                onClick={() => onSelectPart(p.part_id)}
                className={
                  selectedPartId === p.part_id
                    ? "rounded-sm border border-amber bg-amber/20 px-2 py-0.5 font-mono text-xs text-amber"
                    : "rounded-sm border border-hairline bg-bg px-2 py-0.5 font-mono text-xs text-dim hover:text-text"
                }
              >
                {p.part_id}
              </button>
            ))}
          </div>
          {edges.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {edges.map((edge, idx) => (
                <button
                  key={`${edge.from_part}-${edge.to_part}-${idx}`}
                  type="button"
                  data-testid={`causal-spline-${edge.from_part}-${edge.to_part}`}
                  onMouseEnter={() => setHoveredEdge(edge)}
                  onMouseLeave={() => setHoveredEdge(null)}
                  onFocus={() => setHoveredEdge(edge)}
                  className="rounded-sm border border-hairline bg-bg px-1.5 py-0.5 font-mono text-xs text-dim hover:border-amber"
                >
                  {edge.from_part}→{edge.to_part}
                </button>
              ))}
            </div>
          )}
          {hoveredEdge && (
            <div data-testid="spline-tooltip" className="rounded-sm border border-amber/50 bg-bg p-2 font-mono text-xs text-text">
              <div className="flex items-center gap-2">
                <Badge variant={hoveredEdge.kind === "thermal" ? "amber" : hoveredEdge.kind === "electrical" ? "cyan" : "olive"}>{hoveredEdge.kind}</Badge>
                <span>{hoveredEdge.mechanism}</span>
              </div>
              <div className="mt-1 text-dim">Sources: {hoveredEdge.source_ids.join(", ") || "physics"}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
