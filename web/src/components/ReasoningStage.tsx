import * as React from "react";
import { BaltamPlanet } from "@/components/BaltamPlanet";
import type { EngineeringSpec, RunEvent } from "@/lib/contracts";
import type { TelemetryState } from "@/lib/sse";

export interface SourceChipItem {
  readonly id: string;
  readonly domain: string;
  readonly title: string;
  readonly url?: string;
}

export interface ImageThumbItem {
  readonly id: string;
  readonly url: string;
  readonly caption: string;
}

const FADE_OPACITIES = [1, 0.84, 0.68, 0.52, 0.38, 0.25] as const;

export function formatMmSs(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function parseDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return rawUrl.slice(0, 28);
  }
}

export function formatReasoningEventMessage(ev: RunEvent): string {
  const q =
    typeof ev.data.query === "string"
      ? ev.data.query
      : typeof ev.data.search_query === "string"
        ? ev.data.search_query
        : null;
  return q && q.trim().length > 0 ? `Searching: ${q.trim()}` : ev.message;
}

export function extractReasoningSources(
  events: readonly RunEvent[],
  spec: EngineeringSpec | null,
): readonly SourceChipItem[] {
  const seen = new Set<string>();
  const chips: SourceChipItem[] = [];
  const pushChip = (id: string, rawUrl: string, rawTitle?: string): void => {
    const key = rawUrl || id;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const domain = parseDomain(rawUrl || id);
    chips.push({ id, domain, title: (rawTitle && rawTitle.trim()) || domain, url: rawUrl || undefined });
  };
  for (const ev of events) {
    if (typeof ev.data.url === "string" && ev.data.url.length > 0) {
      pushChip(`ev-${ev.seq}`, ev.data.url, typeof ev.data.title === "string" ? ev.data.title : undefined);
    }
    if (Array.isArray(ev.data.sources)) {
      for (const item of ev.data.sources) {
        if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          const u = typeof rec.url === "string" ? rec.url : "";
          const d = typeof rec.domain === "string" ? rec.domain : u;
          if (d) pushChip(`ev-${ev.seq}-${chips.length}`, u || d, typeof rec.title === "string" ? rec.title : undefined);
        }
      }
    }
  }
  for (const s of spec?.sources ?? []) {
    if (s.url) pushChip(s.source_id, s.url, s.title);
  }
  return chips.slice(-6);
}

export function extractReasoningImages(
  events: readonly RunEvent[],
  spec: EngineeringSpec | null,
): readonly ImageThumbItem[] {
  const seen = new Set<string>();
  const thumbs: ImageThumbItem[] = [];
  const pushThumb = (id: string, url: string, caption: string): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    thumbs.push({ id, url, caption });
  };
  for (const ev of events) {
    const imgUrl = typeof ev.data.image_url === "string" ? ev.data.image_url : typeof ev.data.image_uri === "string" ? ev.data.image_uri : null;
    if (imgUrl) pushThumb(`img-${ev.seq}`, imgUrl, ev.message || "Evidence image");
    if (Array.isArray(ev.data.images)) {
      for (const item of ev.data.images) {
        if (typeof item === "string") pushThumb(`img-${ev.seq}-${thumbs.length}`, item, ev.message);
        else if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          if (typeof rec.url === "string") pushThumb(`img-${ev.seq}-${thumbs.length}`, rec.url, typeof rec.caption === "string" ? rec.caption : ev.message);
        }
      }
    }
  }
  for (const s of spec?.sources ?? []) {
    if (s.image_uri) pushThumb(s.source_id, s.image_uri, s.title || s.source_id);
  }
  return thumbs.slice(-6);
}

export interface ReasoningStageProps {
  readonly telemetry: TelemetryState;
  readonly spec: EngineeringSpec | null;
  readonly elapsedSeconds: number;
  readonly fadedOut: boolean;
}

export function ReasoningStage({ telemetry, spec, elapsedSeconds, fadedOut }: ReasoningStageProps): React.JSX.Element {
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    if (fadedOut) return undefined;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [fadedOut]);

  const latestSix = React.useMemo(() => [...telemetry.recentEvents].reverse().slice(0, 6), [telemetry.recentEvents]);
  const sourceChips = React.useMemo(() => extractReasoningSources(telemetry.recentEvents, spec), [telemetry.recentEvents, spec]);
  const imageThumbs = React.useMemo(() => extractReasoningImages(telemetry.recentEvents, spec), [telemetry.recentEvents, spec]);

  const silenceMs = telemetry.lastEventAtMs !== null ? Math.max(0, nowMs - telemetry.lastEventAtMs) : elapsedSeconds * 1000;
  const forcedSilenceSec = typeof latestSix[0]?.data.silence_s === "number" ? Number(latestSix[0].data.silence_s) : 0;
  const showHighThinking = silenceMs >= 20_000 || forcedSilenceSec >= 20;

  return (
    <div
      data-testid="reasoning-stage"
      data-stage-state={fadedOut ? "faded-out" : "active"}
      className={`absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/95 px-6 py-4 transition-opacity duration-500 ease-out ${
        fadedOut ? "pointer-events-none z-0 opacity-0" : "pointer-events-auto z-20 opacity-100"
      }`}
    >
      <BaltamPlanet scannerActive={!fadedOut} globeOpacity={0.85} />
      <div data-testid="reasoning-stream" className="flex w-full max-w-2xl flex-col gap-1.5 rounded-md bg-panel/85 px-4 py-3 font-mono text-xs tabular-nums">
        {showHighThinking && (
          <div data-testid="reasoning-high-thinking" className="flex items-center justify-between text-amber">
            <span>Argon is reasoning (high thinking)…</span>
            <span>{formatMmSs(Math.max(elapsedSeconds, forcedSilenceSec))}</span>
          </div>
        )}
        {latestSix.map((ev, idx) => (
          <div key={ev.seq} data-testid={`reasoning-event-${ev.seq}`} className="truncate text-text transition-opacity duration-200" style={{ opacity: FADE_OPACITIES[idx] ?? 0.25 }}>
            <span className="text-amber">{ev.stage}</span>
            <span className="text-dim"> · </span>
            <span className="text-cyan">{ev.part_id ?? "system"}</span>
            <span className="text-dim"> · </span>
            <span>{formatReasoningEventMessage(ev)}</span>
          </div>
        ))}
        {sourceChips.length > 0 && (
          <div data-testid="reasoning-sources" className="mt-1 flex flex-wrap gap-1.5 pt-1">
            {sourceChips.map((chip) => (
              <span key={chip.id} data-testid="reasoning-source-chip" className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 font-sans text-xs text-text">
                <span className="font-mono text-cyan">{chip.domain}</span>
                <span className="text-dim">·</span>
                <span className="max-w-44 truncate">{chip.title}</span>
              </span>
            ))}
          </div>
        )}
        {imageThumbs.length > 0 && (
          <div data-testid="reasoning-images" className="mt-1 flex flex-wrap items-center gap-2 pt-1">
            {imageThumbs.map((img) => (
              <img key={img.id} data-testid="reasoning-image-thumb" src={img.url} alt={img.caption} className="h-8 w-8 rounded-sm object-cover" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
