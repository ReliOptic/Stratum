import * as React from "react";

const ASCII_RAMP = " .:-=+*#%@";
const DISPERSION_GLYPHS = "·:+#*";
const CIPHER_GLYPHS = "01#$%*+;:~^=";
const GRID_COLS = 54;
const GRID_ROWS = 22;
const TARGET_FPS = 60;
const FRAME_MS = 1000 / TARGET_FPS;

const WHISPER_CORNERS = [
  { id: "tl", pos: "top-1 left-2", text: "STRATA 03" },
  { id: "tr", pos: "top-1 right-2", text: "EVIDENCE 0" },
  { id: "bl", pos: "bottom-1 left-2", text: "LOOP V0" },
  { id: "br", pos: "bottom-1 right-2", text: "AUDIT —" },
] as const;

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
  decodeProgress: number,
  sunriseProgress: number,
  scannerPhase: number | null,
): { readonly char: string; readonly kind: "ocean" | "strata" | "ochre" | "void" } {
  const rawNx = ((c - GRID_COLS / 2) / (GRID_COLS / 2)) * 1.95;
  const rawNy = ((r - GRID_ROWS / 2) / (GRID_ROWS / 2)) * 1.12;
  const dx = rawNx - cursorNx;
  const dy = rawNy - cursorNy;
  const distSq = dx * dx + dy * dy;
  if (distSq < 0.045 && rawNx * rawNx + rawNy * rawNy < 1.28) {
    return { char: DISPERSION_GLYPHS[(r * 3 + c * 5) % DISPERSION_GLYPHS.length] ?? "*", kind: "strata" };
  }
  const push = distSq < 0.22 ? (0.22 - distSq) * 0.55 : 0;
  const invLen = distSq > 1e-5 ? 1 / Math.sqrt(distSq) : 0;
  const nx = rawNx - dx * invLen * push;
  const ny = rawNy - dy * invLen * push;
  const rSq = nx * nx + ny * ny;
  if (rSq > 1.0) return { char: distSq < 0.11 ? "·" : " ", kind: "void" };
  if (decodeProgress < 1) {
    const cellJitter = ((r * 17 + c * 31) % 37) / 37;
    if (decodeProgress < 0.12 + 0.78 * ((c / GRID_COLS) * 0.65 + cellJitter * 0.35)) {
      const idx = Math.floor(decodeProgress * 40 + r * 7 + c * 13) % CIPHER_GLYPHS.length;
      return { char: CIPHER_GLYPHS[idx] ?? "#", kind: "ochre" };
    }
  }
  const nz = Math.sqrt(Math.max(0, 1.0 - rSq));
  const terrain = sampleStrataNoise(nx * cosA + nz * sinA, ny, -nx * sinA + nz * cosA);
  const sweepX = -1.0 + sunriseProgress * 2.2;
  const rimBoost = sunriseProgress > 0 && sunriseProgress < 1 && Math.abs(nx - sweepX) < 0.16 ? 0.38 : 0;
  const beamDist = scannerPhase !== null ? Math.abs(r - scannerPhase * (GRID_ROWS - 1)) : 99;
  const beamBoost = beamDist <= 1.8 ? 0.5 * (1 - beamDist / 1.8) : 0;
  const light = Math.max(0.08, nx * -0.45 + ny * -0.3 + nz * 0.84 + rimBoost + beamBoost);
  const shade = Math.min(ASCII_RAMP.length - 1, Math.max(1, Math.floor((light * 0.75 + (terrain + 1) * 0.18) * ASCII_RAMP.length)));
  const kind = rimBoost > 0 || beamBoost > 0.1 ? "ochre" : terrain < -0.22 ? "ocean" : Math.abs(terrain) < 0.2 ? "strata" : "ochre";
  return { char: ASCII_RAMP[shade] ?? ".", kind };
}

