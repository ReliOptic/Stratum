import { describe, expect, it } from "vitest";
import type { CadManifest, ObjectiveConfirmation } from "@/lib/contracts";
import {
  canTriggerRevision,
  computeExplodedPosition,
  confirmObjectiveDraft,
  createObjectiveDraftState,
  getAvailableRevisions,
  mapManifestToPartByNode,
  updateObjectiveDraft,
  validateExternalResultsUpload,
} from "@/lib/state";

describe("objective/token state machine", () => {
  it("starts disabled without confirmation token and tracks base revision", () => {
    const initial = createObjectiveDraftState(0);
    expect(initial.baseRevision).toBe(0);
    expect(canTriggerRevision(initial, 3)).toBe(false);
  });

  it("enables revision after confirm and clears token upon subsequent edit", () => {
    const draft = updateObjectiveDraft(
      createObjectiveDraftState(0),
      "Reduce thermal resistance on widget-a spreader",
      "preset-thermal",
    );
    expect(canTriggerRevision(draft, 3)).toBe(false);

    const confirmation: ObjectiveConfirmation = {
      confirm_token: "tok-widget-a-v1",
      base_revision: 0,
      normalized_targets: ["max_temp_c <= 55"],
      objective_text: "Reduce thermal resistance on widget-a spreader",
    };
    const confirmed = confirmObjectiveDraft(draft, confirmation);
    expect(canTriggerRevision(confirmed, 3)).toBe(true);
    expect(confirmed.normalizedTargets).toEqual(["max_temp_c <= 55"]);

    const edited = updateObjectiveDraft(confirmed, "Edited objective text");
    expect(edited.confirmToken).toBeNull();
    expect(canTriggerRevision(edited, 3)).toBe(false);
  });

  it("blocks revision when baseRevision reaches maxRevision", () => {
    const confirmed = confirmObjectiveDraft(createObjectiveDraftState(3), {
      confirm_token: "tok-widget-a-v3",
      base_revision: 3,
      normalized_targets: ["target"],
      objective_text: "Improve widget-a",
    });
    expect(canTriggerRevision(confirmed, 3)).toBe(false);
  });
});

describe("manifest to node mapping and exploded position", () => {
  const widgetAManifest: CadManifest = {
    revision: 0,
    glb_url: "/api/runs/widget-a/artifacts/0.glb",
    nodes: [
      {
        node_name: "mesh_core_0",
        part_id: "part_heat_01",
        role: "heat_source",
        center: [0, 0, 0],
        explode_vector: [0, 1.5, 0],
      },
      {
        node_name: "mesh_shell_0",
        part_id: "part_enc_01",
        role: "enclosure",
        center: [0, 0.5, 0],
        explode_vector: [0, 2.0, 0],
      },
    ],
  };

  it("maps manifest node_name keys to ManifestNode records", () => {
    const mapped = mapManifestToPartByNode(widgetAManifest);
    expect(mapped.mesh_core_0?.part_id).toBe("part_heat_01");
    expect(mapped.mesh_shell_0?.role).toBe("enclosure");
    expect(mapManifestToPartByNode(null)).toEqual({});
  });

  it("computes clamped exploded coordinates", () => {
    const node = widgetAManifest.nodes[0];
    expect(computeExplodedPosition(node, 0.5)).toEqual([0, 0.75, 0]);
    expect(computeExplodedPosition(node, 2.0)).toEqual([0, 1.5, 0]);
  });
});

describe("revision tab logic", () => {
  it("lists only existing integer design revisions up to maxRevision", () => {
    expect(getAvailableRevisions(0, 3)).toEqual([{ revision: 0, label: "V0" }]);
    expect(getAvailableRevisions(2, 3)).toEqual([
      { revision: 0, label: "V0" },
      { revision: 1, label: "V1" },
      { revision: 2, label: "V2" },
    ]);
  });
});

describe("external-results upload validation", () => {
  it("validates Simulink bundle files", () => {
    const bad = validateExternalResultsUpload("simulink", ["results.csv"]);
    expect(bad.valid).toBe(false);

    const good = validateExternalResultsUpload("simulink", [
      "results.csv",
      "audit.txt",
      "stratum_results_manifest.txt",
    ]);
    expect(good.valid).toBe(true);
  });

  it("validates Lab measurement files", () => {
    expect(validateExternalResultsUpload("lab", ["notes.txt"]).valid).toBe(false);
    expect(validateExternalResultsUpload("lab", ["measurement.csv"]).valid).toBe(true);
  });
});
