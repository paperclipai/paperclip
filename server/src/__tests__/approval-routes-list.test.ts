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

describe("approval routes list and detail", () => {
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

  describe("GET /companies/:companyId/approvals", () => {
    it("returns all approvals when no status filter", async () => {
      mockApprovalService.list.mockResolvedValue([
        makeApproval({ id: "a1", status: "pending" }),
        makeApproval({ id: "a2", status: "approved" }),
        makeApproval({ id: "a3", status: "revision_requested" }),
      ]);

      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect(mockApprovalService.list).toHaveBeenCalledWith("company-1", undefined);
    });

    it("filters by pending status", async () => {
      mockApprovalService.list.mockResolvedValue([
        makeApproval({ id: "a1", status: "pending" }),
      ]);

      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals?status=pending");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe("pending");
      expect(mockApprovalService.list).toHaveBeenCalledWith("company-1", "pending");
    });

    it("filters by revision_requested status", async () => {
      mockApprovalService.list.mockResolvedValue([
        makeApproval({ id: "a1", status: "revision_requested", decisionNote: "fix budget" }),
      ]);

      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals?status=revision_requested");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe("revision_requested");
      expect(mockApprovalService.list).toHaveBeenCalledWith("company-1", "revision_requested");
    });

    it("filters by approved status", async () => {
      mockApprovalService.list.mockResolvedValue([
        makeApproval({ id: "a1", status: "approved" }),
      ]);

      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals?status=approved");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe("approved");
    });

    it("filters by rejected status", async () => {
      mockApprovalService.list.mockResolvedValue([
        makeApproval({ id: "a1", status: "rejected" }),
      ]);

      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals?status=rejected");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe("rejected");
    });

    it("returns 400 for invalid status filter", async () => {
      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals?status=invalid_status");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid status filter");
    });

    it("returns 400 for empty string status filter", async () => {
      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals?status=")

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid status filter");
    });

    it("returns empty array when no approvals match status", async () => {
      mockApprovalService.list.mockResolvedValue([]);

      const res = await request(await createBoardApp())
        .get("/api/companies/company-1/approvals?status=revision_requested");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /approvals/:id", () => {
    it("returns detail with pending status", async () => {
      mockApprovalService.getById.mockResolvedValue(makeApproval({ status: "pending" }));

      const res = await request(await createBoardApp())
        .get("/api/approvals/approval-1");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
    });

    it("returns detail with revision_requested status", async () => {
      mockApprovalService.getById.mockResolvedValue(
        makeApproval({ status: "revision_requested", decisionNote: "needs budget fix" }),
      );

      const res = await request(await createBoardApp())
        .get("/api/approvals/approval-1");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("revision_requested");
      expect(res.body.decisionNote).toBe("needs budget fix");
    });

    it("returns detail with approved status", async () => {
      mockApprovalService.getById.mockResolvedValue(
        makeApproval({ status: "approved", decisionNote: "looks good" }),
      );

      const res = await request(await createBoardApp())
        .get("/api/approvals/approval-1");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
    });

    it("returns detail with rejected status", async () => {
      mockApprovalService.getById.mockResolvedValue(
        makeApproval({ status: "rejected", decisionNote: "not approved" }),
      );

      const res = await request(await createBoardApp())
        .get("/api/approvals/approval-1");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
    });

    it("returns 404 for unknown approval id", async () => {
      mockApprovalService.getById.mockResolvedValue(null);

      const res = await request(await createBoardApp())
        .get("/api/approvals/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Approval not found");
    });
  });
});
