import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  getInitiativesRollup,
  getNeedsYouIssues,
  getParkedSummary,
  priorityRank,
} from "./needs-attention";

let seq = 0;
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  seq += 1;
  return {
    id: `issue-${seq}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${seq}`,
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: `FUS-${seq}`,
    updatedAt: new Date("2026-06-26T00:00:00.000Z"),
    createdAt: new Date("2026-06-26T00:00:00.000Z"),
    ...overrides,
  } as Issue;
}

describe("priorityRank", () => {
  it("orders critical < high < medium < low", () => {
    expect(priorityRank("critical")).toBeLessThan(priorityRank("high"));
    expect(priorityRank("high")).toBeLessThan(priorityRank("medium"));
    expect(priorityRank("medium")).toBeLessThan(priorityRank("low"));
  });

  it("treats unknown priority as medium", () => {
    expect(priorityRank("nonsense")).toBe(priorityRank("medium"));
  });
});

describe("getNeedsYouIssues", () => {
  const me = "user-me";

  it("returns only in_review issues assigned to the current user", () => {
    const mine = makeIssue({ status: "in_review", assigneeUserId: me });
    const agentReview = makeIssue({
      status: "in_review",
      assigneeAgentId: "agent-1",
    });
    const otherUser = makeIssue({ status: "in_review", assigneeUserId: "user-2" });
    const myInProgress = makeIssue({ status: "in_progress", assigneeUserId: me });

    const result = getNeedsYouIssues(
      [mine, agentReview, otherUser, myInProgress],
      me,
    );

    expect(result.map((i) => i.id)).toEqual([mine.id]);
  });

  it("returns nothing when there is no current user", () => {
    const mine = makeIssue({ status: "in_review", assigneeUserId: me });
    expect(getNeedsYouIssues([mine], null)).toEqual([]);
    expect(getNeedsYouIssues([mine], undefined)).toEqual([]);
  });

  it("sorts by priority then oldest issue within a priority", () => {
    const lowOld = makeIssue({
      status: "in_review",
      assigneeUserId: me,
      priority: "low",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const highNew = makeIssue({
      status: "in_review",
      assigneeUserId: me,
      priority: "high",
      createdAt: new Date("2026-06-25T00:00:00.000Z"),
    });
    const highOld = makeIssue({
      status: "in_review",
      assigneeUserId: me,
      priority: "high",
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
    });

    const result = getNeedsYouIssues([lowOld, highNew, highOld], me);

    // high (oldest first), then low
    expect(result.map((i) => i.id)).toEqual([highOld.id, highNew.id, lowOld.id]);
  });

  it("does not let a recent edit bury an older review", () => {
    const editedOld = makeIssue({
      status: "in_review",
      assigneeUserId: me,
      priority: "high",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-25T00:00:00.000Z"),
    });
    const untouchedNew = makeIssue({
      status: "in_review",
      assigneeUserId: me,
      priority: "high",
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    });

    expect(getNeedsYouIssues([untouchedNew, editedOld], me).map((i) => i.id))
      .toEqual([editedOld.id, untouchedNew.id]);
  });
});

describe("getInitiativesRollup", () => {
  it("counts descendants recursively and computes progress", () => {
    const root = makeIssue({ status: "in_progress", priority: "high" });
    const childDone = makeIssue({ parentId: root.id, status: "done" });
    const childOpen = makeIssue({ parentId: root.id, status: "in_progress" });
    const grandchildDone = makeIssue({ parentId: childOpen.id, status: "done" });
    const grandchildCancelled = makeIssue({
      parentId: childOpen.id,
      status: "cancelled",
    });

    const [rollup] = getInitiativesRollup([
      root,
      childDone,
      childOpen,
      grandchildDone,
      grandchildCancelled,
    ]);

    expect(rollup.issue.id).toBe(root.id);
    expect(rollup.totalChildren).toBe(3); // cancelled excluded
    expect(rollup.doneChildren).toBe(2);
    expect(rollup.openChildren).toBe(1);
    expect(rollup.progressPercent).toBe(67); // 2/3
  });

  it("excludes roots with no children and cancelled roots", () => {
    const lonelyRoot = makeIssue({ status: "in_progress" });
    const cancelledRoot = makeIssue({ status: "cancelled" });
    const childOfCancelled = makeIssue({
      parentId: cancelledRoot.id,
      status: "in_progress",
    });

    const rollups = getInitiativesRollup([
      lonelyRoot,
      cancelledRoot,
      childOfCancelled,
    ]);

    expect(rollups).toEqual([]);
  });

  it("sorts by open-child count descending", () => {
    const busy = makeIssue({ status: "in_progress" });
    const quiet = makeIssue({ status: "in_progress" });
    const busyChildren = [
      makeIssue({ parentId: busy.id, status: "todo" }),
      makeIssue({ parentId: busy.id, status: "in_progress" }),
    ];
    const quietChild = makeIssue({ parentId: quiet.id, status: "todo" });

    const rollups = getInitiativesRollup([
      quiet,
      busy,
      quietChild,
      ...busyChildren,
    ]);

    expect(rollups.map((r) => r.issue.id)).toEqual([busy.id, quiet.id]);
  });
});

describe("getParkedSummary", () => {
  it("collects blocked and agent-assigned in_review without double-counting", () => {
    const blocked = makeIssue({ status: "blocked" });
    const agentReview = makeIssue({
      status: "in_review",
      assigneeAgentId: "agent-1",
    });
    const userReview = makeIssue({
      status: "in_review",
      assigneeUserId: "user-me",
    });

    const summary = getParkedSummary([blocked, agentReview, userReview]);

    expect(summary.blocked.map((i) => i.id)).toEqual([blocked.id]);
    expect(summary.agentReview.map((i) => i.id)).toEqual([agentReview.id]);
    expect(summary.total).toBe(2);
    expect(summary.issues).toHaveLength(2);
  });
});
