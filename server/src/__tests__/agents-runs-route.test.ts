import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
    resolveByReference: vi.fn(),
    getChainOfCommand: vi.fn(),
  }),
  approvalService: () => ({}),
  heartbeatService: () => ({
    list: mocks.listRuns,
  }),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  return app;
}

describe("company runs routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRuns.mockResolvedValue([{ id: "run-1", status: "succeeded" }]);
  });

  it("serves /companies/:companyId/runs", async () => {
    const app = makeApp();

    const res = await request(app).get("/api/companies/company-1/runs?agentId=agent-1&limit=200");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "run-1", status: "succeeded" }]);
    expect(mocks.listRuns).toHaveBeenCalledWith("company-1", "agent-1", 200);
  });

  it("keeps /companies/:companyId/heartbeat-runs behavior", async () => {
    const app = makeApp();

    const res = await request(app).get("/api/companies/company-1/heartbeat-runs?limit=200");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "run-1", status: "succeeded" }]);
    expect(mocks.listRuns).toHaveBeenCalledWith("company-1", undefined, 200);
  });
});
