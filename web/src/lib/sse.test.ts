import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@/lib/contracts";
import {
  buildEventsUrl,
  connectRunEventStream,
  createInitialTelemetryState,
  reduceRunEvent,
  stageToTelemetryLayer,
} from "@/lib/sse";

describe("event reducer", () => {
  it("maps EventStage to telemetry layers, tracks usage, part progress, thoughts, and ignores duplicate seq", () => {
    expect(stageToTelemetryLayer("fetch")).toBe("surface");
    expect(stageToTelemetryLayer("verify")).toBe("internal");
    expect(stageToTelemetryLayer("cad")).toBe("kernel");

    let state = createInitialTelemetryState();
    const ev1: RunEvent = {
      seq: 1,
      run_id: "run-widget-a-001",
      at: "2026-10-16T11:25:00Z",
      stage: "v0",
      level: "info",
      message: "Extracting surface specifications",
      data: {},
    };
    state = reduceRunEvent(state, ev1);
    expect(state.activeStage).toBe("surface");
    expect(state.lastSeq).toBe(1);

    // Duplicate seq is ignored
    state = reduceRunEvent(state, { ...ev1, stage: "verify" });
    expect(state.activeStage).toBe("surface");

    const ev2: RunEvent = {
      seq: 2,
      run_id: "run-widget-a-001",
      at: "2026-10-16T11:25:02Z",
      stage: "verify",
      part_id: "core-stage",
      level: "info",
      message: "Verified thermal dissipation from spec sheet",
      data: {
        usage: {
          context_tokens: 48200,
          output_tokens: 1800,
          sources: 6,
          images: 3,
          model_calls: 4,
        },
        thought_summary: "Coupling core-stage to storage-cell via conduction",
      },
    };
    state = reduceRunEvent(state, ev2);
    expect(state.activeStage).toBe("internal");
    expect(state.completedStages).toContain("surface");
    expect(state.usage?.context_tokens).toBe(48200);
    expect(state.usage?.sources).toBe(6);
    expect(state.partProgress["core-stage"]).toBe("Verified thermal dissipation from spec sheet");
    expect(state.thoughts).toEqual(["Coupling core-stage to storage-cell via conduction"]);

    const ev3: RunEvent = {
      seq: 3,
      run_id: "run-widget-a-001",
      at: "2026-10-16T11:25:05Z",
      stage: "revision",
      revision: 1,
      level: "info",
      message: "V1 ready",
      data: { status: "V1_READY" },
    };
    state = reduceRunEvent(state, ev3);
    expect(state.status).toBe("V1_READY");
    expect(state.latestRevision).toBe(1);
  });
});

describe("connectRunEventStream and reconnect", () => {
  it("builds events URL with after=seq and reconnects from latest seq on error", () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const instances: {
      onopen: (() => void) | null;
      onmessage: ((ev: MessageEvent<string>) => void) | null;
      onerror: (() => void) | null;
      close: () => void;
    }[] = [];

    const fakeFactory = (url: string): EventSource => {
      urls.push(url);
      const inst = {
        onopen: null as (() => void) | null,
        onmessage: null as ((ev: MessageEvent<string>) => void) | null,
        onerror: null as (() => void) | null,
        close: vi.fn(),
      };
      instances.push(inst);
      return inst as unknown as EventSource;
    };

    const received: RunEvent[] = [];
    const disconnect = connectRunEventStream("run-widget-a-001", 0, {
      onEvent: (e) => received.push(e),
      createEventSource: fakeFactory,
      reconnectDelayMs: 200,
    });

    expect(urls[0]).toBe(buildEventsUrl("run-widget-a-001", 0));
    instances[0]?.onmessage?.({
      data: JSON.stringify({
        seq: 4,
        run_id: "run-widget-a-001",
        at: "2026-10-16T11:25:00Z",
        stage: "cad",
        level: "info",
        message: "Compiled CAD",
        data: {},
      }),
    } as MessageEvent<string>);
    expect(received).toHaveLength(1);

    instances[0]?.onerror?.();
    vi.advanceTimersByTime(250);
    expect(urls[1]).toBe(buildEventsUrl("run-widget-a-001", 4));

    disconnect();
    vi.useRealTimers();
  });
});
