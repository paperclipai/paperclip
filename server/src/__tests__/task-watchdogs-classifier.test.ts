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

  it("treats in_review leaves with pending interactions as a live waiting path", () => {
    const result = classify({
      issues: [
        issue({ status: "done" }),
        issue({ id: childId, identifier: "PAP-2", parentId: sourceId, status: "in_review" }),
      ],
      pendingInteractions: [{
        companyId,
        issueId: childId,
        id: "interaction-1",
        kind: "request_confirmation",
        status: "pending",
      }],
    });

    // Fork law (watchdog in_review shield): an in_review issue with pending
    // interactions is a live waiting review path, never watchdog-triggered.
    // The 2026-07-28 merge spliced upstream's opposite expectation ("stopped
    // work that needs verification") into this fork test; the fork body is
    // restored here.
    expect(result).toMatchObject({
      state: "live",
      liveIssueIds: [childId],
    });
  });

  it("keeps the material fingerprint stable across metadata-only ticks", () => {
    const initial = classify({
      issues: [issue({
        status: "blocked",
        latestCommentAt: "2026-06-17T20:01:00.000Z",
        latestDocumentAt: "2026-06-17T20:02:00.000Z",
        latestWorkProductAt: "2026-06-17T20:03:00.000Z",
      })],
    });
    const ticked = classify({
      issues: [issue({
        status: "blocked",
        updatedAt: "2026-06-18T20:00:00.000Z",
        latestCommentAt: "2026-06-18T20:01:00.000Z",
        latestDocumentAt: "2026-06-18T20:02:00.000Z",
        latestWorkProductAt: "2026-06-18T20:03:00.000Z",
      })],
    });

    expect(initial.state).toBe("stopped");
    expect(ticked.state).toBe("stopped");
    if (initial.state !== "stopped" || ticked.state !== "stopped") return;
    expect(ticked.stopFingerprint).toBe(initial.stopFingerprint);
    expect(ticked.stoppedLeaves[0]?.updatedAt).not.toBe(initial.stoppedLeaves[0]?.updatedAt);
  });

  it("suppresses a shrink-only stopped state after a sibling completes", () => {
    // Fixture note: the upstream version used an in_review child with a
    // pending interaction, which the fork's in_review shield classifies as
    // LIVE — a blocked child keeps the subtree stopped so the shrink-only
    // suppression under test can actually run.
    const siblingId = "child-2";
    const initial = classify({
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked" }),
        issue({ id: siblingId, parentId: sourceId, status: "blocked" }),
      ],
      pendingInteractions: [{ companyId, issueId: childId, id: "interaction-1", status: "pending" }],
    });
    expect(initial.state).toBe("stopped");
    if (initial.state !== "stopped") return;

    const shrunk = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: initial.stopFingerprint,
        lastReviewedStopSnapshot: initial.stopSnapshot,
      },
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked" }),
        issue({ id: siblingId, parentId: sourceId, status: "done" }),
      ],
      pendingInteractions: [{ companyId, issueId: childId, id: "interaction-1", status: "pending" }],
    });

    expect(shrunk.state).toBe("already_reviewed");
    if (shrunk.state !== "already_reviewed") return;
    expect(shrunk.stopFingerprint).not.toBe(initial.stopFingerprint);
  });

  it("uses exact-hash behavior when the legacy reviewed snapshot is null", () => {
    const siblingId = "child-2";
    const initial = classify({
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked" }),
        issue({ id: siblingId, parentId: sourceId, status: "blocked" }),
      ],
    });
    expect(initial.state).toBe("stopped");
    if (initial.state !== "stopped") return;

    const changed = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: initial.stopFingerprint,
        lastReviewedStopSnapshot: null,
      },
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked" }),
        issue({ id: siblingId, parentId: sourceId, status: "done" }),
      ],
    });

    expect(changed.state).toBe("stopped");
  });

  it("includes waits on non-leaf issues in the material snapshot", () => {
    // Fixture note: upstream used an in_review source, which the fork's
    // in_review shield turns LIVE when it carries a pending approval. Waits
    // are snapshotted for any non-terminal issue, so an in_progress source
    // exercises the same non-leaf-waits behavior without tripping the shield.
    const initial = classify({
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked" }),
      ],
      pendingApprovals: [{ companyId, issueId: sourceId, id: "approval-1", status: "pending" }],
    });

    expect(initial.state).toBe("stopped");
    if (initial.state !== "stopped") return;
    expect(initial.stopSnapshot.waitsByIssueId).toEqual({
      [sourceId]: {
        pendingInteractionIds: [],
        pendingApprovalIds: ["approval-1"],
      },
    });

    const changed = classify({
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: initial.stopFingerprint,
        lastReviewedStopSnapshot: initial.stopSnapshot,
      },
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked" }),
      ],
      pendingApprovals: [{ companyId, issueId: sourceId, id: "approval-2", status: "pending" }],
    });

    expect(changed.state).toBe("stopped");
  });

  it.each([
    ["wait set", {
      pendingInteractions: [{ companyId, issueId: childId, id: "interaction-2", status: "pending" }],
    }],
    ["leaf status", {
      issues: [issue({ status: "in_progress" }), issue({ id: childId, parentId: sourceId, status: "todo" })],
    }],
    ["leaf assignee", {
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked", assigneeAgentId: "agent-2" }),
      ],
    }],
    ["leaf blocker", {
      blockers: [{ companyId, blockedIssueId: childId, blockerIssueId: "blocker-2" }],
    }],
    ["new stopped leaf", {
      issues: [
        issue({ status: "in_progress" }),
        issue({ id: childId, parentId: sourceId, status: "blocked" }),
        issue({ id: "child-2", parentId: sourceId, status: "blocked" }),
      ],
    }],
  ])("triggers a fresh stop when the %s changes", (_label, overrides) => {
    const baseInput = {
      issues: [issue({ status: "in_progress" }), issue({ id: childId, parentId: sourceId, status: "blocked" })],
      pendingInteractions: [{ companyId, issueId: childId, id: "interaction-1", status: "pending" }],
      blockers: [{ companyId, blockedIssueId: childId, blockerIssueId: "blocker-1" }],
    };
    const initial = classify(baseInput);
    expect(initial.state).toBe("stopped");
    if (initial.state !== "stopped") return;

    const changed = classify({
      ...baseInput,
      ...overrides,
      watchdog: {
        companyId,
        issueId: sourceId,
        lastReviewedFingerprint: initial.stopFingerprint,
        lastReviewedStopSnapshot: initial.stopSnapshot,
      },
    });

    expect(changed.state).toBe("stopped");
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
