import { describe, expect, it, vi } from "vitest";
import { issueActionService } from "./issue-actions.js";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-501",
    title: "Ship checkout fix",
    description: null,
    status: "in_review",
    assigneeAgentId: "qa-agent-1",
    assigneeUserId: null,
    projectId: null,
    parentId: null,
    workflowTemplateKey: null,
    workflowLaneRole: null,
    executionWorkspaceId: null,
    executionState: {
      lastDecisionOutcome: null,
    },
    ...overrides,
  };
}

function createDeps() {
  const addComment = vi.fn(async (_issueId: string, body: string, actor?: { agentId?: string | null; userId?: string | null }) => ({
    id: "comment-1",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    authorAgentId: actor?.agentId ?? null,
    authorUserId: actor?.userId ?? null,
    body,
    createdAt: new Date("2026-04-22T10:00:00Z"),
    updatedAt: new Date("2026-04-22T10:00:00Z"),
  }));
  const update = vi.fn(async (_issueId: string, patch: Record<string, unknown>) => makeIssue({
    status: patch.status ?? "in_review",
    assigneeAgentId: patch.assigneeAgentId === undefined ? "qa-agent-1" : patch.assigneeAgentId,
    assigneeUserId: patch.assigneeUserId === undefined ? null : patch.assigneeUserId,
  }));
  const listComments = vi.fn(async () => []);
  const logActivity = vi.fn(async () => undefined);

  return {
    db: {} as any,
    issues: {
      update,
      addComment,
      listComments,
      getWakeableParentAfterChildCompletion: vi.fn(async () => null),
    },
    agents: {
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        role: agentId.startsWith("qa") ? "qa" : "engineer",
        name: agentId === "qa-agent-1" ? "QA and Release Engineer" : "Engineer",
      })),
      list: vi.fn(async () => [
        {
          id: "qa-agent-1",
          companyId: "company-1",
          role: "qa",
          status: "active",
          name: "QA and Release Engineer",
        },
      ]),
    },
    companies: {
      getById: vi.fn(async () => ({
        id: "company-1",
        releaseGateQaAgentId: "qa-agent-1",
      })),
    },
    projects: {
      getById: vi.fn(async () => null),
    },
    issueWorkflow: {
      decorateIssue: vi.fn(async (issue: unknown) => issue),
      evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [] })),
    },
    issueMerge: {
      attemptQaPassAutoMerge: vi.fn(async () => ({ outcome: "not_applicable" as const, status: null })),
    },
    executionWorkspaces: {
      getById: vi.fn(async () => null),
      update: vi.fn(async () => null),
    },
    documents: {
      getIssueDocumentByKey: vi.fn(async (): Promise<any> => null),
      upsertIssueDocument: vi.fn(async (input: Record<string, unknown>): Promise<any> => ({
        created: true,
        document: {
          id: "document-1",
          key: input.key ?? "qa-verdict",
          title: input.title ?? "QA verdict",
          format: input.format ?? "markdown",
          body: input.body ?? "",
          latestRevisionId: "revision-1",
          latestRevisionNumber: 1,
        },
      })),
    },
    logActivity,
  };
}

