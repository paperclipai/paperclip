import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { costRoutes } from "../routes/costs.js";

const mocks = vi.hoisted(() => ({
  companyUpdate: vi.fn(),
  agentGetById: vi.fn(),
  agentUpdate: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  costService: () => ({}),
  companyService: () => ({
    update: mocks.companyUpdate,
  }),
  agentService: () => ({
    getById: mocks.agentGetById,
    update: mocks.agentUpdate,
  }),
  logActivity: mocks.logActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", costRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("cost budget route authorization", () => {
  beforeEach(() => {
    mocks.companyUpdate.mockReset();
    mocks.agentGetById.mockReset();
    mocks.agentUpdate.mockReset();
    mocks.logActivity.mockReset();
  });

  it("denies authenticated board users from updating another company's budget", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const res = await request(app)
      .patch("/api/companies/company-2/budgets")
      .send({ budgetMonthlyCents: 5000 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(mocks.companyUpdate).not.toHaveBeenCalled();
  });

  it("allows authenticated board users to update their own company's budget", async () => {
    mocks.companyUpdate.mockResolvedValue({
      id: "company-1",
      budgetMonthlyCents: 5000,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 5000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "company-1",
      budgetMonthlyCents: 5000,
    });
    expect(mocks.companyUpdate).toHaveBeenCalledWith("company-1", { budgetMonthlyCents: 5000 });
  });

  it("denies authenticated board users from updating another company's agent budget", async () => {
    mocks.agentGetById.mockResolvedValue({
      id: "agent-2",
      companyId: "company-2",
      budgetMonthlyCents: 2000,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const res = await request(app)
      .patch("/api/agents/agent-2/budgets")
      .send({ budgetMonthlyCents: 5000 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(mocks.agentUpdate).not.toHaveBeenCalled();
  });

  it("allows authenticated board users to update an agent budget in their company", async () => {
    mocks.agentGetById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      budgetMonthlyCents: 2000,
    });
    mocks.agentUpdate.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      budgetMonthlyCents: 5000,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 5000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "agent-1",
      companyId: "company-1",
      budgetMonthlyCents: 5000,
    });
    expect(mocks.agentUpdate).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 5000 });
  });

  it("allows an agent to update its own budget", async () => {
    mocks.agentGetById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      budgetMonthlyCents: 2000,
    });
    mocks.agentUpdate.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      budgetMonthlyCents: 2500,
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "agent-1",
      companyId: "company-1",
      budgetMonthlyCents: 2500,
    });
    expect(mocks.agentUpdate).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 2500 });
  });
});
