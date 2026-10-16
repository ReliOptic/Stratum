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
    r.fulfill(jsonRoute([{ preset_id: "thermal_margin", title: "Lower Peak Temp", rationale: "Reduce steady-state temperature on core-stage and storage-cell", source_ids: ["src-page-1"], targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }] }])),
  );
  await page.route("**/api/runs/run-widget-a-001/loop*", (r) =>
    r.fulfill(jsonRoute([{ revision: 1, label: "V1", confirmed_count: 2, refuted_count: 0, badges: tracker.imported ? ["simulated", "sandbox-checked", "simulink-audited"] : ["simulated", "sandbox-checked"], wall_time_s: 14, context_tokens: 12400, ...(tracker.imported ? { audit: "match", max_abs_diff_C: 0.0 } : {}) }])),
  );
  await page.route("**/api/runs/run-widget-a-001/variants*", (r) =>
    r.fulfill(
      jsonRoute([
        { variant_id: "Alpha", revision: 1, summary: "2mm Al6061 spreader", weights: { thermal: 1 }, score: 0.91, primary: true },
        { variant_id: "Beta", revision: 1, summary: "4mm air gap", weights: { thermal: 0.8 }, score: 0.78, primary: false },
        { variant_id: "Gamma", revision: 1, summary: "1.5mm Cu shim", weights: { thermal: 0.85 }, score: 0.83, primary: false },
      ]),
    ),
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
  await page.route("**/api/runs/run-widget-a-001/matlab-link*", (r) => r.fulfill(jsonRoute({ command: "stratum_Bridge_V0_V1", expires_at: "2026-10-16T12:45:00Z" })));
  await page.route("**/api/runs/run-widget-a-001/external-results", (r) => {
    tracker.imported = true;
    return r.fulfill(jsonRoute({ status: "EXTERNAL_RESULTS_IMPORTED", draft_objective: "Tighten storage-cell margin for V2", base_revision: 1, external_sim: extSim }));
  });
}

test("Director's Brief: H1 thesis text, 6.4s title sequence frames, reduced motion, and keypress skip", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Can Gemini 4 Argon make the physical world safer?");
  if (testInfo.project.name.startsWith("desktop")) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: "test-results/title-seq-0.8s.png" });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: "test-results/title-seq-2.6s.png" });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: "test-results/title-seq-4.2s.png" });
    await page.waitForTimeout(2800);
    await expect(page.getByTestId("hero-title-sequence")).toHaveAttribute("data-sequence-state", "docked");
    await page.screenshot({ path: "test-results/title-seq-7.0s-docked.png" });

    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload();
    await expect(page.getByTestId("hero-title-sequence")).toHaveAttribute("data-sequence-state", "playing");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("hero-title-sequence")).toHaveAttribute("data-sequence-state", "docked");
    await page.screenshot({ path: "test-results/title-seq-skip.png" });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload();
    await expect(page.getByTestId("hero-title-sequence")).toHaveAttribute("data-sequence-state", "docked");
    await page.screenshot({ path: "test-results/title-seq-reduced-motion.png" });
  } else {
    await page.keyboard.press("Space");
    await expect(page.getByTestId("hero-title-sequence")).toHaveAttribute("data-sequence-state", "docked");
  }
});

test("G3-UI closed loop: 2-step objective review/confirm, matrix, temp chart, MATLAB link, external import -> V2", async ({ page }, testInfo) => {
  const tracker: MockTracker = { imported: false, objectiveCalls: 0, confirmCalls: 0, lastConfirmBody: {} };
  await registerCoreRoutes(page);
  await registerLoopRoutes(page, tracker);
  await registerActionRoutes(page, tracker);

  await page.goto("/");
  await expect(page.getByTestId("hero-title-sequence")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("hero-title-sequence")).toHaveAttribute("data-sequence-state", "docked");
  await expect(page.getByTestId("baltam-planet")).toHaveAttribute("data-fps-target", "60");
  await page.getByTestId("product-url-input").fill("https://example.invalid/widget-a");
  await page.getByTestId("reconstruct-button").click();
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-mapped-parts", "4");

  await page.getByTestId("preset-thermal_margin").click();
  await expect(page.getByTestId("confirm-targets-list")).toContainText("peak_temp_C (lte / <=) 58 C [base V0]");
  expect(tracker.objectiveCalls).toBe(1);
  expect(tracker.confirmCalls).toBe(0);
  await page.getByTestId("modal-close-button").click();
  await page.getByTestId("objective-input").fill("Edited objective requiring fresh review");
  await expect(page.getByTestId("control-deck")).toHaveAttribute("data-objective-hash", "none");
  await page.getByTestId("open-confirm-modal-button").click();
  await expect(page.getByTestId("objective-confirm-modal")).toHaveAttribute("data-objective-hash", "hash-widget-a-r0-2");
  expect(tracker.confirmCalls).toBe(0);
  await page.getByTestId("modal-confirm-button").click();
  await expect(page.getByTestId("modal-409-recovery")).toContainText("Confirm Objective");
  await page.getByTestId("modal-confirm-button").click();
  expect(tracker.lastConfirmBody).toEqual({ objective_hash: "hash-widget-a-r0-2", base_revision: 0 });
  expect("confirmed_by_user" in tracker.lastConfirmBody).toBe(false);

  await page.getByTestId("modal-close-button").click();
  await page.getByTestId("revise-button").click();
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-glb-rev", "1");
  await expect(page.getByTestId("variant-card-Alpha")).toHaveAttribute("data-primary", "true");
  await expect(page.getByTestId("variant-card-Beta")).toBeVisible();
  await expect(page.getByTestId("variant-card-Gamma")).toBeVisible();
  await expect(page.getByTestId("pass-cell-core-stage-1")).toHaveAttribute("data-outcome-source", "sim");
  await expect(page.getByTestId("pass-cell-core-stage-2")).toHaveAttribute("data-suspicious", "true");
  await expect(page.getByTestId("target-status-peak_temp_C")).toContainText("MET");
  await page.getByTestId("run-matlab-online-button").click();
  await expect(page.getByTestId("matlab-waiting-badge")).toHaveAttribute("data-expires-at", "2026-10-16T12:45:00Z");

  await page.getByTestId("import-results-toggle").click();
  await page.getByTestId("external-results-file-input").setInputFiles([
    path.join(BRIDGE_RESULTS_DIR, "results.csv"),
    path.join(BRIDGE_RESULTS_DIR, "audit.txt"),
    path.join(BRIDGE_RESULTS_DIR, "stratum_results_manifest.txt"),
  ]);
  await expect(page.getByTestId("audit-badge")).toContainText("AUDIT MATCH · max ΔT 0.0°C");
  await expect(page.getByTestId("pass-cell-core-stage-1")).toHaveAttribute("data-outcome-source", "external");
  await expect(page.getByTestId("sim-line-external")).toBeVisible();
  await page.getByTestId("start-next-round-button").click();
  await expect(page.getByTestId("confirm-targets-list")).toContainText("[base V1]");
  expect(tracker.confirmCalls).toBe(2);
  await page.getByTestId("modal-confirm-button").click();
  await page.getByTestId("modal-close-button").click();
  await expect(page.getByTestId("revise-button")).toContainText("Revise (V1 → V2)");
  await page.screenshot({ path: `test-results/g3-ui-${testInfo.project.name}.png` });
});
