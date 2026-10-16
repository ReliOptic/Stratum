import { describe, expect, it, vi } from "vitest";
import { renderAsciiPlanetFrame } from "@/components/BaltamPlanet";
import { loadAppConfig } from "@/lib/config";
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
    const err = createStratumError(
      "CONFIRMATION_REQUIRED_409",
      "Missing token",
      "Confirm first",
      409,
    );
    expect(isStratumError(err)).toBe(true);
    expect(isStratumError(null)).toBe(false);
  });

  it("formats and logs structured JSON telemetry entries", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const formatted = formatStructuredLog(
      "unit_test",
      "widget-a",
      "part_01",
      "surface_specs",
    );
    expect(JSON.parse(formatted).run_id).toBe("widget-a");

    const entry = logStructured("unit_test", "widget-a", "part_01", "surface_specs");
    expect(entry.event).toBe("unit_test");
    spy.mockRestore();
  });
});

describe("BaltamPlanet ASCII raymarcher", () => {
  it("renders deterministic ASCII strata rows and disperses particles near cursor", () => {
    const base = renderAsciiPlanetFrame(0.5);
    expect(base.length).toBe(18);
    expect(base[9]?.text.trim().length).toBeGreaterThan(0);

    const dispersed = renderAsciiPlanetFrame(0.5, 0.0, 0.0);
    expect(dispersed[9]?.text).not.toBe(base[9]?.text);
  });
});
