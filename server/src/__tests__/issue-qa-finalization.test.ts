import { describe, expect, it, vi } from "vitest";
import { finalizeQaValidatedIssueFromComment } from "../services/issue-qa-finalization.js";

describe("finalizeQaValidatedIssueFromComment", () => {
  it("skips workflow lane issues even if workflowTemplateKey is absent", async () => {
    const update = vi.fn();
    const addComment = vi.fn();
    const logActivity = vi.fn();
    const attemptQaPassAutoMerge = vi.fn();

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

    expect(result.issue).toBe(issue);
    expect(result.mergeStatus).toBeNull();
    expect(attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
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
});
