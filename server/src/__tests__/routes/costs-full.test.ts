import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { costRoutes } from "../../routes/costs.js";
import { errorHandler } from "../../middleware/index.js";

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../../services/index.js", () => ({
  costService: () => mockCostService,
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
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
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("costRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("POST /companies/:companyId/cost-events", () => {
    it("creates a cost event", async () => {
      mockCostService.createEvent.mockResolvedValue({
        id: "cost-1", costCents: 100, model: "gpt-4",
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/cost-events")
        .send({
          agentId: "00000000-0000-0000-0000-000000000001",
          costCents: 100,
          provider: "openai",
          model: "gpt-4",
          occurredAt: new Date().toISOString(),
          inputTokens: 1000,
          outputTokens: 500,
        });
      expect(res.status).toBe(201);
    });

    it("returns 403 when agent reports for another agent", async () => {
      const res = await request(createApp({
        type: "agent", agentId: "00000000-0000-0000-0000-000000000002", companyId: "company-1",
      }))
        .post("/api/companies/company-1/cost-events")
        .send({
          agentId: "00000000-0000-0000-0000-000000000001",
          costCents: 100,
          provider: "openai",
          model: "gpt-4",
          occurredAt: new Date().toISOString(),
          inputTokens: 1000,
          outputTokens: 500,
        });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /companies/:companyId/costs/summary", () => {
    it("returns cost summary", async () => {
      mockCostService.summary.mockResolvedValue({ totalCents: 500 });
      const res = await request(createApp()).get("/api/companies/company-1/costs/summary");
      expect(res.status).toBe(200);
      expect(res.body.totalCents).toBe(500);
    });
  });

  describe("GET /companies/:companyId/costs/by-agent", () => {
    it("returns costs by agent", async () => {
      mockCostService.byAgent.mockResolvedValue([{ agentId: "a1", totalCents: 100 }]);
      const res = await request(createApp()).get("/api/companies/company-1/costs/by-agent");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("GET /companies/:companyId/costs/by-project", () => {
    it("returns costs by project", async () => {
      mockCostService.byProject.mockResolvedValue([{ projectId: "p1", totalCents: 200 }]);
      const res = await request(createApp()).get("/api/companies/company-1/costs/by-project");
      expect(res.status).toBe(200);
    });
  });

  describe("PATCH /companies/:companyId/budgets", () => {
    it("updates company budget", async () => {
      mockCompanyService.update.mockResolvedValue({ id: "company-1", budgetMonthlyCents: 10000 });
      const res = await request(createApp())
        .patch("/api/companies/company-1/budgets")
        .send({ budgetMonthlyCents: 10000 });
      expect(res.status).toBe(200);
    });

    it("returns 404 for nonexistent company", async () => {
      mockCompanyService.update.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/companies/company-1/budgets")
        .send({ budgetMonthlyCents: 10000 });
      expect(res.status).toBe(404);
    });

    it("returns 403 for non-board user", async () => {
      const res = await request(createApp({
        type: "agent", agentId: "a1", companyId: "company-1",
      }))
        .patch("/api/companies/company-1/budgets")
        .send({ budgetMonthlyCents: 10000 });
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /agents/:agentId/budgets", () => {
    it("updates agent budget", async () => {
      mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1" });
      mockAgentService.update.mockResolvedValue({ id: "agent-1", budgetMonthlyCents: 5000, companyId: "company-1" });
      const res = await request(createApp())
        .patch("/api/agents/agent-1/budgets")
        .send({ budgetMonthlyCents: 5000 });
      expect(res.status).toBe(200);
    });

    it("returns 403 when agent changes another agent budget", async () => {
      mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1" });
      const res = await request(createApp({
        type: "agent", agentId: "agent-2", companyId: "company-1",
      }))
        .patch("/api/agents/agent-1/budgets")
        .send({ budgetMonthlyCents: 5000 });
      expect(res.status).toBe(403);
    });

    it("returns 404 for nonexistent agent", async () => {
      mockAgentService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/agents/missing/budgets")
        .send({ budgetMonthlyCents: 5000 });
      expect(res.status).toBe(404);
    });
  });
});
