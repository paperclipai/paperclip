import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const ctoUserId = "cto-user";
const boardUserId = "board-user";

function makePolicy(
  stages: Array<{ type: "review" | "approval"; participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }> }>,
) {
  return normalizeIssueExecutionPolicy({ stages })!;
}

function twoStagePolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

function reviewOnlyPolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
  ]);
}

function approvalOnlyPolicy() {
  return makePolicy([
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

describe("normalizeIssueExecutionPolicy", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeIssueExecutionPolicy(null)).toBeNull();
    expect(normalizeIssueExecutionPolicy(undefined)).toBeNull();
  });

  it("returns null when stages are empty", () => {
    expect(normalizeIssueExecutionPolicy({ stages: [] })).toBeNull();
  });

  it("throws when all participants are invalid (missing agentId)", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [{ type: "review", participants: [{ type: "agent" }] }],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("deduplicates participants within a stage", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("assigns UUIDs to stages and participants", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.stages[0].id).toBeDefined();
    expect(result!.stages[0].participants[0].id).toBeDefined();
  });

  it("always sets commentRequired to true", () => {
    const result = normalizeIssueExecutionPolicy({
      commentRequired: false,
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.commentRequired).toBe(true);
  });

  it("defaults mode to normal", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.mode).toBe("normal");
  });

  it("rejects approvalsNeeded values above 1", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [
          {
            type: "review",
            approvalsNeeded: 2,
            participants: [{ type: "agent", agentId: qaAgentId }],
          },
        ],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("throws for invalid input", () => {
    expect(() => normalizeIssueExecutionPolicy({ stages: [{ type: "invalid_type" }] })).toThrow();
  });

  it("keeps monitor-only policies", () => {
    const result = normalizeIssueExecutionPolicy({
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        externalRef: "https://example.test/deploy?token=secret",
      },
      stages: [],
    });
    expect(result).toMatchObject({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "assignee",
        externalRef: "[redacted]",
      },
    });
  });
});

describe("parseIssueExecutionState", () => {
  it("returns null for null/undefined", () => {
    expect(parseIssueExecutionState(null)).toBeNull();
    expect(parseIssueExecutionState(undefined)).toBeNull();
  });

  it("returns null for invalid shape", () => {
    expect(parseIssueExecutionState({ status: "bogus" })).toBeNull();
  });

  it("parses a valid state", () => {
    const state = parseIssueExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state).not.toBeNull();
    expect(state!.status).toBe("pending");
  });
});

