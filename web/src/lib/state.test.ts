import { describe, expect, it } from "vitest";
import type { ConfirmResponse, Manifest, Objective } from "@/lib/contracts";
import {
  canTriggerRevision,
  computeExplodedPosition,
  computePartCenterMm,
  computePartSizeMm,
  confirmObjectiveDraft,
  createObjectiveDraftState,
  formatTargetSummary,
  getAvailableRevisions,
  mapManifestToPartByNode,
  updateObjectiveDraft,
  validateExternalResultsUpload,
} from "@/lib/state";

describe("objective/token state machine", () => {
  it("disables revision until confirmed, stores token and base_revision, and clears token on edit", () => {
    const initial = createObjectiveDraftState(0);
    expect(canTriggerRevision(initial, 3)).toBe(false);

    const edited = updateObjectiveDraft(initial, "Reduce peak thermal load on heat_source", "preset-1");
    expect(canTriggerRevision(edited, 3)).toBe(false);

    const objective: Objective = {
      text: "Reduce peak thermal load on heat_source",
      targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 52, unit: "C" }],
      base_revision: 1,
      objective_hash: "hash-widget-a-01",
    };
    const confirmation: ConfirmResponse = {
      token: "tok_widget_a_001",
      expires_at: "2026-10-16T12:30:00Z",
    };
    const confirmed = confirmObjectiveDraft(edited, objective, confirmation);
    expect(confirmed.baseRevision).toBe(1);
    expect(confirmed.confirmToken).toBe("tok_widget_a_001");
    expect(formatTargetSummary(confirmed.targets[0]!)).toBe("peak_temp_C <= 52 C");
    expect(canTriggerRevision(confirmed, 3)).toBe(true);
    expect(canTriggerRevision(confirmed, 1)).toBe(false);

    const reEdited = updateObjectiveDraft(confirmed, "Modified objective text");
    expect(reEdited.confirmToken).toBeNull();
    expect(canTriggerRevision(reEdited, 3)).toBe(false);
  });
});

describe("manifest to node mapping and exploded position", () => {
  const sampleManifest: Manifest = {
    run_id: "run-widget-a-001",
    revision: 0,
    parts: [
      {
        part_id: "outer-shell",
        glb_node: "part_outer-shell",
        bbox_mm: [-40, -25, -10, 40, 25, 10],
        volume_mm3: 19360,
      },
      {
        part_id: "core-stage",
        glb_node: "part_core-stage",
        bbox_mm: [-24, -10, -4, 0, 10, 0],
        volume_mm3: 1920,
      },
    ],
    checks: [{ check_id: "non_empty_volume", passed: true, detail: "Positive volume" }],
  };

  it("maps glb_node to ManifestPart and handles null manifest", () => {
    expect(mapManifestToPartByNode(null)).toEqual({});
    const mapped = mapManifestToPartByNode(sampleManifest);
    expect(mapped["part_outer-shell"]?.part_id).toBe("outer-shell");
    expect(mapped["part_core-stage"]?.volume_mm3).toBe(1920);
  });

  it("computes center, size, and exploded position from bbox_mm", () => {
    const core = sampleManifest.parts[1]!;
    expect(computePartCenterMm(core)).toEqual([-12, 0, -2]);
    expect(computePartSizeMm(core)).toEqual([24, 20, 4]);
    expect(computeExplodedPosition(core, 0)).toEqual([-12, 0, -2]);
    const exploded = computeExplodedPosition(core, 1);
    expect(exploded[0]).toBeLessThan(-12);
  });
});

describe("revision tab logic", () => {
  it("returns only existing revisions up to maxRevision", () => {
    expect(getAvailableRevisions(0, 3)).toEqual([{ revision: 0, label: "V0" }]);
    expect(getAvailableRevisions(2, 3)).toEqual([
      { revision: 0, label: "V0" },
      { revision: 1, label: "V1" },
      { revision: 2, label: "V2" },
    ]);
  });
});

describe("external-results upload validation", () => {
  it("validates simulink bundle files and rejects incomplete uploads", () => {
    expect(
      validateExternalResultsUpload("simulink", [
        "results.csv",
        "audit.txt",
        "stratum_results_manifest.txt",
      ]).valid,
    ).toBe(true);
    const bad = validateExternalResultsUpload("simulink", ["results.csv"]);
    expect(bad.valid).toBe(false);
  });

  it("validates lab measurement uploads", () => {
    expect(validateExternalResultsUpload("lab", ["measurement.csv"]).valid).toBe(true);
    expect(validateExternalResultsUpload("lab", ["notes.txt"]).valid).toBe(false);
  });
});
