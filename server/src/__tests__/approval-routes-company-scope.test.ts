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

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

/** Board user scoped to company-a only. */
function createAppForCompanyA() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-a",
      companyIds: ["company-a"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/** Agent scoped to company-a. */
function createAppForAgentCompanyA() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-a",
      companyId: "company-a",
      source: "agent_key",
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const COMPANY_B_APPROVAL = {
  id: "approval-b1",
  companyId: "company-b",
  type: "hire_agent",
  status: "pending",
  payload: {},
  requestedByAgentId: "agent-b",
  requestedByUserId: null,
  decisionNote: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("approval routes: cross-company isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
  });

  describe("board user scoped to company-a", () => {
    it("GET /approvals/:id returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA()).get("/api/approvals/approval-b1");

      expect(res.status).toBe(403);
      expect(mockApprovalService.getById).toHaveBeenCalledWith("approval-b1");
    });

    it("GET /companies/:companyId/approvals returns 403 for company-b", async () => {
      const res = await request(createAppForCompanyA()).get("/api/companies/company-b/approvals");

      expect(res.status).toBe(403);
      expect(mockApprovalService.list).not.toHaveBeenCalled();
    });

    it("POST /approvals/:id/approve returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/approval-b1/approve")
        .send({});

      expect(res.status).toBe(403);
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    });

    it("POST /approvals/:id/reject returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/approval-b1/reject")
        .send({});

      expect(res.status).toBe(403);
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
    });

    it("POST /approvals/:id/request-revision returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/approval-b1/request-revision")
        .send({ decisionNote: "needs work" });

      expect(res.status).toBe(403);
      expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
    });

    it("POST /approvals/:id/resubmit returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/approval-b1/resubmit")
        .send({});

      expect(res.status).toBe(403);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("GET /approvals/:id/comments returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA()).get("/api/approvals/approval-b1/comments");

      expect(res.status).toBe(403);
      expect(mockApprovalService.listComments).not.toHaveBeenCalled();
    });

    it("POST /approvals/:id/comments returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/approval-b1/comments")
        .send({ body: "comment text" });

      expect(res.status).toBe(403);
      expect(mockApprovalService.addComment).not.toHaveBeenCalled();
    });

    it("GET /approvals/:id/issues returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForCompanyA()).get("/api/approvals/approval-b1/issues");

      expect(res.status).toBe(403);
      expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    });
  });

  describe("agent scoped to company-a", () => {
    it("GET /approvals/:id returns 403 for approval belonging to company-b", async () => {
      mockApprovalService.getById.mockResolvedValue(COMPANY_B_APPROVAL);

      const res = await request(createAppForAgentCompanyA()).get("/api/approvals/approval-b1");

      expect(res.status).toBe(403);
    });

    it("GET /companies/company-b/approvals returns 403 for agent scoped to company-a", async () => {
      const res = await request(createAppForAgentCompanyA()).get(
        "/api/companies/company-b/approvals",
      );

      expect(res.status).toBe(403);
      expect(mockApprovalService.list).not.toHaveBeenCalled();
    });
  });

  describe("approval not found", () => {
    it("POST /approvals/:id/approve returns 404 when approval does not exist", async () => {
      mockApprovalService.getById.mockResolvedValue(null);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/nonexistent/approve")
        .send({});

      expect(res.status).toBe(404);
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    });

    it("POST /approvals/:id/reject returns 404 when approval does not exist", async () => {
      mockApprovalService.getById.mockResolvedValue(null);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/nonexistent/reject")
        .send({});

      expect(res.status).toBe(404);
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
    });

    it("POST /approvals/:id/request-revision returns 404 when approval does not exist", async () => {
      mockApprovalService.getById.mockResolvedValue(null);

      const res = await request(createAppForCompanyA())
        .post("/api/approvals/nonexistent/request-revision")
        .send({ decisionNote: "needs work" });

      expect(res.status).toBe(404);
      expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
    });
  });
});
