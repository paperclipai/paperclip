import { describe, expect, it } from "vitest";
import type { IssueOverview, IssueOverviewPullRequest } from "@paperclipai/shared";
import {
  collectCompletedTasks,
  collectProjectBlockers,
  groupProjectTasks,
  hasExplicitRoadmapLabels,
  isInventoryTruncated,
  normalizeDeliveryKind,
  PROJECT_OPERATOR_OVERVIEW_PAGE_SIZE,
  resolveCompletionState,
  resolveDeliveryCoverage,
  summarizeProjectOutcomes,
  summarizePullRequests,
  taskRoadmapBucket,
  type OperatorSnapshotTask,
} from "./project-operator-overview";

let idCounter = 0;
function task(overrides: Partial<OperatorSnapshotTask> = {}): OperatorSnapshotTask {
  idCounter += 1;
  return {
    id: `task-${idCounter}`,
    identifier: null,
    title: "Task",
    status: "todo",
    priority: "medium",
    parentId: null,
    updatedAt: "2026-09-01T00:00:00Z",
    completedAt: null,
    deliveryKind: null,
    labelNames: [],
    unblockOwnerLabel: null,
    unblockAction: null,
    reviewStalled: false,
    reviewReason: null,
    blockedInbox: null,
    blockedByRefs: [],
    ...overrides,
  };
}
function deliveryOctane(
  overrides: Partial<NonNullable<IssueOverview["delivery"]>> = {},
): NonNullable<IssueOverview["delivery"]> {
  return {
    phase: "merged",
    artifactReady: false,
    reviewStatus: "none",
    blockingFindings: 0,
    queuePosition: null,
    nextAction: null,
    lastEventAt: null,
    mergedAt: "2026-09-04T00:00:00Z",
    ...overrides,
  };
}

function overview(issueId: string, overrides: Partial<IssueOverview> = {}): IssueOverview {
  return {
    issueId,
    phase: "in_progress",
    phaseSource: "status",
    blocked: false,
    project: null,
    parent: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    blocker: null,
    pullRequests: [],
    delivery: null,
    ...overrides,
  };
}
describe("roadmap lanes", () => {
  it("lanes root outcomes by explicit label with overflow for unlabeled roots", () => {
    const grouping = groupProjectTasks([
      task({ id: "now-1", status: "in_progress", labelNames: ["Now"] }),
      task({ id: "next-1", status: "todo", labelNames: ["  NEXT "] }),
      task({ id: "later-1", status: "backlog", labelNames: ["later"] }),
      task({ id: "other-1", status: "in_progress" }),
      task({ id: "done-1", status: "done", labelNames: ["now"], completedAt: "2026-09-02T00:00:00Z" }),
    ]);
    expect(grouping.mode).toBe("roadmap");
    expect(grouping.lanes.map((lane) => lane.key)).toEqual(["now", "next", "later", "other-open"]);
    expect(grouping.lanes[0].roots.map((r) => r.task.id)).toEqual(["now-1"]);
    expect(grouping.lanes[2].roots.map((r) => r.task.id)).toEqual(["later-1"]);
    expect(grouping.lanes[3].roots.map((r) => r.task.id)).toEqual(["other-1"]);
    expect(grouping.lanes.flatMap((lane) => lane.roots).some((r) => r.task.id === "done-1")).toBe(false);
  });

  it("nests children under their root instead of laning them as peers", () => {
    const grouping = groupProjectTasks([
      task({ id: "epic", status: "in_progress", labelNames: ["now"] }),
      task({ id: "child-1", status: "done", parentId: "epic" }),
      task({ id: "child-2", status: "todo", parentId: "epic" }),
      task({ id: "orphan", status: "todo", parentId: "missing" }),
    ]);
    const now = grouping.lanes[0];
    expect(now.roots.map((r) => r.task.id)).toEqual(["epic"]);
    expect(grouping.lanes[3].roots.map((r) => r.task.id)).toEqual(["orphan"]);
    expect(now.roots.find((r) => r.task.id === "epic")!.children.map((c) => c.id).sort()).toEqual([
      "child-1",
      "child-2",
    ]);
  });

  it("resolves competing roadmap labels with Now over Next over Later", () => {
    expect(taskRoadmapBucket(task({ labelNames: ["later", "next"] }))).toBe("next");
    expect(taskRoadmapBucket(task({ labelNames: ["later", "now"] }))).toBe("now");
    expect(taskRoadmapBucket(task({ labelNames: ["someday"] }))).toBeNull();
  });

  it("detects explicit labels across the inventory", () => {
    expect(hasExplicitRoadmapLabels([task({ labelNames: ["later"] })])).toBe(true);
    expect(hasExplicitRoadmapLabels([task()])).toBe(false);
  });
});

