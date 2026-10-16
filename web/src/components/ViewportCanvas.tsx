import { OrbitControls, QuadraticBezierLine } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import * as React from "react";
import type { BufferGeometry, Mesh, Object3D } from "three";
import { GLTFLoader } from "three-stdlib";
import type { CausalEdge, CausalKind, ManifestPart } from "@/lib/contracts";
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

const MM_TO_SCENE = 0.025;

export interface ViewportCanvasProps {
  readonly parts: readonly ManifestPart[];
  readonly edges: readonly CausalEdge[];
  readonly explodeFactor: number;
  readonly selectedPartId: string | null;
  readonly onSelectPart: (partId: string) => void;
  readonly onHoverEdge: (edge: CausalEdge | null) => void;
  readonly glbBuffer: ArrayBuffer | null;
}

function isThreeMesh(obj: Object3D): obj is Mesh {
  return "isMesh" in obj && obj.isMesh === true;
}

export function ViewportCanvas({
  parts,
  edges,
  explodeFactor,
  selectedPartId,
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
          if (isThreeMesh(obj) && obj.name) {
            next[obj.name] = obj.geometry;
          }
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
      map[p.part_id] = [x * MM_TO_SCENE, z * MM_TO_SCENE, y * MM_TO_SCENE];
    }
    return map;
  }, [parts, explodeFactor]);

  return (
    <Canvas camera={{ position: [2.8, 2.2, 2.8], fov: 45 }}>
      <ambientLight intensity={0.65} />
      <directionalLight position={[4, 6, 4]} intensity={1.1} />
      {parts.map((part) => {
        const pos = posByPart[part.part_id] ?? [0, 0, 0];
        const [sx, sy, sz] = computePartSizeMm(part);
        const isSelected = selectedPartId === part.part_id;
        const ghost = !isSelected && selectedPartId !== null;
        const glbGeo = glbGeometries[part.glb_node] ?? glbGeometries[part.part_id];
        return (
          <mesh
            key={part.glb_node}
            geometry={glbGeo}
            position={[pos[0], pos[1], pos[2]]}
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
              opacity={ghost ? 0.15 : 0.95}
            />
          </mesh>
        );
      })}
      {edges.map((edge, idx) => {
        const from = posByPart[edge.from_part];
        const to = posByPart[edge.to_part];
        if (!from || !to) return null;
        const mid: [number, number, number] = [
          (from[0] + to[0]) / 2,
          Math.max(from[1], to[1]) + 0.45,
          (from[2] + to[2]) / 2,
        ];
        return (
          <QuadraticBezierLine
            key={`${edge.from_part}-${edge.to_part}-${idx}`}
            start={[from[0], from[1], from[2]]}
            mid={mid}
            end={[to[0], to[1], to[2]]}
            color={EDGE_COLOR_HEX[edge.kind]}
            lineWidth={2.5}
            onPointerOver={(e) => {
              e.stopPropagation();
              onHoverEdge(edge);
            }}
            onPointerOut={() => onHoverEdge(null)}
          />
        );
      })}
      <OrbitControls makeDefault enablePan enableZoom />
    </Canvas>
  );
}
