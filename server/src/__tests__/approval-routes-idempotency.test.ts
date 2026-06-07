import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  getById: vi.fn(),
  listComments: vi.fn(),
  update: vi.fn(),
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
    vi.clearAllMocks();
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
    mockIssueService.addComment.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.listComments.mockReset();
    mockIssueService.update.mockReset();
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
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Approval approved" });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
    });
    mockIssueService.update.mockResolvedValue({ id: "issue-1", status: "in_review" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved and artifacts exist", async () => {
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
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-1",
        issueId: "issue-1",
        deletedAt: null,
        body: "Approval approved: approval-1",
        metadata: {
          version: 1,
          sections: [
            {
              title: "Approval resolution",
              rows: [
                { type: "key_value", label: "approvalId", value: "approval-1" },
                { type: "key_value", label: "outcome", value: "approved" },
              ],
            },
          ],
        },
      },
    ]);

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).toHaveBeenCalledWith("approval-1");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved and artifacts exist", async () => {
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
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-1",
        issueId: "issue-1",
        deletedAt: null,
        body: "Approval rejected: approval-1",
        metadata: {
          version: 1,
          sections: [
            {
              title: "Approval resolution",
              rows: [
                { type: "key_value", label: "approvalId", value: "approval-1" },
                { type: "key_value", label: "outcome", value: "rejected" },
              ],
            },
          ],
        },
      },
    ]);

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("recovers missing linked approval artifacts after an approve write failure without duplicating existing artifacts", async () => {
    const approval = {
      id: "approval-retry",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: {
        title: "Approve plan",
        planRevisionId: "revision-1",
      },
      decisionNote: "Approved by board",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue({
      ...approval,
      status: "pending",
    });
    mockApprovalService.approve
      .mockResolvedValueOnce({ approval, applied: true })
      .mockResolvedValueOnce({ approval, applied: false });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1" },
      { id: "issue-2" },
    ]);
    mockIssueService.listComments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "comment-issue-1",
          issueId: "issue-1",
          deletedAt: null,
          body: "Approval approved: approval-retry",
          metadata: {
            version: 1,
            sections: [
              {
                title: "Approval resolution",
                rows: [
                  { type: "key_value", label: "approvalId", value: "approval-retry" },
                  { type: "key_value", label: "outcome", value: "approved" },
                ],
              },
            ],
          },
        },
      ])
      .mockResolvedValueOnce([]);
    mockIssueService.addComment
      .mockResolvedValueOnce({ id: "comment-issue-1", body: "Approval approved: approval-retry" })
      .mockRejectedValueOnce(new Error("comment write failed"))
      .mockResolvedValueOnce({ id: "comment-issue-2", body: "Approval approved: approval-retry" });

    const first = await request(await createApp())
      .post("/api/approvals/approval-retry/approve")
      .send({ decisionNote: "Approved by board" });

    expect(first.status).toBe(500);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();

    const retry = await request(await createApp())
      .post("/api/approvals/approval-retry/approve")
      .send({ decisionNote: "Approved by board" });

    expect(retry.status).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(3);
    expect(mockIssueService.addComment).toHaveBeenLastCalledWith(
      "issue-2",
      expect.stringContaining("Approval approved: approval-retry"),
      {},
      expect.objectContaining({ authorType: "system" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_approved",
        payload: expect.objectContaining({
          approvalId: "approval-retry",
          approvalStatus: "approved",
          issueIds: ["issue-1", "issue-2"],
          linkedIssueIds: ["issue-1", "issue-2"],
        }),
        contextSnapshot: expect.objectContaining({
          taskId: "issue-1",
          wakeReason: "approval_approved",
        }),
      }),
    );
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
    expect(mockIssueService.update).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000001", {
      status: "in_review",
      actorAgentId: "agent-1",
      actorUserId: null,
    });
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

  it("records linked approval decisions on issue threads and wakes the requester with decision context", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {
        title: "Approve plan",
        summary: "Need board approval.",
        recommendedAction: "Approve the plan.",
        planRevisionId: "revision-1",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-7",
        companyId: "company-1",
        type: "request_board_approval",
        status: "approved",
        payload: {
          title: "Approve plan",
          summary: "Need board approval.",
          recommendedAction: "Approve the plan.",
          planRevisionId: "revision-1",
        },
        decisionNote: "Approved by board",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
      },
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1" },
      { id: "issue-2" },
    ]);

    const res = await request(await createApp())
      .post("/api/approvals/approval-7/approve")
      .send({ decisionNote: "Approved by board" });

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Approval approved: approval-7"),
      {},
      expect.objectContaining({
        authorType: "system",
        metadata: expect.objectContaining({
          version: 1,
          sections: [
            expect.objectContaining({
              title: "Approval resolution",
              rows: expect.arrayContaining([
                { type: "key_value", label: "approvalId", value: "approval-7" },
                { type: "key_value", label: "approvalStatus", value: "approved" },
                { type: "key_value", label: "linkedIssueIds", value: "issue-1, issue-2" },
              ]),
            }),
          ],
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_approved",
        payload: expect.objectContaining({
          approvalId: "approval-7",
          approvalStatus: "approved",
          issueIds: ["issue-1", "issue-2"],
          linkedIssueIds: ["issue-1", "issue-2"],
          decisionContext: expect.objectContaining({
            planRevisionId: "revision-1",
            decisionNote: "Approved by board",
          }),
        }),
        contextSnapshot: expect.objectContaining({
          approvalId: "approval-7",
          approvalStatus: "approved",
          linkedIssueIds: ["issue-1", "issue-2"],
          wakeReason: "approval_approved",
        }),
      }),
    );
  });
});
