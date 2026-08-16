import { describe, expect, it } from "vitest";
import {
  bindAtomicReviewDecision,
  executorRunSucceeded,
  formatLifecycleTimeoutDiagnostics,
  matchesAuthoritativeStageRun,
  matchesExecutorRun,
  resolveAuthoritativeRunIssue,
} from "../test-support/signoff-policy-run-binding.js";

const expected: {
  companyId: string;
  issueId: string;
  agentId: string;
  stageId: string;
  stageType: "review" | "approval";
  reviewRoundId: string | null;
} = {
  companyId: "company-1",
  issueId: "issue-1",
  agentId: "reviewer-1",
  stageId: "stage-1",
  stageType: "review",
  reviewRoundId: "round-1",
};

function validRun() {
  return {
    id: "run-1",
    companyId: expected.companyId,
    agentId: expected.agentId,
    status: "running",
    finishedAt: null,
    invocationSource: "assignment",
    contextSnapshot: {
      issueId: expected.issueId,
      taskId: expected.issueId,
      source: "issue.execution_stage",
      wakeReason: "execution_review_requested",
      executionStage: {
        wakeRole: "reviewer",
        stageId: expected.stageId,
        stageType: expected.stageType,
        reviewRoundId: expected.reviewRoundId,
        currentParticipant: { type: "agent", agentId: expected.agentId },
        allowedActions: ["approve", "request_changes"],
      },
    },
  };
}

