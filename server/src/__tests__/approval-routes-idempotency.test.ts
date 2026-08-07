import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  withdraw: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  listReviewAttention: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1", agentId = "agent-1") {
  const runRows = [{
    id: runId,
    companyId: "company-1",
    agentId,
    contextSnapshot,
  }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(
            Object.keys(selection).includes("contextSnapshot") ? runRows : [],
          ),
        })),
      })),
    })),
  } as any;
}

async function createAgentApp(options: {
  runId?: string;
  contextSnapshot?: Record<string, unknown>;
  actorOverrides?: Record<string, unknown>;
} = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: options.runId ?? "run-1",
      source: "api_key",
      isInstanceAdmin: false,
      ...options.actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(options.contextSnapshot, options.runId ?? "run-1")));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.withdraw.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockIssueService.listReviewAttention.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("derives approval attribution from the authenticated actor on approve", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-4",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-4",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-4/approve")
      .send({ decidedByUserId: "forged-user", decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-4", "user-1", "ship it");
  });

  it("derives approval attribution from the authenticated actor on reject", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-5",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-5",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-5/reject")
      .send({ decidedByUserId: "forged-user", decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-5", "user-1", "not now");
  });

  it("derives approval attribution from the authenticated actor on request revision", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "revision_requested",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-6/request-revision")
      .send({ decidedByUserId: "forged-user", decisionNote: "Need changes" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      "approval-6",
      "user-1",
      "Need changes",
    );
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Approve hosting spend" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: { title: "Approve hosting spend" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
    });
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
      }),
    );
  });

  it("ignores an agent-supplied requester id and persists the authenticated agent", async () => {
    mockApprovalService.create.mockImplementation(async (_companyId, input) => ({
      id: "approval-spoof",
      companyId: "company-1",
      ...input,
    }));

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        requestedByAgentId: "00000000-0000-4000-8000-000000000099",
        payload: { title: "Spoof requester" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: "agent-1" }),
    );
  });

  it("lets the requesting agent withdraw its own pending approval and records bounded audit metadata", async () => {
    const pending = {
      id: "approval-own",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    };
    const withdrawn = {
      ...pending,
      status: "withdrawn",
      decisionNote: "Superseded",
      withdrawnByAgentId: "agent-1",
      withdrawnByUserId: null,
      withdrawnAt: new Date("2026-08-06T12:00:00.000Z"),
    };
    mockApprovalService.getById.mockResolvedValue(pending);
    mockApprovalService.withdraw.mockResolvedValue({ approval: withdrawn, applied: true });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-own/withdraw")
      .send({ reason: "  Superseded  " });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockApprovalService.withdraw).toHaveBeenCalledWith(
      "approval-own",
      { agentId: "agent-1", userId: null },
      "Superseded",
    );
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "approval.withdraw:any" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.withdrawn",
        actorType: "agent",
        actorId: "agent-1",
        details: expect.objectContaining({
          authorizationMode: "requester",
          reason: "Superseded",
          withdrawnByAgentId: "agent-1",
        }),
      }),
    );
  });

  it("fences a task_bridge-scoped requester from withdrawing its parent agent's own approval card", async () => {
    const pending = {
      id: "approval-scoped-tb",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    };
    mockApprovalService.getById.mockResolvedValue(pending);
    // A task_bridge key acts AS its parent agent, so the bare requester identity check
    // (actor.agentId === requestedByAgentId) passes. The real decideTaskBridgeAccess denies
    // company_scope:read; mirror that here so the boundary gate must run BEFORE the requester
    // branch to fence the key. Against 4388a9ea (no gate) the requester branch withdraws → 200.
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) =>
      action === "company_scope:read"
        ? { allowed: false, action, reason: "deny_scope", explanation: "Task bridge keys cannot use company-wide APIs." }
        : { allowed: true, action, reason: "allow_test", explanation: "Allowed by test mock." },
    );

    const res = await request(await createAgentApp({
      actorOverrides: { keyScope: { kind: "task_bridge", keyId: "key-tb-1" } },
    }))
      .post("/api/approvals/approval-scoped-tb/withdraw")
      .send({ reason: "Suppress parent homework" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Approvals are outside this actor's authorization boundary");
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("fences a skill_test-scoped requester from withdrawing its parent agent's own approval card", async () => {
    const pending = {
      id: "approval-scoped-st",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    };
    mockApprovalService.getById.mockResolvedValue(pending);
    // Same fence for skill_test run tokens: decideSkillTestAccess denies company_scope:read.
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) =>
      action === "company_scope:read"
        ? { allowed: false, action, reason: "deny_scope", explanation: "Skill-test run tokens cannot use company-wide APIs." }
        : { allowed: true, action, reason: "allow_test", explanation: "Allowed by test mock." },
    );

    const res = await request(await createAgentApp({
      actorOverrides: { keyScope: { kind: "skill_test", issueId: "issue-harness-1" } },
    }))
      .post("/api/approvals/approval-scoped-st/withdraw")
      .send({ reason: "Suppress parent homework" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Approvals are outside this actor's authorization boundary");
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("wakes a linked issue assignee when withdrawal removes its review path", async () => {
    const pending = {
      id: "approval-linked",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    };
    mockApprovalService.getById.mockResolvedValue(pending);
    mockApprovalService.withdraw.mockResolvedValue({
      approval: { ...pending, status: "withdrawn", decisionNote: "No longer needed" },
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1", assigneeAgentId: "agent-2" },
    ]);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map([
      ["issue-1", { state: "stalled" }],
    ]));

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-linked/withdraw")
      .send({ reason: "No longer needed" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({
        reason: "approval_withdrawn",
        requestedByActorType: "agent",
        requestedByActorId: "agent-1",
        payload: expect.objectContaining({
          approvalStatus: "withdrawn",
          issueId: "issue-1",
          reviewPathLost: true,
        }),
      }),
    );
  });

  it("denies a different same-company agent without approval.withdraw:any, even if named CEO", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-other",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-2",
    });
    // Full-privilege agent: passes the company_scope:read boundary gate but lacks the
    // approval.withdraw:any grant, so it is denied at the non-requester branch.
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) =>
      action === "approval.withdraw:any"
        ? { allowed: false, action, reason: "deny_missing_grant", explanation: "Missing permission" }
        : { allowed: true, action, reason: "allow_test", explanation: "Allowed by test mock." },
    );

    const res = await request(await createAgentApp({ actorOverrides: { role: "ceo" } }))
      .post("/api/approvals/approval-other/withdraw")
      .send({ reason: "Cleanup" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("lets an explicit approval.withdraw:any holder withdraw another request", async () => {
    const pending = {
      id: "approval-cleanup",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-2",
    };
    mockApprovalService.getById.mockResolvedValue(pending);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "approval.withdraw:any",
      reason: "allow_explicit_grant",
      explanation: "Allowed by explicit grant",
    });
    mockApprovalService.withdraw.mockResolvedValue({
      approval: {
        ...pending,
        status: "withdrawn",
        withdrawnByAgentId: "agent-1",
        withdrawnByUserId: null,
      },
      applied: true,
    });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-cleanup/withdraw")
      .send({ reason: "Backlog cleanup" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "approval.withdraw:any",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ authorizationMode: "scoped_cleanup" }),
      }),
    );
  });

  it("returns cross-company withdraw ids as not found", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-cross-company",
      companyId: "company-2",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-cross-company/withdraw")
      .send({ reason: "No longer needed" });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("blocks cheap status-only recovery runs from withdrawing approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-cheap",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-cheap/withdraw")
      .send({ reason: "No longer needed" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from creating approvals", async () => {
    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve hosting spend" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from resubmitting approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-7/resubmit")
      .send({ payload: { title: "Retry" } });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from commenting on approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-8",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-8/comments")
      .send({ body: "please approve" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
  });
});
