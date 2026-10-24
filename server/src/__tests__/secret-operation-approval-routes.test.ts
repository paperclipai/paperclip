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

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockCheckSecretOperationTarget = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock("../services/authorization.js", async (importActual) => ({
  ...await importActual<typeof import("../services/authorization.js")>(),
  canActorReadApproval: async () => true,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

vi.mock("../services/secret-approval-hook.js", () => ({
  checkSecretOperationTarget: mockCheckSecretOperationTarget,
}));

const { errorHandler } = await import("../middleware/index.js");
const { approvalRoutes } = await import("../routes/approvals.js");

const TARGET = "3f1c0b6e-5f0a-4a2e-9b1d-8c7a6e5d4c3b";

function stubDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
        })),
      })),
    })),
  } as any;
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(stubDb()));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
};

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "secret_operation",
    status: "pending",
    payload: { op: "delete", targetId: TARGET },
    requestedByAgentId: "agent-1",
    ...overrides,
  };
}

describe("secret_operation approval routes", () => {
  beforeEach(() => {
    for (const fn of [
      ...Object.values(mockApprovalService),
      ...Object.values(mockHeartbeatService),
      ...Object.values(mockIssueApprovalService),
      ...Object.values(mockSecretService),
      ...Object.values(mockAccessService),
      mockLogActivity,
      mockCheckSecretOperationTarget,
    ]) {
      fn.mockReset();
    }
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockCheckSecretOperationTarget.mockResolvedValue(null);
    mockApprovalService.create.mockImplementation(async (companyId: string, data: any) => ({
      id: "approval-1",
      companyId,
      ...data,
    }));
  });

  it("refuses to let an agent approve its own secret operation", async () => {
    mockApprovalService.getById.mockResolvedValue(approvalRow());

    const res = await request(createApp(agentActor))
      .post("/api/approvals/approval-1/approve")
      .send({});

    // The approved row is the authorization; being the requester is not.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("stores a valid rename request submitted by an agent", async () => {
    const res = await request(createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "secret_operation",
        payload: {
          op: "rename",
          targetId: TARGET,
          newName: "gateway-client-secret",
          summary: "Rename the gateway client secret whose current name is its value.",
        },
      });

    expect(res.status).toBe(201);
    const stored = mockApprovalService.create.mock.calls[0][1].payload;
    expect(stored).toEqual({
      op: "rename",
      targetId: TARGET,
      newName: "gateway-client-secret",
      summary: "Rename the gateway client secret whose current name is its value.",
    });
  });

  it("rejects a payload that carries a secret value", async () => {
    const res = await request(createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "secret_operation",
        payload: { op: "rename", targetId: TARGET, newName: "fine", value: "super-secret" },
      });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    // The rejection reports shape, never the submitted content.
    expect(JSON.stringify(res.body)).not.toContain("super-secret");
  });

  it("rejects a delete request that smuggles in a rename", async () => {
    const res = await request(createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "secret_operation",
        payload: { op: "delete", targetId: TARGET, newName: "not-allowed-here" },
      });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown operation", async () => {
    const res = await request(createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "secret_operation",
        payload: { op: "rotate", targetId: TARGET },
      });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("returns the execution result when the board approves and the operation succeeds", async () => {
    mockApprovalService.getById.mockResolvedValue(approvalRow());
    mockApprovalService.approve.mockResolvedValue({
      approval: approvalRow({ status: "approved" }),
      applied: true,
      secretOperation: { ok: true, op: "delete", targetId: TARGET, error: null },
    });

    const res = await request(createApp(boardActor))
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.secretOperation).toEqual({
      ok: true,
      op: "delete",
      targetId: TARGET,
      error: null,
    });
    // `targetId` is not a secret-shaped key, so the board can still read what was done.
    expect(res.body.payload.targetId).toBe(TARGET);
  });

  it("fails the response when the decision was recorded but the operation was not", async () => {
    mockApprovalService.getById.mockResolvedValue(approvalRow());
    mockApprovalService.approve.mockResolvedValue({
      approval: approvalRow({ status: "approved" }),
      applied: true,
      secretOperation: { ok: false, op: "delete", targetId: TARGET, error: "secret not found" },
    });

    const res = await request(createApp(boardActor))
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.secretOperation.error).toBe("secret not found");
    // The requester is still woken: a failed operation must not also be a silent one.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalled();
  });

  it("rejects a target that is not a company secret of this company", async () => {
    mockCheckSecretOperationTarget.mockResolvedValue("secret not found");

    const res = await request(createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "secret_operation", payload: { op: "delete", targetId: TARGET } });

    expect(res.status).toBe(422);
    expect(mockCheckSecretOperationTarget).toHaveBeenCalledWith(expect.anything(), "company-1", TARGET);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("validates a resubmitted payload with the same strict schema", async () => {
    mockApprovalService.getById.mockResolvedValue(approvalRow({ status: "revision_requested" }));

    const res = await request(createApp(agentActor))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { op: "delete", targetId: TARGET, newName: "not-allowed-here" } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("checks the company of a resubmitted target", async () => {
    mockApprovalService.getById.mockResolvedValue(approvalRow({ status: "revision_requested" }));
    mockCheckSecretOperationTarget.mockResolvedValue("secret not found");

    const res = await request(createApp(agentActor))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { op: "delete", targetId: TARGET } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("stores a valid resubmitted payload", async () => {
    mockApprovalService.getById.mockResolvedValue(approvalRow({ status: "revision_requested" }));
    mockApprovalService.resubmit.mockResolvedValue(approvalRow());

    const res = await request(createApp(agentActor))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { op: "rename", targetId: TARGET, newName: "gateway-client-secret" } });

    expect(res.status).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledWith("approval-1", {
      op: "rename",
      targetId: TARGET,
      newName: "gateway-client-secret",
    });
  });
});
