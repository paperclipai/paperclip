import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();
const APPROVAL_ID = randomUUID();
const AGENT_ID = randomUUID();

const MOCK_APPROVAL = {
  id: APPROVAL_ID,
  companyId: COMPANY_ID,
  type: "budget",
  status: "pending",
  payload: { amount: 5000, reason: "Infrastructure upgrade" },
  requestedByUserId: USER_ID,
  requestedByAgentId: AGENT_ID,
  decisionNote: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_COMMENT = {
  id: randomUUID(),
  approvalId: APPROVAL_ID,
  body: "Looks good to me",
  authorUserId: USER_ID,
  authorAgentId: null,
  createdAt: new Date(),
};

// ── Service mocks ───────────────────────────────────────────────────────────

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
  wakeup: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000000" }),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
  listIssuesForApproval: vi.fn().mockResolvedValue([]),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn().mockImplementation((_cid: any, payload: any) => payload),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../redaction.js", () => ({
  redactEventPayload: vi.fn((x: any) => x),
}));

vi.mock("../services/agent-reflection.js", () => ({
  extractLessonFromRejection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/agent-workspace.js", () => ({
  generateMeetingMinutes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/channels.js", () => ({
  findCompanyChannel: vi.fn().mockResolvedValue(null),
  postMessage: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (req: any, _res: any, next: any) => next(),
}));

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>) {
  const { approvalRoutes } = await import("../routes/approvals.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const fakeDb = {} as any;
  app.use("/api", approvalRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

function boardUser(userId: string, companyIds: string[]) {
  return { type: "board", userId, companyIds, isInstanceAdmin: false, source: "session" };
}

function noActor() {
  return { type: "none" };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("approval routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.list.mockResolvedValue([MOCK_APPROVAL]);
    mockApprovalService.getById.mockResolvedValue(MOCK_APPROVAL);
    mockApprovalService.create.mockResolvedValue(MOCK_APPROVAL);
    mockApprovalService.approve.mockResolvedValue({ approval: { ...MOCK_APPROVAL, status: "approved" }, applied: true });
    mockApprovalService.reject.mockResolvedValue({ approval: { ...MOCK_APPROVAL, status: "rejected" }, applied: true });
    mockApprovalService.requestRevision.mockResolvedValue({ ...MOCK_APPROVAL, status: "revision_requested" });
    mockApprovalService.resubmit.mockResolvedValue({ ...MOCK_APPROVAL, status: "pending" });
    mockApprovalService.listComments.mockResolvedValue([MOCK_COMMENT]);
    mockApprovalService.addComment.mockResolvedValue(MOCK_COMMENT);
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /api/companies/:companyId/approvals", () => {
    it("lists approvals for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/approvals`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ type: "budget", status: "pending" });
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/approvals`);
      expect(res.status).toBe(401);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/approvals`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/approvals/:id", () => {
    it("returns approval by ID", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/approvals/${APPROVAL_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: APPROVAL_ID, type: "budget" });
    });

    it("returns 404 for non-existent approval", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/approvals/${randomUUID()}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/companies/:companyId/approvals", () => {
    it("creates an approval for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send({ type: "budget", payload: { amount: 5000 } });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ type: "budget" });
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("rejects unauthenticated create with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send({ type: "budget", payload: {} });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/approvals/:id/approve", () => {
    it("approves a pending approval", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/approvals/${APPROVAL_ID}/approve`)
        .send({ decidedByUserId: USER_ID, decisionNote: "Approved" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
    });

    it("rejects non-board actors from approving", async () => {
      const agentActor = { type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID };
      const app = await createApp(agentActor);
      const res = await request(app)
        .post(`/api/approvals/${APPROVAL_ID}/approve`)
        .send({ decidedByUserId: USER_ID });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/approvals/:id/reject", () => {
    it("rejects a pending approval", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/approvals/${APPROVAL_ID}/reject`)
        .send({ decidedByUserId: USER_ID, decisionNote: "Too expensive" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
    });

    it("rejects non-board actors from rejecting", async () => {
      const agentActor = { type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID };
      const app = await createApp(agentActor);
      const res = await request(app)
        .post(`/api/approvals/${APPROVAL_ID}/reject`)
        .send({ decidedByUserId: USER_ID });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/approvals/:id/request-revision", () => {
    it("requests revision on a pending approval", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/approvals/${APPROVAL_ID}/request-revision`)
        .send({ decidedByUserId: USER_ID, decisionNote: "Need more details" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("revision_requested");
    });
  });

  describe("GET /api/approvals/:id/comments", () => {
    it("lists comments for an approval", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/approvals/${APPROVAL_ID}/comments`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ body: "Looks good to me" });
    });

    it("returns 404 for comments on non-existent approval", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/approvals/${randomUUID()}/comments`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/approvals/:id/comments", () => {
    it("adds a comment to an approval", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/approvals/${APPROVAL_ID}/comments`)
        .send({ body: "Looks good to me" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ body: "Looks good to me" });
    });

    it("returns 404 for comment on non-existent approval", async () => {
      mockApprovalService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/approvals/${randomUUID()}/comments`)
        .send({ body: "Test" });
      expect(res.status).toBe(404);
    });
  });
});
