import { describe, expect, it } from "vitest";

import {
  STALE_CONTINUATION_THRESHOLD_MS,
  evaluateApprovalReconciliation,
  evaluateConfirmationReconciliation,
  type StaleApprovalCandidate,
  type StaleConfirmationCandidate,
} from "../services/recovery/continuation-reconciler.js";

const NOW = new Date("2026-05-19T12:00:00.000Z");
const STALE_AT = new Date(NOW.getTime() - STALE_CONTINUATION_THRESHOLD_MS - 1_000);
const FRESH_AT = new Date(NOW.getTime() - 60_000);

function approvalCandidate(
  overrides: Partial<StaleApprovalCandidate> = {},
): StaleApprovalCandidate {
  return {
    approvalId: "approval-1",
    requestedByAgentId: "agent-1",
    decidedAt: STALE_AT,
    linkedIssues: [{ id: "issue-1", status: "todo" }],
    hasActiveExecutionPath: false,
    hasQueuedOrDeferredWake: false,
    alreadyReconciled: false,
    ...overrides,
  };
}

function confirmationCandidate(
  overrides: Partial<StaleConfirmationCandidate> = {},
): StaleConfirmationCandidate {
  return {
    interactionId: "interaction-1",
    issueId: "issue-1",
    assigneeAgentId: "agent-1",
    issueStatus: "in_progress",
    resolvedAt: STALE_AT,
    hasActiveExecutionPath: false,
    hasQueuedOrDeferredWake: false,
    alreadyReconciled: false,
    ...overrides,
  };
}

describe("evaluateApprovalReconciliation", () => {
  it("skips when decision is younger than the bounded threshold", () => {
    const decision = evaluateApprovalReconciliation(
      approvalCandidate({ decidedAt: FRESH_AT }),
      NOW,
    );
    expect(decision).toEqual({ kind: "skip", reason: "below_threshold" });
  });

  it("skips when the approval was already reconciled (idempotence)", () => {
    const decision = evaluateApprovalReconciliation(
      approvalCandidate({ alreadyReconciled: true }),
      NOW,
    );
    expect(decision).toEqual({ kind: "skip", reason: "already_reconciled" });
  });

  it("skips when an active execution path is observed", () => {
    const decision = evaluateApprovalReconciliation(
      approvalCandidate({ hasActiveExecutionPath: true }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "skip",
      reason: "has_active_execution_path",
    });
  });

  it("skips when a queued or deferred wake is observed", () => {
    const decision = evaluateApprovalReconciliation(
      approvalCandidate({ hasQueuedOrDeferredWake: true }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "skip",
      reason: "has_queued_or_deferred_wake",
    });
  });

  it("requeues with the first actionable primary issue id when stale and unreconciled", () => {
    const decision = evaluateApprovalReconciliation(
      approvalCandidate({
        linkedIssues: [
          { id: "issue-blocked", status: "blocked" },
          { id: "issue-todo", status: "todo" },
        ],
      }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "requeue_with_primary",
      primaryIssueId: "issue-todo",
      actionableIssueIds: ["issue-todo"],
      blockedIssueIds: ["issue-blocked"],
      linkedIssueIds: ["issue-blocked", "issue-todo"],
    });
  });

  it("escalates with no-follow-up when every linked issue is blocked or terminal", () => {
    const decision = evaluateApprovalReconciliation(
      approvalCandidate({
        linkedIssues: [
          { id: "issue-blocked", status: "blocked" },
          { id: "issue-done", status: "done" },
        ],
      }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "escalate_no_follow_up",
      reason: "all_linked_issues_blocked",
      blockedIssueIds: ["issue-blocked", "issue-done"],
      linkedIssueIds: ["issue-blocked", "issue-done"],
    });
  });

  it("escalates with no-follow-up when the approval has no linked issues", () => {
    const decision = evaluateApprovalReconciliation(
      approvalCandidate({ linkedIssues: [] }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "escalate_no_follow_up",
      reason: "no_linked_issues",
      blockedIssueIds: [],
      linkedIssueIds: [],
    });
  });
});

