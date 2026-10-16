import { describe, expect, it } from "vitest";
import type { Manifest, Preset } from "@/lib/contracts";
import {
  canTriggerRevision,
  computeAssemblyCentroidMm,
  computeExplodedPosition,
  computePartCenterMm,
  computePartSizeMm,
  confirmObjectiveDraft,
  createObjectiveDraftState,
  formatTargetSummary,
  getAvailableRevisions,
  mapManifestToPartByNode,
  parseGlbNodeNames,
  selectPresetDraft,
  updateObjectiveDraft,
  validateAttachments,
  validateExternalResultsUpload,
} from "@/lib/state";

function makeMinimalGlbBuffer(nodeNames: readonly string[]): ArrayBuffer {
  const jsonStr = JSON.stringify({ asset: { version: "2.0" }, nodes: nodeNames.map((name) => ({ name })) });
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const paddedLen = Math.ceil(jsonBytes.byteLength / 4) * 4;
  const totalLen = 20 + paddedLen;
  const buf = new ArrayBuffer(totalLen);
  const view = new DataView(buf);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLen, true);
  view.setUint32(12, paddedLen, true);
  view.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(buf, 20, paddedLen);
  bytes.fill(0x20);
  bytes.set(jsonBytes);
  return buf;
}

describe("Objective confirmation state guard", () => {
  it("blocks revision until objective is confirmed with a valid token and OBJECTIVE_CONFIRMED status", () => {
    const initial = createObjectiveDraftState(0);
    expect(canTriggerRevision(initial)).toBe(false);

    const preset: Preset = {
      preset_id: "p1",
      title: "Lower Peak Temp",
      rationale: "Reduce peak temperature",
      source_ids: ["src-page-1"],
      targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }],
    };
    const presetDraft = selectPresetDraft(initial, preset);
    expect(presetDraft.selectedPresetId).toBe("p1");
    expect(presetDraft.targets.length).toBe(1);
    expect(canTriggerRevision(presetDraft, 3, "PRESETS_READY")).toBe(false);

    const confirmed = confirmObjectiveDraft(
      presetDraft,
      {
        text: "Reduce peak temperature",
        targets: preset.targets,
        base_revision: 0,
        objective_hash: "hash-001",
      },
      { token: "tok-001", expires_at: "2026-10-16T13:00:00Z" },
    );
    expect(canTriggerRevision(confirmed, 3, "PRESETS_READY")).toBe(false);
    expect(canTriggerRevision(confirmed, 3, "OBJECTIVE_CONFIRMED")).toBe(true);
    expect(formatTargetSummary(confirmed.targets[0]!)).toBe("peak_temp_C <= 58 C");

    const editedAgain = updateObjectiveDraft(confirmed, "Modified text");
    expect(canTriggerRevision(editedAgain, 3, "OBJECTIVE_CONFIRMED")).toBe(false);
  });

  it("caps revision tabs at maxRevision", () => {
    const tabs = getAvailableRevisions(5, 3);
    expect(tabs.map((t) => t.label)).toEqual(["V0", "V1", "V2", "V3"]);
  });
});

describe("Manifest, GLB node parser, and exploded view math", () => {
  const sampleManifest: Manifest = {
    run_id: "run-widget-a-001",
    revision: 0,
    parts: [
      { part_id: "outer-shell", glb_node: "part_outer-shell", bbox_mm: [-40, -25, -10, 40, 25, 10], volume_mm3: 19360 },
      { part_id: "core-stage", glb_node: "part_core-stage", bbox_mm: [-24, -10, -4, 0, 10, 0], volume_mm3: 1920 },
    ],
    checks: [],
  };

  it("maps glb_node to ManifestPart, parses GLB node names, and computes exploded offsets from centroid", () => {
    const map = mapManifestToPartByNode(sampleManifest);
    expect(map["part_core-stage"]?.part_id).toBe("core-stage");
    expect(computePartCenterMm(sampleManifest.parts[1]!)).toEqual([-12, 0, -2]);
    expect(computePartSizeMm(sampleManifest.parts[1]!)).toEqual([24, 20, 4]);

    const centroid = computeAssemblyCentroidMm(sampleManifest.parts);
    expect(centroid).toEqual([-6, 0, -1]);

    const unexploded = computeExplodedPosition(sampleManifest.parts[1]!, 0, centroid);
    const exploded = computeExplodedPosition(sampleManifest.parts[1]!, 1, centroid);
    expect(unexploded).toEqual([-12, 0, -2]);
    expect(exploded[0]).toBeLessThan(-12);

    const glbBuf = makeMinimalGlbBuffer(["part_outer-shell", "part_core-stage"]);
    expect(parseGlbNodeNames(glbBuf)).toEqual(["part_outer-shell", "part_core-stage"]);
  });
});

describe("Attachment (<= 3) and external results validation", () => {
  it("caps attachments at 3 files and returns a validation error when exceeded", () => {
    expect(validateAttachments(["a.png", "b.png", "c.pdf"], 3).error).toBeNull();
    const over = validateAttachments(["1.png", "2.png", "3.png", "4.png"], 3);
    expect(over.accepted).toEqual(["1.png", "2.png", "3.png"]);
    expect(over.error?.code).toBe("VALIDATION_ERROR");
  });

  it("validates Simulink and lab bundles", () => {
    expect(validateExternalResultsUpload("simulink", ["results.csv", "audit.txt", "stratum_results_manifest.txt"]).valid).toBe(true);
    expect(validateExternalResultsUpload("simulink", ["results.csv"]).valid).toBe(false);
    expect(validateExternalResultsUpload("lab", ["measurement.csv"]).valid).toBe(true);
  });
});
