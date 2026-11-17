import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({ report: vi.fn(), retry: vi.fn(), decide: vi.fn(), canManage: vi.fn() }));
vi.mock("../services/cost-data-quality.js", () => ({ costDataQualityReport: mocks.report }));
vi.mock("../routes/ai-connections.js", () => ({ canManageAiConnections: mocks.canManage }));
vi.mock("../services/index.js", () => ({
  heartbeatService: () => ({}), costService: () => ({}), financeService: () => ({}), budgetService: () => ({}),
  companyService: () => ({}), agentService: () => ({}), issueService: () => ({}), accessService: () => ({ decide: mocks.decide }),
}));
vi.mock("../services/accounting-integrity.js", () => ({ accountingIntegrityService: () => ({ retry: mocks.retry }) }));
vi.mock("../services/billing-reconciliation.js", () => ({ billingReconciliationService: () => ({}) }));
const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const path = `/api/companies/${companyId}/costs`;
function app(type: "board" | "agent" = "board", role = "member") {
  const instance = express(); instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = type === "board" ? { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: role }] } as typeof req.actor : { type: "agent", agentId: "agent", companyId } as typeof req.actor;
    next();
  });
  instance.use("/api", costRoutes({} as Db)); instance.use(errorHandler); return instance;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.decide.mockResolvedValue({ allowed: true });
  mocks.report.mockResolvedValue({ events: [], runs: [] }); mocks.retry.mockResolvedValue({ accounted: false });
});
describe("cost details and accounting retry authorization", () => {
  it("allows cost readers, makes viewers read-only, and does not query connection-management permissions", async () => {
    expect((await request(app()).get(`${path}/data-quality?period=all`)).status).toBe(200);
    expect(mocks.report).toHaveBeenLastCalledWith(expect.anything(), companyId, true, { allTime: true });
    expect((await request(app("board", "viewer")).get(`${path}/data-quality`)).status).toBe(200);
    expect(mocks.report).toHaveBeenLastCalledWith(expect.anything(), companyId, false, undefined);
    expect(mocks.canManage).not.toHaveBeenCalled();
  });
  it("rejects agents, foreign companies, invalid date bounds and denied cost visibility before reading details", async () => {
    expect((await request(app("agent")).get(`${path}/data-quality`)).status).toBe(403);
    expect((await request(app()).get("/api/companies/other/costs/data-quality")).status).toBe(403);
    for (const query of ["from=invalid", "from=2026-10-09&to=2026-10-01", "period=all&from=2026-10-01"]) {
      expect((await request(app()).get(`${path}/data-quality?${query}`)).status).toBe(400);
    }
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(`${path}/data-quality`)).status).toBe(403);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("passes authorized retry to the existing audited accounting service without executing agents", async () => {
    const response = await request(app()).post(`${path}/retry-accounting`).send({ runId });
    expect(response.status).toBe(200); expect(response.body).toEqual({ accounted: false });
    expect(mocks.retry).toHaveBeenCalledExactlyOnceWith(companyId, runId, "alice");
  });
  it("rejects viewers, agents, cross-company requests, malformed IDs and denied cost visibility before retrying", async () => {
    expect((await request(app("board", "viewer")).post(`${path}/retry-accounting`).send({ runId })).status).toBe(403);
    expect((await request(app("agent")).post(`${path}/retry-accounting`).send({ runId })).status).toBe(403);
    expect((await request(app()).post("/api/companies/other/costs/retry-accounting").send({ runId })).status).toBe(403);
    expect((await request(app()).post(`${path}/retry-accounting`).send({ runId: "bad" })).status).toBe(400);
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).post(`${path}/retry-accounting`).send({ runId })).status).toBe(403);
    expect(mocks.retry).not.toHaveBeenCalled();
  });
});
