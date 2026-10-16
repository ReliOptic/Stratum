import { fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderAsciiPlanetFrame } from "@/components/BaltamPlanet";
import { HeroTitleSequence } from "@/components/HeroTitleSequence";
import {
  extractReasoningImages,
  extractReasoningSources,
  formatMmSs,
  formatReasoningEventMessage,
} from "@/components/ReasoningStage";
import { loadAppConfig } from "@/lib/config";
import {
  countEdgesByKind,
  describeTargetDirection,
  findTargetLinkedEdges,
  formatEdgeSentence,
  orderEdgesByStrength,
} from "@/lib/connectivity";
import type { CausalEdge, MetricSet, RunEvent } from "@/lib/contracts";
import {
  cn,
  createStratumError,
  formatStructuredLog,
  isStratumError,
  logStructured,
} from "@/lib/utils";

describe("config and utils", () => {
  it("loads defaults and parses env overrides in loadAppConfig", () => {
    const defaults = loadAppConfig({});
    expect(defaults.maxRevision).toBe(3);
    expect(defaults.apiBaseUrl).toBe("/api");

    const custom = loadAppConfig({
      VITE_MAX_REVISION: "5",
      VITE_SSE_RECONNECT_MS: "500",
      VITE_API_BASE_URL: "/custom-api",
    });
    expect(custom.maxRevision).toBe(5);
    expect(custom.sseReconnectDelayMs).toBe(500);
    expect(custom.apiBaseUrl).toBe("/custom-api");
  });

  it("merges classes and constructs typed StratumError objects", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    const err = createStratumError("CONFIRMATION_REQUIRED_409", "Missing token", "Confirm first", 409);
    expect(isStratumError(err)).toBe(true);
    expect(isStratumError(null)).toBe(false);
  });

  it("formats and logs structured JSON telemetry entries", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const formatted = formatStructuredLog("unit_test", "widget-a", "part_01", "surface_specs");
    expect(JSON.parse(formatted).run_id).toBe("widget-a");
    const entry = logStructured("unit_test", "widget-a", "part_01", "surface_specs");
    expect(entry.event).toBe("unit_test");
    spy.mockRestore();
  });
});

describe("BaltamPlanet, HeroTitleSequence, ReasoningStage, and Connectivity", () => {
  it("renders deterministic rotating strata bands, scan beam boost, and particle dispersion", () => {
    const frameA = renderAsciiPlanetFrame(0.2);
    const frameB = renderAsciiPlanetFrame(1.4);
    expect(frameA.length).toBe(22);
    expect(frameA.map((r) => r.text).join("\n")).not.toBe(frameB.map((r) => r.text).join("\n"));
    const scanned = renderAsciiPlanetFrame(0.2, -10, -10, 1, 1, 0.5);
    expect(scanned.map((r) => r.text).join("\n")).not.toBe(frameA.map((r) => r.text).join("\n"));
  });

  it("renders H1 thesis text, Deep Verify default OFF, and skips on keypress", () => {
    window.sessionStorage.clear();
    const { getByTestId } = render(
      React.createElement(HeroTitleSequence, { onSubmitRun: () => undefined, busy: false }),
    );
    expect(getByTestId("thesis-line").tagName).toBe("H1");
    expect(getByTestId("deep-verify-toggle").getAttribute("aria-checked")).toBe("false");
    expect(getByTestId("product-url-input").getAttribute("placeholder")).toBe("Paste a product link");
    fireEvent.keyDown(window, { key: " " });
    expect(getByTestId("hero-title-sequence").getAttribute("data-sequence-state")).toBe("docked");
  });

  it("formats reasoning events, sources, images, and connectivity target directions", () => {
    expect(formatMmSs(125)).toBe("02:05");
    const ev: RunEvent = {
      seq: 1, run_id: "r1", at: "2026-10-16T00:00:00Z", stage: "fetch", level: "info",
      message: "Fetching", data: { query: "Li-ion cell clearance", url: "https://ti.com/ thermal", image_url: "https://ti.com/a.png" },
    };
    expect(formatReasoningEventMessage(ev)).toBe("Searching: Li-ion cell clearance");
    expect(extractReasoningSources([ev], null).length).toBe(1);
    expect(extractReasoningImages([ev], null).length).toBe(1);

    const edges: readonly CausalEdge[] = [
      { from_part: "core-stage", to_part: "storage-cell", kind: "thermal", mechanism: "9mm gap radiation", strength: 0.85, source_ids: ["src-1"] },
      { from_part: "psu", to_part: "core-stage", kind: "electrical", mechanism: "bus rail", strength: 0.6, source_ids: [] },
    ];
    expect(orderEdgesByStrength(edges)[0]?.strength).toBe(0.85);
    expect(countEdgesByKind(edges)).toEqual({ thermal: 1, electrical: 1, mechanical: 0 });
    expect(formatEdgeSentence(edges[0]!)).toContain("Heat from core-stage reaches storage-cell");

    const metrics: MetricSet = {
      run_id: "r1", revision: 0,
      values: [
        { metric_id: "min_gap_mm", value: 9.0, unit: "mm", status: "computed", part_ids: ["core-stage", "storage-cell"], note: "" },
        { metric_id: "peak_temp_C", value: 68.4, unit: "C", status: "computed", part_ids: ["core-stage"], note: "" },
      ],
    };
    const safeGap = describeTargetDirection({ metric_id: "min_gap_mm", comparator: "gte", threshold: 10.0, unit: "mm" }, metrics, 0);
    expect(safeGap.safer).toBe(true);
    expect(safeGap.sentence).toContain("Heat-source ↔ cell gap  9 mm → ≥ 10 mm  ↑ safer");

    const unsafeGap = describeTargetDirection({ metric_id: "min_gap_mm", comparator: "lte", threshold: 5.0, unit: "mm" }, metrics, 0);
    expect(unsafeGap.safer).toBe(false);
    expect(unsafeGap.directionBadge).toBe("direction check");
    expect(findTargetLinkedEdges([{ metric_id: "min_gap_mm", comparator: "gte", threshold: 10.0 }], edges, metrics)).toContain("core-stage->storage-cell:thermal");
  });
});
