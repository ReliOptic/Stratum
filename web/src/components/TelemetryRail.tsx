import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appConfig } from "@/lib/config";
import type { EngineeringSpec, EvidenceSource, ImageEvidenceCrop, ParameterStatus, Part, TelemetryLayerId } from "@/lib/contracts";
import type { TelemetryState } from "@/lib/sse";

const LAYER_LABELS: readonly { readonly id: TelemetryLayerId; readonly title: string }[] = [
  { id: "surface", title: "Surface & Specs" },
  { id: "internal", title: "Internal Evidence" },
  { id: "kernel", title: "Geometry & Physics Kernel" },
];

const STATUS_VARIANT_MAP: Readonly<Record<ParameterStatus, "confirm" | "cyan" | "amber" | "olive" | "danger">> = {
  OBSERVED: "confirm", DOCUMENTED: "cyan", INFERRED: "amber", ASSUMED: "olive", UNKNOWN: "danger",
};

function deriveImageCrops(spec: EngineeringSpec, part: Part): readonly ImageEvidenceCrop[] {
  const partSourceIds = new Set(part.parameters.flatMap((p) => p.source_ids));
  return spec.sources
    .filter((s) => (s.kind === "image" || Boolean(s.image_uri) || Boolean(s.crop_box)) && (partSourceIds.size === 0 || partSourceIds.has(s.source_id)))
    .map((s) => {
      const cropUrl = `${appConfig.apiBaseUrl}/runs/${encodeURIComponent(spec.run_id)}/evidence/${encodeURIComponent(s.source_id)}/crop.png`;
      return {
        source_id: s.source_id,
        part_id: part.part_id,
        crop_url: cropUrl,
        full_url: s.image_uri ?? s.url ?? cropUrl,
        caption: s.excerpt || s.title,
        bbox: s.crop_box ?? [0.1, 0.1, 0.8, 0.8],
      };
    });
}

interface PartEvidenceSectionProps {
  readonly part: Part;
  readonly sourceMap: Readonly<Record<string, EvidenceSource>>;
  readonly crops: readonly ImageEvidenceCrop[];
  readonly onOpenCrop: (crop: ImageEvidenceCrop) => void;
  readonly onSelectPart: (partId: string) => void;
}

