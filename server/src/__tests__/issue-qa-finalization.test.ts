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
});
