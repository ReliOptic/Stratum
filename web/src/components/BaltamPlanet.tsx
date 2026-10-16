import * as React from "react";

const ASCII_RAMP = " .:-=+*#%@";
const GRID_COLS = 44;
const GRID_ROWS = 18;

export interface AsciiBandLine {
  readonly rowIndex: number;
  readonly text: string;
  readonly bandKind: "ochre" | "strata" | "ocean";
}

function sampleStrataNoise(x: number, y: number, z: number): number {
  const lat = Math.asin(Math.max(-1, Math.min(1, y)));
  const lon = Math.atan2(z, x);
  const strata = Math.sin(lat * 14 + Math.cos(lon * 3) * 1.4);
  const basin = Math.sin(lon * 2.5 - lat * 2.0) * Math.cos(lat * 3.0);
  return strata * 0.6 + basin * 0.4;
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
    const ny = ((r - GRID_ROWS / 2) / (GRID_ROWS / 2)) * 1.12;
    let rowChars = "";
    let oceanHits = 0;
    let strataHits = 0;

    for (let c = 0; c < GRID_COLS; c += 1) {
      const nx = ((c - GRID_COLS / 2) / (GRID_COLS / 2)) * 1.95;
      const dx = nx - cursorNx;
      const dy = ny - cursorNy;
      const cursorDistSq = dx * dx + dy * dy;
      const rSq = nx * nx + ny * ny;

      if (cursorDistSq < 0.06 && rSq < 1.2) {
        rowChars += (r + c) % 2 === 0 ? "*" : ":";
        continue;
      }
      if (rSq > 1.0) {
        rowChars += " ";
        continue;
      }

      const nz = Math.sqrt(Math.max(0, 1.0 - rSq));
      const rx = nx * cosA + nz * sinA;
      const rz = -nx * sinA + nz * cosA;
      const terrain = sampleStrataNoise(rx, ny, rz);
      const light = Math.max(0.08, nx * -0.45 + ny * -0.3 + nz * 0.84);

      if (terrain < -0.25) {
        oceanHits += 1;
      } else if (Math.abs(terrain) < 0.18) {
        strataHits += 1;
      }

      const shade = Math.min(
        ASCII_RAMP.length - 1,
        Math.max(1, Math.floor((light * 0.75 + (terrain + 1) * 0.18) * ASCII_RAMP.length)),
      );
      rowChars += ASCII_RAMP[shade] ?? ".";
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
  const [cursor, setCursor] = React.useState<{ readonly x: number; readonly y: number }>({
    x: -10,
    y: -10,
  });

  React.useEffect(() => {
    if (paused) {
      return undefined;
    }
    let frameId = 0;
    let lastTime = performance.now();

    const step = (now: number): void => {
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      if (typeof document === "undefined" || !document.hidden) {
        setAngle((prev) => (prev + dt * 0.55) % (Math.PI * 2));
      }
      frameId = window.requestAnimationFrame(step);
    };

    frameId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frameId);
  }, [paused]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const nx = (((e.clientX - rect.left) / rect.width) * 2 - 1) * 1.95;
    const ny = (((e.clientY - rect.top) / rect.height) * 2 - 1) * 1.12;
    setCursor({ x: nx, y: ny });
  };

  const lines = React.useMemo(
    () => renderAsciiPlanetFrame(angle, cursor.x, cursor.y),
    [angle, cursor.x, cursor.y],
  );

  return (
    <div
      data-testid="baltam-planet"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setCursor({ x: -10, y: -10 })}
      className="select-none rounded-sm border border-hairline bg-panel/60 px-4 py-2 font-mono text-xs leading-tight tracking-widest"
      aria-label="Baltam planetary strata instrument"
    >
      {lines.map((line) => (
        <pre
          key={line.rowIndex}
          className={BAND_CLASS_MAP[line.bandKind]}
        >
          {line.text}
        </pre>
      ))}
    </div>
  );
}