describe("evaluateConfirmationReconciliation", () => {
  it("skips fresh confirmations within the bounded threshold", () => {
    const decision = evaluateConfirmationReconciliation(
      confirmationCandidate({ resolvedAt: FRESH_AT }),
      NOW,
    );
    expect(decision).toEqual({ kind: "skip", reason: "below_threshold" });
  });

  it("is idempotent: once reconciled, never re-acts even under process-loss cleanup", () => {
    // Simulates process-loss / continuation cleanup re-firing the reconciler:
    // the prior reconciliation activity log entry must keep us from emitting
    // a duplicate wake or duplicate escalation.
    const decision = evaluateConfirmationReconciliation(
      confirmationCandidate({ alreadyReconciled: true }),
      NOW,
    );
    expect(decision).toEqual({ kind: "skip", reason: "already_reconciled" });
  });

  it("requeues a fresh follow-up wake when the issue is actionable", () => {
    const decision = evaluateConfirmationReconciliation(
      confirmationCandidate({ issueStatus: "in_progress" }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "requeue_with_primary",
      primaryIssueId: "issue-1",
      actionableIssueIds: ["issue-1"],
      blockedIssueIds: [],
      linkedIssueIds: ["issue-1"],
    });
  });

  it("emits a visible no-follow-up escalation when the issue is blocked", () => {
    const decision = evaluateConfirmationReconciliation(
      confirmationCandidate({ issueStatus: "blocked" }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "escalate_no_follow_up",
      reason: "all_linked_issues_blocked",
      blockedIssueIds: ["issue-1"],
      linkedIssueIds: ["issue-1"],
    });
  });

  it("emits a visible no-follow-up escalation when the issue is already done", () => {
    const decision = evaluateConfirmationReconciliation(
      confirmationCandidate({ issueStatus: "done" }),
      NOW,
    );
    expect(decision).toMatchObject({
      kind: "escalate_no_follow_up",
      reason: "all_linked_issues_blocked",
    });
  });

  it("skips when the heartbeat has not yet picked up the wake (active path observed)", () => {
    const decision = evaluateConfirmationReconciliation(
      confirmationCandidate({ hasActiveExecutionPath: true }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "skip",
      reason: "has_active_execution_path",
    });
  });

  it("respects the deferred queue: when a deferred wake exists, no duplicate is queued", () => {
    const decision = evaluateConfirmationReconciliation(
      confirmationCandidate({ hasQueuedOrDeferredWake: true }),
      NOW,
    );
    expect(decision).toEqual({
      kind: "skip",
      reason: "has_queued_or_deferred_wake",
    });
  });
});

describe("reconciler idempotence under repeated invocation", () => {
  it("requeues exactly once even if the reconciler fires twice in a row", () => {
    // First pass: nothing reconciled yet, should requeue.
    const first = evaluateApprovalReconciliation(approvalCandidate(), NOW);
    expect(first.kind).toBe("requeue_with_primary");

    // Second pass simulates the deferred follow-up promotion firing again
    // after an unrelated process-loss cleanup. The activity log marker
    // (alreadyReconciled=true) ensures the deferred follow-up is not
    // cancelled or duplicated.
    const second = evaluateApprovalReconciliation(
      approvalCandidate({ alreadyReconciled: true }),
      NOW,
    );
    expect(second).toEqual({ kind: "skip", reason: "already_reconciled" });
  });

  it("escalates exactly once when all linked issues stay blocked across reconciler ticks", () => {
    const blocked = {
      linkedIssues: [{ id: "issue-blocked", status: "blocked" }],
    };
    const first = evaluateApprovalReconciliation(
      approvalCandidate(blocked),
      NOW,
    );
    expect(first.kind).toBe("escalate_no_follow_up");

    const second = evaluateApprovalReconciliation(
      approvalCandidate({ ...blocked, alreadyReconciled: true }),
      NOW,
    );
    expect(second).toEqual({ kind: "skip", reason: "already_reconciled" });
  });
});
