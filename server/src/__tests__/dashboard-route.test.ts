import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRoutes } from "../routes/dashboard.js";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => ({
    summary: mocks.summary,
  }),
}));

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", dashboardRoutes({} as any));
  return app;
}

describe("dashboard route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summary.mockResolvedValue({
      companyId: "company-1",
      agents: { active: 0, running: 0, paused: 0, error: 0 },
      tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
      staleTasks: 0,
      runs: {
        successFailureSeries: [
          { date: "2026-03-01", succeeded: 1, failed: 0 },
        ],
      },
    });
  });

  it("returns dashboard summary including run success/failure series", async () => {
    const app = makeApp();

    const res = await request(app).get("/api/companies/company-1/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.runs.successFailureSeries).toEqual([
      { date: "2026-03-01", succeeded: 1, failed: 0 },
    ]);
    expect(mocks.summary).toHaveBeenCalledWith("company-1");
  });
});
