import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_FIXTURES_DIR = path.resolve(__dirname, "../../contracts/fixtures/widget-a");
const CAD_GLB_PATH = path.resolve(__dirname, "../../cad/fixtures/widget-a.glb");
const BRIDGE_RESULTS_DIR = path.resolve(__dirname, "../../bridge/fixtures/widget-a-results");

const readJsonFixture = <T = unknown>(fileName: string): T =>
  JSON.parse(fs.readFileSync(path.join(CONTRACTS_FIXTURES_DIR, fileName), "utf-8")) as T;
const jsonRoute = (body: unknown, status = 200) => ({
  status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body),
});

interface MockTracker {
  imported: boolean;
  objectiveCalls: number;
  confirmCalls: number;
  lastConfirmBody: Record<string, unknown>;
}

async function registerCoreRoutes(page: Page): Promise<void> {
  const glbBytes = fs.readFileSync(CAD_GLB_PATH);
  const metricsV0 = readJsonFixture<{ values: Array<Record<string, unknown>> }>("metrics_v0.json");
  const simV0 = readJsonFixture<{ nodes: Array<Record<string, unknown>> }>("sim_v0.json");

  await page.route("**/api/runs", (r) => r.fulfill(jsonRoute(readJsonFixture("run.json"))));
  await page.route("**/api/runs/run-widget-a-001/events*", (r) => {
    const ev1 = {
      seq: 1, run_id: "run-widget-a-001", at: "2026-10-16T11:25:00Z", stage: "verify", part_id: "core-stage", level: "info",
      message: "Verified core-stage dissipation",
      data: { usage: { context_tokens: 12400, output_tokens: 2150, sources: 1, images: 0, model_calls: 2 }, thought_summary: "Cross-checking core-stage conductive coupling to storage-cell" },
    };
    return r.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify(ev1)}\n\n` });
  });
  await page.route("**/api/runs/run-widget-a-001/spec*", (r) => r.fulfill(jsonRoute(readJsonFixture("spec_v0.json"))));
  await page.route("**/api/runs/run-widget-a-001/graph*", (r) => r.fulfill(jsonRoute(readJsonFixture("graph_v0.json"))));
  await page.route("**/api/runs/run-widget-a-001/manifest*", (r) => r.fulfill(jsonRoute(readJsonFixture("manifest_v0.json"))));
  await page.route("**/api/runs/run-widget-a-001/metrics*", (r) => {
    const isRev1 = r.request().url().includes("rev=1");
    const v1Vals = metricsV0.values.map((m) => (m.metric_id === "peak_temp_C" ? { ...m, value: 56.2 } : m));
    return r.fulfill(jsonRoute(isRev1 ? { ...metricsV0, revision: 1, values: v1Vals } : metricsV0));
  });
  await page.route("**/api/runs/run-widget-a-001/sim*", (r) => {
    const isRev1 = r.request().url().includes("rev=1");
    const v1Nodes = simV0.nodes.map((n) => (n.part_id === "storage-cell" ? { ...n, peak_temp_C: 41.2, peak_rise_C: 16.2 } : n));
    return r.fulfill(jsonRoute(isRev1 ? { ...simV0, revision: 1, nodes: v1Nodes } : simV0));
  });
  await page.route("**/api/runs/run-widget-a-001/artifacts/*.glb", (r) =>
    r.fulfill({ status: 200, contentType: "model/gltf-binary", body: glbBytes }),
  );
}

async function registerLoopRoutes(page: Page, tracker: MockTracker): Promise<void> {
  const pass1 = {
    revision: 1, part_id: "core-stage", pass_no: 1, action: "Insert 2mm Al6061 spreader plate",
    prediction: { metric_id: "peak_temp_C", expected_direction: "down", expected_delta: -8, falsified_if: "peak_temp_C >= 68.4", registered_at: "2026-10-16T11:30:00Z" },
    metric_deltas: [{ metric_id: "peak_temp_C", before: 68.4, after: 56.2, delta: -12.2, unit: "C" }],
    verdict: "kept", outcome: "confirmed", suspicious: false, suspicious_reason: null, fitted_adjustment: false, at: "2026-10-16T11:31:00Z",
  };
  await page.route("**/api/runs/run-widget-a-001/presets*", (r) =>
    r.fulfill(jsonRoute([
      { preset_id: "thermal_margin", title: "Lower Peak Temp", rationale: "Reduce steady-state temperature on core-stage and storage-cell", source_ids: ["src-page-1"], targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }] },
      { preset_id: "unsafe_gap", title: "Shrink Gap (Unsafe)", rationale: "Test direction check warning", source_ids: [], targets: [{ metric_id: "min_gap_mm", comparator: "lte", threshold: 4.0, unit: "mm" }] },
    ])),
  );
  await page.route("**/api/runs/run-widget-a-001/loop*", (r) =>
    r.fulfill(jsonRoute([{ revision: 1, label: "V1", confirmed_count: 2, refuted_count: 0, badges: tracker.imported ? ["simulated", "sandbox-checked", "simulink-audited"] : ["simulated", "sandbox-checked"], wall_time_s: 14, context_tokens: 12400, ...(tracker.imported ? { audit: "match", max_abs_diff_C: 0.0 } : {}) }])),
  );
  await page.route("**/api/runs/run-widget-a-001/variants*", (r) =>
    r.fulfill(jsonRoute([
      { variant_id: "Alpha", revision: 1, summary: "2mm Al6061 spreader", weights: { thermal: 1 }, score: 0.91, primary: true },
      { variant_id: "Beta", revision: 1, summary: "4mm air gap", weights: { thermal: 0.8 }, score: 0.78, primary: false },
      { variant_id: "Gamma", revision: 1, summary: "1.5mm Cu shim", weights: { thermal: 0.85 }, score: 0.83, primary: false },
    ])),
  );
  await page.route("**/api/runs/run-widget-a-001/passes*", (r) => {
    const p1 = tracker.imported ? { ...pass1, external_outcome: "confirmed" } : pass1;
    const p2 = { ...p1, pass_no: 2, suspicious: true, suspicious_reason: "Step gain exceeds linear RC bound", fitted_adjustment: true };
    return r.fulfill(jsonRoute([p1, p2]));
  });
  await page.route("**/api/runs/run-widget-a-001/sandbox*", (r) => r.fulfill(jsonRoute({ revision: 1, agrees_with_metrics: true, notes: ["watertight"] })));
  await page.route("**/api/runs/run-widget-a-001/benchmarks*", (r) => r.fulfill(jsonRoute([{ input_key: "widget-a", runs: [] }])));
}

async function registerActionRoutes(page: Page, tracker: MockTracker): Promise<void> {
  const extSim = { run_id: "run-widget-a-001", revision: 1, tool: "simulink", bundle_sha256: "abc123", audit: "match", max_abs_diff_C: 0.0, nodes: [{ node_id: "node_storage-cell", part_id: "storage-cell", peak_temp_C: 41.2, peak_rise_C: 16.2, t_peak_s: 600 }], imported_at: "2026-10-16T12:00:00Z", source_id: "src-ext-1" };
  await page.route("**/api/runs/run-widget-a-001/objective", (r) => {
    tracker.objectiveCalls += 1;
    const req = JSON.parse(r.request().postData() ?? "{}") as { base_revision?: number; text?: string };
    return r.fulfill(jsonRoute({ text: req.text ?? "Reduce steady-state temperature", targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }], base_revision: req.base_revision ?? 0, objective_hash: `hash-widget-a-r${req.base_revision ?? 0}-${tracker.objectiveCalls}` }));
  });
  await page.route("**/api/runs/run-widget-a-001/objective/confirm", (r) => {
    tracker.confirmCalls += 1;
    tracker.lastConfirmBody = JSON.parse(r.request().postData() ?? "{}") as Record<string, unknown>;
    if (tracker.confirmCalls === 1) return r.fulfill(jsonRoute({}, 409));
    return r.fulfill(jsonRoute({ token: `tok-${tracker.confirmCalls}`, expires_at: "2026-10-16T13:00:00Z" }));
  });
  await page.route("**/api/runs/run-widget-a-001/revisions", (r) => r.fulfill(jsonRoute({ revision: 1, status: "V1_READY" })));
  await page.route("**/api/runs/run-widget-a-001/matlab-link*", (r) => r.fulfill(jsonRoute({ command: "eval(webread('https://stratum/api/b/tok-matlab/run.m'))", expires_at: "2026-10-16T12:45:00Z" })));
  await page.route("**/api/b/*/status", (r) => r.fulfill(jsonRoute({ status: tracker.imported ? "received" : "downloaded" })));
  await page.route("**/api/runs/run-widget-a-001/external-results", (r) => {
    tracker.imported = true;
    return r.fulfill(jsonRoute({ status: "EXTERNAL_RESULTS_IMPORTED", draft_objective: "Tighten storage-cell margin for V2", base_revision: 1, external_sim: extSim }));
  });
}

test("Title sequence non-overlap at 2.6/4.2/5.4s, Deep Verify OFF, and pre-GLB ReasoningStage", async ({ page }, testInfo) => {
  await page.route("**/api/runs", (r) => r.fulfill(jsonRoute({ ...readJsonFixture<Record<string, unknown>>("run.json"), status: "V0_RUNNING" })));
  await page.route("**/api/runs/run-widget-a-001/events*", (r) => {
    const evs = [
      { seq: 1, run_id: "run-widget-a-001", at: "2026-10-16T11:25:00Z", stage: "fetch", part_id: "core-stage", level: "info", message: "Grounding", data: { query: "Baltam Widget-A thermal resistance", url: "https://datasheets.example.com/widget-a.pdf", title: "Widget-A Thermal Datasheet", usage: { context_tokens: 18400, output_tokens: 1200, sources: 3, images: 1, model_calls: 2 } } },
      { seq: 2, run_id: "run-widget-a-001", at: "2026-10-16T11:25:10Z", stage: "v0", part_id: "storage-cell", level: "info", message: "Synthesizing 18650 cell envelope & 9mm gap", data: { silence_s: 24 } },
    ];
    return r.fulfill({ status: 200, contentType: "text/event-stream", body: evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
  });
  await page.route("**/api/runs/run-widget-a-001/**", (r) => {
    if (r.request().url().includes("/events")) return r.fallback();
    return r.fulfill(jsonRoute(null, 404));
  });

  await page.goto("/");
  await expect(page.getByTestId("deep-verify-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("product-url-input")).toHaveAttribute("placeholder", "Paste a product link");
  if (testInfo.project.name.startsWith("desktop")) {
    await page.waitForTimeout(2600);
    await page.screenshot({ path: "test-results/title-seq-2.6s.png" });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: "test-results/title-seq-4.2s.png" });
    await page.waitForTimeout(1200);
    const subBox = await page.getByTestId("hero-subline").boundingBox();
    const planetBox = await page.getByTestId("baltam-planet").boundingBox();
    expect((subBox?.y ?? 0) + (subBox?.height ?? 0)).toBeLessThanOrEqual((planetBox?.y ?? 999) + 2);
    await page.screenshot({ path: "test-results/title-seq-5.4s.png" });
  }
  await page.keyboard.press("Space");
  await page.getByTestId("product-url-input").fill("https://example.invalid/widget-a");
  await page.getByTestId("reconstruct-button").click();
  await expect(page.getByTestId("reasoning-stage")).toHaveAttribute("data-stage-state", "active");
  await expect(page.getByTestId("reasoning-stream")).toContainText("Searching: Baltam Widget-A thermal resistance");
  await expect(page.getByTestId("reasoning-high-thinking")).toContainText("Argon is reasoning (high thinking)…");
  if (testInfo.project.name.startsWith("desktop")) {
    await page.screenshot({ path: "test-results/reasoning-stage-running.png" });
  }
});

test("Connectivity tour, 60% strata explode, readable target direction, 1-click confirm, and MATLAB handoff panel", async ({ page }, testInfo) => {
  const tracker: MockTracker = { imported: false, objectiveCalls: 0, confirmCalls: 0, lastConfirmBody: {} };
  await registerCoreRoutes(page);
  await registerLoopRoutes(page, tracker);
  await registerActionRoutes(page, tracker);

  await page.goto("/");
  await page.keyboard.press("Space");
  await page.getByTestId("product-url-input").fill("https://example.invalid/widget-a");
  await page.getByTestId("reconstruct-button").click();
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-mapped-parts", "4");
  await expect(page.getByTestId("explode-percent")).toHaveText("60%");
  await expect(page.getByTestId("connectivity-tour-card")).toBeVisible();
  await expect(page.getByTestId("why-it-matters")).toBeVisible();
  await expect(page.getByTestId("preset-direction-warning-unsafe_gap")).toHaveText("direction check");
  if (testInfo.project.name.startsWith("desktop")) {
    await page.screenshot({ path: "test-results/connectivity-tour-v0.png" });
  }

  await page.getByTestId("preset-thermal_margin").click();
  await expect(page.getByTestId("confirm-targets-list")).toContainText("↓ safer");
  expect(tracker.objectiveCalls).toBe(1);
  expect(tracker.confirmCalls).toBe(0);
  if (testInfo.project.name.startsWith("desktop")) {
    await page.screenshot({ path: "test-results/confirm-direction-modal.png" });
  }
  await page.getByTestId("modal-confirm-button").click();
  await expect(page.getByTestId("modal-409-recovery")).toContainText("Confirm Objective");
  await page.getByTestId("modal-confirm-button").click();
  expect(tracker.lastConfirmBody).toEqual({ objective_hash: "hash-widget-a-r0-1", base_revision: 0 });
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-glb-rev", "1");

  await page.getByTestId("run-matlab-online-button").click();
  await expect(page.getByTestId("matlab-handoff-panel")).toBeVisible();
  await expect(page.getByTestId("matlab-command-text")).toContainText("tok-matlab");
  if (testInfo.project.name.startsWith("desktop")) {
    await page.screenshot({ path: "test-results/matlab-handoff-panel.png" });
  }

  await page.getByTestId("import-results-toggle").click();
  await page.getByTestId("external-results-file-input").setInputFiles([
    path.join(BRIDGE_RESULTS_DIR, "results.csv"),
    path.join(BRIDGE_RESULTS_DIR, "audit.txt"),
    path.join(BRIDGE_RESULTS_DIR, "stratum_results_manifest.txt"),
  ]);
  await expect(page.getByTestId("matlab-live-status")).toContainText("Results received ✓ AUDIT MATCH");
  await expect(page.getByTestId("audit-badge")).toContainText("AUDIT MATCH · max ΔT 0.0°C");
  await page.screenshot({ path: `test-results/g3-ui-${testInfo.project.name}.png` });
});
