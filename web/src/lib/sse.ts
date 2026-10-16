import { appConfig } from "@/lib/config";
import type {
  RunEvent,
  RunStatus,
  TelemetryLayerId,
  UsageStats,
} from "@/lib/contracts";
import { createStratumError, logStructured, type StratumError } from "@/lib/utils";

export interface TelemetryState {
  readonly lastSeq: number;
  readonly activeStage: TelemetryLayerId | null;
  readonly completedStages: readonly TelemetryLayerId[];
  readonly partProgress: Readonly<Record<string, string>>;
  readonly usage: UsageStats | null;
  readonly thoughts: readonly string[];
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
    partProgress: {},
    usage: null,
    thoughts: [],
    status: null,
    latestRevision: 0,
    connected: false,
    error: null,
  };
}

export function reduceRunEvent(
  state: TelemetryState,
  event: RunEvent,
): TelemetryState {
  if (event.seq <= state.lastSeq) {
    return state;
  }
  const nextSeq = event.seq;
  if (event.type === "usage" && event.usage) {
    return { ...state, lastSeq: nextSeq, usage: event.usage };
  }
  if (event.type === "thought_summary" && event.message) {
    return {
      ...state,
      lastSeq: nextSeq,
      thoughts: [...state.thoughts.slice(-19), event.message],
    };
  }
  if (event.type === "part_progress" && event.part_id && event.message) {
    return {
      ...state,
      lastSeq: nextSeq,
      partProgress: { ...state.partProgress, [event.part_id]: event.message },
    };
  }
  if (event.type === "stage" && event.stage) {
    const prevStages =
      state.activeStage && !state.completedStages.includes(state.activeStage)
        ? [...state.completedStages, state.activeStage]
        : state.completedStages;
    return {
      ...state,
      lastSeq: nextSeq,
      activeStage: event.stage,
      completedStages: prevStages,
    };
  }
  if (event.type === "status" && event.status) {
    const rev =
      typeof event.revision === "number" && event.revision > state.latestRevision
        ? event.revision
        : state.latestRevision;
    return { ...state, lastSeq: nextSeq, status: event.status, latestRevision: rev };
  }
  if (event.type === "external_results") {
    return {
      ...state,
      lastSeq: nextSeq,
      status: "EXTERNAL_RESULTS_IMPORTED",
    };
  }
  if (event.type === "error") {
    return {
      ...state,
      lastSeq: nextSeq,
      status: "FAILED",
      error: createStratumError(
        "API_ERROR",
        event.message ?? "Run stream reported an error",
        "Check input sources or retry the operation.",
      ),
    };
  }
  return { ...state, lastSeq: nextSeq };
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
  const makeSource =
    handlers.createEventSource ?? ((url: string) => new EventSource(url));

  const openStream = (): void => {
    if (closed) {
      return;
    }
    const url = buildEventsUrl(runId, currentSeq);
    logStructured("sse_connect", runId, null, "telemetry", { after: currentSeq });
    source = makeSource(url);
    source.onopen = () => {
      handlers.onConnectionChange?.(true);
    };
    source.onmessage = (msg: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(msg.data) as RunEvent;
        if (typeof parsed.seq === "number" && parsed.seq > currentSeq) {
          currentSeq = parsed.seq;
        }
        handlers.onEvent(parsed);
      } catch (err: unknown) {
        const stratumErr = createStratumError(
          "PARSE_ERROR",
          err instanceof Error ? err.message : "Invalid SSE event payload",
          "Verify server event payload matches RunEvent contract.",
        );
        logStructured("sse_parse_error", runId, null, "telemetry");
        handlers.onError?.(stratumErr);
      }
    };
    source.onerror = () => {
      handlers.onConnectionChange?.(false);
      source?.close();
      if (!closed) {
        logStructured("sse_reconnect_scheduled", runId, null, "telemetry", {
          after: currentSeq,
        });
        timerId = setTimeout(openStream, delay);
      }
    };
  };

  openStream();

  return () => {
    closed = true;
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    source?.close();
  };
}
