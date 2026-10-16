import { describe, expect, it, vi } from "vitest";
import { confirmObjectiveByHash, reviewObjective } from "@/lib/api";
import type { Manifest, Preset } from "@/lib/contracts";
import {
  canConfirmReviewedObjective,
  canTriggerRevision,
  computeAssemblyCentroidMm,
  computeExplodedPosition,
  computePartCenterMm,
  computePartSizeMm,
  confirmObjectiveDraft,
  createObjectiveDraftState,
  formatTargetSummary,
  getAvailableRevisions,
  isTargetMet,
  mapManifestToPartByNode,
  parseGlbNodeNames,
  reviewObjectiveDraft,
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

describe("Two-step objective review and confirmation guard", () => {
  it("prevents confirmation before server-normalized targets are reviewed", () => {
    const initial = createObjectiveDraftState(0);
    expect(canConfirmReviewedObjective(initial)).toBe(false);
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
    expect(presetDraft.targets).toEqual([]);
    expect(presetDraft.objectiveHash).toBeNull();
    expect(canConfirmReviewedObjective(presetDraft)).toBe(false);

    const prematureConfirm = confirmObjectiveDraft(presetDraft, {
      token: "tok-premature",
      expires_at: "2026-10-16T13:00:00Z",
    });
    expect(prematureConfirm.confirmToken).toBeNull();
    expect(canTriggerRevision(prematureConfirm, 3, "OBJECTIVE_CONFIRMED")).toBe(false);
  });

  it("discards objective_hash on text edit and enables revision only after review + confirm", () => {
    const targets: Preset["targets"] = [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }];
    const reviewed = reviewObjectiveDraft(createObjectiveDraftState(0), {
      text: "Reduce peak temperature",
      targets,
      base_revision: 0,
      objective_hash: "hash-001",
    });
    expect(canConfirmReviewedObjective(reviewed)).toBe(true);
    expect(reviewed.confirmToken).toBeNull();

    const editedAfterReview = updateObjectiveDraft(reviewed, "Edited objective text");
    expect(editedAfterReview.objectiveHash).toBeNull();
    expect(editedAfterReview.targets).toEqual([]);
    expect(canConfirmReviewedObjective(editedAfterReview)).toBe(false);

    const reviewedAgain = reviewObjectiveDraft(editedAfterReview, {
      text: "Edited objective text",
      targets,
      base_revision: 0,
      objective_hash: "hash-002",
    });
    const confirmed = confirmObjectiveDraft(reviewedAgain, {
      token: "tok-002",
      expires_at: "2026-10-16T13:00:00Z",
    });
    expect(canTriggerRevision(confirmed, 3, "PRESETS_READY")).toBe(false);
    expect(canTriggerRevision(confirmed, 3, "OBJECTIVE_CONFIRMED")).toBe(true);
    expect(formatTargetSummary(confirmed.targets[0]!, confirmed.baseRevision)).toBe(
      "peak_temp_C (lte / <=) 58 C [base V0]",
    );
    expect(isTargetMet(56.2, confirmed.targets[0])).toBe(true);
    expect(isTargetMet(59.4, confirmed.targets[0])).toBe(false);
  });

  it("splits reviewObjective (POST /objective) from confirmObjectiveByHash (POST /objective/confirm without confirmed_by_user)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url, body });
      if (url.endsWith("/objective")) {
        return new Response(
          JSON.stringify({
            text: "Reduce peak temperature",
            targets: [{ metric_id: "peak_temp_C", comparator: "lte", threshold: 58.0, unit: "C" }],
            base_revision: 0,
            objective_hash: "hash-server-1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ token: "tok-1", expires_at: "2026-10-16T13:00:00Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const reviewed = await reviewObjective("run-widget-a-001", 0, "Reduce peak temperature");
      expect(calls.length).toBe(1);
      expect(calls[0]?.url).toContain("/runs/run-widget-a-001/objective");
      expect(calls[0]?.url).not.toContain("/confirm");
      expect(reviewed.objective_hash).toBe("hash-server-1");

      await confirmObjectiveByHash("run-widget-a-001", reviewed.base_revision, reviewed.objective_hash);
      expect(calls.length).toBe(2);
      expect(calls[1]?.url).toContain("/runs/run-widget-a-001/objective/confirm");
      expect(calls[1]?.body).toEqual({ objective_hash: "hash-server-1", base_revision: 0 });
      expect("confirmed_by_user" in (calls[1]?.body ?? {})).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
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
    expect(computeExplodedPosition(sampleManifest.parts[1]!, 0, centroid)).toEqual([-12, 0, -2]);
    expect(computeExplodedPosition(sampleManifest.parts[1]!, 1, centroid)[0]).toBeLessThan(-12);
    expect(parseGlbNodeNames(makeMinimalGlbBuffer(["part_outer-shell", "part_core-stage"]))).toEqual([
      "part_outer-shell",
      "part_core-stage",
    ]);
  });
});

describe("Attachment (<= 3) and external results validation", () => {
  it("caps attachments at 3 files and validates Simulink and lab bundles", () => {
    expect(validateAttachments(["a.png", "b.png", "c.pdf"], 3).error).toBeNull();
    const over = validateAttachments(["1.png", "2.png", "3.png", "4.png"], 3);
    expect(over.accepted).toEqual(["1.png", "2.png", "3.png"]);
    expect(over.error?.code).toBe("VALIDATION_ERROR");
    expect(validateExternalResultsUpload("simulink", ["results.csv", "audit.txt", "stratum_results_manifest.txt"]).valid).toBe(true);
    expect(validateExternalResultsUpload("simulink", ["results.csv"]).valid).toBe(false);
    expect(validateExternalResultsUpload("lab", ["measurement.csv"]).valid).toBe(true);
  });
});
