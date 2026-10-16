export type {
  AuditStatus,
  BasisType,
  BenchmarkComparison,
  CadOp,
  CadOpType,
  CadPlacement,
  CausalEdge,
  CausalKind,
  Comparator,
  ComponentGraph,
  ConfirmResponse,
  EngineeringSpec,
  EventLevel,
  EventStage,
  EvidenceKind,
  EvidenceSource,
  ExpectedDirection,
  ExternalSimNode,
  ExternalSimResult,
  ExternalTool,
  Manifest,
  ManifestCheck,
  ManifestPart,
  MetricDelta,
  MetricSet,
  MetricStatus,
  MetricValue,
  Objective,
  Parameter,
  ParameterStatus,
  Part,
  PartLayer,
  PartRole,
  PassReport,
  PassVerdict,
  Prediction,
  PredictionOutcome,
  Preset,
  Revision,
  Run,
  RunEvent,
  RunInputs,
  RunStats,
  RunStatus,
  SandboxCheck,
  SimModel,
  SimNode,
  SimResult,
  StratumContracts,
  Target,
  UsageStat,
  Variant,
  VariantId,
} from "@contracts/index";

import type { AuditStatus, PartLayer, PredictionOutcome } from "@contracts/index";

export type OrchestratorModel = "gemini-4-argon" | "gemini-3.8-flash";
export type InputMode = "link" | "photos" | "drawings" | "cad";
export type VerificationBadge = "simulated" | "sandbox-checked" | "simulink-audited";
export type TelemetryLayerId = PartLayer;

export interface ImageEvidenceCrop {
  readonly source_id: string;
  readonly part_id?: string;
  readonly crop_url: string;
  readonly full_url?: string;
  readonly caption: string;
  readonly bbox: readonly [number, number, number, number];
}

export interface LoopNode {
  readonly revision: number;
  readonly label: string;
  readonly confirmed_count: number;
  readonly refuted_count: number;
  readonly badges: readonly VerificationBadge[];
  readonly wall_time_s: number;
  readonly context_tokens: number;
  readonly audit?: AuditStatus;
  readonly max_abs_diff_C?: number | null;
}

export interface SimPoint {
  readonly time_s: number;
  readonly base_temp_c: number;
  readonly new_temp_c: number;
  readonly external_temp_c?: number;
}

export interface MetricDiffRow {
  readonly metric_id: string;
  readonly unit: string;
  readonly base_value: number | null;
  readonly new_value: number | null;
  readonly delta: number | null;
  readonly target_met: boolean;
}

export interface PassMatrixCell {
  readonly pass_no: number;
  readonly part_id: string;
  readonly action: string;
  readonly metric_id: string;
  readonly falsified_if: string;
  readonly registered_at: string;
  readonly outcome: PredictionOutcome;
  readonly external_outcome?: PredictionOutcome | null;
  readonly suspicious: boolean;
  readonly fitted_adjustment: boolean;
}