describe("signoff-policy authoritative stage run binding", () => {
  it("accepts only the active unfinished run for the exact review stage participant", () => {
    expect(matchesAuthoritativeStageRun(validRun(), expected)).toBe(true);
  });

  it.each([
    ["finished", { finishedAt: "2026-01-01T00:00:00.000Z" }],
    ["not running", { status: "succeeded" }],
    ["wrong company", { companyId: "company-2" }],
    ["wrong agent", { agentId: "reviewer-2" }],
    ["generic timer", { invocationSource: "timer" }],
    ["wrong issue", { contextSnapshot: { ...validRun().contextSnapshot, issueId: "issue-2", taskId: "issue-2" } }],
    ["generic source", { contextSnapshot: { ...validRun().contextSnapshot, source: "issue_assigned" } }],
    ["wrong wake reason", { contextSnapshot: { ...validRun().contextSnapshot, wakeReason: "issue_assigned" } }],
    ["wrong role", { contextSnapshot: { ...validRun().contextSnapshot, executionStage: { ...validRun().contextSnapshot.executionStage, wakeRole: "approver" } } }],
    ["wrong stage", { contextSnapshot: { ...validRun().contextSnapshot, executionStage: { ...validRun().contextSnapshot.executionStage, stageId: "stage-2" } } }],
    ["wrong round", { contextSnapshot: { ...validRun().contextSnapshot, executionStage: { ...validRun().contextSnapshot.executionStage, reviewRoundId: "round-2" } } }],
    ["wrong participant", { contextSnapshot: { ...validRun().contextSnapshot, executionStage: { ...validRun().contextSnapshot.executionStage, currentParticipant: { type: "agent", agentId: "reviewer-2" } } } }],
  ])("rejects %s candidates", (_label, patch) => {
    expect(matchesAuthoritativeStageRun({ ...validRun(), ...patch }, expected)).toBe(false);
  });

  it("binds a fresh issue snapshot to the exact selected run and stage", () => {
    const issue = {
      id: expected.issueId,
      companyId: expected.companyId,
      status: "in_review",
      updatedAt: "2026-08-13T12:00:00.000Z",
      executionState: {
        status: "pending",
        currentStageId: expected.stageId,
        currentStageType: expected.stageType,
        reviewRoundId: expected.reviewRoundId,
        currentParticipant: { type: "agent", agentId: expected.agentId },
      },
    };
    expect(bindAtomicReviewDecision(issue, "run-1", expected)).toEqual({
      reviewerRunId: "run-1",
      stageId: expected.stageId,
      reviewRoundId: expected.reviewRoundId,
      expectedUpdatedAt: issue.updatedAt,
    });
    expect(bindAtomicReviewDecision({ ...issue, updatedAt: "2026-08-13T12:01:00.000Z" }, "run-1", expected))
      .toMatchObject({ expectedUpdatedAt: "2026-08-13T12:01:00.000Z" });
  });

  it.each([
    ["stale stage", { currentStageId: "stage-2" }],
    ["stale round", { reviewRoundId: "round-2" }],
    ["wrong role participant", { currentParticipant: { type: "agent", agentId: "approver-1" } }],
    ["finished stage", { status: "completed" }],
  ])("refuses a fresh binding for %s", (_label, statePatch) => {
    const issue = {
      id: expected.issueId,
      companyId: expected.companyId,
      status: "in_review",
      updatedAt: "2026-08-13T12:00:00.000Z",
      executionState: {
        status: "pending",
        currentStageId: expected.stageId,
        currentStageType: expected.stageType,
        reviewRoundId: expected.reviewRoundId,
        currentParticipant: { type: "agent", agentId: expected.agentId },
        ...statePatch,
      },
    };
    expect(bindAtomicReviewDecision(issue, "run-1", expected)).toBeNull();
  });

  it("validates approval wake semantics independently", () => {
    const run = validRun();
    run.contextSnapshot.wakeReason = "execution_approval_requested";
    run.contextSnapshot.executionStage.wakeRole = "approver";
    run.contextSnapshot.executionStage.stageType = "approval";
    expect(matchesAuthoritativeStageRun(run, { ...expected, stageType: "approval" })).toBe(true);
  });

  it("matches only the exact executor lifecycle and requires terminal success", () => {
    const executorExpected = {
      companyId: expected.companyId,
      issueId: expected.issueId,
      agentId: "executor-1",
      wakeReason: "issue_assigned" as const,
    };
    const run = {
      id: "executor-run-1",
      companyId: expected.companyId,
      agentId: executorExpected.agentId,
      status: "running",
      finishedAt: null,
      contextSnapshot: {
        issueId: expected.issueId,
        taskId: expected.issueId,
        wakeReason: "issue_assigned",
      },
    };
    expect(matchesExecutorRun(run, executorExpected)).toBe(true);
    expect(executorRunSucceeded(run, executorExpected)).toBe(false);
    expect(executorRunSucceeded({ ...run, status: "succeeded", finishedAt: "2026-08-13T12:00:01.000Z" }, executorExpected)).toBe(true);
    expect(matchesExecutorRun({ ...run, agentId: "executor-2" }, executorExpected)).toBe(false);
    expect(matchesExecutorRun({ ...run, contextSnapshot: { ...run.contextSnapshot, issueId: "issue-2", taskId: "issue-2" } }, executorExpected)).toBe(false);
    expect(matchesExecutorRun({ ...run, contextSnapshot: { ...run.contextSnapshot, wakeReason: "timer" } }, executorExpected)).toBe(false);
  });

  it("rejects stale stage and round metadata on executor resubmission", () => {
    const expectedResubmission = {
      companyId: expected.companyId,
      issueId: expected.issueId,
      agentId: "executor-1",
      wakeReason: "execution_changes_requested" as const,
      stageId: expected.stageId,
      reviewRoundId: expected.reviewRoundId,
    };
    const run = {
      companyId: expected.companyId,
      agentId: "executor-1",
      contextSnapshot: {
        issueId: expected.issueId,
        taskId: expected.issueId,
        source: "issue.execution_stage",
        wakeReason: "execution_changes_requested",
        executionStage: { wakeRole: "executor", stageId: expected.stageId, reviewRoundId: expected.reviewRoundId },
      },
    };
    expect(matchesExecutorRun(run, expectedResubmission)).toBe(true);
    expect(matchesExecutorRun({ ...run, contextSnapshot: { ...run.contextSnapshot, executionStage: { stageId: "stage-2", reviewRoundId: expected.reviewRoundId } } }, expectedResubmission)).toBe(false);
    expect(matchesExecutorRun({ ...run, contextSnapshot: { ...run.contextSnapshot, executionStage: { stageId: expected.stageId, reviewRoundId: "round-2" } } }, expectedResubmission)).toBe(false);
  });

  it("resolves issue identity only from the exact authoritative run", () => {
    const run = validRun();
    expect(resolveAuthoritativeRunIssue(run, {
      runId: "run-1",
      companyId: expected.companyId,
      agentId: expected.agentId,
      issueId: expected.issueId,
    })).toEqual({ runId: "run-1", issueId: expected.issueId });
  });

  it.each([
    ["missing issue context", { contextSnapshot: { source: "issue.execution_stage" } }],
    ["malformed response", "not-an-object"],
    ["wrong company", { ...validRun(), companyId: "company-2" }],
    ["wrong agent", { ...validRun(), agentId: "reviewer-2" }],
    ["wrong issue", { ...validRun(), contextSnapshot: { ...validRun().contextSnapshot, issueId: "issue-2", taskId: "issue-2" } }],
    ["generic timer", { ...validRun(), invocationSource: "timer" }],
  ])("fails closed for %s during authoritative issue resolution", (_label, run) => {
    expect(resolveAuthoritativeRunIssue(run, {
      runId: "run-1",
      companyId: expected.companyId,
      agentId: expected.agentId,
      issueId: expected.issueId,
    })).toBeNull();
  });

  it("ignores agreeing environment issue IDs because run context is authoritative", () => {
    const run = { ...validRun(), contextSnapshot: { ...validRun().contextSnapshot, issueId: "issue-2", taskId: "issue-2" } };
    const environmentIssueId = expected.issueId;
    expect(environmentIssueId).toBe(expected.issueId);
    expect(resolveAuthoritativeRunIssue(run, {
      runId: "run-1",
      companyId: expected.companyId,
      agentId: expected.agentId,
      issueId: expected.issueId,
    })).toBeNull();
  });

  it("does not require environment issue IDs for valid run-based resolution", () => {
    const environmentIssueId = undefined;
    expect(environmentIssueId).toBeUndefined();
    expect(resolveAuthoritativeRunIssue(validRun(), {
      runId: "run-1",
      companyId: expected.companyId,
      agentId: expected.agentId,
      issueId: expected.issueId,
    })).toEqual({ runId: "run-1", issueId: expected.issueId });
  });

  it("formats bounded timeout diagnostics with issue and candidate metadata", () => {
    const diagnostics = formatLifecycleTimeoutDiagnostics({
      issue: { id: expected.issueId, status: "in_review", assigneeAgentId: expected.agentId, executionState: { currentStageId: expected.stageId, reviewRoundId: expected.reviewRoundId } },
      expected,
      candidates: [validRun(), { ...validRun(), id: "run-2" }],
    });
    expect(diagnostics).toContain(expected.issueId);
    expect(diagnostics).toContain(expected.stageId);
    expect(diagnostics).toContain(expected.reviewRoundId);
    expect(diagnostics).toContain("run-1");
    expect(diagnostics.length).toBeLessThan(8000);
  });
});
