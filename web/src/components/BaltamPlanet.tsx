import * as React from "react";

const ASCII_RAMP = " .:-=+*#%@";
const DISPERSION_GLYPHS = "·:+#*";
const GRID_COLS = 44;
const GRID_ROWS = 18;
const TARGET_FPS = 60;
const FRAME_MS = 1000 / TARGET_FPS;

export interface AsciiBandLine {
  readonly rowIndex: number;
  readonly text: string;
  readonly bandKind: "ochre" | "strata" | "ocean";
}

function sampleStrataNoise(x: number, y: number, z: number): number {
  const lat = Math.asin(Math.max(-1, Math.min(1, y)));
  const lon = Math.atan2(z, x);
  const strata = Math.sin(lat * 16 + Math.cos(lon * 3) * 1.45);
  const fault = Math.cos(lat * 9 - lon * 2) * 0.25;
  const basin = Math.sin(lon * 2.5 - lat * 2.0) * Math.cos(lat * 3.0);
  return strata * 0.55 + basin * 0.3 + fault;
}

function samplePlanetCell(
  r: number,
  c: number,
  cosA: number,
  sinA: number,
  cursorNx: number,
  cursorNy: number,
): { readonly char: string; readonly kind: "ocean" | "strata" | "ochre" | "void" } {
  const rawNx = ((c - GRID_COLS / 2) / (GRID_COLS / 2)) * 1.95;
  const rawNy = ((r - GRID_ROWS / 2) / (GRID_ROWS / 2)) * 1.12;
  const dx = rawNx - cursorNx;
  const dy = rawNy - cursorNy;
  const distSq = dx * dx + dy * dy;

  if (distSq < 0.045 && rawNx * rawNx + rawNy * rawNy < 1.28) {
    const glyph = DISPERSION_GLYPHS[(r * 3 + c * 5) % DISPERSION_GLYPHS.length] ?? "*";
    return { char: glyph, kind: "strata" };
  }

  const push = distSq < 0.22 ? (0.22 - distSq) * 0.55 : 0;
  const invLen = distSq > 1e-5 ? 1 / Math.sqrt(distSq) : 0;
  const nx = rawNx - dx * invLen * push;
  const ny = rawNy - dy * invLen * push;
  const rSq = nx * nx + ny * ny;
  if (rSq > 1.0) {
    return { char: distSq < 0.11 ? "·" : " ", kind: "void" };
  }

  const nz = Math.sqrt(Math.max(0, 1.0 - rSq));
  const rx = nx * cosA + nz * sinA;
  const rz = -nx * sinA + nz * cosA;
  const terrain = sampleStrataNoise(rx, ny, rz);
  const light = Math.max(0.08, nx * -0.45 + ny * -0.3 + nz * 0.84);
  const shade = Math.min(
    ASCII_RAMP.length - 1,
    Math.max(1, Math.floor((light * 0.75 + (terrain + 1) * 0.18) * ASCII_RAMP.length)),
  );
  const kind = terrain < -0.22 ? "ocean" : Math.abs(terrain) < 0.2 ? "strata" : "ochre";
  return { char: ASCII_RAMP[shade] ?? ".", kind };
}

export function renderAsciiPlanetFrame(
  angleRad: number,
  cursorNx: number = -10,
  cursorNy: number = -10,
): readonly AsciiBandLine[] {
  const lines: AsciiBandLine[] = [];
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  for (let r = 0; r < GRID_ROWS; r += 1) {
    let rowChars = "";
    let oceanHits = 0;
    let strataHits = 0;
    for (let c = 0; c < GRID_COLS; c += 1) {
      const cell = samplePlanetCell(r, c, cosA, sinA, cursorNx, cursorNy);
      rowChars += cell.char;
      if (cell.kind === "ocean") oceanHits += 1;
      else if (cell.kind === "strata") strataHits += 1;
    }
    const bandKind: AsciiBandLine["bandKind"] =
      oceanHits > 6 ? "ocean" : strataHits > 5 ? "strata" : "ochre";
    lines.push({ rowIndex: r, text: rowChars, bandKind });
  }
  return lines;
}

export interface BaltamPlanetProps {
  readonly paused?: boolean;
}

const BAND_CLASS_MAP: Readonly<Record<AsciiBandLine["bandKind"], string>> = {
  ochre: "text-amber/90",
  strata: "text-olive",
  ocean: "text-dim",
};

export function BaltamPlanet({ paused = false }: BaltamPlanetProps): React.JSX.Element {
  const [angle, setAngle] = React.useState<number>(0.4);
  const [docHidden, setDocHidden] = React.useState<boolean>(
    () => typeof document !== "undefined" && document.hidden,
  );
  const [cursor, setCursor] = React.useState<{ readonly x: number; readonly y: number }>({
    x: -10,
    y: -10,
  });
  const isPaused = paused || docHidden;

  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVis = (): void => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  React.useEffect(() => {
    if (isPaused) return undefined;
    let frameId = 0;
    let lastStep = performance.now();
    const step = (now: number): void => {
      const elapsed = now - lastStep;
      if (elapsed >= FRAME_MS) {
        const dt = Math.min(0.1, elapsed / 1000);
        lastStep = now - (elapsed % FRAME_MS);
        setAngle((prev) => (prev + dt * 0.65) % (Math.PI * 2));
      }
      frameId = window.requestAnimationFrame(step);
    };
    frameId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frameId);
  }, [isPaused]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setCursor({
      x: (((e.clientX - rect.left) / rect.width) * 2 - 1) * 1.95,
      y: (((e.clientY - rect.top) / rect.height) * 2 - 1) * 1.12,
    });
  };

  const lines = React.useMemo(
    () => renderAsciiPlanetFrame(angle, cursor.x, cursor.y),
    [angle, cursor.x, cursor.y],
  );
  const cursorActive = cursor.x > -5 && cursor.y > -5;

  return (
    <div
      data-testid="baltam-planet"
      data-fps-target={TARGET_FPS}
      data-paused={isPaused ? "true" : "false"}
      data-dispersed={cursorActive ? "true" : "false"}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setCursor({ x: -10, y: -10 })}
      className="select-none rounded-sm border border-hairline bg-panel/60 px-4 py-2 font-mono text-xs leading-tight tracking-widest"
      aria-label="Baltam planetary strata instrument"
    >
      {lines.map((line) => (
        <pre key={line.rowIndex} data-band={line.bandKind} className={BAND_CLASS_MAP[line.bandKind]}>
          {line.text}
        </pre>
      ))}
    </div>
  );
}

