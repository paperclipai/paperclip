import { describe, expect, it } from "vitest";
import { founderBriefIssueStatus } from "./founder-brief.js";

describe("founderBriefIssueStatus", () => {
  it("completes a pure FYI brief", () => {
    expect(founderBriefIssueStatus(0)).toBe("done");
  });

  it("keeps a brief actionable only while it has a pending decision", () => {
    expect(founderBriefIssueStatus(1)).toBe("in_review");
    expect(founderBriefIssueStatus(3)).toBe("in_review");
  });
});
