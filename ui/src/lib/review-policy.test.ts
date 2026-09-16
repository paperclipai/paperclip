import { describe, expect, it } from "vitest";

import {
  formatReviewPolicyValue,
  issueReviewPolicyBadge,
  readIssueReviewPolicyMetadata,
} from "./review-policy";

describe("issueReviewPolicyBadge", () => {
  // The default is what every issue already does, so it earns no pixels.
  it("shows nothing for the default, however the column spells it", () => {
    expect(issueReviewPolicyBadge(null)).toBeNull();
    expect(issueReviewPolicyBadge(undefined)).toBeNull();
    expect(issueReviewPolicyBadge("anyone")).toBeNull();
  });

  it("badges each opt-in constraint in the board's words", () => {
    expect(issueReviewPolicyBadge("not_creator")?.label).toBe("Anyone else");
    expect(issueReviewPolicyBadge("human_only")?.label).toBe("Human only");
  });

  it("spells the rule out in the tooltip so the badge is recoverable", () => {
    expect(issueReviewPolicyBadge("not_creator")?.description).toContain("asked for the review");
    expect(issueReviewPolicyBadge("human_only")?.description).toContain("Agents cannot");
  });

  it("shows nothing for a policy this build does not know", () => {
    expect(issueReviewPolicyBadge("board_only" as never)).toBeNull();
  });
});

describe("formatReviewPolicyValue", () => {
  it("reads a cleared policy as 'anyone', never as 'none'", () => {
    expect(formatReviewPolicyValue(null)).toBe("anyone");
    expect(formatReviewPolicyValue(undefined)).toBe("anyone");
    expect(formatReviewPolicyValue("anyone")).toBe("anyone");
  });

  it("uses the badge wording mid-sentence so a receipt matches the badge", () => {
    expect(formatReviewPolicyValue("not_creator")).toBe("anyone else");
    expect(formatReviewPolicyValue("human_only")).toBe("human only");
  });

  it("humanizes an unknown policy rather than hiding it", () => {
    expect(formatReviewPolicyValue("board_only")).toBe("board only");
  });
});

describe("readIssueReviewPolicyMetadata", () => {
  it("reads the policy off an attention subject's metadata bag", () => {
    expect(readIssueReviewPolicyMetadata({ reviewPolicy: "human_only" })).toBe("human_only");
  });

  it("returns null when the subject carries no policy", () => {
    expect(readIssueReviewPolicyMetadata(null)).toBeNull();
    expect(readIssueReviewPolicyMetadata(undefined)).toBeNull();
    expect(readIssueReviewPolicyMetadata({ priority: "high" })).toBeNull();
  });

  it("rejects a value outside the enum instead of trusting the wire", () => {
    expect(readIssueReviewPolicyMetadata({ reviewPolicy: "board_only" })).toBeNull();
    expect(readIssueReviewPolicyMetadata({ reviewPolicy: 3 })).toBeNull();
  });
});
