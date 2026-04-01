import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/index.js";

const PLAN = {
  id: "plan-1",
  companyId: "company-1",
  agentId: null,
  provider: "anthropic",
  biller: "anthropic",
  monthlyCostCents: 20000,
  seatCount: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveUntil: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSubscriptionPlanService = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  totalMonthlyCostCents: vi.fn().mockResolvedValue(0),
}));

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0, effectiveSpendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  budgetService: () => mockBudgetService,
  costService: () => mockCostService,
  financeService: () => mockFinanceService,
  subscriptionPlanService: () => mockSubscriptionPlanService,
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: mockFetchAllQuotaWindows,
}));

function makeDb() {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };
  const thenableChain = Object.assign(Promise.resolve([]), selectChain);
  return {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

function createAppWithActor(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSubscriptionPlanService.create.mockResolvedValue(PLAN);
  mockSubscriptionPlanService.update.mockResolvedValue(PLAN);
  mockSubscriptionPlanService.delete.mockResolvedValue(PLAN);
  mockSubscriptionPlanService.list.mockResolvedValue([PLAN]);
});

describe("subscription plan routes", () => {
  describe("GET /companies/:id/subscription-plans", () => {
    it("returns the list of plans", async () => {
      const app = createApp();
      const res = await request(app).get("/api/companies/company-1/subscription-plans");
      expect(res.status).toBe(200);
      expect(mockSubscriptionPlanService.list).toHaveBeenCalledWith("company-1");
    });
  });

  describe("POST /companies/:id/subscription-plans", () => {
    it("creates a plan with valid data", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/subscription-plans")
        .send({
          provider: "anthropic",
          biller: "anthropic",
          monthlyCostCents: 20000,
        });

      expect(res.status).toBe(201);
      expect(mockSubscriptionPlanService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          provider: "anthropic",
          biller: "anthropic",
          monthlyCostCents: 20000,
        }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "subscription_plan.created",
          entityType: "subscription_plan",
        }),
      );
    });

    it("returns 422 when provider is missing", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/subscription-plans")
        .send({
          biller: "anthropic",
          monthlyCostCents: 20000,
        });

      expect(res.status).toBe(400);
      expect(mockSubscriptionPlanService.create).not.toHaveBeenCalled();
    });

    it("returns 400 when monthlyCostCents is negative", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/subscription-plans")
        .send({
          provider: "anthropic",
          biller: "anthropic",
          monthlyCostCents: -100,
        });

      expect(res.status).toBe(400);
    });

    it("rejects non-board actors", async () => {
      const app = createAppWithActor({
        type: "agent",
        agentId: "agent-1",
        source: "api_key",
        companyIds: ["company-1"],
      });

      const res = await request(app)
        .post("/api/companies/company-1/subscription-plans")
        .send({
          provider: "anthropic",
          biller: "anthropic",
          monthlyCostCents: 20000,
        });

      expect(res.status).toBe(403);
    });

    it("rejects board users outside the company", async () => {
      const app = createAppWithActor({
        type: "board",
        userId: "board-user",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-other"],
      });

      const res = await request(app)
        .post("/api/companies/company-1/subscription-plans")
        .send({
          provider: "anthropic",
          biller: "anthropic",
          monthlyCostCents: 20000,
        });

      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /companies/:id/subscription-plans/:planId", () => {
    it("updates a plan", async () => {
      const app = createApp();
      const res = await request(app)
        .patch("/api/companies/company-1/subscription-plans/plan-1")
        .send({ monthlyCostCents: 30000 });

      expect(res.status).toBe(200);
      expect(mockSubscriptionPlanService.update).toHaveBeenCalledWith(
        "company-1",
        "plan-1",
        expect.objectContaining({ monthlyCostCents: 30000 }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "subscription_plan.updated",
        }),
      );
    });

    it("can toggle isActive", async () => {
      const app = createApp();
      const res = await request(app)
        .patch("/api/companies/company-1/subscription-plans/plan-1")
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(mockSubscriptionPlanService.update).toHaveBeenCalledWith(
        "company-1",
        "plan-1",
        expect.objectContaining({ isActive: false }),
      );
    });
  });

  describe("DELETE /companies/:id/subscription-plans/:planId", () => {
    it("deletes a plan and logs activity", async () => {
      const app = createApp();
      const res = await request(app).delete(
        "/api/companies/company-1/subscription-plans/plan-1",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockSubscriptionPlanService.delete).toHaveBeenCalledWith(
        "company-1",
        "plan-1",
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "subscription_plan.deleted",
        }),
      );
    });
  });

  describe("GET /companies/:id/subscription-plans/total", () => {
    it("returns the total monthly cost", async () => {
      mockSubscriptionPlanService.totalMonthlyCostCents.mockResolvedValue(45000);
      const app = createApp();
      const res = await request(app).get(
        "/api/companies/company-1/subscription-plans/total",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ totalMonthlyCostCents: 45000 });
    });
  });
});
