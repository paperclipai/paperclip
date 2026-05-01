// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  buildSubIssueProgressSummary,
  shouldRenderRichSubIssuesSection,
  shouldRenderSubIssueProgressSummary,
} from "./issue-detail-subissues";

function issue(
  id: string,
  status: Issue["status"],
  createdAt: string,
  blockedByIds: string[] = [],
): Issue {
  return {
    id,
    identifier: `PAP-${id}`,
    title: `Issue ${id}`,
    status,
    createdAt: new Date(createdAt),
    blockedBy: blockedByIds.map((blockerId) => ({ id: blockerId })),
  } as Issue;
}

describe("shouldRenderRichSubIssuesSection", () => {
  it("shows the rich sub-issues section while child issues are loading", () => {
    expect(shouldRenderRichSubIssuesSection(true, 0)).toBe(true);
  });

  it("shows the rich sub-issues section when at least one child issue exists", () => {
    expect(shouldRenderRichSubIssuesSection(false, 1)).toBe(true);
  });

  it("hides the rich sub-issues section when there are no child issues", () => {
    expect(shouldRenderRichSubIssuesSection(false, 0)).toBe(false);
  });
});

describe("shouldRenderSubIssueProgressSummary", () => {
  it("requires both the opt-in flag and multiple child issues", () => {
    expect(shouldRenderSubIssueProgressSummary(true, 2)).toBe(true);
    expect(shouldRenderSubIssueProgressSummary(true, 1)).toBe(false);
    expect(shouldRenderSubIssueProgressSummary(false, 1)).toBe(false);
    expect(shouldRenderSubIssueProgressSummary(true, 0)).toBe(false);
  });
});

describe("buildSubIssueProgressSummary", () => {
  it("counts statuses and picks the first actionable issue in workflow order", () => {
    const summary = buildSubIssueProgressSummary([
      issue("3", "todo", "2026-04-03T00:00:00.000Z", ["2"]),
      issue("1", "done", "2026-04-01T00:00:00.000Z"),
      issue("2", "in_progress", "2026-04-02T00:00:00.000Z", ["1"]),
      issue("4", "blocked", "2026-04-04T00:00:00.000Z"),
      issue("5", "cancelled", "2026-04-05T00:00:00.000Z"),
    ]);

    expect(summary.totalCount).toBe(4);
    expect(summary.doneCount).toBe(1);
    expect(summary.inProgressCount).toBe(1);
    expect(summary.blockedCount).toBe(1);
    expect(summary.countsByStatus.todo).toBe(1);
    expect(summary.countsByStatus.cancelled).toBeUndefined();
    expect(summary.target?.kind).toBe("next");
    expect(summary.target?.issue.id).toBe("2");
  });

  it("waits on the first blocked issue when no remaining work is actionable", () => {
    const summary = buildSubIssueProgressSummary([
      issue("1", "done", "2026-04-01T00:00:00.000Z"),
      issue("2", "blocked", "2026-04-02T00:00:00.000Z"),
      issue("3", "cancelled", "2026-04-03T00:00:00.000Z"),
    ]);

    expect(summary.target?.kind).toBe("blocked");
    expect(summary.target?.issue.id).toBe("2");
  });
});
