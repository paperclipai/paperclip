import { describe, expect, it } from "vitest";
import { classifyIssueReviewPaths } from "./issue-graph-liveness.js";

const companyId = "company-1";

const issue = {
  id: "issue-1",
  companyId,
  identifier: "ORU-1",
  title: "Blocked issue with a pending board ask",
  status: "blocked",
};

describe("classifyIssueReviewPaths", () => {
  it("surfaces a pending interaction path even when the issue is not in_review", () => {
    const paths = classifyIssueReviewPaths(
      {
        issues: [issue],
        relations: [],
        agents: [],
        pendingInteractions: [
          { id: "interaction-1", companyId, issueId: issue.id, status: "pending" },
        ],
      },
      issue,
    );

    expect(paths).toEqual([
      { kind: "interaction", ref: "interaction-1", agentId: null, userId: null, since: null },
    ]);
  });

  it("returns no paths for a non in_review issue with no pending interaction", () => {
    const paths = classifyIssueReviewPaths(
      { issues: [issue], relations: [], agents: [], pendingInteractions: [] },
      issue,
    );

    expect(paths).toEqual([]);
  });
});