describe("status fallback lanes", () => {
  it("buckets open roots honestly and never lanes done or cancelled tasks", () => {
    const grouping = groupProjectTasks([
      task({ id: "a", status: "in_progress" }),
      task({ id: "b", status: "blocked" }),
      task({ id: "c", status: "in_review" }),
      task({ id: "d", status: "todo" }),
      task({ id: "e", status: "backlog" }),
      task({ id: "f", status: "done" }),
      task({ id: "g", status: "cancelled" }),
    ]);
    expect(grouping.mode).toBe("status");
    expect(grouping.lanes.map((lane) => lane.key)).toEqual(["active", "ready", "backlog"]);
    expect(grouping.lanes[0].roots.map((r) => r.task.id).sort()).toEqual(["a", "b", "c"]);
    expect(grouping.lanes[1].roots.map((r) => r.task.id)).toEqual(["d"]);
    expect(grouping.lanes[2].roots.map((r) => r.task.id)).toEqual(["e"]);
  });

  it("orders roots by priority then recency", () => {
    const grouping = groupProjectTasks([
      task({ id: "old-low", status: "todo", priority: "low", updatedAt: "2026-08-01T00:00:00Z" }),
      task({ id: "new-low", status: "todo", priority: "low", updatedAt: "2026-09-01T00:00:00Z" }),
      task({ id: "crit", status: "todo", priority: "critical", updatedAt: "2026-08-01T00:00:00Z" }),
    ]);
    expect(grouping.lanes[1].roots.map((r) => r.task.id)).toEqual(["crit", "new-low", "old-low"]);
  });
});

describe("outcome summary", () => {
  it("counts done, cancelled, open, and roots separately", () => {
    const summary = summarizeProjectOutcomes([
      task({ id: "a", status: "done", completedAt: "2026-09-02T00:00:00Z" }),
      task({ id: "b", status: "done", completedAt: "2026-09-03T00:00:00Z" }),
      task({ id: "c", status: "cancelled" }),
      task({ id: "d", status: "todo" }),
      task({ id: "e", status: "todo", parentId: "d" }),
    ]);
    expect(summary).toMatchObject({ total: 5, done: 2, cancelled: 1, open: 2, rootCount: 4 });
    expect(summary.doneTaskIds).toEqual(["b", "a"]);
  });
});

describe("blockers", () => {
  it("prefers overview blocker detail and never duplicates a task", () => {
    const blockers = collectProjectBlockers(
      [task({ id: "b", status: "blocked", identifier: "PAP-1", title: "Stuck" }), task({ id: "fine", status: "in_progress" })],
      new Map([
        [
          "b",
          overview("b", {
            blocked: true,
            blocker: {
              message: "Waiting on API",
              ownerLabel: "Backend",
              nextAction: "Ship endpoint",
              issues: [{ id: "x", identifier: "PAP-9", title: "API", status: "in_progress" }],
            },
          }),
        ],
      ]),
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      taskId: "b",
      ownerLabel: "Backend",
      nextAction: "Ship endpoint",
      message: "Waiting on API",
      needsDecision: false,
    });
    expect(blockers[0].blockingRefs.map((ref) => ref.id)).toEqual(["x"]);
  });

  it("marks needs-decision only for canonical awaiting-decision attention", () => {
    const blockers = collectProjectBlockers(
      [
        task({
          id: "dec",
          status: "blocked",
          blockedInbox: { ownerLabel: "Board", actionLabel: "Decide", actionDetail: null, needsDecision: true },
        }),
        task({ id: "rs", status: "in_review", reviewStalled: true, reviewReason: "No reviewer" }),
      ],
      new Map([
        ["rs", overview("rs", { delivery: deliveryOctane({ phase: "review", mergedAt: null, blockingFindings: 2 }) })],
      ]),
    );
    expect(blockers.find((b) => b.taskId === "dec")!.needsDecision).toBe(true);
    const stalled = blockers.find((b) => b.taskId === "rs")!;
    expect(stalled.needsDecision).toBe(false);
    expect(stalled.stalledReview).toBe(true);
    expect(stalled.blockingFindingCount).toBe(2);
  });

  it("sorts decisions first, then blocked status, then recency", () => {
    const blockers = collectProjectBlockers(
      [
        task({ id: "old-blocked", status: "blocked", updatedAt: "2026-08-01T00:00:00Z" }),
        task({
          id: "new-dec",
          status: "blocked",
          updatedAt: "2026-09-05T00:00:00Z",
          blockedInbox: { ownerLabel: "Board", actionLabel: "Decide", actionDetail: null, needsDecision: true },
        }),
      ],
      new Map(),
    );
    expect(blockers.map((b) => b.taskId)).toEqual(["new-dec", "old-blocked"]);
  });
});

