import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type StratumErrorCode =
  | "NETWORK_ERROR"
  | "CONFIRMATION_REQUIRED_409"
  | "MAX_REVISION_REACHED_422"
  | "VALIDATION_ERROR"
  | "PARSE_ERROR"
  | "SSE_DISCONNECTED"
  | "API_ERROR";

export interface StratumError {
  readonly code: StratumErrorCode;
  readonly message: string;
  readonly recoveryHint: string;
  readonly status?: number;
}

export function createStratumError(
  code: StratumErrorCode,
  message: string,
  recoveryHint: string,
  status?: number,
): StratumError {
  return { code, message, recoveryHint, status };
}

export function isStratumError(err: unknown): err is StratumError {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const candidate = err as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.recoveryHint === "string"
  );
}

export interface StructuredLogEntry {
  readonly event: string;
  readonly run_id: string | null;
  readonly part_id: string | null;
  readonly stage: string;
  readonly timestamp: string;
  readonly detail?: Record<string, unknown>;
}

export function formatStructuredLog(
  event: string,
  runId: string | null,
  partId: string | null,
  stage: string,
  detail?: Record<string, unknown>,
): string {
  const entry: StructuredLogEntry = {
    event,
    run_id: runId,
    part_id: partId,
    stage,
    timestamp: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };
  return JSON.stringify(entry);
}

export function logStructured(
  event: string,
  runId: string | null,
  partId: string | null,
  stage: string,
  detail?: Record<string, unknown>,
): StructuredLogEntry {
  const json = formatStructuredLog(event, runId, partId, stage, detail);
  console.info(json);
  return JSON.parse(json) as StructuredLogEntry;
}
