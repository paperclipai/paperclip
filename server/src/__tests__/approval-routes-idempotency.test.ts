import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

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
const INVALID_UUID_ERROR = Object.assign(new Error("invalid uuid"), { code: "22P02" });

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
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
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId, payload) => payload,
    );
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      {
        id: "issue-1",
        title: "Hire a Hermes worker",
        description: "Create and onboard the requested worker.",
        identifier: "HER-1",
      },
    ]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
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

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
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

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("wakes the requesting agent when an approval is rejected", async () => {
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        decisionNote: "Not yet",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({ decisionNote: "Not yet" });

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).toHaveBeenCalledWith("approval-1");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_rejected",
        payload: expect.objectContaining({
          approvalId: "approval-1",
          approvalStatus: "rejected",
          decisionNote: "Not yet",
          wakeReason: "approval_rejected",
        }),
        contextSnapshot: expect.objectContaining({
          source: "approval.rejected",
          taskTitle: "Hire a Hermes worker",
          taskBody: "Create and onboard the requested worker.",
          issueIdentifier: "HER-1",
          wakeReason: "approval_rejected",
          decisionNote: "Not yet",
        }),
      }),
    );
  });

  it("wakes the requesting agent with hire payload summary when an approval is approved", async () => {
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        decisionNote: "Approved",
        payload: {
          name: "Hermes Manager",
          role: "engineer",
          agentId: "11111111-1111-4111-8111-111111111111",
          reportsTo: "22222222-2222-4222-8222-222222222222",
          adapterType: "hermes_local",
          desiredSkills: ["company:verification-before-completion"],
          adapterConfig: {
            apiKey: "secret-value",
          },
        },
        requestedByAgentId: "agent-1",
      },
      applied: true,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "Approved" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_approved",
        payload: expect.objectContaining({
          approvalId: "approval-1",
          approvalStatus: "approved",
          approvalType: "hire_agent",
          approvalPayloadName: "Hermes Manager",
          approvalPayloadRole: "engineer",
          approvalPayloadAgentId: "11111111-1111-4111-8111-111111111111",
          approvalPayloadReportsTo: "22222222-2222-4222-8222-222222222222",
          approvalPayloadAdapterType: "hermes_local",
          approvalPayloadDesiredSkills: ["company:verification-before-completion"],
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: "approval_approved",
          approvalType: "hire_agent",
          approvalPayloadName: "Hermes Manager",
          approvalPayloadRole: "engineer",
          approvalPayloadAgentId: "11111111-1111-4111-8111-111111111111",
          approvalPayloadReportsTo: "22222222-2222-4222-8222-222222222222",
          approvalPayloadAdapterType: "hermes_local",
          approvalPayloadDesiredSkills: ["company:verification-before-completion"],
        }),
      }),
    );
  });

  it("wakes the requesting agent when an approval needs revision", async () => {
    mockApprovalService.requestRevision.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "revision_requested",
      decisionNote: "Please tighten the scope",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/request-revision")
      .send({ decisionNote: "Please tighten the scope" });

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).toHaveBeenCalledWith("approval-1");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_revision_requested",
        payload: expect.objectContaining({
          approvalId: "approval-1",
          approvalStatus: "revision_requested",
          decisionNote: "Please tighten the scope",
          wakeReason: "approval_revision_requested",
        }),
        contextSnapshot: expect.objectContaining({
          source: "approval.revision_requested",
          taskTitle: "Hire a Hermes worker",
          taskBody: "Create and onboard the requested worker.",
          issueIdentifier: "HER-1",
          wakeReason: "approval_revision_requested",
          decisionNote: "Please tighten the scope",
        }),
      }),
    );
  });

  it.each([
    [{ body: "Board note" }, "Board note"],
    [{ content: "Compatibility note" }, "Compatibility note"],
    [{ comments: "Legacy note" }, "Legacy note"],
  ])("accepts approval comment payload aliases: %j", async (payload, expectedBody) => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
    });
    mockApprovalService.addComment.mockResolvedValue({
      id: "comment-1",
      approvalId: "approval-1",
      body: expectedBody,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/comments")
      .send(payload);

    expect(res.status).toBe(201);
    expect(mockApprovalService.addComment).toHaveBeenCalledWith(
      "approval-1",
      expectedBody,
      expect.objectContaining({
        userId: "user-1",
      }),
    );
  });

  it("treats malformed approval ids as missing on linked issue lookups", async () => {
    mockApprovalService.getById.mockRejectedValue(INVALID_UUID_ERROR);

    const res = await request(createApp())
      .get("/api/approvals/not-a-uuid/issues");

    expect(res.status).toBe(404);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
  });

  it("treats malformed approval ids as missing on revision requests", async () => {
    mockApprovalService.requestRevision.mockRejectedValue(INVALID_UUID_ERROR);

    const res = await request(createApp())
      .post("/api/approvals/not-a-uuid/request-revision")
      .send({ decisionNote: "Please tighten the scope" });

    expect(res.status).toBe(404);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("merges and validates hire approval resubmits before persisting them", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      requestedByAgentId: "11111111-1111-4111-8111-111111111111",
      status: "revision_requested",
      payload: {
        name: "Hermes Worker",
        role: "engineer",
        reportsTo: "11111111-1111-4111-8111-111111111111",
        adapterType: "hermes_local",
        capabilities: "Initial scope",
        adapterConfig: { model: "gpt-4o", persistSession: true },
        runtimeConfig: { cwd: "/tmp/worker" },
        desiredSkills: ["paperclip"],
        budgetMonthlyCents: 0,
        metadata: { source: "hire" },
        agentId: "22222222-2222-4222-8222-222222222222",
        requestedConfigurationSnapshot: {
          adapterType: "hermes_local",
          adapterConfig: { model: "gpt-4o", persistSession: true },
          runtimeConfig: { cwd: "/tmp/worker" },
          desiredSkills: ["paperclip"],
        },
      },
    });
    mockApprovalService.resubmit.mockImplementation(async (_id, payload) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      requestedByAgentId: "11111111-1111-4111-8111-111111111111",
      status: "pending",
      payload,
    }));

    const res = await request(createApp())
      .post("/api/approvals/approval-1/resubmit")
      .send({
        payload: {
          capabilities: "Revised scope",
          reportsTo: "$PAPERCLIP_AGENT_ID",
        },
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Hermes Worker",
        role: "engineer",
        reportsTo: "11111111-1111-4111-8111-111111111111",
        capabilities: "Revised scope",
        adapterType: "hermes_local",
        adapterConfig: { model: "gpt-4o", persistSession: true },
        runtimeConfig: { cwd: "/tmp/worker" },
        desiredSkills: ["paperclip"],
        agentId: "22222222-2222-4222-8222-222222222222",
        requestedConfigurationSnapshot: {
          adapterType: "hermes_local",
          adapterConfig: { model: "gpt-4o", persistSession: true },
          runtimeConfig: { cwd: "/tmp/worker" },
          desiredSkills: ["paperclip"],
        },
      }),
      { strictMode: false },
    );
    expect(mockApprovalService.resubmit).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        reportsTo: "11111111-1111-4111-8111-111111111111",
        capabilities: "Revised scope",
      }),
    );
  });

  it("rejects invalid hire approval resubmit identifiers instead of masking them as missing approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      requestedByAgentId: "11111111-1111-4111-8111-111111111111",
      status: "revision_requested",
      payload: {
        name: "Hermes Worker",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: { model: "gpt-4o" },
        runtimeConfig: {},
        budgetMonthlyCents: 0,
      },
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/resubmit")
      .send({
        payload: {
          reportsTo: "CEO",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Invalid hire approval resubmit payload");
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("does not collapse nested invalid identifiers during approve into a false approval 404", async () => {
    mockApprovalService.approve.mockRejectedValue(INVALID_UUID_ERROR);

    const res = await request(createApp())
      .post("/api/approvals/11111111-1111-4111-8111-111111111111/approve")
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Approval payload contains an invalid identifier");
  });
});
