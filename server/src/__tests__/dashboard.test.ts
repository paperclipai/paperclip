import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();

const MOCK_SUMMARY = {
  activeAgents: 5,
  totalIssues: 42,
  openIssues: 12,
  completedIssues: 30,
  activeProjects: 3,
  pendingApprovals: 2,
  totalCostCents: 15000,
};

// ── Service mocks ───────────────────────────────────────────────────────────

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── Fake db for war-room queries ────────────────────────────────────────────

function createFakeDb() {
  // Chainable that's also awaitable (resolves to []).
  const chainable: any = {};
  chainable.select = vi.fn().mockReturnValue(chainable);
  chainable.from = vi.fn().mockReturnValue(chainable);
  chainable.leftJoin = vi.fn().mockReturnValue(chainable);
  chainable.where = vi.fn().mockReturnValue(chainable);
  chainable.groupBy = vi.fn().mockReturnValue(chainable);
  chainable.orderBy = vi.fn().mockReturnValue(chainable);
  chainable.limit = vi.fn().mockReturnValue(chainable);
  chainable.then = vi.fn().mockImplementation((resolve: any) => resolve([]));
  // Make db itself callable as select()
  const db = vi.fn().mockReturnValue(chainable);
  Object.assign(db, chainable);
  return db;
}

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>) {
  const { dashboardRoutes } = await import("../routes/dashboard.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const fakeDb = createFakeDb();
  app.use("/api", dashboardRoutes(fakeDb as any));
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

describe("dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDashboardService.summary.mockResolvedValue(MOCK_SUMMARY);
  });

  describe("GET /api/companies/:companyId/dashboard", () => {
    it("returns dashboard summary for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/dashboard`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        activeAgents: 5,
        totalIssues: 42,
        pendingApprovals: 2,
      });
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/dashboard`);
      expect(res.status).toBe(401);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/dashboard`);
      expect(res.status).toBe(403);
    });

    it("returns summary with correct structure", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/dashboard`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("activeAgents");
      expect(res.body).toHaveProperty("totalIssues");
      expect(res.body).toHaveProperty("completedIssues");
      expect(res.body).toHaveProperty("activeProjects");
    });

    it("calls dashboardService.summary with companyId", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      await request(app).get(`/api/companies/${COMPANY_ID}/dashboard`);

      expect(mockDashboardService.summary).toHaveBeenCalledWith(COMPANY_ID);
    });
  });

  describe("GET /api/companies/:companyId/war-room", () => {
    it("returns war room data for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/war-room`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("summary");
      expect(res.body).toHaveProperty("goalsProgress");
      expect(res.body).toHaveProperty("windowSpend24hCents");
    });

    it("rejects unauthenticated war-room requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/war-room`);
      expect(res.status).toBe(401);
    });

    it("rejects cross-company war-room access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/war-room`);
      expect(res.status).toBe(403);
    });

    it("returns goalsProgress as an array", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/war-room`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.goalsProgress)).toBe(true);
    });

    it("returns windowSpend24hCents as a number", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/war-room`);

      expect(res.status).toBe(200);
      expect(typeof res.body.windowSpend24hCents).toBe("number");
    });

    it("includes summary from dashboard service in war-room response", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/war-room`);

      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject(MOCK_SUMMARY);
      expect(mockDashboardService.summary).toHaveBeenCalledWith(COMPANY_ID);
    });
  });
});