export function renderAsciiPlanetFrame(
  angleRad: number,
  cursorNx: number = -10,
  cursorNy: number = -10,
  decodeProgress: number = 1,
  sunriseProgress: number = 1,
  scannerPhase: number | null = null,
): readonly AsciiBandLine[] {
  const lines: AsciiBandLine[] = [];
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  for (let r = 0; r < GRID_ROWS; r += 1) {
    let rowChars = "";
    let oceanHits = 0;
    let strataHits = 0;
    for (let c = 0; c < GRID_COLS; c += 1) {
      const cell = samplePlanetCell(r, c, cosA, sinA, cursorNx, cursorNy, decodeProgress, sunriseProgress, scannerPhase);
      rowChars += cell.char;
      if (cell.kind === "ocean") oceanHits += 1;
      else if (cell.kind === "strata") strataHits += 1;
    }
    const bandKind: AsciiBandLine["bandKind"] = oceanHits > 7 ? "ocean" : strataHits > 6 ? "strata" : "ochre";
    lines.push({ rowIndex: r, text: rowChars, bandKind });
  }
  return lines;
}

export interface BaltamPlanetProps {
  readonly paused?: boolean;
  readonly decodeProgress?: number;
  readonly sunriseProgress?: number;
  readonly scanlineProgress?: number | null;
  readonly whisperElapsedMs?: number;
  readonly globeOpacity?: number;
  readonly scannerActive?: boolean;
}

const BAND_CLASS_MAP: Readonly<Record<AsciiBandLine["bandKind"], string>> = {
  ochre: "text-amber/90",
  strata: "text-olive/90",
  ocean: "text-dim/80",
};

export function BaltamPlanet({
  paused = false,
  decodeProgress = 1,
  sunriseProgress = 1,
  scanlineProgress = null,
  whisperElapsedMs = 1000,
  globeOpacity = 1,
  scannerActive = false,
}: BaltamPlanetProps): React.JSX.Element {
  const [angle, setAngle] = React.useState<number>(0.4);
  const [docHidden, setDocHidden] = React.useState<boolean>(() => typeof document !== "undefined" && document.hidden);
  const [cursor, setCursor] = React.useState<{ readonly x: number; readonly y: number }>({ x: -10, y: -10 });
  const isPaused = paused || docHidden;
  const beamPhase = scannerActive ? ((angle * 0.42) % 1 + 1) % 1 : null;
  const activeScanline = scanlineProgress ?? beamPhase;

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
        lastStep = now - (elapsed % FRAME_MS);
        setAngle((prev) => (prev + Math.min(0.1, elapsed / 1000) * 0.55) % (Math.PI * 2));
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
    () => renderAsciiPlanetFrame(angle, cursor.x, cursor.y, decodeProgress, sunriseProgress, beamPhase),
    [angle, cursor.x, cursor.y, decodeProgress, sunriseProgress, beamPhase],
  );
  const charsVisible = Math.max(0, Math.floor(whisperElapsedMs / 18));

  return (
    <div
      data-testid="baltam-planet"
      data-fps-target={TARGET_FPS}
      data-paused={isPaused ? "true" : "false"}
      data-dispersed={cursor.x > -5 && cursor.y > -5 ? "true" : "false"}
      data-planet-glow="true"
      data-globe-opacity={globeOpacity.toFixed(2)}
      data-scanner-active={scannerActive ? "true" : "false"}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setCursor({ x: -10, y: -10 })}
      className="pointer-events-auto relative flex select-none flex-col items-center justify-center px-10 py-2 font-mono text-xs leading-tight tracking-widest"
      aria-label="Baltam planetary strata instrument"
    >
      {WHISPER_CORNERS.map((w) => (
        <span key={w.id} data-whisper-label="true" data-testid={`planet-whisper-${w.id}`} className={`pointer-events-none absolute ${w.pos}`}>
          {w.text.slice(0, charsVisible)}
        </span>
      ))}
      {activeScanline !== null && activeScanline >= 0 && activeScanline <= 1 && (
        <div data-testid="planet-scanline" data-scanline="true" className="pointer-events-none absolute inset-x-4 h-px" style={{ top: `${(activeScanline * 100).toFixed(1)}%` }} />
      )}
      <div data-testid="baltam-planet-glyphs" className="flex flex-col items-center" style={{ opacity: globeOpacity }}>
        {lines.map((line) => {
          const nearBeam = beamPhase !== null && Math.abs(line.rowIndex - beamPhase * (GRID_ROWS - 1)) <= 1.5;
          return (
            <pre key={line.rowIndex} data-band={line.bandKind} data-beam-bright={nearBeam ? "true" : undefined} className={nearBeam ? "text-amber brightness-125" : BAND_CLASS_MAP[line.bandKind]}>{line.text}</pre>
          );
        })}
      </div>
    </div>
  );
}