describe("issue execution policy transitions", () => {
  describe("happy path: executor → review → approval → done", () => {
    const policy = twoStagePolicy();

    it("routes executor completion into review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the feature",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
      });
      expect(result.decision).toBeUndefined();
    });

    it("carries loose review instructions on the pending handoff", () => {
      const reviewInstructions = [
        "Please focus on whether the migration path is reversible.",
        "",
        "- Check failure handling",
        "- Call out any unclear operator instructions",
      ].join("\n");

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the migration",
        reviewRequest: { instructions: reviewInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: { instructions: reviewInstructions },
      });
    });

    it("clears loose review instructions with explicit null during a stage transition", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Old review request" },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
        reviewRequest: null,
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: null,
      });
    });

    it("reviewer approves → advances to approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        completedStageIds: [reviewStageId],
        currentParticipant: { type: "user", userId: ctoUserId },
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
      });
    });

    it("lets a reviewer provide loose instructions for the next approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalInstructions = "Please decide whether this is ready to ship, with any launch caveats.";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Review the implementation details." },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
        reviewRequest: { instructions: approvalInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: ctoUserId },
        reviewRequest: { instructions: approvalInstructions },
      });
    });

    it("approver approves → marks completed (allows done)", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Approved, ship it",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: expect.arrayContaining([reviewStageId, approvalStageId]),
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
      });
      // status should NOT be overridden — caller can set done
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("changes requested flow", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer requests changes → returns to executor", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Needs another pass on edge cases",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "changes_requested",
      });
    });

    it("executor re-submits after changes → returns to same review stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "changes_requested",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Fixed edge cases",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: reviewStageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });
  });

  describe("review-only policy (no approval stage)", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer approval completes the policy", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "LGTM",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: [reviewStageId],
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageType: "review",
        outcome: "approved",
      });
    });
  });

  describe("approval-only policy (no review stage)", () => {
    const policy = approvalOnlyPolicy();

    it("executor completion routes directly to approval", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
      });
    });
  });

  describe("access control", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-participant cannot advance the active stage", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: { assigneeUserId: boardUserId },
          actor: { agentId: coderAgentId },
          commentBody: "Trying to bypass review",
        }),
      ).toThrow("Only the active reviewer or approver can advance");
    });

    it("non-participant can still post non-advancing updates", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Just a note",
      });

      // No error — just no patch modifications
      expect(result.patch).toEqual({});
    });
  });

  describe("comment requirements", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("approval without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "",
        }),
      ).toThrow("requires a comment");
    });

    it("changes requested without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).toThrow("requires a comment");
    });

    it("whitespace-only comment is treated as empty", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "   ",
        }),
      ).toThrow("requires a comment");
    });
  });

  describe("policy removal mid-flow", () => {
    it("clears execution state when policy removed and returns to executor", () => {
      // Use a real UUID for currentStageId so parseIssueExecutionState succeeds
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    });

    it("clears execution state without assignee change when not in_review", () => {
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "changes_requested",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      // Not in_review, so no status/assignee change
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("reopening from done/cancelled clears state", () => {
    it("reopening a done issue clears execution state", () => {
      const policy = twoStagePolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "done",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "todo",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });
  });

  describe("no-op transitions", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-done status change without review context is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("coerces a malformed executor in_review patch into the first policy stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: { assigneeUserId: boardUserId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });

    it("reasserts the active stage when issue status drifted out of in_review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: { assigneeAgentId: coderAgentId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
        },
      });
    });

    it("no policy and no state is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
        },
        policy: null,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("does not auto-start workflow when policy is added to an already in_review issue", () => {
      const reviewOnly = reviewOnlyPolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: boardUserId,
          executionPolicy: null,
          executionState: null,
        },
        policy: reviewOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toEqual({});
    });
  });

  describe("multi-participant stages", () => {
    it("selects the preferred participant when explicitly requested", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: { assigneeAgentId: ctoAgentId },
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(ctoAgentId);
    });

    it("falls back to first participant when no preference given", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("excludes the return assignee from participant selection", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: coderAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      // coderAgentId is the returnAssignee, so QA should be selected
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("skips a self-review-only stage and completes the workflow", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        executionState: {
          status: "completed",
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
      expect(result.patch.status).toBeUndefined();
      expect(result.patch.assigneeAgentId).toBeUndefined();
    });

    it("skips a self-review-only review stage and advances to approval", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
        {
          type: "approval",
          participants: [{ type: "user", userId: ctoUserId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: ctoUserId,
        executionState: {
          status: "pending",
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: ctoUserId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
    });
  });

  describe("changes requested with no return assignee", () => {
    it("throws when requesting changes with no return assignee", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "Changes needed",
        }),
      ).toThrow("no return assignee");
    });
  });

  describe("approval stage changes requested → bounces back to executor", () => {
    it("approver requests changes during approval stage", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Not happy with the approach, needs rework",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "approval",
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "changes_requested",
      });
    });
  });

  describe("user participants", () => {
    it("handles user-type reviewer participant correctly", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "user", userId: boardUserId }] },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(boardUserId);
    });
  });

  describe("policy edits while a stage is active", () => {
    it("clears the active execution state when its stage is removed from the policy", () => {
      const reviewAndApproval = twoStagePolicy();
      const approvalOnly = approvalOnlyPolicy();

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: reviewAndApproval,
          executionState: {
            status: "pending",
            currentStageId: reviewAndApproval.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: approvalOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionState: null,
      });
    });

    it("reassigns the active stage when the current participant is removed", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);
      const updatedPolicy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: ctoAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: policy.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: {
          ...updatedPolicy,
          stages: [{ ...updatedPolicy.stages[0], id: policy.stages[0].id }],
        },
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: ctoAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });
  });

  describe("monitor policy", () => {
    it("schedules a one-shot monitor on an active agent-owned issue", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorAttemptCount: 0,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: null,
        },
        policy,
        previousPolicy: null,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
      expect(result.patch.monitorScheduledBy).toBe("board");
      expect(result.patch.executionState).toMatchObject({
        status: "idle",
        monitor: {
          status: "scheduled",
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      });
    });

    it("auto-clears a scheduled monitor when the issue moves to done", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionPolicy).toBeNull();
      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: {
          status: "cleared",
          clearReason: "done",
        },
      });
    });

    it("rejects explicitly scheduling a monitor on an invalid issue state", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "blocked",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("rejects explicitly re-arming a monitor after max attempts are exhausted", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          maxAttempts: 1,
          scheduledBy: "assignee",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: 1,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor bounds are already exhausted");
    });
  });

  describe("stage participant selection — fallback to executor when only candidate (issue #5104)", () => {
    it("advances to Stage 2 with the executor as approver when Stage 2 has no other participants", () => {
      // Repro of the deadlock from #5104. Coder is the executor (returnAssignee).
      // Stage 2's sole participant is also the coder. Without the fallback,
      // selectStageParticipant filters the coder out, returns null, and the
      // function throws "No eligible approval participant is configured for
      // this issue" — leaving the issue stuck in `in_review` with no normal-flow
      // way out (only `PATCH executionPolicy=null` clears it, at the cost of
      // the audit trail).
      const policy = makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "approval", participants: [{ type: "agent", agentId: coderAgentId }] },
      ]);
      const reviewStage = policy.stages[0];
      const approvalStage = policy.stages[1];

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStage.id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Looks good, approving",
      });

      // After the fix: Stage 2 is in flight with the executor self-approving.
      // Self-review is better than a permanently stuck issue.
      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: approvalStage.id,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: coderAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        completedStageIds: [reviewStage.id],
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStage.id,
        outcome: "approved",
      });
    });

    it("still excludes returnAssignee when other stage participants are available", () => {
      // Regression guard. Stage 2 has both an agent and a user; the executor's
      // exclusion still routes work to the non-executor candidate.
      const policy = makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
        { type: "approval", participants: [
          { type: "agent", agentId: qaAgentId },
          { type: "user", userId: ctoUserId },
        ]},
      ]);
      const reviewStage = policy.stages[0];

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStage.id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: coderAgentId },
            returnAssignee: { type: "agent", agentId: qaAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented",
      });

      // qaAgentId is excluded (returnAssignee), so ctoUser gets the approval.
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        currentParticipant: { type: "user", userId: ctoUserId },
      });
    });

    it("preserves auto-skip when a review stage's only participant equals returnAssignee", () => {
      // Regression guard for the auto-skip path. A review stage whose only
      // participant is the executor IS auto-skipped (the existing behavior
      // canAutoSkipPendingStage asserts at line ~595). We must not collapse
      // this case into self-review by accident.
      const policy = makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
        { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done — no peer review configured for this stage",
      });

      // Stage 1 was auto-skipped (the executor doesn't review themselves);
      // Stage 2 (the approval) is now in flight.
      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        currentStageId: policy.stages[1].id,
        currentStageType: "approval",
        completedStageIds: [policy.stages[0].id],
      });
    });

    it("falls back at the post-auto-skip-loop site when the first pending stage is approval-only with the executor", () => {
      // Site-4 throw path: issue has no executionState yet, requestedStatus is
      // "done", and the workflow-start branch picks the first pending stage —
      // an approval whose sole participant equals the executor.
      // canAutoSkipPendingStage rejects approval stages, so the while loop
      // never iterates and `participant` is null entering the post-loop
      // fallback. Before the fix this throws "No eligible approval participant"
      // right at workflow start; after the fix the executor self-approves.
      const policy = makePolicy([
        { type: "approval", participants: [{ type: "agent", agentId: coderAgentId }] },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done — only configured approver is the executor",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: coderAgentId },
      });
    });

    it("falls back at the initial-active-stage path when currentParticipant is missing", () => {
      // Site-1 throw path: existingState has currentStageId but currentParticipant
      // is null (e.g., a partial state from an interrupted earlier transition).
      // The activeStage's only participant equals returnAssignee. Before the
      // fix this throws at the early "No eligible ... participant" check;
      // after the fix the executor is self-assigned.
      const policy = makePolicy([
        { type: "approval", participants: [{ type: "agent", agentId: coderAgentId }] },
      ]);
      const stage = policy.stages[0];

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: stage.id,
            currentStageIndex: 0,
            currentStageType: "approval",
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      // The function returns without throwing. We don't pin the exact patch
      // shape here — site 1's role is to NOT throw on the initial selector.
      // The lack of an error escape is the regression signal.
      expect(result.patch).toBeDefined();
    });
  });
});
