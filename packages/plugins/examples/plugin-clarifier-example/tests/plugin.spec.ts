import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  evaluateTier0,
  type FixtureBlocker,
  type FixtureComment,
  type FixtureIssue,
  type Trigger,
} from "../src/tier0.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<FixtureIssue> = {}): FixtureIssue {
  return {
    id: randomUUID(),
    status: "in_progress",
    assigneeAgentId: randomUUID(),
    updatedAt: new Date("2026-05-15T12:00:00Z"),
    ...overrides,
  };
}

function makeComment(overrides: Partial<FixtureComment> = {}): FixtureComment {
  return {
    id: randomUUID(),
    body: "noop",
    actorType: "agent",
    authorAgentId: randomUUID(),
    createdAt: new Date("2026-05-15T11:55:00Z"),
    ...overrides,
  };
}

function fullIssue(seed: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  return {
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...seed,
  } as Issue;
}

function fullComment(seed: Partial<IssueComment> & Pick<IssueComment, "id" | "companyId" | "issueId" | "body" | "authorType">): IssueComment {
  const now = new Date();
  return {
    authorAgentId: null,
    authorUserId: null,
    presentation: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...seed,
  } as IssueComment;
}

// ---------------------------------------------------------------------------
// Pure pre-filter fixture tests (10 cases — every signal + negatives)
// ---------------------------------------------------------------------------

describe("Tier-0 pre-filter fixtures", () => {
  const now = new Date("2026-05-15T13:00:00Z");

  it("F1 — agent question triggers agent_question signal", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "in_progress" }),
      trigger: {
        kind: "comment.created",
        comment: makeComment({ body: "Should we ship this today?" }),
      },
      now,
    });
    expect(verdict).toEqual({
      eligible: true,
      signals: ["agent_question"],
      reasons: [],
    });
  });

  it("F2 — agent comment ending with '?' triggers agent_question signal", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "in_review" }),
      trigger: {
        kind: "comment.created",
        comment: makeComment({ body: "Ready to merge yet?" }),
      },
      now,
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.signals).toEqual(["agent_question"]);
  });

  it("F3 — user-authored question does NOT trigger agent_question", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "in_progress" }),
      trigger: {
        kind: "comment.created",
        comment: makeComment({
          body: "Should we ship this today?",
          actorType: "user",
          authorAgentId: null,
        }),
      },
      now,
    });
    expect(verdict).toEqual({
      eligible: false,
      signals: [],
      reasons: ["no_signal"],
    });
  });

  it("F4 — status transition to blocked triggers transitioned_to_blocked", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "blocked" }),
      trigger: {
        kind: "issue.status_changed",
        previousStatus: "in_progress",
        newStatus: "blocked",
      },
      now,
    });
    expect(verdict).toEqual({
      eligible: true,
      signals: ["transitioned_to_blocked"],
      reasons: [],
    });
  });

  it("F5 — run finished within 1h with no change since triggers run_finished_no_change", () => {
    const runFinishedAt = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "in_progress", updatedAt: new Date(runFinishedAt.getTime() - 5 * 60 * 1000) }),
      trigger: { kind: "agent.run.finished", runId: randomUUID(), runFinishedAt },
      lastRunFinishedAt: runFinishedAt,
      statusOrAssigneeChangedAt: new Date(runFinishedAt.getTime() - 5 * 60 * 1000),
      now,
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.signals).toContain("run_finished_no_change");
  });

  it("F6 — stale issue (>4h) with agent-authored last comment triggers stale_after_agent_comment", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({
        status: "in_progress",
        updatedAt: new Date(now.getTime() - 5 * 60 * 60 * 1000), // 5h ago
      }),
      trigger: { kind: "scheduled.evaluate" },
      latestComment: makeComment({
        body: "running checks",
        createdAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
      }),
      now,
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.signals).toContain("stale_after_agent_comment");
  });

  it("F7 — stuck blocker (cap depth 1) triggers stuck_blocker", () => {
    const blockers: FixtureBlocker[] = [
      { id: randomUUID(), status: "blocked", stuck: true },
    ];
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "blocked" }),
      trigger: { kind: "scheduled.evaluate" },
      blockers,
      now,
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.signals).toContain("stuck_blocker");
  });

  it("F8 — ineligible status disqualifies even with signals", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "done" }),
      trigger: {
        kind: "comment.created",
        comment: makeComment({ body: "Should we re-open?" }),
      },
      now,
    });
    expect(verdict).toEqual({
      eligible: false,
      signals: [],
      reasons: ["status_not_eligible"],
    });
  });

  it("F9 — missing assignee disqualifies even with signals", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({ status: "in_progress", assigneeAgentId: null }),
      trigger: {
        kind: "comment.created",
        comment: makeComment({ body: "How should we proceed?" }),
      },
      now,
    });
    expect(verdict).toEqual({
      eligible: false,
      signals: [],
      reasons: ["missing_assignee"],
    });
  });

  it("F10 — eligible status + assignee but no signal at all → ineligible (no_signal)", () => {
    const verdict = evaluateTier0({
      issue: makeIssue({
        status: "in_progress",
        // Fresh, just-updated issue.
        updatedAt: new Date(now.getTime() - 60_000),
      }),
      trigger: { kind: "scheduled.evaluate" },
      latestComment: makeComment({ body: "ok, working on it" }),
      blockers: [],
      lastRunFinishedAt: null,
      now,
    });
    expect(verdict).toEqual({
      eligible: false,
      signals: [],
      reasons: ["no_signal"],
    });
  });
});

