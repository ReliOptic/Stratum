import { appConfig } from "@/lib/config";
import type {
  EventStage,
  RunEvent,
  RunStatus,
  TelemetryLayerId,
  UsageStat,
} from "@/lib/contracts";
import { createStratumError, logStructured, type StratumError } from "@/lib/utils";

export interface TelemetryState {
  readonly lastSeq: number;
  readonly activeStage: TelemetryLayerId | null;
  readonly completedStages: readonly TelemetryLayerId[];
  readonly lastEventStage: EventStage | null;
  readonly partProgress: Readonly<Record<string, string>>;
  readonly usage: UsageStat | null;
  readonly thoughts: readonly string[];
  readonly recentEvents: readonly RunEvent[];
  readonly lastEventAtMs: number | null;
  readonly status: RunStatus | null;
  readonly latestRevision: number;
  readonly connected: boolean;
  readonly error: StratumError | null;
}

export function createInitialTelemetryState(): TelemetryState {
  return {
    lastSeq: 0,
    activeStage: null,
    completedStages: [],
    lastEventStage: null,
    partProgress: {},
    usage: null,
    thoughts: [],
    recentEvents: [],
    lastEventAtMs: null,
    status: null,
    latestRevision: 0,
    connected: false,
    error: null,
  };
}

export function stageToTelemetryLayer(stage: EventStage): TelemetryLayerId {
  if (stage === "fetch" || stage === "v0") return "surface";
  if (stage === "verify") return "internal";
  return "kernel";
}

function extractUsageStat(data: Readonly<Record<string, unknown>>): UsageStat | null {
  const candidate = typeof data.usage === "object" && data.usage !== null ? (data.usage as Record<string, unknown>) : data;
  if (typeof candidate.context_tokens !== "number") return null;
  return {
    context_tokens: candidate.context_tokens,
    output_tokens: typeof candidate.output_tokens === "number" ? candidate.output_tokens : 0,
    sources: typeof candidate.sources === "number" ? candidate.sources : 0,
    images: typeof candidate.images === "number" ? candidate.images : 0,
    model_calls: typeof candidate.model_calls === "number" ? candidate.model_calls : 0,
  };
}

export function reduceRunEvent(
  state: TelemetryState,
  event: RunEvent,
  nowMs: number = Date.now(),
): TelemetryState {
  if (event.seq <= state.lastSeq) return state;
  const layer = stageToTelemetryLayer(event.stage);
  const completedStages =
    state.activeStage && state.activeStage !== layer && !state.completedStages.includes(state.activeStage)
      ? [...state.completedStages, state.activeStage]
      : state.completedStages;

  const usage = extractUsageStat(event.data) ?? state.usage;
  const thoughtText =
    typeof event.data.thought_summary === "string"
      ? event.data.thought_summary
      : event.data.kind === "thought_summary"
        ? event.message
        : null;
  const thoughts = thoughtText ? [...state.thoughts.slice(-19), thoughtText] : state.thoughts;
  const recentEvents = [...state.recentEvents.slice(-23), event];

  const partProgress =
    typeof event.part_id === "string" && event.part_id.length > 0
      ? { ...state.partProgress, [event.part_id]: event.message }
      : state.partProgress;

  const rawStatus = typeof event.data.status === "string" ? (event.data.status as RunStatus) : null;
  const status: RunStatus | null =
    event.level === "error"
      ? "FAILED"
      : event.stage === "import"
        ? (rawStatus ?? "EXTERNAL_RESULTS_IMPORTED")
        : (rawStatus ?? state.status);

  const latestRevision =
    typeof event.revision === "number" && event.revision > state.latestRevision
      ? event.revision
      : state.latestRevision;

  const error =
    event.level === "error"
      ? createStratumError("API_ERROR", event.message || "Run stream reported an error", "Check input sources or retry.")
      : state.error;

  return {
    ...state,
    lastSeq: event.seq,
    activeStage: layer,
    completedStages,
    lastEventStage: event.stage,
    partProgress,
    usage,
    thoughts,
    recentEvents,
    lastEventAtMs: nowMs,
    status,
    latestRevision,
    error,
  };
}

export function buildEventsUrl(
  runId: string,
  afterSeq: number,
  baseUrl: string = appConfig.apiBaseUrl,
): string {
  const encodedId = encodeURIComponent(runId);
  return `${baseUrl}/runs/${encodedId}/events?after=${afterSeq}`;
}

export interface EventStreamHandlers {
  readonly onEvent: (event: RunEvent) => void;
  readonly onConnectionChange?: (connected: boolean) => void;
  readonly onError?: (err: StratumError) => void;
  readonly createEventSource?: (url: string) => EventSource;
  readonly reconnectDelayMs?: number;
}

export function connectRunEventStream(
  runId: string,
  initialAfterSeq: number,
  handlers: EventStreamHandlers,
): () => void {
  let currentSeq = initialAfterSeq;
  let closed = false;
  let source: EventSource | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const delay = handlers.reconnectDelayMs ?? appConfig.sseReconnectDelayMs;
  const makeSource = handlers.createEventSource ?? ((url: string) => new EventSource(url));

  const openStream = (): void => {
    if (closed) return;
    const url = buildEventsUrl(runId, currentSeq);
    logStructured("sse_connect", runId, null, "telemetry", { after: currentSeq });
    source = makeSource(url);
    source.onopen = () => handlers.onConnectionChange?.(true);
    source.onmessage = (msg: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(msg.data) as RunEvent;
        if (typeof parsed.seq === "number" && parsed.seq > currentSeq) {
          currentSeq = parsed.seq;
        }
        handlers.onEvent(parsed);
      } catch (err: unknown) {
        logStructured("sse_parse_error", runId, null, "telemetry");
        handlers.onError?.(
          createStratumError(
            "PARSE_ERROR",
            err instanceof Error ? err.message : "Invalid SSE event payload",
            "Verify server event payload matches RunEvent contract.",
          ),
        );
      }
    };
    source.onerror = () => {
      handlers.onConnectionChange?.(false);
      source?.close();
      if (!closed) {
        logStructured("sse_reconnect_scheduled", runId, null, "telemetry", { after: currentSeq });
        timerId = setTimeout(openStream, delay);
      }
    };
  };

  openStream();
  return () => {
    closed = true;
    if (timerId !== null) clearTimeout(timerId);
    source?.close();
  };
}
