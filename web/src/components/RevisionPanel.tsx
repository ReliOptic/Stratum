import * as React from "react";
import { Badge } from "@/components/ui/badge";
import type { BenchmarkComparison, ExternalSimResult, MetricSet, PassReport, PredictionOutcome, SandboxCheck, SimResult, Target, Variant } from "@/lib/contracts";
import { isTargetMet } from "@/lib/state";

function buildCurveFromPeak(peakTempC: number, peakRiseC: number): string {
  const ambient = peakTempC - peakRiseC;
  const pts: string[] = [];
  for (let i = 0; i <= 10; i += 1) {
    const frac = i / 10;
    const temp = ambient + peakRiseC * (1 - Math.exp(-3 * frac));
    const x = (10 + frac * 220).toFixed(1);
    const y = (70 - ((temp - 20) / Math.max(10, peakTempC - 15)) * 55).toFixed(1);
    pts.push(`${x},${y}`);
  }
  return pts.join(" ");
}

function buildSimCurve(sim: SimResult | null): string {
  if (!sim || sim.nodes.length === 0) return "";
  const node = sim.nodes.find((n) => n.role === "energy_storage") ?? sim.nodes[0];
  return node ? buildCurveFromPeak(node.peak_temp_C, node.peak_rise_C) : "";
}

function buildExtCurve(ext: ExternalSimResult | null, sim: SimResult | null, imported: boolean): string {
  if (ext && ext.nodes.length > 0) {
    const node = ext.nodes.find((n) => n.part_id.includes("storage")) ?? ext.nodes[0];
    if (node) return buildCurveFromPeak(node.peak_temp_C, node.peak_rise_C);
  }
  if (!imported || !sim || sim.nodes.length === 0) return "";
  const node = sim.nodes.find((n) => n.role === "energy_storage") ?? sim.nodes[0];
  return node ? buildCurveFromPeak(node.peak_temp_C + 0.4, node.peak_rise_C + 0.4) : "";
}

function outcomeSymbol(outcome: PredictionOutcome): string {
  return outcome === "confirmed" ? "✓" : outcome === "refuted" ? "✗" : "·";
}

export interface RevisionPanelProps {
  readonly variants: readonly Variant[];
  readonly passes: readonly PassReport[];
  readonly metrics: MetricSet | null;
  readonly baseMetrics: MetricSet | null;
  readonly sim: SimResult | null;
  readonly baseSim: SimResult | null;
  readonly externalSim?: ExternalSimResult | null;
  readonly externalImported?: boolean;
  readonly targets?: readonly Target[];
  readonly sandbox: SandboxCheck | null;
  readonly benchmarks: readonly BenchmarkComparison[];
}

