import * as React from "react";
import { Badge } from "@/components/ui/badge";
import type {
  BenchmarkEntry,
  MetricDiff,
  PassPrediction,
  PredictionOutcome,
  SandboxCheck,
  SimPoint,
  VariantCard,
} from "@/lib/contracts";

function buildPolylinePoints(
  points: readonly SimPoint[],
  pickTemp: (p: SimPoint) => number | undefined,
): string {
  const valid = points.filter((p) => typeof pickTemp(p) === "number");
  if (valid.length === 0) return "";
  const maxTime = Math.max(1, ...points.map((p) => p.time_s));
  const temps = points.flatMap((p) => [
    p.base_temp_c,
    p.new_temp_c,
    ...(typeof p.external_temp_c === "number" ? [p.external_temp_c] : []),
  ]);
  const minT = Math.min(...temps) - 2;
  const maxT = Math.max(minT + 5, ...temps) + 2;
  return valid
    .map((p) => {
      const val = pickTemp(p) ?? minT;
      const x = ((p.time_s / maxTime) * 220 + 10).toFixed(1);
      const y = (72 - ((val - minT) / (maxT - minT)) * 60).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
}

function outcomeSymbol(outcome: PredictionOutcome): string {
  return outcome === "confirmed" ? "✓" : outcome === "refuted" ? "✗" : "·";
}

export interface RevisionPanelProps {
  readonly variants: readonly VariantCard[];
  readonly passes: readonly PassPrediction[];
  readonly metrics: readonly MetricDiff[];
  readonly simPoints: readonly SimPoint[];
  readonly sandbox: SandboxCheck | null;
  readonly benchmarks: readonly BenchmarkEntry[];
}

export function RevisionPanel({
  variants,
  passes,
  metrics,
  simPoints,
  sandbox,
  benchmarks,
}: RevisionPanelProps): React.JSX.Element {
  const [selectedPass, setSelectedPass] = React.useState<PassPrediction | null>(null);
  const baseLine = React.useMemo(() => buildPolylinePoints(simPoints, (p) => p.base_temp_c), [simPoints]);
  const newLine = React.useMemo(() => buildPolylinePoints(simPoints, (p) => p.new_temp_c), [simPoints]);
  const extLine = React.useMemo(() => buildPolylinePoints(simPoints, (p) => p.external_temp_c), [simPoints]);

  return (
    <div data-testid="revision-panel" className="grid grid-cols-1 gap-3 pt-2 md:grid-cols-3">
      <div className="flex flex-col gap-2 rounded-sm border border-hairline bg-bg p-2.5 font-mono text-xs">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="text-dim">PART × PASS HYPOTHESIS MATRIX</span>
          <div className="flex gap-1">
            {variants.map((v) => (
              <Badge key={v.variant_id} variant={v.primary ? "amber" : "dim"}>
                {v.variant_id}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" data-testid="pass-matrix">
          {passes.map((cell) => {
            const effective = cell.external_outcome ?? cell.outcome;
            const flagged = Boolean(cell.suspicious || cell.fitted_adjustment);
            return (
              <button
                key={`${cell.part_id}-${cell.pass_id}`}
                type="button"
                data-testid={`pass-cell-${cell.part_id}-${cell.pass_id}`}
                onClick={() => setSelectedPass(cell)}
                className={
                  effective === "confirmed"
                    ? "rounded-sm border border-confirm bg-confirm/15 px-2 py-1 text-confirm"
                    : effective === "refuted"
                      ? "rounded-sm border border-danger bg-danger/15 px-2 py-1 text-danger"
                      : "rounded-sm border border-hairline bg-panel px-2 py-1 text-dim"
                }
              >
                {cell.part_id}:{cell.pass_id} {outcomeSymbol(effective)}
                {flagged ? " ⚠" : ""}
              </button>
            );
          })}
        </div>
        {selectedPass && (
          <div data-testid="pass-tooltip" className="rounded-sm border border-hairline bg-panel p-2 text-xs text-text">
            <div>Prediction: {selectedPass.prediction}</div>
            <div className="text-dim">Falsified if: {selectedPass.falsified_if}</div>
            <div className="text-dim">Registered: {selectedPass.registered_at}</div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-sm border border-hairline bg-bg p-2.5 font-mono text-xs">
        <span className="text-dim">METRIC DIFF TABLE</span>
        <table className="w-full text-left" data-testid="metric-diff-table">
          <thead>
            <tr className="border-b border-hairline text-dim">
              <th className="pb-1">Metric</th>
              <th className="pb-1">Base</th>
              <th className="pb-1">New</th>
              <th className="pb-1">Δ</th>
              <th className="pb-1">Met</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.metric} className="border-b border-hairline/50">
                <td className="py-1 text-text">{m.metric}</td>
                <td className="py-1 text-dim">{m.base_value}{m.unit}</td>
                <td className="py-1 text-amber">{m.new_value}{m.unit}</td>
                <td className="py-1 text-cyan">{m.delta > 0 ? `+${m.delta}` : m.delta}{m.unit}</td>
                <td className="py-1">
                  <Badge variant={m.target_met ? "confirm" : "danger"}>
                    {m.target_met ? "YES" : "NO"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 rounded-sm border border-hairline bg-bg p-2.5 font-mono text-xs">
        <div className="flex items-center justify-between">
          <span className="text-dim">STORAGE NODE TEMP (°C)</span>
          <div className="flex gap-2">
            <span className="text-dim">-- Base</span>
            <span className="text-amber">— Sim</span>
            {extLine && <span className="text-cyan">— Ext</span>}
          </div>
        </div>
        <svg data-testid="sim-temperature-chart" viewBox="0 0 240 80" className="h-20 w-full rounded-sm border border-hairline bg-panel">
          {baseLine && <polyline points={baseLine} strokeWidth="1.5" strokeDasharray="3 2" className="fill-none stroke-dim" />}
          {newLine && <polyline points={newLine} strokeWidth="2" className="fill-none stroke-amber" />}
          {extLine && <polyline points={extLine} strokeWidth="2" className="fill-none stroke-cyan" />}
        </svg>
        {sandbox && sandbox.executed && (
          <div data-testid="sandbox-panel" className="flex items-center justify-between rounded-sm border border-hairline bg-panel px-2 py-1">
            <span className="text-dim">Independent check · Google-hosted sandbox</span>
            <Badge variant={sandbox.agrees_with_sim ? "confirm" : "danger"}>
              {sandbox.agrees_with_sim ? "AGREE" : "DISAGREE"}
            </Badge>
          </div>
        )}
        {benchmarks.length >= 2 && (
          <div data-testid="benchmark-view" className="border-t border-hairline pt-1 text-xs">
            {benchmarks.map((b) => (
              <div key={b.orchestrator_model} className="flex justify-between">
                <span className="text-amber">{b.orchestrator_model}</span>
                <span className="text-dim">✓{b.predictions_confirmed}/✗{b.predictions_refuted} · {b.context_tokens}tok · {b.wall_time_s}s</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
