// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  buildIssueSiblingNavigation,
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

function siblingIssue(
  id: string,
  createdAt: string,
  blockedByIds: string[] = [],
  overrides: Partial<Issue> = {},
): Issue {
  return {
    ...issue(id, "todo", createdAt, blockedByIds),
    parentId: "parent-1",
    title: `Sibling ${id}`,
    hiddenAt: null,
    ...overrides,
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

describe("buildIssueSiblingNavigation", () => {
  it("orders linear blocker chains before selecting previous and next siblings", () => {
    const current = siblingIssue("2", "2026-04-02T00:00:00.000Z", ["1"]);
    const navigation = buildIssueSiblingNavigation(current, [
      siblingIssue("3", "2026-04-03T00:00:00.000Z", ["2"]),
      siblingIssue("1", "2026-04-01T00:00:00.000Z"),
      current,
    ]);

    expect(navigation?.previous?.id).toBe("1");
    expect(navigation?.next?.id).toBe("3");
    expect(navigation?.currentIndex).toBe(1);
    expect(navigation?.totalCount).toBe(3);
  });

  it("degrades branch and merge graphs to stable workflow order", () => {
    const current = siblingIssue("3", "2026-04-03T00:00:00.000Z", ["1"]);
    const navigation = buildIssueSiblingNavigation(current, [
      siblingIssue("4", "2026-04-04T00:00:00.000Z", ["2", "3"]),
      siblingIssue("2", "2026-04-02T00:00:00.000Z", ["1"]),
      current,
      siblingIssue("1", "2026-04-01T00:00:00.000Z"),
    ]);

    expect(navigation?.previous?.id).toBe("2");
    expect(navigation?.next?.id).toBe("4");
  });

  it("falls back to created time and id when siblings have no direct blocker hints", () => {
    const current = siblingIssue("2", "2026-04-01T00:00:00.000Z");
    const navigation = buildIssueSiblingNavigation(current, [
      siblingIssue("3", "2026-04-02T00:00:00.000Z"),
      siblingIssue("1", "2026-04-01T00:00:00.000Z"),
      current,
    ]);

    expect(navigation?.previous?.id).toBe("1");
    expect(navigation?.next?.id).toBe("3");
  });

  it("hides navigation for root issues without children or hidden current issues", () => {
    expect(buildIssueSiblingNavigation(siblingIssue("1", "2026-04-01T00:00:00.000Z", [], { parentId: null }), []))
      .toBeNull();
    expect(buildIssueSiblingNavigation(siblingIssue("1", "2026-04-01T00:00:00.000Z", [], { parentId: null }), [
      siblingIssue("2", "2026-04-02T00:00:00.000Z", [], { parentId: null }),
    ])).toBeNull();
    expect(buildIssueSiblingNavigation(siblingIssue("1", "2026-04-01T00:00:00.000Z", [], { hiddenAt: new Date() }), []))
      .toBeNull();
  });

  it("hides navigation when the current issue is the only visible child", () => {
    const current = siblingIssue("1", "2026-04-01T00:00:00.000Z");
    const navigation = buildIssueSiblingNavigation(current, [
      current,
      siblingIssue("2", "2026-04-02T00:00:00.000Z", [], { hiddenAt: new Date() }),
    ]);

    expect(navigation).toBeNull();
  });

  it("returns only next for the first sibling and only previous for the last sibling", () => {
    const first = siblingIssue("1", "2026-04-01T00:00:00.000Z");
    const last = siblingIssue("3", "2026-04-03T00:00:00.000Z");
    const siblings = [
      siblingIssue("2", "2026-04-02T00:00:00.000Z"),
      last,
      first,
    ];

    expect(buildIssueSiblingNavigation(first, siblings)).toMatchObject({
      previous: null,
      next: { id: "2" },
    });
    expect(buildIssueSiblingNavigation(last, siblings)).toMatchObject({
      previous: { id: "2" },
      next: null,
    });
  });

  it("uses the first direct child as next when a root issue has no sibling next", () => {
    const current = siblingIssue("1", "2026-04-01T00:00:00.000Z", [], { parentId: null });
    const navigation = buildIssueSiblingNavigation(current, [], [
      siblingIssue("3", "2026-04-03T00:00:00.000Z", ["2"], { parentId: "1" }),
      siblingIssue("2", "2026-04-02T00:00:00.000Z", [], { parentId: "1" }),
    ]);

    expect(navigation).toMatchObject({
      previous: null,
      next: { id: "2" },
    });
  });

  it("uses the first direct child as next when the current sibling is last", () => {
    const current = siblingIssue("2", "2026-04-02T00:00:00.000Z");
    const navigation = buildIssueSiblingNavigation(current, [
      siblingIssue("1", "2026-04-01T00:00:00.000Z"),
      current,
    ], [
      siblingIssue("4", "2026-04-04T00:00:00.000Z", ["3"], { parentId: "2" }),
      siblingIssue("3", "2026-04-03T00:00:00.000Z", [], { parentId: "2" }),
    ]);

    expect(navigation).toMatchObject({
      previous: { id: "1" },
      next: { id: "3" },
    });
  });
});
