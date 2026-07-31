import { describe, expect, it } from "vitest";
import { inferIssueToolRequirements } from "../services/issue-capability-routing.ts";

/**
 * Regression cover for 2026-07-25 (fences) + TSMC-18607 (prose demotion).
 *
 * `stripCodeFences` existed in issue-capability-routing.ts but was never called, so keyword
 * routing matched the RAW body — including quoted tool output. Any issue that merely QUOTED
 * an agent name (in a results table, a log excerpt, or the matcher's own regexes) was
 * force-required media toolsets, and creating it with a deliberate non-media assignee failed:
 *
 *   422 "Assigned agent does not satisfy the issue's required tool capabilities"
 *       matchedSignals: { image_gen: ["keyword:media_specialist"], ... }
 *
 * Two real cases that day: an RCA naming the lane as a stranded recovery's owner, and an
 * automated guard card whose output table listed it in an assignee column — the guard's DATA
 * silently overriding the caller's deliberate owner choice. Filing the bug report about it
 * took five attempts, because quoting these rules trips these rules.
 *
 * Fences close the quoted-data half. TSMC-18607 demotes bare prose mentions of the same
 * tokens to soft suggestions — so an unfenced Designer-Media *mention* is no longer a hard
 * require either. Hard requires stay on explicit intent prefixes and labels only.
 */
describe("issue capability routing — fenced code blocks are data, not routing intent", () => {
  it("does NOT require media toolsets for an agent name quoted inside a code fence", () => {
    const result = inferIssueToolRequirements({
      title: "[GUARD] stranded-recovery red for 2 consecutive runs",
      description: [
        "Issues blocked with no live blocker and an already-resolved recovery action.",
        "",
        "```",
        "  co    issue       assignee              stranded  loops",
        "  TSM   TSM-5737    Designer-Media        22.5h     2",
        "```",
        "",
        "Route each to its assignee lane for a real disposition.",
      ].join("\n"),
    });

    expect(result.requiresMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestsMediaTools).toBe(false);
    expect(result.suggestedToolsets).toEqual([]);
  });

  it("bare Designer-Media outside a fence is a SOFT suggestion only (TSMC-18607)", () => {
    const result = inferIssueToolRequirements({
      title: "Produce the launch tiles",
      description: "Hand this to Designer-Media to generate the artwork.",
    });

    // Pre-18607 this hard-required; post-18607 prose mentions must not 422 deliberate assignees.
    expect(result.requiresMediaTools).toBe(false);
    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestsMediaTools).toBe(true);
    expect(result.suggestedToolsets).toContain("image_gen");
    expect(result.suggestedSignals.image_gen).toContain("mention:media_specialist");
  });

  it("still hard-requires on an explicit toolset request outside a fence", () => {
    const result = inferIssueToolRequirements({
      title: "Thumbnail pass",
      description: "requires: image_gen",
    });

    expect(result.requiredToolsets).toContain("image_gen");
    expect(result.requiresMediaTools).toBe(true);
  });

  it("does not route on an explicit toolset request that is only quoted as an example", () => {
    const result = inferIssueToolRequirements({
      title: "Document the routing keywords",
      description: [
        "The matcher fires on lines like this:",
        "",
        "```",
        "requires: image_gen",
        "requires: video_gen",
        "```",
        "",
        "That is why an accurate bug report about the matcher was unfileable.",
      ].join("\n"),
    });

    expect(result.requiredToolsets).toEqual([]);
    expect(result.suggestedToolsets).toEqual([]);
  });
});
