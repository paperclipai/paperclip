import { describe, it, expect } from "vitest";
import { evaluateLaunchChecklist, hasProofMetadata, isLaunchIssueText } from "../services/issue-launch-guards.js";

describe("issue launch guards", () => {
  it("detects launch-oriented issues from title/description", () => {
    expect(isLaunchIssueText("Launch campaign", null)).toBe(true);
    expect(isLaunchIssueText("Bugfix", "refactor parser")).toBe(false);
  });

  it("validates proof metadata", () => {
    expect(hasProofMetadata({ proof: { urlOrPostId: "https://x.com/p/1", timestamp: "2026-03-23T10:00:00Z", platformChannel: "x:@brand" } })).toBe(true);
    expect(hasProofMetadata({ proof: { urlOrPostId: "", timestamp: "2026", platformChannel: "x" } })).toBe(false);
  });

  it("requires all launch checklist checks", () => {
    const result = evaluateLaunchChecklist({
      metadata: {
        copyFinal: true,
        linksValid: true,
        scheduledTime: "2026-03-24T09:00:00Z",
        proof: {
          urlOrPostId: "https://x.com/p/1",
          timestamp: "2026-03-24T09:01:00Z",
          platformChannel: "x:@brand",
        },
      },
      hasImageAttachment: true,
      hasApprovedLinkedApproval: true,
    });

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
