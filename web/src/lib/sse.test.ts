import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@/lib/contracts";
import {
  buildEventsUrl,
  connectRunEventStream,
  createInitialTelemetryState,
  reduceRunEvent,
} from "@/lib/sse";

describe("reduceRunEvent", () => {
  it("reduces stage, usage, part_progress, thought_summary, and status events in sequence order", () => {
    let state = createInitialTelemetryState();

    state = reduceRunEvent(state, {
      seq: 1,
      type: "stage",
      stage: "surface_specs",
      timestamp: "2026-10-16T11:20:00Z",
    });
    expect(state.activeStage).toBe("surface_specs");

    state = reduceRunEvent(state, {
      seq: 2,
      type: "usage",
      usage: {
        context_tokens: 48200,
        sources_count: 6,
        images_count: 3,
        model_calls: 4,
      },
      timestamp: "2026-10-16T11:20:01Z",
    });
    expect(state.usage?.context_tokens).toBe(48200);

    state = reduceRunEvent(state, {
      seq: 3,
      type: "part_progress",
      part_id: "part_heat_01",
      message: "Grounded 4 parameters",
      timestamp: "2026-10-16T11:20:02Z",
    });
    expect(state.partProgress.part_heat_01).toBe("Grounded 4 parameters");

    state = reduceRunEvent(state, {
      seq: 4,
      type: "thought_summary",
      message: "Coupling thermal path on widget-a",
      timestamp: "2026-10-16T11:20:03Z",
    });
    expect(state.thoughts).toEqual(["Coupling thermal path on widget-a"]);

    state = reduceRunEvent(state, {
      seq: 5,
      type: "stage",
      stage: "internal_evidence",
      timestamp: "2026-10-16T11:20:04Z",
    });
    expect(state.completedStages).toEqual(["surface_specs"]);
    expect(state.activeStage).toBe("internal_evidence");

    state = reduceRunEvent(state, {
      seq: 6,
      type: "status",
      status: "V0_READY",
      revision: 0,
      timestamp: "2026-10-16T11:20:05Z",
    });
    expect(state.status).toBe("V0_READY");

    const duplicate = reduceRunEvent(state, {
      seq: 2,
      type: "thought_summary",
      message: "Ignored old seq",
      timestamp: "2026-10-16T11:20:06Z",
    });
    expect(duplicate).toBe(state);
  });
});

describe("connectRunEventStream and reconnect", () => {
  it("builds events URL with after=seq and reconnects from latest seq on error", () => {
    expect(buildEventsUrl("widget-a", 7, "/api")).toBe(
      "/api/runs/widget-a/events?after=7",
    );

    vi.useFakeTimers();
    const urls: string[] = [];
    const received: RunEvent[] = [];
    interface MockSource {
      onopen: (() => void) | null;
      onmessage: ((e: MessageEvent<string>) => void) | null;
      onerror: (() => void) | null;
      close: () => void;
    }
    const sources: MockSource[] = [];

    const cleanup = connectRunEventStream("widget-a", 0, {
      reconnectDelayMs: 200,
      onEvent: (ev) => received.push(ev),
      createEventSource: (url: string) => {
        urls.push(url);
        const mock: MockSource = {
          onopen: null,
          onmessage: null,
          onerror: null,
          close: vi.fn(),
        };
        sources.push(mock);
        return mock as unknown as EventSource;
      },
    });

    expect(urls).toEqual(["/api/runs/widget-a/events?after=0"]);
    sources[0]?.onmessage?.({
      data: JSON.stringify({
        seq: 4,
        type: "status",
        status: "V0_READY",
        timestamp: "2026-10-16T11:20:00Z",
      }),
    } as MessageEvent<string>);
    expect(received).toHaveLength(1);

    sources[0]?.onerror?.();
    vi.advanceTimersByTime(250);
    expect(urls).toEqual([
      "/api/runs/widget-a/events?after=0",
      "/api/runs/widget-a/events?after=4",
    ]);

    cleanup();
    vi.useRealTimers();
  });
});