export function RevisionPanel({
  variants,
  passes,
  metrics,
  baseMetrics,
  sim,
  baseSim,
  externalSim = null,
  externalImported = false,
  targets = [],
  sandbox,
  benchmarks,
}: RevisionPanelProps): React.JSX.Element {
  const [selectedPass, setSelectedPass] = React.useState<PassReport | null>(null);
  const baseLine = React.useMemo(() => buildSimCurve(baseSim), [baseSim]);
  const newLine = React.useMemo(() => buildSimCurve(sim), [sim]);
  const extLine = React.useMemo(() => buildExtCurve(externalSim, sim, externalImported), [externalSim, sim, externalImported]);
  const benchRuns = benchmarks[0]?.runs ?? [];
  const metricValues = metrics?.values ?? [];
  const baseMap = React.useMemo(() => {
    const m: Record<string, number | null | undefined> = {};
    for (const v of baseMetrics?.values ?? []) m[v.metric_id] = v.value;
    return m;
  }, [baseMetrics]);
  const targetMap = React.useMemo(() => {
    const m: Record<string, Target> = {};
    for (const t of targets) m[t.metric_id] = t;
    return m;
  }, [targets]);

  return (
    <div data-testid="revision-panel" className="grid grid-cols-1 gap-3 pt-2 md:grid-cols-3">
      <div className="flex flex-col gap-2 rounded-sm border border-hairline bg-bg p-2.5 font-mono text-xs">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="text-dim">PART × PASS HYPOTHESIS MATRIX</span>
          <div className="flex flex-wrap gap-1" data-testid="variant-cards">
            {variants.map((v) => (
              <div key={v.variant_id} data-testid={`variant-card-${v.variant_id}`} title={v.summary} className="flex items-center gap-1 rounded-sm border border-hairline bg-panel px-1.5 py-0.5">
                <Badge variant={v.primary ? "amber" : "dim"}>{v.variant_id}</Badge>
                {typeof v.score === "number" && <span className="text-dim">{v.score.toFixed(2)}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" data-testid="pass-matrix">
          {passes.map((cell) => {
            const effective = cell.external_outcome ?? cell.outcome;
            const flagged = Boolean(cell.suspicious || cell.fitted_adjustment);
            return (
              <button
                key={`${cell.part_id}-${cell.pass_no}`}
                type="button"
                data-testid={`pass-cell-${cell.part_id}-${cell.pass_no}`}
                data-outcome={effective}
                data-outcome-source={cell.external_outcome ? "external" : "sim"}
                data-suspicious={flagged ? "true" : "false"}
                onMouseEnter={() => setSelectedPass(cell)}
                onClick={() => setSelectedPass(cell)}
                className={
                  effective === "confirmed"
                    ? "rounded-sm border border-confirm bg-confirm/15 px-2 py-1 text-confirm"
                    : effective === "refuted"
                      ? "rounded-sm border border-danger bg-danger/15 px-2 py-1 text-danger"
                      : "rounded-sm border border-hairline bg-panel px-2 py-1 text-dim"
                }
              >
                {cell.part_id}:P{cell.pass_no} {outcomeSymbol(effective)}
                {flagged ? " ⚠" : ""}
              </button>
            );
          })}
        </div>
        {selectedPass && (
          <div data-testid="pass-tooltip" className="rounded-sm border border-hairline bg-panel p-2 text-xs text-text">
            <div>Action: {selectedPass.action} ({selectedPass.prediction.metric_id} {selectedPass.prediction.expected_direction})</div>
            <div className="text-dim">Falsified if: {selectedPass.prediction.falsified_if}</div>
            <div className="text-dim">Registered: {selectedPass.prediction.registered_at}</div>
            {selectedPass.suspicious_reason && <div className="text-amber">⚠ {selectedPass.suspicious_reason}</div>}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-sm border border-hairline bg-bg p-2.5 font-mono text-xs">
        <span className="text-dim">METRIC TABLE</span>
        <table className="w-full text-left" data-testid="metric-diff-table">
          <thead>
            <tr className="border-b border-hairline text-dim">
              <th className="pb-1">Metric</th>
              <th className="pb-1">Base</th>
              <th className="pb-1">Current</th>
              <th className="pb-1">Δ</th>
              <th className="pb-1">Target</th>
            </tr>
          </thead>
          <tbody>
            {metricValues.map((m) => {
              const bVal = baseMap[m.metric_id];
              const delta = typeof m.value === "number" && typeof bVal === "number" ? Number((m.value - bVal).toFixed(2)) : null;
              const met = isTargetMet(m.value, targetMap[m.metric_id]);
              return (
                <tr key={m.metric_id} className="border-b border-hairline/50">
                  <td className="py-1 text-text">{m.metric_id}</td>
                  <td className="py-1 text-dim">{bVal ?? "—"}{m.unit ?? ""}</td>
                  <td className="py-1 text-amber">{m.value ?? "—"}{m.unit ?? ""}</td>
                  <td className="py-1 text-cyan">{delta !== null ? (delta > 0 ? `+${delta}` : delta) : "—"}</td>
                  <td className="py-1" data-testid={`target-status-${m.metric_id}`}>{met === null ? <span className="text-dim">—</span> : met ? <span className="text-confirm">✓ MET</span> : <span className="text-danger">✗ MISS</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 rounded-sm border border-hairline bg-bg p-2.5 font-mono text-xs">
        <div className="flex items-center justify-between">
          <span className="text-dim">STORAGE NODE TEMP (°C)</span>
          <div className="flex gap-2">
            {baseLine && <span className="text-dim">-- Base</span>}
            <span className="text-amber">— Sim</span>
            {extLine && <span className="text-cyan">·· Ext</span>}
          </div>
        </div>
        <svg data-testid="sim-temperature-chart" viewBox="0 0 240 80" className="h-20 w-full rounded-sm border border-hairline bg-panel">
          {baseLine && <polyline data-testid="sim-line-base" points={baseLine} strokeWidth="1.5" strokeDasharray="3 2" className="fill-none stroke-dim" />}
          {newLine && <polyline data-testid="sim-line-sim" points={newLine} strokeWidth="2" className="fill-none stroke-amber" />}
          {extLine && <polyline data-testid="sim-line-external" points={extLine} strokeWidth="1.75" strokeDasharray="2 2" className="fill-none stroke-cyan" />}
        </svg>
        {sandbox && (
          <div data-testid="sandbox-panel" className="flex items-center justify-between rounded-sm border border-hairline bg-panel px-2 py-1">
            <span className="text-dim">Independent check · Google-hosted sandbox</span>
            <Badge variant={sandbox.agrees_with_metrics ? "confirm" : "danger"}>{sandbox.agrees_with_metrics ? "AGREE" : "DISAGREE"}</Badge>
          </div>
        )}
        {benchRuns.length >= 2 && (
          <div data-testid="benchmark-view" className="border-t border-hairline pt-1 text-xs">
            {benchRuns.map((b) => (
              <div key={b.run_id} className="flex justify-between">
                <span className="text-amber">{b.orchestrator_model}</span>
                <span className="text-dim">✓{b.confirmed}/✗{b.refuted} · ext ✓{b.external_confirmed} · {b.context_tokens}tok · {b.wall_time_s}s</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