// ---------------------------------------------------------------------------
// Worker wiring test — ensure the worker subscribes and persists to the table.
// ---------------------------------------------------------------------------

describe("clarifier worker wiring", () => {
  it("subscribes to comment + status + run events and writes a verdict row per evaluation", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const assigneeAgentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        fullIssue({
          id: issueId,
          companyId,
          title: "Plan a billing pipeline migration",
          status: "in_progress",
          assigneeAgentId,
          updatedAt: new Date(),
        }),
      ],
      issueComments: [
        fullComment({
          id: randomUUID(),
          companyId,
          issueId,
          body: "Should I gate the migration behind a feature flag?",
          authorType: "agent",
          authorAgentId: assigneeAgentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    expect(harness.logs.some((entry) => entry.message === "clarifier worker ready")).toBe(true);

    await harness.emit(
      "issue.comment.created",
      {
        commentId: randomUUID(),
        bodySnippet: "Should I gate the migration behind a feature flag?",
        identifier: "CAL-999",
        agentId: assigneeAgentId,
      },
      {
        companyId,
        entityId: issueId,
        entityType: "issue",
        actorType: "agent",
        actorId: assigneeAgentId,
      },
    );

    expect(harness.dbExecutes.length).toBeGreaterThan(0);
    const lastExec = harness.dbExecutes.at(-1)!;
    expect(lastExec.sql).toContain(".clarifier_eligible");
    expect(lastExec.params?.[3]).toBe(true); // eligible column
    expect(lastExec.params?.[4]).toEqual(expect.arrayContaining(["agent_question"]));
  });

  it("does not write a verdict for issue.updated payloads with no status change", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        fullIssue({
          id: issueId,
          companyId,
          title: "Stable issue",
          status: "in_progress",
          assigneeAgentId: randomUUID(),
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const before = harness.dbExecutes.length;
    await harness.emit(
      "issue.updated",
      {
        identifier: "CAL-1",
        patch: { title: "Renamed" },
        _previous: { status: "in_progress", assigneeAgentId: null, assigneeUserId: null },
      },
      { companyId, entityId: issueId, entityType: "issue" },
    );
    expect(harness.dbExecutes.length).toBe(before);
  });
});
