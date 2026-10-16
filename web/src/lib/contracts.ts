export type RunStatus =
  | "V0_READY"
  | "PRESETS_READY"
  | "OBJECTIVE_CONFIRMED"
  | "REVISION_RUNNING"
  | "V1_READY"
  | "PARTIAL"
  | "BRIDGE_READY"
  | "EXTERNAL_RESULTS_IMPORTED"
  | "V2_READY"
  | "INPUTS_REQUIRED"
  | "FAILED";

export type PartRole =
  | "heat_source"
  | "energy_storage"
  | "power_conversion"
  | "enclosure"
  | "structural_frame"
  | "thermal_spreader"
  | "user_contact_surface"
  | "connector"
  | "magnetic"
  | "fastener"
  | "moving_part"
  | "other";

export type ParameterStatus = "OBSERVED" | "DOCUMENTED" | "INFERRED" | "ASSUMED" | "UNKNOWN";
export type BasisType = "source" | "physics" | "model_prior";
export type OrchestratorModel = "gemini-4-argon" | "gemini-3.8-flash";
export type InputMode = "link" | "photos" | "drawings" | "cad";
export type VerificationBadge = "simulated" | "sandbox-checked" | "simulink-audited";
export type PredictionOutcome = "confirmed" | "refuted" | "inconclusive";
export type CouplingKind = "thermal" | "electrical" | "mechanical";
export type TelemetryLayerId = "surface_specs" | "internal_evidence" | "geometry_physics";

export interface SourceCitation {
  readonly source_id: string;
  readonly title: string;
  readonly url?: string;
}

export interface EngineeringParameter {
  readonly key: string;
  readonly label: string;
  readonly value: number | string | null;
  readonly unit: string;
  readonly status: ParameterStatus;
  readonly basis_type: BasisType;
  readonly source_ids: readonly string[];
}

export interface ImageEvidenceCrop {
  readonly source_id: string;
  readonly part_id: string;
  readonly crop_url: string;
  readonly full_url?: string;
  readonly caption: string;
  readonly bbox: readonly [number, number, number, number];
}

export interface PartSpec {
  readonly part_id: string;
  readonly name: string;
  readonly role: PartRole;
  readonly parameters: readonly EngineeringParameter[];
  readonly image_evidence?: readonly ImageEvidenceCrop[];
}

export interface CausalEdge {
  readonly edge_id: string;
  readonly from_part_id: string;
  readonly to_part_id: string;
  readonly kind: CouplingKind;
  readonly mechanism: string;
  readonly source_ids: readonly string[];
}

export interface ComponentGraph {
  readonly revision: number;
  readonly parts: readonly PartSpec[];
  readonly edges: readonly CausalEdge[];
  readonly sources: readonly SourceCitation[];
}

export interface ManifestNode {
  readonly node_name: string;
  readonly part_id: string;
  readonly role: PartRole;
  readonly center: readonly [number, number, number];
  readonly explode_vector: readonly [number, number, number];
}

export interface CadManifest {
  readonly revision: number;
  readonly glb_url: string;
  readonly nodes: readonly ManifestNode[];
}

export interface UsageStats {
  readonly context_tokens: number;
  readonly sources_count: number;
  readonly images_count: number;
  readonly model_calls: number;
}

export interface RunEvent {
  readonly seq: number;
  readonly type: "stage" | "part_progress" | "usage" | "thought_summary" | "status" | "external_results" | "error";
  readonly stage?: TelemetryLayerId;
  readonly part_id?: string;
  readonly status?: RunStatus;
  readonly message?: string;
  readonly usage?: UsageStats;
  readonly revision?: number;
  readonly timestamp: string;
}

export interface ObjectivePreset {
  readonly preset_id: string;
  readonly label: string;
  readonly description: string;
  readonly target_summary: string;
}

export interface ObjectiveConfirmation {
  readonly confirm_token: string;
  readonly base_revision: number;
  readonly normalized_targets: readonly string[];
  readonly objective_text: string;
}

export interface PassPrediction {
  readonly pass_id: string;
  readonly part_id: string;
  readonly prediction: string;
  readonly falsified_if: string;
  readonly registered_at: string;
  readonly verdict: "pass" | "fail" | "warn" | "unchanged";
  readonly outcome: PredictionOutcome;
  readonly external_outcome?: PredictionOutcome;
  readonly suspicious?: boolean;
  readonly fitted_adjustment?: boolean;
}

export interface VariantCard {
  readonly variant_id: "Alpha" | "Beta" | "Gamma";
  readonly summary: string;
  readonly primary: boolean;
}

export interface MetricDiff {
  readonly metric: string;
  readonly unit: string;
  readonly base_value: number;
  readonly new_value: number;
  readonly delta: number;
  readonly target_met: boolean;
}

export interface SimPoint {
  readonly time_s: number;
  readonly base_temp_c: number;
  readonly new_temp_c: number;
  readonly external_temp_c?: number;
}

export interface SandboxCheck {
  readonly executed: boolean;
  readonly agrees_with_sim: boolean;
  readonly summary: string;
}

export interface LoopNode {
  readonly revision: number;
  readonly label: string;
  readonly confirmed_count: number;
  readonly refuted_count: number;
  readonly badges: readonly VerificationBadge[];
  readonly wall_time_s: number;
  readonly context_tokens: number;
  readonly audit_match?: boolean;
  readonly max_delta_t_c?: number;
}

export interface BenchmarkEntry {
  readonly orchestrator_model: OrchestratorModel;
  readonly predictions_confirmed: number;
  readonly predictions_refuted: number;
  readonly external_confirmed: number;
  readonly external_refuted: number;
  readonly observed_or_documented_pct: number;
  readonly downgrades_count: number;
  readonly context_tokens: number;
  readonly wall_time_s: number;
}
