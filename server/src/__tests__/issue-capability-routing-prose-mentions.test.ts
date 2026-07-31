import { describe, expect, it } from "vitest";
import { inferIssueToolRequirements } from "../services/issue-capability-routing.ts";

/**
 * Regression cover for TSMC-18607 (2026-07-31).
 *
 * After stripCodeFences closed the "quoted output drives routing" half of the
 * capability-gate false-positive class, bare PROSE mentions still force-required
 * media toolsets. Filing this card itself 422'd on the first attempt because the
 * description named `image_gen` in prose:
 *
 *   HTTP 422 ...capabilities
 *   requiredToolsets: [ image_gen ]
 *   matchedSignals: { image_gen: [ "keyword:image_gen" ] }
 *
 * Live burn-night shape (2026-07-30/31 logs): recovery issues that merely name
 * Designer-Media as a stranded owner hit keyword:media_specialist and 422 when
 * assigned to a non-media lane. Four FP cards that night alone; ongoing stream of
 * stranded-recovery 422s with the same signal.
 *
 * Contract under test:
 *   - bare prose mention  -> soft suggestion only (no hard require / no 422)
 *   - explicit intent     -> hard require (positive control; law 16 — do not trust a zero)
 *   - fenced quote        -> neither (still covered by code-fences suite)
 */
describe("issue capability routing — prose mentions are suggestions, not hard requirements", () => {
  // --- False-positive fixtures (burn-night / live repro shapes) ------------

  it("FP fixture: bare image_gen prose (this card's own 422) does NOT hard-require", () => {
    // Verbatim shape from TSMC-18607 filing attempt — discuss the toolset without declaring it.
    const result = inferIssueToolRequirements({
      title: "[PLATFORM] Capability gate still force-routes on PROSE mentions, not just fenced quotes",
      description: [
        "Root cause is inferIssueToolRequirements().",
        "Bare /\\bimage_gen\\b still force-requires the image_gen toolset.",
        "A card that merely DISCUSSES media work 422s against a deliberate non-media assignee.",
      ].join("\n"),
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.matchedSignals.image_gen).toEqual([]);
    expect(result.suggestsMediaTools).toBe(true);
    expect(result.suggestedToolsets).toContain("image_gen");
    expect(result.suggestedSignals.image_gen).toContain("mention:image_gen");
  });

  it("FP fixture: RCA naming Designer-Media as stranded owner does NOT hard-require", () => {
    const result = inferIssueToolRequirements({
      title: "[RCA] stranded recovery loops on media lane",
      description: [
        "TSM-5927 stayed blocked overnight.",
        "Assignee column on the guard table listed Designer-Media as the prior owner.",
        "Escalate to the OpCo CEO lane for disposition — this is not a render job.",
      ].join("\n"),
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestsMediaTools).toBe(true);
    expect(result.suggestedSignals.image_gen).toContain("mention:media_specialist");
    expect(result.suggestedSignals.video_gen).toContain("mention:media_specialist");
  });

  it("FP fixture: postmortem discussing video_gen keyword does NOT hard-require", () => {
    const result = inferIssueToolRequirements({
      title: "Postmortem: routing-guard false positives on burn night",
      description: [
        "Four cards tripped the capability gate on bare video_gen mentions.",
        "None of them asked for a render; they audited the matcher.",
      ].join("\n"),
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestedToolsets).toContain("video_gen");
    expect(result.suggestedSignals.video_gen).toContain("mention:video_gen");
  });

  it("FP fixture: status rollup with 'generate an image' phrasing does NOT hard-require", () => {
    const result = inferIssueToolRequirements({
      title: "Weekly creative ops rollup",
      description: "Design still needs to generate an image for the hero; tracking only — no assignment change.",
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestedSignals.image_gen).toContain("mention:generate_image");
  });

  it("FP fixture: grok-imagine named in prose does NOT hard-require", () => {
    const result = inferIssueToolRequirements({
      title: "Model lane note",
      description: "grok-imagine remains the media adapter behind Designer-Media; no work ordered here.",
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestedSignals.image_gen).toContain("mention:media_specialist");
  });

  // --- Positive controls (law 16 — do not trust a zero) --------------------

  it("POSITIVE: explicit requires: image_gen still hard-requires media toolset", () => {
    const result = inferIssueToolRequirements({
      title: "Thumbnail pass",
      description: "requires: image_gen for the store listing tile.",
    });

    expect(result.requiresMediaTools).toBe(true);
    expect(result.requiredToolsets).toEqual(["image_gen"]);
    expect(result.matchedSignals.image_gen).toContain("keyword:image_gen");
  });

  it("POSITIVE: needs: video_gen still hard-requires video toolset", () => {
    const result = inferIssueToolRequirements({
      title: "Trailer cut",
      description: "needs: video_gen — deliver a 15s vertical cut.",
    });

    expect(result.requiresMediaTools).toBe(true);
    expect(result.requiredToolsets).toEqual(["video_gen"]);
    expect(result.matchedSignals.video_gen).toContain("keyword:video_gen");
  });

  it("POSITIVE: toolset: image_gen still hard-requires", () => {
    const result = inferIssueToolRequirements({
      title: "Icon set",
      description: "toolset: image_gen",
    });

    expect(result.requiredToolsets).toContain("image_gen");
    expect(result.requiresMediaTools).toBe(true);
  });

  it("POSITIVE: image_gen label still hard-requires", () => {
    const result = inferIssueToolRequirements({
      title: "Asset batch",
      description: "Ship the approved stills.",
      labels: ["image_gen"],
    });

    expect(result.requiresMediaTools).toBe(true);
    expect(result.requiredToolsets).toContain("image_gen");
    expect(result.matchedSignals.image_gen.some((s) => s.startsWith("label:"))).toBe(true);
  });

  it("POSITIVE: media label still hard-requires both toolsets", () => {
    const result = inferIssueToolRequirements({
      title: "Creative package",
      description: "Full suite.",
      labels: ["media"],
    });

    expect(result.requiresMediaTools).toBe(true);
    expect(result.requiredToolsets).toEqual(["image_gen", "video_gen"]);
  });

  // --- Boundary hygiene ----------------------------------------------------

  it("explicit hard signal is not also double-counted as a soft mention", () => {
    const result = inferIssueToolRequirements({
      title: "Hero still",
      description: "requires: image_gen",
    });

    expect(result.requiredToolsets).toEqual(["image_gen"]);
    // Bare token is present, but hard already claimed keyword:image_gen — soft must not mirror it.
    expect(result.suggestedSignals.image_gen).not.toContain("mention:image_gen");
  });

  it("routine_execution origin ignores bare prose (explicit-only body policy unchanged)", () => {
    const result = inferIssueToolRequirements({
      title: "Portfolio Intake monitor",
      description: "Prior assignee was Designer-Media; image_gen mentioned in audit only.",
      originKind: "routine_execution",
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.suggestsMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestedToolsets).toEqual([]);
  });

  it("fenced bare mention remains non-routing on both hard and soft paths", () => {
    const result = inferIssueToolRequirements({
      title: "Document the matcher",
      description: [
        "Example tokens that must not route:",
        "```",
        "image_gen",
        "Designer-Media",
        "requires: video_gen",
        "```",
      ].join("\n"),
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.suggestsMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestedToolsets).toEqual([]);
  });
});
