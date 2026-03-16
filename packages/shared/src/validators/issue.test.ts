import { describe, expect, it } from "vitest";
import { createIssueSchema, issueReviewSubmissionSchema, updateIssueSchema } from "./issue.js";

describe("issue validators", () => {
  it("applies the V1 defaults for new issues", () => {
    const result = createIssueSchema.parse({
      title: "Ship the review handoff flow",
    });

    expect(result.status).toBe("backlog");
    expect(result.priority).toBe("medium");
    expect(result.requestDepth).toBe(0);
    expect(result.labelIds).toBeUndefined();
  });

  it("requires a real pull request URL in review submissions", () => {
    const result = issueReviewSubmissionSchema.safeParse({
      branchName: "codex/review-handoff",
      headCommitSha: "deadbeef",
      pullRequestUrl: "not-a-url",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["pullRequestUrl"]);
  });

  it("allows comment handoffs on updates without forcing other fields", () => {
    const result = updateIssueSchema.parse({
      comment: "Ready for review.",
      reviewSubmission: {
        branchName: "codex/review-handoff",
        headCommitSha: "deadbeef",
        pullRequestUrl: "https://github.com/paperclipai/paperclip/pull/123",
      },
    });

    expect(result.comment).toBe("Ready for review.");
    expect(result.reviewSubmission?.branchName).toBe("codex/review-handoff");
  });
});
