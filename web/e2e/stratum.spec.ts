import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_FIXTURES_DIR = path.resolve(__dirname, "../../contracts/fixtures/widget-a");
const CAD_GLB_PATH = path.resolve(__dirname, "../../cad/fixtures/widget-a.glb");

const readJsonFixture = (fileName: string): string =>
  fs.readFileSync(path.join(CONTRACTS_FIXTURES_DIR, fileName), "utf-8");

const jsonRoute = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function registerWidgetARoutes(page: Page, getImported: () => boolean): Promise<void> {
  const runJson = readJsonFixture("run.json");
  const specV0 = readJsonFixture("spec_v0.json");
  const graphV0 = readJsonFixture("graph_v0.json");
  const manifestV0 = readJsonFixture("manifest_v0.json");
  const metricsV0 = readJsonFixture("metrics_v0.json");
  const simV0 = readJsonFixture("sim_v0.json");
  const glbBytes = fs.readFileSync(CAD_GLB_PATH);

  await page.route("**/api/runs", (r) => r.fulfill(jsonRoute(runJson)));
  await page.route("**/api/runs/run-widget-a-001/events*", (r) => {
    const ev1 = {
      seq: 1,
      run_id: "run-widget-a-001",
      at: "2026-10-16T11:25:00Z",
      stage: "verify",
      part_id: "core-stage",
      level: "info",
      message: "Verified core-stage dissipation",
      data: {
        usage: { context_tokens: 12400, output_tokens: 2150, sources: 1, images: 0, model_calls: 2 },
        thought_summary: "Cross-checking core-stage conductive coupling to storage-cell",
      },
    };
    const ev2 = {
      seq: 2,
      run_id: "run-widget-a-001",
      at: "2026-10-16T11:25:01Z",
      stage: "cad",
      level: "info",
      message: "Compiled V0 geometry and RC network",
      data: {},
    };
    return r.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(ev1)}\n\ndata: ${JSON.stringify(ev2)}\n\n`,
    });
  });
  await page.route("**/api/runs/run-widget-a-001/spec*", (r) => r.fulfill(jsonRoute(specV0)));
  await page.route("**/api/runs/run-widget-a-001/graph*", (r) => r.fulfill(jsonRoute(graphV0)));
  await page.route("**/api/runs/run-widget-a-001/manifest*", (r) => r.fulfill(jsonRoute(manifestV0)));
  await page.route("**/api/runs/run-widget-a-001/metrics*", (r) => r.fulfill(jsonRoute(metricsV0)));
  await page.route("**/api/runs/run-widget-a-001/sim*", (r) => r.fulfill(jsonRoute(simV0)));
  await page.route("**/api/runs/run-widget-a-001/artifacts/*.glb", (r) =>
    r.fulfill({ status: 200, contentType: "model/gltf-binary", body: glbBytes }),
  );
  await page.route("**/api/runs/run-widget-a-001/presets*", (r) =>
    r.fulfill(
      jsonRoute([
        {
          preset_id: "thermal_margin",
          title: "Lower Peak Temp",
          rationale: "Reduce steady-state temperature on core-stage and storage-cell",
          source_ids: ["src-page-1"],
          targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }],
        },
      ]),
    ),
  );
  await page.route("**/api/runs/run-widget-a-001/loop*", (r) => {
    const imported = getImported();
    return r.fulfill(
      jsonRoute([
        {
          revision: 1,
          label: "V1",
          confirmed_count: 2,
          refuted_count: 0,
          badges: imported ? ["simulated", "simulink-audited"] : ["simulated"],
          wall_time_s: 14,
          context_tokens: 12400,
          ...(imported ? { audit: "match", max_abs_diff_C: 0.7 } : {}),
        },
      ]),
    );
  });
  for (const sub of ["variants", "passes", "benchmarks"]) {
    await page.route(`**/api/runs/run-widget-a-001/${sub}*`, (r) => r.fulfill(jsonRoute([])));
  }
  await page.route("**/api/runs/run-widget-a-001/sandbox*", (r) => r.fulfill(jsonRoute(null)));
}

test("G2-UI steps 1-6: 3-file cap, GLB by rev, explode, x-ray ghosts, causal splines, 409 confirm guard", async ({
  page,
}, testInfo) => {
  let imported = false;
  await registerWidgetARoutes(page, () => imported);
  await page.route("**/api/runs/run-widget-a-001/external-results", (r) => {
    imported = true;
    return r.fulfill(
      jsonRoute({
        status: "EXTERNAL_RESULTS_IMPORTED",
        draft_objective: "Refine widget-a V2 thermal margin",
        base_revision: 1,
      }),
    );
  });

  await page.goto("/");
  await expect(page.getByTestId("onboarding-header")).toHaveAttribute("data-docked", "false");
  await expect(page.getByTestId("attachment-button")).toContainText("Attach (0/3)");
  await page.getByTestId("attachment-file-input").setInputFiles([
    { name: "1.png", mimeType: "image/png", buffer: Buffer.from("1") },
    { name: "2.png", mimeType: "image/png", buffer: Buffer.from("2") },
    { name: "3.png", mimeType: "image/png", buffer: Buffer.from("3") },
    { name: "4.png", mimeType: "image/png", buffer: Buffer.from("4") },
  ]);
  await expect(page.getByTestId("attachment-button")).toContainText("Attach (3/3)");
  await expect(page.getByTestId("attachment-validation-note")).toContainText("Attachment limit is 3 files");

  await page.getByTestId("product-url-input").fill("https://example.invalid/widget-a");
  await page.getByTestId("reconstruct-button").click();

  await expect(page.getByTestId("onboarding-header")).toHaveAttribute("data-docked", "true");
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-glb-rev", "0");
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-mapped-parts", "4");

  await page.getByTestId("viewport-node-core-stage").click();
  await expect(page.getByTestId("viewport-node-core-stage")).toHaveAttribute("data-visual-state", "active-amber");
  await expect(page.getByTestId("viewport-node-outer-shell")).toHaveAttribute("data-visual-state", "xray-ghost-15");
  await expect(page.getByTestId("evidence-ledger")).toContainText("Core Stage (core-stage)");

  await page.getByTestId("rail-part-storage-cell").click();
  await page.getByTestId("param-row-clearance_to_heat_source").click();
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-active-part", "storage-cell");

  await page.getByTestId("explode-slider").fill("0.5");
  await expect(page.getByTestId("explode-percent")).toHaveText("50%");

  await page.getByTestId("causal-spline-core-stage-storage-cell").click();
  await expect(page.getByTestId("spline-tooltip")).toContainText(
    "Conductive and radiative heat transfer across internal gap",
  );
  await expect(page.getByTestId("spline-tooltip")).toContainText("src-page-1");

  await page.route("**/api/runs/run-widget-a-001/objective", (r) =>
    r.fulfill(
      jsonRoute({
        text: "Reduce steady-state temperature on core-stage and storage-cell",
        targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }],
        base_revision: 0,
        objective_hash: "hash-widget-a-001",
      }),
    ),
  );
  await page.route("**/api/runs/run-widget-a-001/objective/confirm", (r) => r.fulfill(jsonRoute({}, 409)));

  await page.getByTestId("preset-thermal_margin").click();
  await expect(page.getByTestId("objective-confirm-modal")).toBeVisible();
  await expect(page.getByTestId("confirm-targets-list")).toContainText("peak_temp_C <= 58 C");
  await page.getByTestId("modal-confirm-button").click();
  await expect(page.getByTestId("deck-error-banner")).toContainText("409");
  await expect(page.getByTestId("modal-409-recovery")).toContainText("Click Confirm Objective");
  await expect(page.getByTestId("revise-button")).toBeDisabled();

  await page.unroute("**/api/runs/run-widget-a-001/objective/confirm");
  await page.route("**/api/runs/run-widget-a-001/objective/confirm", (r) =>
    r.fulfill(jsonRoute({ token: "tok-widget-a-1", expires_at: "2026-10-16T13:00:00Z" })),
  );
  await page.route("**/api/runs/run-widget-a-001/revisions", (r) =>
    r.fulfill(jsonRoute({ revision: 1, status: "V1_READY" })),
  );

  await page.getByTestId("modal-confirm-button").click();
  await expect(page.getByTestId("run-status-badge")).toHaveText("OBJECTIVE_CONFIRMED");
  await page.getByTestId("modal-close-button").click();
  await expect(page.getByTestId("revise-button")).toBeEnabled();
  await page.getByTestId("revise-button").click();
  await expect(page.getByTestId("viewport-3d")).toHaveAttribute("data-glb-rev", "1");

  await page.getByTestId("import-results-toggle").click();
  await page.getByTestId("external-results-file-input").setInputFiles([
    { name: "results.csv", mimeType: "text/csv", buffer: Buffer.from("t,T\n0,25\n") },
    { name: "audit.txt", mimeType: "text/plain", buffer: Buffer.from("MATCH\n") },
    { name: "stratum_results_manifest.txt", mimeType: "text/plain", buffer: Buffer.from("rev=1\n") },
  ]);

  await expect(page.getByTestId("audit-badge")).toContainText("AUDIT MATCH");
  await page.screenshot({ path: `test-results/g2-ui-${testInfo.project.name}.png` });
});