function PartEvidenceSection({ part, sourceMap, crops, onOpenCrop, onSelectPart }: PartEvidenceSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-2" data-testid="evidence-ledger">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="font-mono text-xs font-semibold text-amber">{part.name} ({part.part_id})</span>
        <div className="flex flex-wrap gap-1">
          {part.roles.map((r) => <Badge key={r} variant="olive">{r}</Badge>)}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {part.parameters.map((param) => (
          <div
            key={param.name}
            role="button"
            tabIndex={0}
            data-testid={`param-row-${param.name}`}
            data-part-id={part.part_id}
            onClick={() => onSelectPart(part.part_id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelectPart(part.part_id); }}
            className={
              param.status === "UNKNOWN" || param.basis_type === "model_prior"
                ? "cursor-pointer rounded-sm border border-danger/60 bg-danger/10 p-2 font-mono text-xs hover:border-amber"
                : "cursor-pointer rounded-sm border border-hairline bg-bg p-2 font-mono text-xs hover:border-amber"
            }
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-text">{param.name}</span>
              <span className="font-semibold text-amber">{param.value ?? "N/A"} {param.unit ?? ""}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
              <div className="flex items-center gap-1">
                <Badge variant={STATUS_VARIANT_MAP[param.status]}>{param.status}</Badge>
                <Badge variant={param.basis_type === "model_prior" ? "danger" : "dim"}>{param.basis_type}</Badge>
              </div>
              <div className="flex flex-wrap gap-1 text-dim">
                {param.source_ids.length > 0 ? (
                  param.source_ids.map((sid) => {
                    const src = sourceMap[sid];
                    return src?.url ? (
                      <a key={sid} href={src.url} target="_blank" rel="noreferrer" className="text-cyan underline">{sid}</a>
                    ) : (
                      <span key={sid}>{sid}</span>
                    );
                  })
                ) : (
                  <span className="text-danger">ungrounded</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {crops.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1">
          {crops.map((crop) => (
            <button
              key={crop.source_id}
              type="button"
              data-testid={`image-crop-${crop.source_id}`}
              onClick={() => onOpenCrop(crop)}
              className="flex flex-col gap-1 rounded-sm border border-amber bg-bg p-2 text-left"
            >
              <div className="relative overflow-hidden rounded-sm border border-amber">
                <img src={crop.crop_url} alt={crop.caption} className="h-20 w-full object-cover" />
              </div>
              <span className="font-mono text-xs text-amber">Read by Gemini 4 Argon · {crop.caption}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface TelemetryRailProps {
  readonly telemetry: TelemetryState;
  readonly spec: EngineeringSpec | null;
  readonly selectedPartId: string | null;
  readonly onSelectPart: (partId: string) => void;
}

export function TelemetryRail({ telemetry, spec, selectedPartId, onSelectPart }: TelemetryRailProps): React.JSX.Element {
  const [expandedCrop, setExpandedCrop] = React.useState<ImageEvidenceCrop | null>(null);
  const parts = spec?.parts ?? [];
  const activePart = parts.find((p) => p.part_id === selectedPartId) ?? parts[0] ?? null;
  const usage = telemetry.usage;
  const sourceMap = React.useMemo(() => {
    const map: Record<string, EvidenceSource> = {};
    for (const s of spec?.sources ?? []) map[s.source_id] = s;
    return map;
  }, [spec]);
  const crops = React.useMemo(() => (spec && activePart ? deriveImageCrops(spec, activePart) : []), [spec, activePart]);

  return (
    <aside
      data-testid="telemetry-rail"
      aria-label="Telemetry Rail"
      className="pointer-events-auto flex max-h-96 w-full flex-col gap-2 overflow-y-auto border-t border-hairline bg-panel/95 p-3 md:h-full md:max-h-none md:w-80 md:border-t-0 md:border-l"
    >
      <div data-testid="context-counter" className="sticky top-0 z-10 rounded-sm border border-hairline bg-bg p-2 font-mono text-xs text-text">
        {usage
          ? `Evidence in context: ${usage.context_tokens} tokens · ${usage.sources} sources · ${usage.images} images · ${usage.model_calls} model calls`
          : "Evidence in context: 0 tokens · 0 sources · 0 images · 0 model calls"}
      </div>
      <div className="flex flex-col gap-1.5" data-testid="telemetry-layers">
        {LAYER_LABELS.map((layer) => {
          const isCurrent = telemetry.activeStage === layer.id;
          const isDone = telemetry.completedStages.includes(layer.id) || Boolean(spec && !isCurrent);
          const cls = isCurrent ? "border-amber bg-amber/10 text-amber" : isDone ? "border-confirm/50 bg-confirm/10 text-confirm" : "border-hairline bg-bg text-dim";
          return (
            <div key={layer.id} data-testid={`layer-${layer.id}`} className={`rounded-sm border px-2.5 py-1.5 font-mono text-xs ${cls}`}>
              <div className="flex items-center justify-between">
                <span>{layer.title}</span>
                <span>{isCurrent ? "ACTIVE" : isDone ? "DONE" : "NOT RUN"}</span>
              </div>
            </div>
          );
        })}
      </div>
      {Object.keys(telemetry.partProgress).length > 0 && (
        <div className="flex flex-col gap-1 border-t border-hairline pt-2 font-mono text-xs">
          {Object.entries(telemetry.partProgress).map(([pid, msg]) => (
            <div key={pid} className="flex justify-between text-dim"><span className="text-text">{pid}</span><span>{msg}</span></div>
          ))}
        </div>
      )}
      {telemetry.thoughts.length > 0 && (
        <div data-testid="thought-summaries" className="flex flex-col gap-1 border-t border-hairline pt-2 font-mono text-xs text-dim">
          {telemetry.thoughts.slice(-3).map((line, idx) => <div key={`${idx}-${line.slice(0, 12)}`} className="truncate">&gt; {line}</div>)}
        </div>
      )}
      {parts.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-hairline pt-2">
          {parts.map((p) => (
            <Button key={p.part_id} size="sm" variant={activePart?.part_id === p.part_id ? "default" : "outline"} data-testid={`rail-part-${p.part_id}`} onClick={() => onSelectPart(p.part_id)}>
              {p.part_id}
            </Button>
          ))}
        </div>
      )}
      {activePart && <PartEvidenceSection part={activePart} sourceMap={sourceMap} crops={crops} onOpenCrop={setExpandedCrop} onSelectPart={onSelectPart} />}
      {expandedCrop && (
        <div data-testid="image-evidence-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 p-4">
          <div className="flex max-w-lg flex-col gap-3 rounded-sm border border-amber bg-panel p-4">
            <div className="flex items-center justify-between font-mono text-xs">
              <span className="text-amber">Read by Gemini 4 Argon · {expandedCrop.source_id}</span>
              <Button size="sm" variant="outline" onClick={() => setExpandedCrop(null)}>Close</Button>
            </div>
            <div className="relative border-2 border-amber"><img src={expandedCrop.full_url ?? expandedCrop.crop_url} alt={expandedCrop.caption} className="max-h-80 w-full object-contain" /></div>
            <p className="font-mono text-xs text-text">{expandedCrop.caption}</p>
          </div>
        </div>
      )}
    </aside>
  );
}
