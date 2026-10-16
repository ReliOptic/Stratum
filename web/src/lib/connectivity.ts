import type { CausalEdge, CausalKind, MetricSet, Target } from "@/lib/contracts";

export interface EdgeKindCounts {
  readonly thermal: number;
  readonly electrical: number;
  readonly mechanical: number;
}

export function edgeKey(edge: Pick<CausalEdge, "from_part" | "to_part" | "kind">): string {
  return `${edge.from_part}->${edge.to_part}:${edge.kind}`;
}

export function orderEdgesByStrength(edges: readonly CausalEdge[]): readonly CausalEdge[] {
  return [...edges].sort((a, b) => b.strength - a.strength);
}

export function countEdgesByKind(edges: readonly CausalEdge[]): EdgeKindCounts {
  let thermal = 0;
  let electrical = 0;
  let mechanical = 0;
  for (const e of edges) {
    if (e.kind === "thermal") thermal += 1;
    else if (e.kind === "electrical") electrical += 1;
    else mechanical += 1;
  }
  return { thermal, electrical, mechanical };
}

export function formatEdgeSentence(edge: CausalEdge): string {
  if (edge.kind === "thermal") {
    return `Heat from ${edge.from_part} reaches ${edge.to_part} (${edge.mechanism})`;
  }
  if (edge.kind === "electrical") {
    return `Current/signal from ${edge.from_part} couples to ${edge.to_part} (${edge.mechanism})`;
  }
  return `Mechanical load between ${edge.from_part} and ${edge.to_part} (${edge.mechanism})`;
}

export function findTargetLinkedEdges(
  targets: readonly Target[],
  edges: readonly CausalEdge[],
  metrics: MetricSet | null,
): readonly string[] {
  if (targets.length === 0 || edges.length === 0) return [];
  const metricParts = new Set<string>();
  const wantKinds = new Set<CausalKind>();
  for (const t of targets) {
    const id = t.metric_id.toLowerCase();
    if (id.includes("temp") || id.includes("thermal") || id.includes("heat") || id.includes("gap")) {
      wantKinds.add("thermal");
    }
    if (id.includes("volt") || id.includes("current") || id.includes("power") || id.includes("elec")) {
      wantKinds.add("electrical");
    }
    if (id.includes("gap") || id.includes("stress") || id.includes("mass") || id.includes("clearance")) {
      wantKinds.add("mechanical");
    }
    const mv = metrics?.values.find((v) => v.metric_id === t.metric_id);
    for (const pid of mv?.part_ids ?? []) metricParts.add(pid);
  }
  const matched = edges.filter(
    (e) =>
      metricParts.has(e.from_part) ||
      metricParts.has(e.to_part) ||
      wantKinds.has(e.kind),
  );
  const list = matched.length > 0 ? matched : edges.slice(0, 1);
  return list.map((e) => edgeKey(e));
}

const METRIC_LABELS: Readonly<Record<string, string>> = {
  min_gap_mm: "Heat-source ↔ cell gap",
  heat_storage_gap_mm: "Heat-source ↔ cell gap",
  peak_temp_C: "Peak temperature",
  storage_temp_rise_C: "Storage cell temp rise",
  total_mass_g: "Assembly mass",
};

function isHigherSaferMetric(metricId: string): boolean {
  const id = metricId.toLowerCase();
  return id.includes("gap") || id.includes("clearance") || id.includes("margin") || id.includes("thickness");
}

export interface TargetDirectionInfo {
  readonly metricId: string;
  readonly label: string;
  readonly currentVal: number | null;
  readonly comparatorSymbol: string;
  readonly threshold: number;
  readonly unit: string;
  readonly safer: boolean;
  readonly directionBadge: string;
  readonly sentence: string;
}

export function describeTargetDirection(
  target: Target,
  metrics: MetricSet | null,
  baseRevision?: number,
): TargetDirectionInfo {
  const mv = metrics?.values.find((v) => v.metric_id === target.metric_id);
  const currentVal = typeof mv?.value === "number" ? mv.value : null;
  const unit = target.unit ?? mv?.unit ?? "";
  const unitStr = unit ? ` ${unit}` : "";
  const op =
    target.comparator === "lte" ? "≤" : target.comparator === "lt" ? "<" : target.comparator === "gte" ? "≥" : ">";
  const asciiOp =
    target.comparator === "lte" ? "<=" : target.comparator === "lt" ? "<" : target.comparator === "gte" ? ">=" : ">";
  const higherSafer = isHigherSaferMetric(target.metric_id);
  const wantsIncrease = target.comparator === "gte" || target.comparator === "gt";
  const comparatorAligned = higherSafer ? wantsIncrease : !wantsIncrease;
  const thresholdAligned =
    currentVal === null
      ? true
      : higherSafer
        ? target.threshold >= currentVal
        : target.threshold <= currentVal;
  const safer = comparatorAligned && thresholdAligned;
  const arrow = wantsIncrease ? "↑" : "↓";
  const directionBadge = safer ? `${arrow} safer` : "direction check";
  const label = METRIC_LABELS[target.metric_id] ?? target.metric_id;
  const curPart = currentVal !== null ? `${currentVal}${unitStr} → ` : "";
  const baseTag = typeof baseRevision === "number" ? ` [base V${baseRevision}]` : "";
  const sentence = `${label}  ${curPart}${op} ${target.threshold}${unitStr}  ${directionBadge} · ${target.metric_id} (${target.comparator} / ${asciiOp}) ${target.threshold}${unitStr}${baseTag}`;
  return {
    metricId: target.metric_id,
    label,
    currentVal,
    comparatorSymbol: op,
    threshold: target.threshold,
    unit,
    safer,
    directionBadge,
    sentence,
  };
}
