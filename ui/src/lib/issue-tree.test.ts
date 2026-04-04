import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildIssueTree } from "./issue-tree";

function makeIssue(id: string, parentId: string | null = null): Issue {
  return {
    id,
    identifier: id.toUpperCase(),
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId,
    title: `Issue ${id}`,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
  };
}

describe("buildIssueTree", () => {
  it("returns all items as roots when no parent-child relationships exist", () => {
    const items = [makeIssue("a"), makeIssue("b"), makeIssue("c")];
    const { roots, childMap } = buildIssueTree(items);
    expect(roots.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(childMap.size).toBe(0);
  });

  it("places children under their parent and excludes them from roots", () => {
    const parent = makeIssue("parent");
    const child1 = makeIssue("child1", "parent");
    const child2 = makeIssue("child2", "parent");
    const { roots, childMap } = buildIssueTree([parent, child1, child2]);
    expect(roots.map((r) => r.id)).toEqual(["parent"]);
    expect(childMap.get("parent")?.map((c) => c.id)).toEqual(["child1", "child2"]);
  });

  it("handles multiple levels of nesting", () => {
    const grandparent = makeIssue("gp");
    const parent = makeIssue("p", "gp");
    const child = makeIssue("c", "p");
    const { roots, childMap } = buildIssueTree([grandparent, parent, child]);
    expect(roots.map((r) => r.id)).toEqual(["gp"]);
    expect(childMap.get("gp")?.map((i) => i.id)).toEqual(["p"]);
    expect(childMap.get("p")?.map((i) => i.id)).toEqual(["c"]);
  });

  it("promotes orphaned sub-tasks (parent not in list) to root level", () => {
    // child references a parent that is not in the items array (e.g. filtered out)
    const child = makeIssue("child", "missing-parent");
    const unrelated = makeIssue("unrelated");
    const { roots, childMap } = buildIssueTree([child, unrelated]);
    expect(roots.map((r) => r.id)).toEqual(["child", "unrelated"]);
    expect(childMap.size).toBe(0);
  });

  it("returns empty roots and empty childMap for an empty list", () => {
    const { roots, childMap } = buildIssueTree([]);
    expect(roots).toEqual([]);
    expect(childMap.size).toBe(0);
  });

  it("preserves list order within roots and within children", () => {
    const p1 = makeIssue("p1");
    const p2 = makeIssue("p2");
    const c1 = makeIssue("c1", "p1");
    const c2 = makeIssue("c2", "p1");
    const { roots, childMap } = buildIssueTree([p1, c1, p2, c2]);
    expect(roots.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(childMap.get("p1")?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
