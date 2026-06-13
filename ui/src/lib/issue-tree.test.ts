import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildIssueTree, buildRenderedIssueOrder, countDescendants, filterIssueDescendants } from "./issue-tree";

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
    workMode: "standard",
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

describe("countDescendants", () => {
  it("returns 0 for a leaf node", () => {
    const { childMap } = buildIssueTree([makeIssue("a")]);
    expect(countDescendants("a", childMap)).toBe(0);
  });

  it("returns direct child count for a single-level parent", () => {
    const { childMap } = buildIssueTree([
      makeIssue("p"),
      makeIssue("c1", "p"),
      makeIssue("c2", "p"),
    ]);
    expect(countDescendants("p", childMap)).toBe(2);
  });

  it("counts all descendants across multiple levels", () => {
    // P → C → G1, G2  (P has 3 total descendants: C, G1, G2)
    const { childMap } = buildIssueTree([
      makeIssue("p"),
      makeIssue("c", "p"),
      makeIssue("g1", "c"),
      makeIssue("g2", "c"),
    ]);
    expect(countDescendants("p", childMap)).toBe(3);
  });

  it("returns 0 for an id not in the childMap", () => {
    const { childMap } = buildIssueTree([makeIssue("a"), makeIssue("b")]);
    expect(countDescendants("nonexistent", childMap)).toBe(0);
  });
});

describe("buildRenderedIssueOrder", () => {
  it("returns input order verbatim when nesting is disabled", () => {
    const items = [
      makeIssue("a"),
      makeIssue("b", "a"), // would otherwise nest under "a"
      makeIssue("c"),
    ];
    expect(buildRenderedIssueOrder(items, false)).toEqual(["a", "b", "c"]);
  });

  it("returns input order when nesting is enabled but no parent-child relationships exist", () => {
    const items = [makeIssue("x"), makeIssue("y"), makeIssue("z")];
    expect(buildRenderedIssueOrder(items, true)).toEqual(["x", "y", "z"]);
  });

  it("groups children under their parent in DFS order regardless of input position", () => {
    // Input order interleaves a child of p1 between p1 and p2 (simulating a sort
    // by status/priority/updatedAt). The rendered DFS order must place c1
    // directly after p1, not between p1 and p2 by their flat position.
    const p1 = makeIssue("p1");
    const c1 = makeIssue("c1", "p1");
    const p2 = makeIssue("p2");
    const c2 = makeIssue("c2", "p2");
    // Flat (sort) order: p1, p2, c1, c2 — but rendered tree is p1 → c1, p2 → c2
    expect(buildRenderedIssueOrder([p1, p2, c1, c2], true)).toEqual([
      "p1",
      "c1",
      "p2",
      "c2",
    ]);
  });

  it("renders multi-level nesting DFS-first", () => {
    const gp = makeIssue("gp");
    const p = makeIssue("p", "gp");
    const c = makeIssue("c", "p");
    const sibling = makeIssue("sibling", "gp");
    // Out-of-order input: children of gp appear in item-encounter order
    // (sibling before p), then DFS walks p's descendants under p.
    expect(buildRenderedIssueOrder([c, sibling, p, gp], true)).toEqual([
      "gp",
      "sibling",
      "p",
      "c",
    ]);
  });
});

describe("filterIssueDescendants", () => {
  it("returns only children and deeper descendants of the requested root", () => {
    const root = makeIssue("root");
    const child = makeIssue("child", "root");
    const grandchild = makeIssue("grandchild", "child");
    const unrelatedParent = makeIssue("other");
    const unrelatedChild = makeIssue("other-child", "other");

    expect(filterIssueDescendants("root", [
      root,
      child,
      grandchild,
      unrelatedParent,
      unrelatedChild,
    ]).map((issue) => issue.id)).toEqual(["child", "grandchild"]);
  });

  it("handles stale broad issue-list responses without requiring the root in the list", () => {
    const child = makeIssue("child", "root");
    const grandchild = makeIssue("grandchild", "child");
    const globalIssue = makeIssue("global");

    expect(filterIssueDescendants("root", [
      globalIssue,
      child,
      grandchild,
    ]).map((issue) => issue.id)).toEqual(["child", "grandchild"]);
  });
});
