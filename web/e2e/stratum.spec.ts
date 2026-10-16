import { expect, type Page, test } from "@playwright/test";

const jsonRoute = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function registerWidgetARoutes(page: Page, getImported: () => boolean): Promise<void> {
  await page.route("**/api/runs", (r) =>
    r.fulfill(jsonRoute({ run_id: "widget-a", status: "V0_READY", revision: 0 })),
  );
  await page.route("**/api/runs/widget-a/events*", (r) => {
    const u = {
      seq: 1,
      type: "usage",
      usage: { context_tokens: 64200, sources_count: 5, images_count: 2, model_calls: 3 },
      timestamp: "2026-10-16T11:25:00Z",
    };
    const s = { seq: 2, type: "stage", stage: "geometry_physics", timestamp: "2026-10-16T11:25:01Z" };
    return r.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(u)}\n\ndata: ${JSON.stringify(s)}\n\n`,
    });
  });
  await page.route("**/api/runs/widget-a/graph*", (r) =>
    r.fulfill(
      jsonRoute({
        revision: 0,
        parts: [
          {
            part_id: "part_heat_01",
            name: "Primary Core",
            role: "heat_source",
            parameters: [
              {
                key: "power_w",
                label: "Dissipation",
                value: 18.5,
                unit: "W",
                status: "DOCUMENTED",
                basis_type: "source",
                source_ids: ["src-01"],
              },
            ],
          },
        ],
        edges: [
          {
            edge_id: "edge_01",
            from_part_id: "part_heat_01",
            to_part_id: "part_spreader_01",
            kind: "thermal",
            mechanism: "Conduction across interface",
            source_ids: ["src-01"],
          },
        ],
        sources: [{ source_id: "src-01", title: "Spec Sheet" }],
      }),
    ),
  );
  await page.route("**/api/runs/widget-a/manifest*", (r) =>
    r.fulfill(
      jsonRoute({
        revision: 0,
        glb_url: "/api/runs/widget-a/artifacts/0.glb",
        nodes: [
          {
            node_name: "node_heat",
            part_id: "part_heat_01",
            role: "heat_source",
            center: [0, 0, 0],
            explode_vector: [0, 1, 0],
          },
        ],
      }),
    ),
  );
  await page.route("**/api/runs/widget-a/presets*", (r) =>
    r.fulfill(
      jsonRoute([
        {
          preset_id: "thermal_margin",
          label: "Lower Peak Temp",
          description: "Reduce steady-state temperature by 8C",
          target_summary: "T_max <= 52C",
        },
      ]),
    ),
  );
  await page.route("**/api/runs/widget-a/loop*", (r) => {
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
          context_tokens: 64200,
          ...(imported ? { audit_match: true, max_delta_t_c: 0.7 } : {}),
        },
      ]),
    );
  });
  for (const sub of ["variants", "passes", "metrics", "sim", "benchmarks"]) {
    await page.route(`**/api/runs/widget-a/${sub}*`, (r) => r.fulfill(jsonRoute([])));
  }
  await page.route("**/api/runs/widget-a/sandbox*", (r) => r.fulfill(jsonRoute(null)));
}

test("onboarding dock, revise disabled before confirm, 409 path, and import audit badge", async ({
  page,
}, testInfo) => {
  let imported = false;
  await registerWidgetARoutes(page, () => imported);
  await page.route("**/api/runs/widget-a/external-results", (r) => {
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
  await expect(page.getByTestId("thesis-line")).toContainText(
    "Can Gemini 4 Argon make the physical world safer?",
  );

  await page.getByTestId("product-url-input").fill("https://example.invalid/widget-a");
  await page.getByTestId("reconstruct-button").click();
  await expect(page.getByTestId("onboarding-header")).toHaveAttribute("data-docked", "true");
  await expect(page.getByTestId("revise-button")).toBeDisabled();

  await page.route("**/api/runs/widget-a/objective", (r) => r.fulfill(jsonRoute({})));
  await page.route("**/api/runs/widget-a/objective/confirm", (r) => r.fulfill(jsonRoute({}, 409)));

  await page.getByTestId("objective-input").fill("Reduce widget-a peak temperature");
  await page.getByTestId("open-confirm-modal-button").click();
  await expect(page.getByTestId("deck-error-banner")).toContainText("409");
  await page.getByRole("button", { name: "Close" }).click();

  await page.unroute("**/api/runs/widget-a/objective/confirm");
  await page.route("**/api/runs/widget-a/objective/confirm", (r) =>
    r.fulfill(
      jsonRoute({
        confirm_token: "tok-widget-a-1",
        base_revision: 0,
        normalized_targets: ["T_max <= 52C"],
        objective_text: "Reduce widget-a peak temperature",
      }),
    ),
  );
  await page.route("**/api/runs/widget-a/revisions", (r) =>
    r.fulfill(jsonRoute({ revision: 1, status: "V1_READY" })),
  );

  await page.getByTestId("open-confirm-modal-button").click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("revise-button")).toBeEnabled();
  await page.getByTestId("revise-button").click();

  await page.getByTestId("import-results-toggle").click();
  await page.getByTestId("external-results-file-input").setInputFiles([
    { name: "results.csv", mimeType: "text/csv", buffer: Buffer.from("t,T\n0,25\n") },
    { name: "audit.txt", mimeType: "text/plain", buffer: Buffer.from("MATCH\n") },
    { name: "stratum_results_manifest.txt", mimeType: "text/plain", buffer: Buffer.from("rev=1\n") },
  ]);

  await expect(page.getByTestId("audit-badge")).toContainText("AUDIT MATCH");
  await page.screenshot({ path: `test-results/closed-loop-${testInfo.project.name}.png` });
});