describe("issueActionService", () => {
  it("builds canonical QA verdict comments from structured payloads", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    const body = service.buildCanonicalQaVerdictComment({
      summary: {
        codeQuality: "pass",
        errorHandling: "pass",
        testCoverage: "pass",
        commentQuality: "na",
        docsImpact: "na",
      },
      verification: {
        typecheck: "pass",
        tests: "pass",
        build: "pass",
        smoke: "na",
      },
      qaPass: true,
      releaseConfirmed: true,
      summaryText: "Verified the fix and reviewed the affected files.",
      verificationText: "TYPECHECK, TESTS, and BUILD passed. Smoke is N/A for this patch.",
    });

    expect(body).toContain("[CQ:pass] [EH:pass] [TC:pass] [CM:na] [DOC:na]");
    expect(body).toContain("[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:na]");
    expect(body).toContain("[QA PASS]");
    expect(body).toContain("[RELEASE CONFIRMED]");
    expect(body).toContain("Smart Review Summary");
    expect(body).toContain("Verification Evidence");
  });

  it("submits a structured QA verdict and closes the issue when the gate passes", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);
    const issue = makeIssue();

    deps.issues.listComments.mockImplementation(async () => ([
      {
        id: "comment-1",
        companyId: "company-1",
        issueId: issue.id,
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:na] [DOC:na]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:na]\n[QA PASS]\n[RELEASE CONFIRMED]",
        createdAt: new Date("2026-04-22T10:00:00Z"),
        updatedAt: new Date("2026-04-22T10:00:00Z"),
      },
    ] as any));
    deps.issues.update.mockImplementation(async (_issueId: string, patch: Record<string, unknown>) => makeIssue({
      status: patch.status ?? "in_review",
      assigneeAgentId: "qa-agent-1",
    }));

    const result = await service.execute({
      issue,
      actor: {
        actorType: "agent",
        actorId: "qa-agent-1",
        agentId: "qa-agent-1",
        runId: "run-1",
      },
      action: {
        type: "submit_qa_verdict",
        payload: {
          summary: {
            codeQuality: "pass",
            errorHandling: "pass",
            testCoverage: "pass",
            commentQuality: "na",
            docsImpact: "na",
          },
          verification: {
            typecheck: "pass",
            tests: "pass",
            build: "pass",
            smoke: "na",
          },
          qaPass: true,
          releaseConfirmed: true,
          summaryText: "Verified the checkout flow and release readiness.",
          verificationText: "Typecheck, tests, and build are green.",
        },
      },
    });

    expect(result.generatedCommentBody).toContain("[QA PASS]");
    expect(result.comment?.body).toContain("[RELEASE CONFIRMED]");
    expect(result.issue.status).toBe("done");
    expect(deps.documents.upsertIssueDocument).toHaveBeenCalledWith(expect.objectContaining({
      issueId: issue.id,
      key: "qa-verdict",
      title: "QA verdict",
      format: "markdown",
      baseRevisionId: null,
      createdByAgentId: "qa-agent-1",
      createdByRunId: "run-1",
    }));
    expect(deps.documents.upsertIssueDocument.mock.calls[0]?.[0]?.body).toContain("# QA Verdict");
    expect(deps.documents.upsertIssueDocument.mock.calls[0]?.[0]?.body).toContain("[QA PASS]");
    expect(deps.issues.addComment).toHaveBeenCalledTimes(1);
    expect(deps.issues.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("rejects reopen_issue when the issue is already open", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    await expect(service.execute({
      issue: makeIssue({ status: "todo" }),
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
      action: {
        type: "reopen_issue",
        payload: {},
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Only closed issues can be reopened.",
    });
    expect(deps.issues.update).not.toHaveBeenCalled();
  });

  it("rejects agent append_note on a closed issue unless reopen is requested", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    await expect(service.execute({
      issue: makeIssue({ status: "done" }),
      actor: {
        actorType: "agent",
        actorId: "engineer-1",
        agentId: "engineer-1",
        runId: "run-1",
      },
      action: {
        type: "append_note",
        payload: {
          body: "Still investigating",
        },
      },
    })).rejects.toMatchObject({
      status: 409,
      message: "Issue is closed. Reopen it before posting agent updates.",
    });
    expect(deps.issues.addComment).not.toHaveBeenCalled();
  });

  it("reopens a closed issue before appending an agent note when reopen is requested", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    const result = await service.execute({
      issue: makeIssue({ status: "done" }),
      actor: {
        actorType: "agent",
        actorId: "engineer-1",
        agentId: "engineer-1",
        runId: "run-1",
      },
      action: {
        type: "append_note",
        payload: {
          body: "Picking this back up now.",
          reopen: true,
        },
      },
    });

    expect(result.issue.status).toBe("todo");
    expect(deps.issues.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    expect(deps.issues.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Picking this back up now.",
      expect.objectContaining({ agentId: "engineer-1", runId: "run-1" }),
    );
  });

  it("reassigns open issues through handoff_issue and records the handoff note", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);
    deps.issues.update.mockImplementationOnce(async (_issueId: string, patch: Record<string, unknown>) => makeIssue({
      status: patch.status ?? "in_progress",
      assigneeAgentId: patch.assigneeAgentId === undefined ? "engineer-1" : patch.assigneeAgentId,
      assigneeUserId: patch.assigneeUserId === undefined ? null : patch.assigneeUserId,
    }));

    const result = await service.execute({
      issue: makeIssue({
        status: "in_progress",
        assigneeAgentId: "engineer-1",
      }),
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
      action: {
        type: "handoff_issue",
        payload: {
          assigneeAgentId: "engineer-2",
          body: "[HANDOFF] Please pick up the follow-up fix.",
        },
      },
    });

    expect(result.issue.status).toBe("in_progress");
    expect(result.issue.assigneeAgentId).toBe("engineer-2");
    expect(deps.issues.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "engineer-2",
      }),
    );
    expect(deps.issues.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "[HANDOFF] Please pick up the follow-up fix.",
      expect.objectContaining({ userId: "local-board" }),
    );
  });

  it("reopens closed issues while reassigning them through handoff_issue", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    const result = await service.execute({
      issue: makeIssue({
        status: "done",
        assigneeAgentId: "qa-agent-1",
      }),
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
      action: {
        type: "handoff_issue",
        payload: {
          assigneeAgentId: "engineer-1",
          reopen: true,
          body: "[HANDOFF] Reopening for implementation follow-up.",
        },
      },
    });

    expect(result.issue.status).toBe("todo");
    expect(result.issue.assigneeAgentId).toBe("engineer-1");
    expect(deps.issues.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        assigneeAgentId: "engineer-1",
      }),
    );
    expect(deps.issues.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "[HANDOFF] Reopening for implementation follow-up.",
      expect.objectContaining({ userId: "local-board" }),
    );
  });

  it("rejects handoff_issue when it does not change ownership", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    await expect(service.execute({
      issue: makeIssue({
        status: "in_progress",
        assigneeAgentId: "engineer-1",
      }),
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
      action: {
        type: "handoff_issue",
        payload: {
          assigneeAgentId: "engineer-1",
          body: "[HANDOFF] This should be rejected.",
        },
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "handoff_issue requires an assignee change",
    });
    expect(deps.issues.update).not.toHaveBeenCalled();
  });

  it("rejects handoff_issue when the handoff note is empty", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    await expect(service.execute({
      issue: makeIssue({
        status: "in_progress",
        assigneeAgentId: "engineer-1",
      }),
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
      action: {
        type: "handoff_issue",
        payload: {
          assigneeAgentId: "engineer-2",
          body: "   ",
        },
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "handoff_issue requires a handoff note",
    });
    expect(deps.issues.update).not.toHaveBeenCalled();
  });

  it("auto-routes delivery issues to the configured QA owner on enter_review", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);
    const issue = makeIssue({
      status: "in_progress",
      assigneeAgentId: "engineer-1",
    });

    const result = await service.execute({
      issue,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
      action: {
        type: "enter_review",
        payload: {},
      },
    });

    expect(result.issue.status).toBe("in_review");
    expect(result.issue.assigneeAgentId).toBe("qa-agent-1");
    expect(deps.issues.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "qa-agent-1",
        assigneeUserId: null,
      }),
    );
    expect(deps.issues.addComment).toHaveBeenCalledWith(
      issue.id,
      expect.stringContaining("[qa-routing]"),
      {},
    );
  });

  it("rejects enter_review for unassigned workflow lanes", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    await expect(service.execute({
      issue: makeIssue({
        status: "todo",
        assigneeAgentId: null,
        workflowTemplateKey: "engineering_delivery_v1",
        workflowLaneRole: "security",
      }),
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
      action: {
        type: "enter_review",
        payload: {},
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Workflow issues must have an assignee before entering review.",
    });
    expect(deps.issues.update).not.toHaveBeenCalled();
  });

  it("closes workflow QA lanes when a typed QA verdict satisfies the lane gate", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);
    const issue = makeIssue({
      status: "in_review",
      assigneeAgentId: "qa-agent-1",
      qaReviewerAgentId: "qa-agent-1",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      parentId: "parent-1",
    });

    deps.issues.listComments.mockImplementation(async () => ([
      {
        id: "comment-1",
        companyId: "company-1",
        issueId: issue.id,
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:na] [DOC:na]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:na]\n[QA PASS]\n[RELEASE CONFIRMED]",
        createdAt: new Date("2026-04-22T10:00:00Z"),
        updatedAt: new Date("2026-04-22T10:00:00Z"),
      },
    ] as any));
    deps.issues.update.mockImplementation(async (_issueId: string, patch: Record<string, unknown>) => makeIssue({
      status: patch.status ?? "in_review",
      assigneeAgentId: "qa-agent-1",
      qaReviewerAgentId: "qa-agent-1",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      parentId: "parent-1",
    }));

    const result = await service.execute({
      issue,
      actor: {
        actorType: "agent",
        actorId: "qa-agent-1",
        agentId: "qa-agent-1",
        runId: "run-1",
      },
      action: {
        type: "submit_qa_verdict",
        payload: {
          summary: {
            codeQuality: "pass",
            errorHandling: "pass",
            testCoverage: "pass",
            commentQuality: "na",
            docsImpact: "na",
          },
          verification: {
            typecheck: "pass",
            tests: "pass",
            build: "pass",
            smoke: "na",
          },
          qaPass: true,
          releaseConfirmed: true,
          summaryText: "Workflow QA passed.",
          verificationText: "Typecheck and smoke passed.",
        },
      },
    });

    expect(result.issue.status).toBe("done");
    expect(deps.issueWorkflow.evaluateLaneCompletion).toHaveBeenCalled();
    expect(deps.documents.upsertIssueDocument).toHaveBeenCalledWith(expect.objectContaining({
      issueId: issue.id,
      key: "qa-verdict",
    }));
    expect(deps.issues.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("allows the assigned pooled workflow QA owner to submit a typed verdict even when release-gate QA differs", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);
    const issue = makeIssue({
      status: "in_review",
      assigneeAgentId: "qa-agent-2",
      qaReviewerAgentId: "qa-agent-2",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      parentId: "parent-1",
    });

    deps.agents.list.mockImplementation(async () => [
      {
        id: "qa-agent-1",
        companyId: "company-1",
        role: "qa",
        status: "active",
        name: "QA and Release Engineer",
      },
      {
        id: "qa-agent-2",
        companyId: "company-1",
        role: "qa",
        status: "active",
        name: "QA Runner",
      },
    ]);
    deps.issues.listComments.mockImplementation(async () => ([
      {
        id: "comment-1",
        companyId: "company-1",
        issueId: issue.id,
        authorAgentId: "qa-agent-2",
        authorUserId: null,
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:na] [DOC:na]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:na]\n[QA PASS]\n[RELEASE CONFIRMED]",
        createdAt: new Date("2026-04-22T10:00:00Z"),
        updatedAt: new Date("2026-04-22T10:00:00Z"),
      },
    ] as any));
    deps.issues.update.mockImplementation(async (_issueId: string, patch: Record<string, unknown>) => makeIssue({
      status: patch.status ?? "in_review",
      assigneeAgentId: "qa-agent-2",
      qaReviewerAgentId: "qa-agent-2",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      parentId: "parent-1",
    }));

    const result = await service.execute({
      issue,
      actor: {
        actorType: "agent",
        actorId: "qa-agent-2",
        agentId: "qa-agent-2",
        runId: "run-2",
      },
      action: {
        type: "submit_qa_verdict",
        payload: {
          summary: {
            codeQuality: "pass",
            errorHandling: "pass",
            testCoverage: "pass",
            commentQuality: "na",
            docsImpact: "na",
          },
          verification: {
            typecheck: "pass",
            tests: "pass",
            build: "pass",
            smoke: "na",
          },
          qaPass: true,
          releaseConfirmed: true,
          summaryText: "Pooled workflow QA passed.",
          verificationText: "Verification passed.",
        },
      },
    });

    expect(result.issue.status).toBe("done");
    expect(deps.documents.upsertIssueDocument).toHaveBeenCalledWith(expect.objectContaining({
      issueId: issue.id,
      createdByAgentId: "qa-agent-2",
    }));
  });

  it("rejects typed workflow QA verdicts when only a stale qaReviewerAgentId remains", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);
    const issue = makeIssue({
      status: "in_review",
      assigneeAgentId: null,
      qaReviewerAgentId: "qa-agent-1",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      parentId: "parent-1",
    });

    await expect(service.execute({
      issue,
      actor: {
        actorType: "agent",
        actorId: "qa-agent-1",
        agentId: "qa-agent-1",
        runId: "run-1",
      },
      action: {
        type: "submit_qa_verdict",
        payload: {
          summary: {
            codeQuality: "pass",
            errorHandling: "pass",
            testCoverage: "pass",
            commentQuality: "na",
            docsImpact: "na",
          },
          verification: {
            typecheck: "pass",
            tests: "pass",
            build: "pass",
            smoke: "na",
          },
          qaPass: true,
          releaseConfirmed: true,
        },
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Workflow QA lane must be assigned to an active QA reviewer.",
    });
    expect(deps.issues.addComment).not.toHaveBeenCalled();
    expect(deps.issues.update).not.toHaveBeenCalled();
  });

  it("updates the existing qa-verdict document when submitting another typed QA verdict", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);
    const issue = makeIssue();

    deps.documents.getIssueDocumentByKey.mockImplementation(async () => ({
      id: "document-1",
      key: "qa-verdict",
      title: "QA verdict",
      format: "markdown",
      body: "old body",
      latestRevisionId: "revision-4",
      latestRevisionNumber: 4,
    }));
    deps.documents.upsertIssueDocument.mockImplementation(async (input: Record<string, unknown>) => ({
      created: false,
      document: {
        id: "document-1",
        key: input.key ?? "qa-verdict",
        title: input.title ?? "QA verdict",
        format: input.format ?? "markdown",
        body: input.body ?? "",
        latestRevisionId: "revision-5",
        latestRevisionNumber: 5,
      },
    }));
    deps.issues.listComments.mockImplementation(async () => ([
      {
        id: "comment-1",
        companyId: "company-1",
        issueId: issue.id,
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:na] [DOC:na]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:na]\n[QA PASS]\n[RELEASE CONFIRMED]",
        createdAt: new Date("2026-04-22T10:00:00Z"),
        updatedAt: new Date("2026-04-22T10:00:00Z"),
      },
    ] as any));

    await service.execute({
      issue,
      actor: {
        actorType: "agent",
        actorId: "qa-agent-1",
        agentId: "qa-agent-1",
        runId: "run-2",
      },
      action: {
        type: "submit_qa_verdict",
        payload: {
          summary: {
            codeQuality: "pass",
            errorHandling: "pass",
            testCoverage: "pass",
            commentQuality: "na",
            docsImpact: "na",
          },
          verification: {
            typecheck: "pass",
            tests: "pass",
            build: "pass",
            smoke: "na",
          },
          qaPass: true,
          releaseConfirmed: true,
          summaryText: "Second QA pass.",
          verificationText: "Evidence updated.",
        },
      },
    });

    expect(deps.documents.upsertIssueDocument).toHaveBeenCalledWith(expect.objectContaining({
      issueId: issue.id,
      key: "qa-verdict",
      baseRevisionId: "revision-4",
    }));
  });

  it("rejects unauthorized structured QA verdict submissions", async () => {
    const deps = createDeps();
    const service = issueActionService(deps as any);

    await expect(service.execute({
      issue: makeIssue(),
      actor: {
        actorType: "agent",
        actorId: "engineer-1",
        agentId: "engineer-1",
        runId: "run-1",
      },
      action: {
        type: "submit_qa_verdict",
        payload: {
          summary: {
            codeQuality: "pass",
            errorHandling: "pass",
            testCoverage: "pass",
            commentQuality: "na",
            docsImpact: "na",
          },
          verification: {
            typecheck: "pass",
            tests: "pass",
            build: "pass",
            smoke: "na",
          },
          qaPass: true,
          releaseConfirmed: true,
        },
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Only the authorized release-gate QA agent can submit typed QA verdicts for this issue.",
    });
  });
});