describe("completed tasks", () => {
  it("lists done tasks most recently completed first", () => {
    const completed = collectCompletedTasks(
      [
        task({ id: "dn", status: "done", completedAt: "2026-09-03T00:00:00Z" }),
        task({ id: "dm", status: "done", completedAt: "2026-09-04T00:00:00Z" }),
        task({ id: "cx", status: "cancelled" }),
      ],
      new Map([["dm", overview("dm", { delivery: deliveryOctane() })]]),
    );
    expect(completed.map((d) => d.taskId)).toEqual(["dm", "dn"]);
    expect(completed[0].merged).toBe(true);
    expect(completed[1].merged).toBe(false);
  });

  it("never treats pull-request state as proof of merge", () => {
    const completed = collectCompletedTasks(
      [task({ id: "ds", status: "done" })],
      new Map([
        [
          "ds",
          overview("ds", {
            pullRequests: [
              { url: null, number: 1, repository: "r", state: "merged", updatedAt: "2026-09-05T00:00:00Z", stale: false },
            ],
            delivery: deliveryOctane({ phase: "review", mergedAt: null }),
          }),
        ],
      ]),
    );
    expect(completed[0].merged).toBe(false);
  });

  it("requires both merged phase and timestamp", () => {
    const completed = collectCompletedTasks(
      [task({ id: "a", status: "done" }), task({ id: "b", status: "done" })],
      new Map([
        ["a", overview("a", { delivery: deliveryOctane({ phase: "merged", mergedAt: null }) })],
        ["b", overview("b", { delivery: deliveryOctane({ phase: "done", mergedAt: "2026-09-04T00:00:00Z" }) })],
      ]),
    );
    expect(completed.map((d) => d.merged)).toEqual([false, false]);
  });

  it("carries the explicit delivery kind through for unclassified copy", () => {
    const completed = collectCompletedTasks(
      [task({ id: "nc", status: "done", deliveryKind: "non_code" })],
      new Map(),
    );
    expect(completed[0].deliveryKind).toBe("non_code");
    expect(completed[0].merged).toBe(false);
  });
});

describe("delivery coverage", () => {
  it("only calls coverage complete after a successful observation", () => {
    expect(resolveDeliveryCoverage({ pending: false, failed: false, observedAt: 0 })).toBe("unavailable");
    expect(resolveDeliveryCoverage({ pending: true, failed: false, observedAt: 0 })).toBe("loading");
    expect(resolveDeliveryCoverage({ pending: false, failed: true, observedAt: 0 })).toBe("unavailable");
    expect(resolveDeliveryCoverage({ pending: false, failed: false, observedAt: 1730000000000 })).toBe("complete");
  });

  it("treats a failure after an earlier observation as partial, not unavailable", () => {
    expect(resolveDeliveryCoverage({ pending: false, failed: true, observedAt: 1730000000000 })).toBe("partial");
    expect(resolveDeliveryCoverage({ pending: true, failed: false, observedAt: 1730000000000 })).toBe("complete");
  });
});

describe("completion state", () => {
  it("keeps recorded code completion distinct from unclassified work", () => {
    expect(resolveCompletionState({ merged: false, deliveryKind: "code" })).toBe("code_unverified");
    expect(resolveCompletionState({ merged: false, deliveryKind: null })).toBe("unclassified");
    expect(resolveCompletionState({ merged: false, deliveryKind: "non_code" })).toBe("non_code");
  });

  it("lets a verified merge outrank the recorded delivery kind", () => {
    expect(resolveCompletionState({ merged: true, deliveryKind: "code" })).toBe("merged");
    expect(resolveCompletionState({ merged: true, deliveryKind: null })).toBe("merged");
  });
});

describe("pull requests and bounds", () => {
  function pr(overrides: Partial<IssueOverviewPullRequest> = {}): IssueOverviewPullRequest {
    return {
      url: null,
      number: null,
      repository: null,
      state: "open",
      updatedAt: null,
      stale: false,
      ...overrides,
    };
  }

  it("dedups the same PR across covered tasks before counting", () => {
    expect(
      summarizePullRequests([
        { issueId: "a", pr: pr({ url: "https://git.example/r/pull/1", state: "open" }) },
        { issueId: "b", pr: pr({ url: "https://git.example/r/pull/1", state: "open" }) },
        { issueId: "b", pr: pr({ repository: "r", number: 2, state: "merged" }) },
        { issueId: "c", pr: pr({ repository: "r", number: 2, state: "merged" }) },
        { issueId: "c", pr: pr({ state: "closed" }) },
      ]),
    ).toEqual({ total: 3, open: 1, merged: 1, closedUnmerged: 1, unknown: 0 });
  });


  it("normalizes delivery kind with unclassified null", () => {
    expect(normalizeDeliveryKind("code")).toBe("code");
    expect(normalizeDeliveryKind("non_code")).toBe("non_code");
    expect(normalizeDeliveryKind("pr")).toBeNull();
    expect(normalizeDeliveryKind(undefined)).toBeNull();
  });

  it("flags truncation exactly at the inventory page size", () => {
    expect(isInventoryTruncated(PROJECT_OPERATOR_OVERVIEW_PAGE_SIZE)).toBe(true);
    expect(isInventoryTruncated(PROJECT_OPERATOR_OVERVIEW_PAGE_SIZE - 1)).toBe(false);
  });
});
