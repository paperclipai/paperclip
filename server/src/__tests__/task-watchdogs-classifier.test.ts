import { describe, expect, it } from "vitest";
import { classifyTaskWatchdogSubtree, type TaskWatchdogClassifierIssue } from "../services/task-watchdogs.ts";

const companyId = "company-1";
const sourceId = "source-1";
const childId = "child-1";
const watchdogId = "watchdog-1";

function issue(overrides: Partial<TaskWatchdogClassifierIssue> = {}): TaskWatchdogClassifierIssue {
  return {
    id: sourceId,
    companyId,
    identifier: "PAP-1",
    title: "Source",
    status: "todo",
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    originKind: "manual",
    updatedAt: new Date("2026-06-17T20:00:00.000Z"),
    ...overrides,
  };
}

function classify(overrides: Partial<Parameters<typeof classifyTaskWatchdogSubtree>[0]> = {}) {
  return classifyTaskWatchdogSubtree({
    watchdog: {
      companyId,
      issueId: sourceId,
      lastReviewedFingerprint: null,
    },
    issues: [issue()],
    ...overrides,
  });
}

describe("task watchdog subtree classifier", () => {
  it("suppresses watchdog wakeups while watched subtree work has a live path", () => {
    const result = classify({
      issues: [
        issue(),
        issue({ id: childId, identifier: "PAP-2", parentId: sourceId, status: "in_progress" }),
      ],
      activeRuns: [{ companyId, issueId: childId, agentId: "agent-1", status: "running" }],
    });

    expect(result).toMatchObject({
      state: "live",
      liveIssueIds: [childId],
    });
  });

  it("treats terminal and waiting leaves as stopped work that needs verification", () => {
    const result = classify({
      issues: [
        issue({ status: "done" }),
        issue({ id: childId, identifier: "PAP-2", parentId: sourceId, status: "in_review" }),
      ],
      pendingInteractions: [{ companyId, issueId: childId, id: "interaction-1", status: "pending" }],
    });

    expect(result.state).toBe("stopped");
    if (result.state !== "stopped") return;
    expect(result.stopFingerprint).toMatch(/^task_watchdog_stop:/);
    expect(result.stoppedLeaves).toEqual([
      expect.objectContaining({
        issueId: childId,
        status: "in_review",
        pendingInteractionIds: ["interaction-1"],
      }),
    ]);
  });

  it("suppresses an unchanged stopped fingerprint once the watchdog reviewed it", () => {
    const stopped = classify({
      issues: [issue({ status: "blocked" })],
    });
    expect(stopped.state).toBe("stopped");
    if (stopped.state !== "stopped") return;

    const reviewed = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: stopped.stopFingerprint,
      },
      issues: [issue({ status: "blocked" })],
    });

    expect(reviewed).toMatchObject({
      state: "already_reviewed",
      stopFingerprint: stopped.stopFingerprint,
    });
  });

  it("does not re-flip an already-reviewed verdict when only touch timestamps change on a repeat no-op status heartbeat", () => {
    const stopped = classify({
      issues: [
        issue({
          status: "blocked",
          updatedAt: new Date("2026-07-11T08:00:00.000Z"),
          latestCommentAt: new Date("2026-07-11T08:00:00.000Z"),
        }),
      ],
    });
    expect(stopped.state).toBe("stopped");
    if (stopped.state !== "stopped") return;

    // Simulate the next heartbeat cycle: the assignee agent finds no
    // actionable work (calendar gate not reached yet), posts another
    // identical "still blocked, waiting on <date>" status comment, and
    // re-affirms status=blocked. Status/assignee/blockers are unchanged, but
    // latestCommentAt/updatedAt both advance because a comment was posted and
    // the issue row was touched.
    const reviewed = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: stopped.stopFingerprint,
      },
      issues: [
        issue({
          status: "blocked",
          updatedAt: new Date("2026-07-11T09:00:00.000Z"),
          latestCommentAt: new Date("2026-07-11T09:00:00.000Z"),
        }),
      ],
    });

    expect(reviewed).toMatchObject({
      state: "already_reviewed",
      stopFingerprint: stopped.stopFingerprint,
    });
  });

  it("still re-evaluates when a structural field actually changes despite unchanged timestamps", () => {
    const stopped = classify({
      issues: [issue({ status: "blocked" })],
    });
    expect(stopped.state).toBe("stopped");
    if (stopped.state !== "stopped") return;

    const changed = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: stopped.stopFingerprint,
      },
      issues: [issue({ status: "blocked", assigneeAgentId: "agent-2" })],
    });

    expect(changed.state).toBe("stopped");
    expect(changed.stopFingerprint).not.toBe(stopped.stopFingerprint);
  });

  it("re-evaluates when an existing document is edited in place even though the document count is unchanged", () => {
    const stopped = classify({
      issues: [
        issue({
          status: "blocked",
          documentCount: 1,
          latestDocumentAt: new Date("2026-07-11T08:00:00.000Z"),
        }),
      ],
    });
    expect(stopped.state).toBe("stopped");
    if (stopped.state !== "stopped") return;

    // Same document row count (no insert/delete), but the existing document's
    // content was edited — e.g. a blocked issue's attached evidence doc was
    // updated with new source information. The count alone would miss this;
    // latestDocumentAt must still bust the fingerprint.
    const edited = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: stopped.stopFingerprint,
      },
      issues: [
        issue({
          status: "blocked",
          documentCount: 1,
          latestDocumentAt: new Date("2026-07-11T09:00:00.000Z"),
        }),
      ],
    });

    expect(edited.state).toBe("stopped");
    expect(edited.stopFingerprint).not.toBe(stopped.stopFingerprint);
  });

  it("re-evaluates when an existing work product is edited in place even though the work-product count is unchanged", () => {
    const stopped = classify({
      issues: [
        issue({
          status: "blocked",
          workProductCount: 1,
          latestWorkProductAt: new Date("2026-07-11T08:00:00.000Z"),
        }),
      ],
    });
    expect(stopped.state).toBe("stopped");
    if (stopped.state !== "stopped") return;

    const edited = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: stopped.stopFingerprint,
      },
      issues: [
        issue({
          status: "blocked",
          workProductCount: 1,
          latestWorkProductAt: new Date("2026-07-11T09:00:00.000Z"),
        }),
      ],
    });

    expect(edited.state).toBe("stopped");
    expect(edited.stopFingerprint).not.toBe(stopped.stopFingerprint);
  });

  it("excludes task-watchdog issues and their descendants from watched subtree scans", () => {
    const result = classify({
      issues: [
        issue({ status: "done" }),
        issue({
          id: watchdogId,
          identifier: "PAP-3",
          title: "Watchdog",
          parentId: sourceId,
          originKind: "task_watchdog",
          status: "in_progress",
        }),
        issue({
          id: "watchdog-child-1",
          identifier: "PAP-4",
          title: "Nested watchdog work",
          parentId: watchdogId,
          originKind: "manual",
          status: "in_progress",
        }),
      ],
      activeRuns: [{ companyId, issueId: "watchdog-child-1", agentId: "agent-1", status: "running" }],
    });

    expect(result.state).toBe("stopped");
    expect(result.includedIssueIds).toEqual([sourceId]);
  });

  it("does not change the stop fingerprint when a task-watchdog-origin review issue is commented on or closed (SFB-87 repro)", () => {
    // Regression for SFB-87: a watchdog agent commenting on / closing its own
    // review issue (originKind: task_watchdog, parented under the watched
    // source issue) must never perturb the *source* issue's stop fingerprint.
    // excludedOriginKinds is supposed to make task_watchdog children fully
    // invisible to the parent's fingerprint computation -- this proves it,
    // independent of the separate touch-timestamp churn bug tracked by SFB-58.
    const first = classify({
      issues: [
        issue({ status: "blocked" }),
        issue({
          id: watchdogId,
          identifier: "PAP-3",
          title: "Watchdog review",
          parentId: sourceId,
          originKind: "task_watchdog",
          status: "in_progress",
          latestCommentAt: new Date("2026-07-11T20:30:00.000Z"),
        }),
      ],
    });
    expect(first.state).toBe("stopped");
    if (first.state !== "stopped") return;

    const afterWatchdogChurn = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: first.stopFingerprint,
      },
      issues: [
        issue({ status: "blocked" }),
        issue({
          id: watchdogId,
          identifier: "PAP-3",
          title: "Watchdog review",
          parentId: sourceId,
          originKind: "task_watchdog",
          status: "done",
          latestCommentAt: new Date("2026-07-11T21:07:44.975Z"),
          documentCount: 1,
          latestDocumentAt: new Date("2026-07-11T21:07:00.000Z"),
        }),
      ],
    });

    expect(afterWatchdogChurn).toMatchObject({
      state: "already_reviewed",
      stopFingerprint: first.stopFingerprint,
    });
  });

  it("defers a stopped verdict for an issue created inside the first-run grace window", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ status: "todo", createdAt })],
      // Evaluation races the issue's own assignment run ~100ms after creation.
      evaluatedAt: new Date("2026-06-18T16:32:45.835Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result.state).toBe("pending_first_run");
    if (result.state !== "pending_first_run") return;
    expect(result.pendingIssueIds).toEqual([sourceId]);
  });

  it("does not defer when a recently-created issue already completed a run", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ status: "blocked", createdAt })],
      evaluatedAt: new Date("2026-06-18T16:32:48.000Z"),
      firstRunGraceMs: 15_000,
      completedRunIssueIds: [sourceId],
    });

    expect(result.state).toBe("stopped");
  });

  it("treats a queued assignment run inside the create-race window as live", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ status: "todo", createdAt })],
      activeRuns: [{ companyId, issueId: sourceId, agentId: "agent-1", status: "queued" }],
      evaluatedAt: new Date("2026-06-18T16:32:45.835Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result).toMatchObject({ state: "live", liveIssueIds: [sourceId] });
  });

  it("treats a queued assignment wake inside the create-race window as live", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ status: "todo", createdAt })],
      queuedWakeRequests: [{ companyId, issueId: sourceId, agentId: "agent-1", status: "queued" }],
      evaluatedAt: new Date("2026-06-18T16:32:45.835Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result).toMatchObject({ state: "live", liveIssueIds: [sourceId] });
  });

  it("triggers a genuinely idle assigned issue once the grace window has elapsed", () => {
    const createdAt = new Date("2026-06-18T16:32:45.731Z");
    const result = classify({
      issues: [issue({ status: "todo", createdAt })],
      // 60s later: no run, no wake, past the grace window.
      evaluatedAt: new Date("2026-06-18T16:33:45.731Z"),
      firstRunGraceMs: 15_000,
    });

    expect(result.state).toBe("stopped");
  });

  it("does not evaluate a task-watchdog issue as a watched source", () => {
    const result = classify({
      watchdog: {
        companyId,
        issueId: watchdogId,
        lastReviewedFingerprint: null,
      },
      issues: [
        issue({
          id: watchdogId,
          identifier: "PAP-3",
          title: "Watchdog",
          originKind: "task_watchdog",
        }),
      ],
    });

    expect(result.state).toBe("not_applicable");
  });
});
