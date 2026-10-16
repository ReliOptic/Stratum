import { OrbitControls, QuadraticBezierLine } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import * as React from "react";
import type { BufferGeometry, Mesh, Object3D } from "three";
import { GLTFLoader } from "three-stdlib";
import type { CausalEdge, CausalKind, ManifestPart } from "@/lib/contracts";
import { edgeKey } from "@/lib/connectivity";
import {
  computeAssemblyCentroidMm,
  computeExplodedPosition,
  computePartSizeMm,
} from "@/lib/state";

export const EDGE_COLOR_HEX: Readonly<Record<CausalKind, string>> = {
  thermal: "#F2A33A",
  electrical: "#4CC9F0",
  mechanical: "#B8A44C",
};

const MM_TO_SCENE = 0.028;

export interface ViewportCanvasProps {
  readonly parts: readonly ManifestPart[];
  readonly edges: readonly CausalEdge[];
  readonly explodeFactor: number;
  readonly selectedPartId: string | null;
  readonly highlightedEdgeKeys?: readonly string[];
  readonly onSelectPart: (partId: string) => void;
  readonly onHoverEdge: (edge: CausalEdge | null) => void;
  readonly glbBuffer: ArrayBuffer | null;
}

function isThreeMesh(obj: Object3D): obj is Mesh {
  return "isMesh" in obj && obj.isMesh === true;
}

interface EdgePulseBeadProps {
  readonly start: readonly [number, number, number];
  readonly mid: readonly [number, number, number];
  readonly end: readonly [number, number, number];
  readonly color: string;
  readonly speed: number;
  readonly dimmed: boolean;
}

function EdgePulseBead({ start, mid, end, color, speed, dimmed }: EdgePulseBeadProps): React.JSX.Element {
  const meshRef = React.useRef<Mesh | null>(null);
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = (clock.getElapsedTime() * speed) % 1;
    const inv = 1 - t;
    meshRef.current.position.set(
      inv * inv * start[0] + 2 * inv * t * mid[0] + t * t * end[0],
      inv * inv * start[1] + 2 * inv * t * mid[1] + t * t * end[1],
      inv * inv * start[2] + 2 * inv * t * mid[2] + t * t * end[2],
    );
  });
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[dimmed ? 0.018 : 0.035, 10, 10]} />
      <meshBasicMaterial color={color} transparent opacity={dimmed ? 0.2 : 0.95} />
    </mesh>
  );
}

export function ViewportCanvas({
  parts,
  edges,
  explodeFactor,
  selectedPartId,
  highlightedEdgeKeys = [],
  onSelectPart,
  onHoverEdge,
  glbBuffer,
}: ViewportCanvasProps): React.JSX.Element {
  const [glbGeometries, setGlbGeometries] = React.useState<Readonly<Record<string, BufferGeometry>>>({});

  React.useEffect(() => {
    if (!glbBuffer) {
      setGlbGeometries({});
      return;
    }
    const loader = new GLTFLoader();
    loader.parse(
      glbBuffer.slice(0),
      "",
      (gltf) => {
        const next: Record<string, BufferGeometry> = {};
        gltf.scene.traverse((obj) => {
          if (isThreeMesh(obj) && obj.name) next[obj.name] = obj.geometry;
        });
        setGlbGeometries(next);
      },
      () => setGlbGeometries({}),
    );
  }, [glbBuffer]);

  const posByPart = React.useMemo(() => {
    const centroid = computeAssemblyCentroidMm(parts);
    const map: Record<string, readonly [number, number, number]> = {};
    for (const p of parts) {
      const [x, y, z] = computeExplodedPosition(p, explodeFactor, centroid);
      map[p.part_id] = [(x - centroid[0]) * MM_TO_SCENE, (z - centroid[2]) * MM_TO_SCENE, (y - centroid[1]) * MM_TO_SCENE];
    }
    return map;
  }, [parts, explodeFactor]);

  const highlightSet = React.useMemo(() => new Set(highlightedEdgeKeys), [highlightedEdgeKeys]);

  return (
    <Canvas camera={{ position: [2.3, 1.85, 2.3], fov: 38 }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 3]} intensity={1.15} />
      {parts.map((part) => {
        const pos = posByPart[part.part_id] ?? [0, 0, 0];
        const [sx, sy, sz] = computePartSizeMm(part);
        const isSelected = selectedPartId === part.part_id;
        const isShell = part.part_id.includes("shell") || part.part_id.includes("enclosure");
        const ghost = (!isSelected && selectedPartId !== null) || isShell;
        const glbGeo = glbGeometries[part.glb_node] ?? glbGeometries[part.part_id];
        return (
          <group key={part.glb_node} position={[pos[0], pos[1], pos[2]]}>
            <mesh
              geometry={glbGeo}
              scale={glbGeo ? [MM_TO_SCENE, MM_TO_SCENE, MM_TO_SCENE] : [1, 1, 1]}
              onClick={(e) => {
                e.stopPropagation();
                onSelectPart(part.part_id);
              }}
            >
              {!glbGeo && <boxGeometry args={[sx * MM_TO_SCENE, sz * MM_TO_SCENE, sy * MM_TO_SCENE]} />}
              <meshStandardMaterial
                color={isSelected ? "#F2A33A" : "#7B8594"}
                wireframe={ghost}
                transparent={ghost}
                opacity={ghost ? 0.18 : 0.92}
              />
            </mesh>
          </group>
        );
      })}
      {edges.map((edge, idx) => {
        const from = posByPart[edge.from_part];
        const to = posByPart[edge.to_part];
        if (!from || !to) return null;
        const eKey = edgeKey(edge);
        const matchesPart = !selectedPartId || edge.from_part === selectedPartId || edge.to_part === selectedPartId;
        const matchesTourOrTarget = highlightSet.size === 0 || highlightSet.has(eKey);
        const isHighlighted = highlightSet.size > 0 ? highlightSet.has(eKey) : matchesPart;
        const dimmed = !isHighlighted && (Boolean(selectedPartId) || highlightSet.size > 0 || !matchesTourOrTarget);
        const mid: [number, number, number] = [(from[0] + to[0]) / 2 + 0.16, (from[1] + to[1]) / 2 + 0.18, (from[2] + to[2]) / 2];
        return (
          <group key={`${eKey}-${idx}`}>
            <QuadraticBezierLine
              start={[from[0], from[1], from[2]]}
              mid={mid}
              end={[to[0], to[1], to[2]]}
              color={EDGE_COLOR_HEX[edge.kind]}
              lineWidth={dimmed ? 1.2 : 1.5 + edge.strength * 3.5}
              transparent
              opacity={dimmed ? 0.15 : 0.95}
              onPointerOver={(e) => {
                e.stopPropagation();
                onHoverEdge(edge);
              }}
              onPointerOut={() => onHoverEdge(null)}
            />
            <EdgePulseBead
              start={from}
              mid={mid}
              end={to}
              color={EDGE_COLOR_HEX[edge.kind]}
              speed={0.35 + edge.strength * 0.25}
              dimmed={dimmed}
            />
          </group>
        );
      })}
      <OrbitControls makeDefault enablePan enableZoom />
    </Canvas>
  );
}
