import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../../routes/approvals.js";
import { errorHandler } from "../../middleware/index.js";

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

vi.mock("../../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

vi.mock("../../redaction.js", () => ({
  redactEventPayload: (p: unknown) => p,
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
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

describe("approvalRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
  });

  describe("GET /companies/:companyId/approvals", () => {
    it("lists approvals for company", async () => {
      mockApprovalService.list.mockResolvedValue([
        { id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {} },
      ]);
      const res = await request(createApp()).get("/api/companies/company-1/approvals");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/approvals");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /approvals/:id", () => {
    it("returns approval by id", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      const res = await request(createApp()).get("/api/approvals/a1");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("a1");
    });

    it("returns 404 for nonexistent approval", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/approvals/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /companies/:companyId/approvals", () => {
    it("creates an approval", async () => {
      mockApprovalService.create.mockResolvedValue({
        id: "a2", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/approvals")
        .send({
          type: "hire_agent",
          payload: { name: "test" },
        });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe("a2");
    });

    it("links issue ids when provided", async () => {
      mockApprovalService.create.mockResolvedValue({
        id: "a2", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/approvals")
        .send({
          type: "hire_agent",
          payload: { name: "test" },
          issueIds: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
        });
      expect(res.status).toBe(201);
      expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
        "a2",
        ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
        expect.any(Object),
      );
    });
  });

  describe("POST /approvals/:id/approve", () => {
    it("approves an approval and wakes requester", async () => {
      mockApprovalService.approve.mockResolvedValue({
        approval: {
          id: "a1", companyId: "company-1", type: "hire_agent", status: "approved",
          payload: {}, requestedByAgentId: "agent-1",
        },
        applied: true,
      });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
      const res = await request(createApp())
        .post("/api/approvals/a1/approve")
        .send({});
      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("does not trigger side effects when already resolved", async () => {
      mockApprovalService.approve.mockResolvedValue({
        approval: {
          id: "a1", companyId: "company-1", type: "hire_agent", status: "approved", payload: {},
        },
        applied: false,
      });
      const res = await request(createApp())
        .post("/api/approvals/a1/approve")
        .send({});
      expect(res.status).toBe(200);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("returns 403 for non-board user", async () => {
      const res = await request(createApp({ type: "agent", agentId: "a-1", companyId: "company-1" }))
        .post("/api/approvals/a1/approve")
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe("POST /approvals/:id/reject", () => {
    it("rejects an approval", async () => {
      mockApprovalService.reject.mockResolvedValue({
        approval: {
          id: "a1", companyId: "company-1", type: "hire_agent", status: "rejected", payload: {},
        },
        applied: true,
      });
      const res = await request(createApp())
        .post("/api/approvals/a1/reject")
        .send({});
      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("skips log when reject is idempotent", async () => {
      mockApprovalService.reject.mockResolvedValue({
        approval: {
          id: "a1", companyId: "company-1", type: "hire_agent", status: "rejected", payload: {},
        },
        applied: false,
      });
      const res = await request(createApp())
        .post("/api/approvals/a1/reject")
        .send({});
      expect(res.status).toBe(200);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  describe("POST /approvals/:id/resubmit", () => {
    it("allows requesting agent to resubmit", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "revision_requested",
        payload: {}, requestedByAgentId: "agent-1",
      });
      mockApprovalService.resubmit.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      const res = await request(createApp({ type: "agent", agentId: "agent-1", companyId: "company-1" }))
        .post("/api/approvals/a1/resubmit")
        .send({});
      expect(res.status).toBe(200);
    });

    it("returns 403 when different agent tries to resubmit", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "revision_requested",
        payload: {}, requestedByAgentId: "agent-1",
      });
      const res = await request(createApp({ type: "agent", agentId: "agent-2", companyId: "company-1" }))
        .post("/api/approvals/a1/resubmit")
        .send({});
      expect(res.status).toBe(403);
    });

    it("returns 404 when approval does not exist", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .post("/api/approvals/missing/resubmit")
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe("GET /approvals/:id/comments", () => {
    it("lists comments for an approval", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      mockApprovalService.listComments.mockResolvedValue([{ id: "c1", body: "hello" }]);
      const res = await request(createApp()).get("/api/approvals/a1/comments");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("POST /approvals/:id/comments", () => {
    it("adds a comment", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      mockApprovalService.addComment.mockResolvedValue({ id: "c2", body: "new comment" });
      const res = await request(createApp())
        .post("/api/approvals/a1/comments")
        .send({ body: "new comment" });
      expect(res.status).toBe(201);
    });

    it("returns 404 when approval not found for comment", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .post("/api/approvals/missing/comments")
        .send({ body: "oops" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /approvals/:id/comments (not found)", () => {
    it("returns 404 when approval not found", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/approvals/missing/comments");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /approvals/:id/issues", () => {
    it("returns linked issues for an approval", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "i1" }]);
      const res = await request(createApp()).get("/api/approvals/a1/issues");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 404 when approval not found", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/approvals/missing/issues");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /approvals/:id/approve — no requestedByAgentId", () => {
    it("does not wake agent when no requestedByAgentId", async () => {
      mockApprovalService.approve.mockResolvedValue({
        approval: {
          id: "a1", companyId: "company-1", type: "hire_agent", status: "approved",
          payload: {}, requestedByAgentId: null,
        },
        applied: true,
      });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
      const res = await request(createApp())
        .post("/api/approvals/a1/approve")
        .send({});
      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });

  describe("POST /approvals/:id/approve — wakeup failure", () => {
    it("logs failure when wakeup throws", async () => {
      mockApprovalService.approve.mockResolvedValue({
        approval: {
          id: "a1", companyId: "company-1", type: "hire_agent", status: "approved",
          payload: {}, requestedByAgentId: "agent-1",
        },
        applied: true,
      });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
      mockHeartbeatService.wakeup.mockRejectedValue(new Error("wakeup failed"));
      const res = await request(createApp())
        .post("/api/approvals/a1/approve")
        .send({});
      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "approval.approved" }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "approval.requester_wakeup_failed" }),
      );
    });
  });

  describe("POST /approvals/:id/request-revision", () => {
    it("requests revision on a pending approval", async () => {
      mockApprovalService.requestRevision.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "revision_requested", payload: {},
      });
      const res = await request(createApp())
        .post("/api/approvals/a1/request-revision")
        .send({ decisionNote: "needs work" });
      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "approval.revision_requested" }),
      );
    });

    it("returns 403 for non-board user", async () => {
      const res = await request(createApp({ type: "agent", agentId: "a-1", companyId: "company-1" }))
        .post("/api/approvals/a1/request-revision")
        .send({ decisionNote: "nope" });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /companies/:companyId/approvals — hire_agent normalization", () => {
    it("normalizes payload for hire_agent type", async () => {
      mockSecretService.normalizeHireApprovalPayloadForPersistence.mockResolvedValue({ name: "normalized" });
      mockApprovalService.create.mockResolvedValue({
        id: "a3", companyId: "company-1", type: "hire_agent", status: "pending", payload: { name: "normalized" },
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/approvals")
        .send({ type: "hire_agent", payload: { name: "raw" } });
      expect(res.status).toBe(201);
      expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalled();
    });

    it("does not normalize payload for non-hire_agent type", async () => {
      mockApprovalService.create.mockResolvedValue({
        id: "a4", companyId: "company-1", type: "approve_ceo_strategy", status: "pending", payload: { foo: "bar" },
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/approvals")
        .send({ type: "approve_ceo_strategy", payload: { foo: "bar" } });
      expect(res.status).toBe(201);
      expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    });
  });

  describe("POST /approvals/:id/resubmit — hire_agent payload normalization", () => {
    it("normalizes payload on resubmit for hire_agent type", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "revision_requested",
        payload: { name: "old" }, requestedByAgentId: null,
      });
      mockSecretService.normalizeHireApprovalPayloadForPersistence.mockResolvedValue({ name: "normalized" });
      mockApprovalService.resubmit.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: { name: "normalized" },
      });
      const res = await request(createApp())
        .post("/api/approvals/a1/resubmit")
        .send({ payload: { name: "new" } });
      expect(res.status).toBe(200);
      expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalled();
    });

    it("does not normalize payload on resubmit for non-hire_agent type", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "general", status: "revision_requested",
        payload: {}, requestedByAgentId: null,
      });
      mockApprovalService.resubmit.mockResolvedValue({
        id: "a1", companyId: "company-1", type: "general", status: "pending", payload: { v: 2 },
      });
      const res = await request(createApp())
        .post("/api/approvals/a1/resubmit")
        .send({ payload: { v: 2 } });
      expect(res.status).toBe(200);
      expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    });
  });

  describe("POST /companies/:companyId/approvals — agent actor", () => {
    it("sets requestedByAgentId from agent actor", async () => {
      mockApprovalService.create.mockResolvedValue({
        id: "a5", companyId: "company-1", type: "hire_agent", status: "pending", payload: {},
      });
      const res = await request(createApp({ type: "agent", agentId: "agent-99", companyId: "company-1" }))
        .post("/api/companies/company-1/approvals")
        .send({ type: "hire_agent", payload: { name: "new-agent" } });
      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ requestedByAgentId: "agent-99" }),
      );
    });
  });
});
