import * as React from "react";
import { BaltamPlanet } from "@/components/BaltamPlanet";
import { PromptBar, type ReconstructRequestPayload } from "@/components/PromptBar";

const TOTAL_SEQ_MS = 6400;
const SESSION_KEY = "stratum_title_seen";

interface StarDot {
  readonly id: number;
  readonly leftPct: string;
  readonly topPct: string;
  readonly opacity: number;
}

const STARFIELD: readonly StarDot[] = Array.from({ length: 96 }, (_, i) => ({
  id: i,
  leftPct: `${((i * 37 + 13) % 98) + 1}%`,
  topPct: `${((i * 53 + 29) % 96) + 2}%`,
  opacity: Number((0.2 + ((i * 19) % 41) / 100).toFixed(2)),
}));

const LINE_1_WORDS = [
  { text: "Can ", idx: 0, sheen: false },
  { text: "Gemini ", idx: 1, sheen: true },
  { text: "4 ", idx: 2, sheen: true },
  { text: "Argon ", idx: 3, sheen: true },
] as const;

const LINE_2_WORDS = [
  { text: "make ", idx: 4 },
  { text: "the ", idx: 5 },
  { text: "physical ", idx: 6 },
  { text: "world ", idx: 7 },
] as const;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - (1 - c) ** 3;
}

function getInitialElapsedMs(): { readonly ms: number; readonly reduced: boolean } {
  if (typeof window === "undefined") return { ms: TOTAL_SEQ_MS, reduced: false };
  const reduced = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  if (reduced) return { ms: TOTAL_SEQ_MS, reduced: true };
  try {
    if (window.sessionStorage.getItem(SESSION_KEY) === "1") return { ms: TOTAL_SEQ_MS, reduced: false };
  } catch {
    return { ms: 0, reduced: false };
  }
  return { ms: 0, reduced: false };
}

function computeWordStyle(elapsedMs: number, wordIdx: number): React.CSSProperties {
  const p = easeOutCubic((elapsedMs - (1600 + wordIdx * 45)) / 480);
  return {
    display: "inline-block",
    whiteSpace: "pre",
    opacity: p,
    transform: `translateY(${((1 - p) * 0.35).toFixed(3)}em)`,
    filter: p < 1 ? `blur(${((1 - p) * 8).toFixed(1)}px)` : "none",
    letterSpacing: `${(-0.01 - 0.02 * p).toFixed(4)}em`,
  };
}

function HeroHeadline({ elapsedMs, dockP }: { readonly elapsedMs: number; readonly dockP: number }): React.JSX.Element {
  const saferP = easeOutCubic((elapsedMs - 3900) / 420);
  const saferBloom = elapsedMs >= 3900 && elapsedMs <= 4500;
  const sheenP = clamp01((elapsedMs - 2100) / 700);
  const kickerOpacity = clamp01((elapsedMs - 1600) / 450) * (1 - 0.3 * dockP);
  const sublineOpacity = clamp01((elapsedMs - 3000) / 500) * (1 - 0.3 * dockP);
  return (
    <div
      className="relative z-10 mt-10 flex flex-col items-center text-center"
      style={{
        transform: `translateY(${(-6 * dockP).toFixed(2)}vh) scale(${(1 - 0.38 * dockP).toFixed(3)})`,
        transformOrigin: "top center",
      }}
    >
      <p data-testid="hero-kicker" data-saira-kicker="true" className="mb-3" style={{ opacity: kickerOpacity }}>
        TRACK 02 — HARD TECH · STRATUM
      </p>
      <h1 data-testid="thesis-line" data-hero-h1="true" className="select-text text-center">
        <span className="block">
          {LINE_1_WORDS.map((w) => (
            <span
              key={w.idx}
              data-argon-sheen={w.sheen && sheenP > 0 && sheenP < 1 ? "active" : "idle"}
              style={{ ...computeWordStyle(elapsedMs, w.idx), backgroundPosition: `${(100 - sheenP * 100).toFixed(0)}% 0` }}
            >
              {w.text}
            </span>
          ))}
        </span>
        <span className="block">
          {LINE_2_WORDS.map((w) => (
            <span key={w.idx} style={computeWordStyle(elapsedMs, w.idx)}>{w.text}</span>
          ))}
        </span>
        <span
          className="block"
          data-testid="safer-word"
          data-safer-word={saferBloom ? "bloom" : "steady"}
          style={{
            opacity: saferP,
            transform: `scale(${(1.04 - 0.04 * saferP).toFixed(3)})`,
            filter: saferP < 1 ? `blur(${((1 - saferP) * 6).toFixed(1)}px)` : "none",
          }}
        >
          safer?
        </span>
      </h1>
      <p data-testid="hero-subline" data-hero-subline="true" className="mt-4 max-w-xl" style={{ opacity: sublineOpacity }}>
        A closed engineering loop — evidence, design, simulation, audit.
      </p>
    </div>
  );
}

