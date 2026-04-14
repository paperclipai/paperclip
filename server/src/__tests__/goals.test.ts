import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();
const GOAL_ID = randomUUID();
const KR_ID = randomUUID();

const MOCK_GOAL = {
  id: GOAL_ID,
  companyId: COMPANY_ID,
  title: "Increase Revenue",
  description: "Grow monthly revenue by 30%",
  status: "active",
  level: "company",
  parentGoalId: null,
  ownerAgentId: null,
  targetDate: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_KEY_RESULT = {
  id: KR_ID,
  goalId: GOAL_ID,
  companyId: COMPANY_ID,
  description: "Close 10 enterprise deals",
  currentValue: 3,
  targetValue: 10,
  unit: "deals",
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Service mocks ───────────────────────────────────────────────────────────

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listKeyResults: vi.fn(),
  createKeyResult: vi.fn(),
  updateKeyResult: vi.fn(),
  removeKeyResult: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (req: any, _res: any, next: any) => next(),
}));

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>) {
  const { goalRoutes } = await import("../routes/goals.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  // Fake DB chainable for assertCanWrite membership queries.
  const chainable: any = {};
  chainable.select = vi.fn().mockReturnValue(chainable);
  chainable.from = vi.fn().mockReturnValue(chainable);
  chainable.where = vi.fn().mockReturnValue(chainable);
  chainable.orderBy = vi.fn().mockReturnValue(chainable);
  chainable.limit = vi.fn().mockReturnValue(chainable);
  // Treat board user with non-viewer role by returning empty rows (membership undefined → not viewer).
  chainable.then = vi.fn().mockImplementation((resolve: any) => resolve([]));
  const fakeDb: any = {
    select: vi.fn().mockReturnValue(chainable),
  };
  app.use("/api", goalRoutes(fakeDb));
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

describe("goal routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoalService.list.mockResolvedValue([MOCK_GOAL]);
    mockGoalService.getById.mockResolvedValue(MOCK_GOAL);
    mockGoalService.create.mockResolvedValue(MOCK_GOAL);
    mockGoalService.update.mockResolvedValue(MOCK_GOAL);
    mockGoalService.remove.mockResolvedValue(MOCK_GOAL);
    mockGoalService.listKeyResults.mockResolvedValue([MOCK_KEY_RESULT]);
    mockGoalService.createKeyResult.mockResolvedValue(MOCK_KEY_RESULT);
    mockGoalService.updateKeyResult.mockResolvedValue(MOCK_KEY_RESULT);
    mockGoalService.removeKeyResult.mockResolvedValue(MOCK_KEY_RESULT);
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /api/companies/:companyId/goals", () => {
    it("lists goals for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/goals`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ title: "Increase Revenue", status: "active" });
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/goals`);
      expect(res.status).toBe(401);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/goals`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/goals/:id", () => {
    it("returns goal by ID for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/goals/${GOAL_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: GOAL_ID, title: "Increase Revenue" });
    });

    it("returns 404 for non-existent goal", async () => {
      mockGoalService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/goals/${randomUUID()}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/companies/:companyId/goals", () => {
    it("creates a goal for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/goals`)
        .send({ title: "Increase Revenue", description: "Grow revenue", status: "active" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ title: "Increase Revenue" });
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("rejects unauthenticated create with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/goals`)
        .send({ title: "Test" });
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /api/goals/:id", () => {
    it("updates a goal status", async () => {
      const updated = { ...MOCK_GOAL, status: "completed" };
      mockGoalService.update.mockResolvedValue(updated);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .patch(`/api/goals/${GOAL_ID}`)
        .send({ status: "completed" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 404 for non-existent goal update", async () => {
      mockGoalService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .patch(`/api/goals/${randomUUID()}`)
        .send({ status: "completed" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/goals/:id", () => {
    it("deletes a goal for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/goals/${GOAL_ID}`);

      expect(res.status).toBe(200);
      expect(mockGoalService.remove).toHaveBeenCalledWith(GOAL_ID);
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 404 when deleting non-existent goal", async () => {
      mockGoalService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/goals/${randomUUID()}`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/companies/:companyId/goals/:goalId/key-results", () => {
    it("lists key results for a goal", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/goals/${GOAL_ID}/key-results`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ description: "Close 10 enterprise deals" });
    });

    it("rejects unauthenticated key results request with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/goals/${GOAL_ID}/key-results`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/companies/:companyId/goals/:goalId/key-results", () => {
    it("creates a key result", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/goals/${GOAL_ID}/key-results`)
        .send({ description: "Close 10 enterprise deals", targetValue: 10 });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ description: "Close 10 enterprise deals" });
    });
  });

  describe("DELETE /api/companies/:companyId/goals/:goalId/key-results/:krId", () => {
    it("deletes a key result", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/companies/${COMPANY_ID}/goals/${GOAL_ID}/key-results/${KR_ID}`);

      expect(res.status).toBe(200);
      expect(mockGoalService.removeKeyResult).toHaveBeenCalledWith(KR_ID);
    });

    it("returns 404 for non-existent key result", async () => {
      mockGoalService.removeKeyResult.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).delete(`/api/companies/${COMPANY_ID}/goals/${GOAL_ID}/key-results/${randomUUID()}`);
      expect(res.status).toBe(404);
    });
  });
});
