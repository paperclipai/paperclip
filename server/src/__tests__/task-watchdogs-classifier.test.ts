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

  it("treats a server-visible scheduled monitor as a live continuation", () => {
    const evaluatedAt = new Date("2026-07-22T05:00:00.000Z");
    const result = classify({
      issues: [
        issue({
          status: "in_review",
          monitorNextCheckAt: new Date("2026-07-22T05:40:00.000Z"),
          executionState: {
            monitor: {
              state: "scheduled",
              timeoutAt: "2026-07-23T02:00:00.000Z",
              recoveryPolicy: "wake_owner",
            },
          },
        }),
      ],
      evaluatedAt,
    });

    expect(result).toMatchObject({ state: "live", liveIssueIds: [sourceId] });
  });

  it("does not re-arm a monitored source when a watchdog child completion bumps its timestamps", () => {
    const evaluatedAt = new Date("2026-07-22T05:00:00.000Z");
    // The watchdog child completing wakes the source (issue_children_completed)
    // and bumps its updatedAt/latestCommentAt. With a live scheduled monitor the
    // source must stay `live` so no new stop fingerprint is minted — otherwise
    // the child completion feeds back into a fresh watchdog review.
    const monitoredSource = () =>
      issue({
        status: "in_review",
        updatedAt: new Date("2026-07-22T04:59:59.000Z"),
        latestCommentAt: new Date("2026-07-22T04:59:59.000Z"),
        monitorNextCheckAt: new Date("2026-07-22T05:40:00.000Z"),
        executionState: {
          monitor: { state: "scheduled", timeoutAt: "2026-07-23T02:00:00.000Z" },
        },
      });

    const before = classify({ issues: [monitoredSource()], evaluatedAt });
    expect(before.state).toBe("live");

    const afterChildCompletion = classify({
      // A prior stopped fingerprint the watchdog already acted on; the child
      // completion changed the source timestamps but the monitor is still live.
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: "task_watchdog_stop:stale",
      },
      issues: [
        {
          ...monitoredSource(),
          updatedAt: new Date("2026-07-22T05:00:01.000Z"),
          latestCommentAt: new Date("2026-07-22T05:00:01.000Z"),
        },
      ],
      evaluatedAt,
    });

    expect(afterChildCompletion).toMatchObject({ state: "live", liveIssueIds: [sourceId] });
  });

  it("does not treat an expired or exhausted monitor as live", () => {
    const evaluatedAt = new Date("2026-07-22T05:00:00.000Z");
    const result = classify({
      issues: [
        issue({
          status: "blocked",
          // nextCheckAt already elapsed relative to the evaluation snapshot.
          monitorNextCheckAt: new Date("2026-07-22T04:00:00.000Z"),
          executionState: {
            monitor: { state: "scheduled", timeoutAt: "2026-07-23T02:00:00.000Z" },
          },
        }),
      ],
      evaluatedAt,
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
