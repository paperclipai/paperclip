import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mockLoggerWarn = vi.hoisted(() => vi.fn());

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
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

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockBuilderProposalStore = vi.hoisted(() => ({
  getByApprovalId: vi.fn(),
  updateStatusFromApproval: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    builderProposalStore: () => mockBuilderProposalStore,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
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
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function createAgentApp() {
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
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
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
    vi.resetAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockBuilderProposalStore.getByApprovalId.mockReset();
    mockBuilderProposalStore.updateStatusFromApproval.mockReset();
    mockLogActivity.mockReset();
    mockLoggerWarn.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
    mockBuilderProposalStore.getByApprovalId.mockResolvedValue(null);
    mockBuilderProposalStore.updateStatusFromApproval.mockResolvedValue(null);
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

    expect(res.status).toBe(403);
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

    expect(res.status).toBe(403);
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

  it("syncs the linked builder proposal status when an approval is approved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-7",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });
    mockBuilderProposalStore.getByApprovalId.mockResolvedValue({
      id: "proposal-7",
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-7/approve")
      .send({ decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockBuilderProposalStore.updateStatusFromApproval).toHaveBeenCalledWith(
      "proposal-7",
      "applied",
      "user-1",
    );
  });

  it("keeps the linked builder proposal approved when approval is not yet fully applied", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-9",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-9",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: false,
    });
    mockBuilderProposalStore.getByApprovalId.mockResolvedValue({
      id: "proposal-9",
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-9/approve")
      .send({ decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockBuilderProposalStore.updateStatusFromApproval).toHaveBeenCalledWith(
      "proposal-9",
      "approved",
      "user-1",
    );
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

  it("syncs the linked builder proposal status when an approval is rejected", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-8",
      companyId: "company-1",
      type: "set_budget",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-8",
        companyId: "company-1",
        type: "set_budget",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });
    mockBuilderProposalStore.getByApprovalId.mockResolvedValue({
      id: "proposal-8",
      companyId: "company-1",
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-8/reject")
      .send({ decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockBuilderProposalStore.updateStatusFromApproval).toHaveBeenCalledWith(
      "proposal-8",
      "rejected",
      "user-1",
    );
  });

  it("keeps approve successful when builder proposal sync fails after approval commit", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-10",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-10",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });
    mockBuilderProposalStore.getByApprovalId.mockRejectedValue(new Error("transient proposal sync"));

    const res = await request(await createApp())
      .post("/api/approvals/approval-10/approve")
      .send({ decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-10", "user-1", "ship it");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.approved",
        entityId: "approval-10",
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-10",
        companyId: "company-1",
        status: "applied",
      }),
      "failed to sync builder proposal after approval resolution",
    );
  });

  it("keeps reject successful when builder proposal sync fails after approval commit", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-11",
      companyId: "company-1",
      type: "set_budget",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-11",
        companyId: "company-1",
        type: "set_budget",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });
    mockBuilderProposalStore.getByApprovalId.mockResolvedValue({
      id: "proposal-11",
      companyId: "company-1",
    });
    mockBuilderProposalStore.updateStatusFromApproval.mockRejectedValue(
      new Error("transient proposal update"),
    );

    const res = await request(await createApp())
      .post("/api/approvals/approval-11/reject")
      .send({ decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-11", "user-1", "not now");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.rejected",
        entityId: "approval-11",
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-11",
        companyId: "company-1",
        status: "rejected",
      }),
      "failed to sync builder proposal after approval resolution",
    );
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
});
