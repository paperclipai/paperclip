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

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

async function createBoardApp(actorOverrides: Record<string, unknown> = {}) {
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

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    payload: { title: "Test approval" },
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-05-12T00:00:00.000Z"),
    updatedAt: new Date("2026-05-12T00:00:00.000Z"),
    ...overrides,
  };
}

describe("approval routes decisionNote validation", () => {
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
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("POST /approvals/:id/reject", () => {
    it("returns 400 when decisionNote is missing", async () => {
      mockApprovalService.getById.mockResolvedValue(makeApproval());

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
    });

    it("returns 400 when decisionNote is null", async () => {
      mockApprovalService.getById.mockResolvedValue(makeApproval());

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({ decisionNote: null });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
    });

    it("returns 400 when decisionNote is empty string", async () => {
      mockApprovalService.getById.mockResolvedValue(makeApproval());

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({ decisionNote: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
    });

    it("returns 200 when decisionNote is valid", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.reject.mockResolvedValue({
        approval: { ...approval, status: "rejected", decisionNote: "not now" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({ decisionNote: "Not approved. Budget too high." });

      expect(res.status).toBe(200);
      expect(mockApprovalService.reject).toHaveBeenCalledWith(
        "approval-1",
        "user-1",
        "Not approved. Budget too high.",
      );
    });

    it("normalizes escaped line breaks and passes validation", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.reject.mockResolvedValue({
        approval: { ...approval, status: "rejected", decisionNote: "Line1\nLine2" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/reject")
        .send({ decisionNote: "Line1\\nLine2" });

      expect(res.status).toBe(200);
      expect(mockApprovalService.reject).toHaveBeenCalledWith(
        "approval-1",
        "user-1",
        "Line1\nLine2",
      );
    });
  });

  describe("POST /approvals/:id/request-revision", () => {
    it("returns 400 when decisionNote is missing", async () => {
      mockApprovalService.getById.mockResolvedValue(makeApproval());

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
    });

    it("returns 400 when decisionNote is null", async () => {
      mockApprovalService.getById.mockResolvedValue(makeApproval());

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({ decisionNote: null });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
    });

    it("returns 400 when decisionNote is empty string", async () => {
      mockApprovalService.getById.mockResolvedValue(makeApproval());

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({ decisionNote: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
    });

    it("returns 200 when decisionNote is valid", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.requestRevision.mockResolvedValue({
        ...approval,
        status: "revision_requested",
        decisionNote: "needs changes",
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({ decisionNote: "Needs: update the budget line items." });

      expect(res.status).toBe(200);
      expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
        "approval-1",
        "user-1",
        "Needs: update the budget line items.",
      );
    });

    it("normalizes escaped line breaks and passes validation", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.requestRevision.mockResolvedValue({
        ...approval,
        status: "revision_requested",
        decisionNote: "Fix\nRevise.",
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({ decisionNote: "Fix\\r\\nRevise." });

      expect(res.status).toBe(200);
      expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
        "approval-1",
        "user-1",
        "Fix\nRevise.",
      );
    });
  });

  describe("POST /approvals/:id/approve", () => {
    it("returns 200 when decisionNote is omitted (optional)", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.approve.mockResolvedValue({
        approval: { ...approval, status: "approved" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/approve")
        .send({});

      expect(res.status).toBe(200);
      expect(mockApprovalService.approve).toHaveBeenCalledWith(
        "approval-1",
        "user-1",
        undefined,
      );
    });

    it("returns 200 when decisionNote is null (nullable)", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.approve.mockResolvedValue({
        approval: { ...approval, status: "approved" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/approve")
        .send({ decisionNote: null });

      expect(res.status).toBe(200);
      expect(mockApprovalService.approve).toHaveBeenCalledWith(
        "approval-1",
        "user-1",
        null,
      );
    });

    it("returns 200 when decisionNote is valid string", async () => {
      const approval = makeApproval();
      mockApprovalService.getById.mockResolvedValue(approval);
      mockApprovalService.approve.mockResolvedValue({
        approval: { ...approval, status: "approved", decisionNote: "ship it" },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/approve")
        .send({ decisionNote: "Approved: looks good" });

      expect(res.status).toBe(200);
      expect(mockApprovalService.approve).toHaveBeenCalledWith(
        "approval-1",
        "user-1",
        "Approved: looks good",
      );
    });
  });
});
