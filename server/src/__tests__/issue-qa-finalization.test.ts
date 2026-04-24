import { describe, expect, it, vi } from "vitest";
import { finalizeQaValidatedIssueFromComment } from "../services/issue-qa-finalization.js";

describe("finalizeQaValidatedIssueFromComment", () => {
  it("closes a blocked workflow QA lane when its QA lane gate is already satisfied", async () => {
    const update = vi.fn();
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn();
    const evaluateLaneCompletion = vi.fn(async () => ({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
      authorizedOwnerAgentId: "agent-qa-release",
    }));
    const getWakeableParentAfterChildCompletion = vi.fn(async () => ({
      id: "root-1",
      assigneeAgentId: "agent-root",
      childIssueIds: ["issue-1"],
    }));

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "blocked",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      executionState: {
        lastDecisionOutcome: null,
      },
      parentId: "root-1",
    };

    update.mockResolvedValue({
      ...issue,
      status: "done",
    });

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-1",
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-release",
        agentId: "agent-qa-release",
        runId: "run-1",
      },
      logActivity,
      issues: {
        update,
        addComment,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
      workflow: {
        evaluateLaneCompletion,
        getWakeableParentAfterChildCompletion,
      },
    });

    expect(evaluateLaneCompletion).toHaveBeenCalledWith(issue);
    expect(update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ status: "done" }),
    );
    expect(result.issue.status).toBe("done");
    expect(result.parentWakeup).toEqual({
      id: "root-1",
      assigneeAgentId: "agent-root",
      childIssueIds: ["issue-1"],
    });
  });

  it("closes a workflow QA lane when its QA lane gate is satisfied and returns the wakeable parent", async () => {
    const update = vi.fn();
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn();
    const evaluateLaneCompletion = vi.fn(async () => ({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
      authorizedOwnerAgentId: "agent-qa-release",
    }));
    const getWakeableParentAfterChildCompletion = vi.fn(async () => ({
      id: "root-1",
      assigneeAgentId: "agent-root",
      childIssueIds: ["issue-1"],
    }));

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "in_review",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: "qa",
      executionState: {
        lastDecisionOutcome: null,
      },
      parentId: "root-1",
    };

    update.mockResolvedValue({
      ...issue,
      status: "done",
    });

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-1",
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-release",
        agentId: "agent-qa-release",
        runId: "run-1",
      },
      logActivity,
      issues: {
        update,
        addComment,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
      workflow: {
        evaluateLaneCompletion,
        getWakeableParentAfterChildCompletion,
      },
    });

    expect(evaluateLaneCompletion).toHaveBeenCalledWith(issue);
    expect(update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ status: "done" }),
    );
    expect(result.issue.status).toBe("done");
    expect(result.mergeStatus).toBeNull();
    expect(result.parentWakeup).toEqual({
      id: "root-1",
      assigneeAgentId: "agent-root",
      childIssueIds: ["issue-1"],
    });
    expect(attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalled();
  });

  it("treats the workflow QA lane assignee as authoritative when qaReviewerAgentId is stale", async () => {
    const update = vi.fn();
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn();
    const evaluateLaneCompletion = vi.fn(async () => ({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
      authorizedOwnerAgentId: "agent-qa-runner",
    }));

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "in_review",
      assigneeAgentId: "agent-qa-runner",
      assigneeUserId: null,
      qaReviewerAgentId: "agent-qa-release",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      executionState: {
        lastDecisionOutcome: null,
      },
      parentId: "root-1",
    };

    update.mockResolvedValue({
      ...issue,
      qaReviewerAgentId: issue.assigneeAgentId,
      status: "done",
    });

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-1",
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        authorAgentId: "agent-qa-runner",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-runner",
        agentId: "agent-qa-runner",
        runId: "run-1",
      },
      logActivity,
      issues: {
        update,
        addComment,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
      workflow: {
        evaluateLaneCompletion,
      },
    });

    expect(evaluateLaneCompletion).toHaveBeenCalledWith(issue);
    expect(result.issue.status).toBe("done");
    expect(result.mergeStatus).toBeNull();
    expect(addComment).not.toHaveBeenCalled();
  });

  it("does not finalize workflow QA lanes from stale qaReviewerAgentId when the lane is unassigned", async () => {
    const update = vi.fn();
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn();
    const evaluateLaneCompletion = vi.fn();

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: null,
      qaReviewerAgentId: "agent-qa-release",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      executionState: {
        lastDecisionOutcome: null,
      },
      parentId: "root-1",
    };

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-1",
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-release",
        agentId: "agent-qa-release",
        runId: "run-1",
      },
      logActivity,
      issues: {
        update,
        addComment,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
      workflow: {
        evaluateLaneCompletion,
      },
    });

    expect(result.issue).toBe(issue);
    expect(update).not.toHaveBeenCalled();
    expect(evaluateLaneCompletion).not.toHaveBeenCalled();
  });

  it("closes from the latest valid canonical QA verdict when the current heartbeat comment is transcript noise", async () => {
    const update = vi.fn(async () => ({
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "done",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: null,
      executionState: {
        lastDecisionOutcome: null,
      },
    }));
    const addComment = vi.fn();
    const listComments = vi.fn(async () => ([
      {
        id: "comment-noise",
        body: [
          "↻ Resumed session 20260421_000731_c4b4df (1 user message, 58 total messages)",
          "",
          "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
          "Let me inspect the current issue state before posting the final verdict.",
          "╰──────────────────────────────────────────────────────────────────────────────╯",
        ].join("\n"),
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:05:00Z"),
      },
      {
        id: "comment-verdict",
        body: [
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
          "",
          "Smart Review Summary",
          "Root cause: release gate picked up transcript output instead of the QA verdict.",
          "Fix: preserved the final verdict and verified the cart locale patch.",
          "Tests: 7/7 passing.",
          "Verification: build verified and release readiness confirmed.",
        ].join("\n"),
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
    ]));
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn(async () => ({ outcome: "not_applicable" as const, status: null }));

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "in_review",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: null,
      executionState: {
        lastDecisionOutcome: null,
      },
      executionWorkspaceId: null,
    };

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-noise",
        body: "↻ Resumed session 20260421_000731_c4b4df",
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:05:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-release",
        agentId: "agent-qa-release",
        runId: "run-1",
      },
      logActivity,
      resolveReleaseGateQaAgent: async () => ({
        releaseGateQaAgent: { id: "agent-qa-release", name: "QA and Release Engineer" },
      }),
      issues: {
        update,
        addComment,
        listComments,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
    });

    expect(listComments).toHaveBeenCalledWith("issue-1");
    expect(update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ status: "done" }),
    );
    expect(result.issue.status).toBe("done");
    expect(attemptQaPassAutoMerge).toHaveBeenCalled();
  });

  it("closes from a DONE-style canonical QA verdict during reconciliation even without literal ship markers", async () => {
    const update = vi.fn(async () => ({
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "done",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: null,
      executionState: {
        lastDecisionOutcome: null,
      },
    }));
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn(async () => ({ outcome: "not_applicable" as const, status: null }));

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "in_review",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: null,
      executionState: {
        lastDecisionOutcome: null,
      },
      executionWorkspaceId: null,
    };

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-verdict",
        body: [
          "DONE: QA verification completed for COMA-1322.",
          "Fix confirmed: cart.modeStatus.idle is present in es.json and component wiring verified.",
          "Build blocker COMA-1320 is done.",
          "QA PASS - release readiness confirmed.",
        ].join("\n"),
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-release",
        agentId: "agent-qa-release",
        runId: null,
      },
      logActivity,
      resolveReleaseGateQaAgent: async () => ({
        releaseGateQaAgent: { id: "agent-qa-release", name: "QA and Release Engineer" },
      }),
      issues: {
        update,
        addComment,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
    });

    expect(update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ status: "done" }),
    );
    expect(result.issue.status).toBe("done");
    expect(attemptQaPassAutoMerge).toHaveBeenCalled();
  });

  it("closes from a canonical QA verdict with a bold summary heading and equality verification tokens", async () => {
    const update = vi.fn(async () => ({
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "done",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: null,
      executionState: {
        lastDecisionOutcome: null,
      },
    }));
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn(async () => ({ outcome: "not_applicable" as const, status: null }));

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      status: "in_review",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: null,
      executionState: {
        lastDecisionOutcome: null,
      },
      executionWorkspaceId: null,
    };

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-verdict",
        body: [
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
          "",
          "**Smart Review Summary**",
          "Root cause: the QA parser only recognized bracketed verification tokens.",
          "Fix: accept the existing equality token form used by heartbeat verdicts.",
          "Files: server/src/services/qa-gate.ts",
          "",
          "TYPECHECK=pass",
          "TESTS=pass",
          "BUILD=pass",
          "SMOKE/NA=pass",
        ].join("\n"),
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-release",
        agentId: "agent-qa-release",
        runId: "run-1",
      },
      logActivity,
      resolveReleaseGateQaAgent: async () => ({
        releaseGateQaAgent: { id: "agent-qa-release", name: "QA and Release Engineer" },
      }),
      issues: {
        update,
        addComment,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
    });

    expect(update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ status: "done" }),
    );
    expect(result.issue.status).toBe("done");
    expect(attemptQaPassAutoMerge).toHaveBeenCalled();
  });

  it("does not duplicate merge-blocked comments for the same QA verdict during reconciliation", async () => {
    const update = vi.fn();
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const listComments = vi.fn(async () => ([
      {
        id: "comment-noise",
        body: [
          "↻ Resumed session 20260421_000731_c4b4df (1 user message, 58 total messages)",
          "",
          "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
          "Checking whether the merge blocker has cleared before posting again.",
          "╰──────────────────────────────────────────────────────────────────────────────╯",
        ].join("\n"),
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:10:00Z"),
      },
      {
        id: "comment-merge-blocked",
        body: [
          "[merge-blocked]",
          "QA validation passed, but auto-merge is blocked.",
          "Branch protection requires one more approval.",
        ].join("\n"),
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:05:00Z"),
      },
      {
        id: "comment-verdict",
        body: [
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
          "",
          "Smart Review Summary",
          "Root cause: release gate picked up transcript output instead of the QA verdict.",
          "Fix: preserved the final verdict and verified the cart locale patch.",
          "Tests: 7/7 passing.",
          "Verification: build verified and release readiness confirmed.",
        ].join("\n"),
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:00:00Z"),
      },
    ]));
    const attemptQaPassAutoMerge = vi.fn(async () => ({
      outcome: "blocked" as const,
      status: {
        state: "blocked",
        targetBranch: "main",
        sourceBranch: "qa/issue-1",
        repoRoot: "/repo",
        reason: "Branch protection requires one more approval.",
        mergedCommit: null,
        mergedAt: null,
        lastAttemptedAt: new Date("2026-04-20T08:10:00Z"),
      },
    }));

    const issue = {
      id: "issue-1",
      companyId: "company-1",
      projectId: "project-1",
      status: "in_review",
      assigneeAgentId: "agent-qa-release",
      assigneeUserId: null,
      workflowTemplateKey: null,
      workflowLaneRole: null,
      executionState: {
        lastDecisionOutcome: null,
      },
      executionWorkspaceId: null,
      identifier: "COMA-1321",
    };

    const result = await finalizeQaValidatedIssueFromComment({
      db: {} as any,
      issue,
      comment: {
        id: "comment-noise",
        body: "↻ Resumed session 20260421_000731_c4b4df",
        authorAgentId: "agent-qa-release",
        createdAt: new Date("2026-04-20T08:10:00Z"),
      },
      actor: {
        actorType: "agent",
        actorId: "agent-qa-release",
        agentId: "agent-qa-release",
        runId: "run-1",
      },
      logActivity,
      issues: {
        update,
        addComment,
        listComments,
      },
      issueMerge: {
        attemptQaPassAutoMerge,
      },
      projects: {
        getById: async () => null,
      },
      executionWorkspaces: {
        getById: async () => null,
      },
      persistExecutionWorkspaceMergeStatus: async () => null,
    });

    expect(result.issue).toBe(issue);
    expect(result.mergeStatus).toMatchObject({
      state: "blocked",
      reason: "Branch protection requires one more approval.",
    });
    expect(attemptQaPassAutoMerge).toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});