export interface HeroTitleSequenceProps {
  readonly onSubmitRun: (payload: ReconstructRequestPayload) => void;
  readonly busy: boolean;
}

export function HeroTitleSequence({ onSubmitRun, busy }: HeroTitleSequenceProps): React.JSX.Element {
  const init = React.useMemo(() => getInitialElapsedMs(), []);
  const [elapsedMs, setElapsedMs] = React.useState<number>(init.ms);
  const [parallax, setParallax] = React.useState<{ readonly x: number; readonly y: number }>({ x: 0, y: 0 });
  const skippedRef = React.useRef<boolean>(init.ms >= TOTAL_SEQ_MS);
  const isDocked = elapsedMs >= TOTAL_SEQ_MS;

  const finishImmediately = React.useCallback((): void => {
    skippedRef.current = true;
    setElapsedMs(TOTAL_SEQ_MS);
    try { window.sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* ignore */ }
    if (typeof document !== "undefined" && typeof document.getAnimations === "function") {
      for (const anim of document.getAnimations()) {
        try { anim.finish(); } catch { /* ignore */ }
      }
    }
  }, []);

  React.useEffect(() => {
    if (isDocked || skippedRef.current) return undefined;
    let rafId = 0;
    const t0 = performance.now();
    const tick = (now: number): void => {
      if (skippedRef.current) return;
      const next = Math.min(TOTAL_SEQ_MS, now - t0);
      setElapsedMs(next);
      if (next >= TOTAL_SEQ_MS) {
        skippedRef.current = true;
        try { window.sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* ignore */ }
        return;
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isDocked]);

  React.useEffect(() => {
    if (isDocked) return undefined;
    window.addEventListener("keydown", finishImmediately, { passive: true });
    window.addEventListener("mousedown", finishImmediately, { passive: true });
    window.addEventListener("wheel", finishImmediately, { passive: true });
    return () => {
      window.removeEventListener("keydown", finishImmediately);
      window.removeEventListener("mousedown", finishImmediately);
      window.removeEventListener("wheel", finishImmediately);
    };
  }, [isDocked, finishImmediately]);

  const decodeP = clamp01((elapsedMs - 600) / 1600);
  const planetFade = clamp01((elapsedMs - 600) / 350);
  const dockP = easeOutCubic((elapsedMs - 5400) / 1000);
  const scanlineP = elapsedMs >= 3900 && elapsedMs <= 4500 ? (elapsedMs - 3900) / 600 : null;

  return (
    <div
      data-testid="hero-title-sequence"
      data-hero-stage="true"
      data-sequence-state={isDocked ? "docked" : "playing"}
      data-reduced-motion={init.reduced ? "true" : "false"}
      onMouseMove={(e) => {
        const nx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
        const ny = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
        setParallax({ x: Number((nx * 3.5).toFixed(2)), y: Number((ny * 3.5).toFixed(2)) });
      }}
      className="pointer-events-auto relative flex h-full w-full flex-col items-center justify-between overflow-hidden px-4 py-8 transition-opacity duration-300 ease-out"
    >
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full opacity-5">
        <filter id="stratum-film-grain"><feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves={3} stitchTiles="stitch" /></filter>
        <rect width="100%" height="100%" filter="url(#stratum-film-grain)" />
      </svg>
      <div data-testid="hero-starfield" className="pointer-events-none absolute inset-0" style={{ opacity: planetFade, transform: `translate3d(${parallax.x}px, ${parallax.y}px, 0)` }}>
        {STARFIELD.map((s) => <span key={s.id} className="absolute block h-px w-px rounded-full bg-text" style={{ left: s.leftPct, top: s.topPct, opacity: s.opacity }} />)}
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ opacity: planetFade * (1 - 0.15 * dockP), transform: `translate3d(${(parallax.x * 0.85).toFixed(2)}px, calc(${(4 * dockP).toFixed(2)}vh + ${(parallax.y * 0.85).toFixed(2)}px), 0) scale(${(1 - 0.1 * dockP).toFixed(3)})` }}>
        <BaltamPlanet decodeProgress={decodeP} sunriseProgress={decodeP} scanlineProgress={scanlineP} whisperElapsedMs={Math.max(0, elapsedMs - 4400)} />
      </div>
      <HeroHeadline elapsedMs={elapsedMs} dockP={dockP} />
      <div data-testid="hero-prompt-dock" className="relative z-20 mb-2 flex w-full justify-center" style={{ opacity: dockP, transform: `translateY(${((1 - dockP) * 24).toFixed(1)}px)`, filter: dockP < 1 ? `blur(${((1 - dockP) * 6).toFixed(1)}px)` : "none" }}>
        <PromptBar onSubmitRun={onSubmitRun} busy={busy} />
      </div>
    </div>
  );
}
