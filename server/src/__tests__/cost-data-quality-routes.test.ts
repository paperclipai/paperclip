import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({ report: vi.fn(), retry: vi.fn(), preview: vi.fn(), settle: vi.fn(), decide: vi.fn(), canManage: vi.fn() }));
vi.mock("../services/cost-data-quality.js", () => ({ costDataQualityReport: mocks.report }));
vi.mock("../routes/ai-connections.js", () => ({ canManageAiConnections: mocks.canManage }));
vi.mock("../services/index.js", () => ({
  heartbeatService: () => ({}), costService: () => ({}), financeService: () => ({}), budgetService: () => ({}),
  companyService: () => ({}), agentService: () => ({}), issueService: () => ({}), accessService: () => ({ decide: mocks.decide }),
}));
vi.mock("../services/accounting-integrity.js", () => ({ accountingIntegrityService: () => ({ retry: mocks.retry,
  settlementPreview: mocks.preview, settle: mocks.settle }) }));
vi.mock("../services/billing-reconciliation.js", () => ({ billingReconciliationService: () => ({}) }));
const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const path = `/api/companies/${companyId}/costs`;
function app(type: "board" | "agent" = "board", role: string | null = "member", status = "active", isInstanceAdmin = false) {
  const instance = express(); instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = type === "board" ? { type: "board", source: "session", userId: "alice", companyIds: [companyId], isInstanceAdmin,
      memberships: role ? [{ companyId, status, membershipRole: role }] : [] } as typeof req.actor : { type: "agent", agentId: "agent", companyId } as typeof req.actor;
    next();
  });
  instance.use("/api", costRoutes({} as Db)); instance.use(errorHandler); return instance;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.decide.mockResolvedValue({ allowed: true });
  mocks.report.mockResolvedValue({ events: [], runs: [] }); mocks.retry.mockResolvedValue({ accounted: false });
  mocks.preview.mockResolvedValue({ runId }); mocks.settle.mockResolvedValue({ accounted: true });
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
  it("reports settlement permission only to company owners", async () => {
    expect((await request(app("board", "owner")).get(`${path}/data-quality`)).body.canSettle).toBe(true);
    for (const role of ["admin", "member", "viewer"]) {
      expect((await request(app("board", role)).get(`${path}/data-quality`)).body.canSettle).toBe(false);
    }
  });
});
describe("owner-approved run settlement authorization", () => {
  const settlement = `${path}/runs/${runId}/settlement`;
  const body = { idempotencyKey: "decision", expectedRevision: "a".repeat(64), estimatedCents: "12.5",
    reason: "Provider console", confirmStopped: true };
  it("lets an active company owner preview and settle through the accounting service", async () => {
    expect((await request(app("board", "owner")).get(settlement)).status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(companyId, runId);
    const response = await request(app("board", "owner")).post(settlement).send(body);
    expect(response.status).toBe(200); expect(response.body).toEqual({ accounted: true });
    expect(mocks.settle).toHaveBeenCalledExactlyOnceWith(companyId, runId, { ...body, estimatedCents: "12.5000000" }, "alice");
  });
  it("lets an instance admin settle unless the admin is a viewer in this company", async () => {
    expect((await request(app("board", null, "active", true)).post(settlement).send(body)).status).toBe(200);
    const viewer = app("board", "viewer", "active", true);
    expect((await request(viewer).get(`${path}/data-quality`)).body.canSettle).toBe(false);
    expect((await request(viewer).get(settlement)).status).toBe(403);
    expect((await request(viewer).post(settlement).send(body)).status).toBe(403);
    expect(mocks.settle).toHaveBeenCalledOnce();
  });
  it("rejects admins, members, viewers, inactive owners, agents, other companies and denied cost visibility", async () => {
    for (const actor of [app("board", "admin"), app("board", "member"), app("board", "viewer"), app("board", "owner", "suspended"), app("agent")]) {
      expect((await request(actor).get(settlement)).status).toBe(403);
      expect((await request(actor).post(settlement).send(body)).status).toBe(403);
    }
    expect((await request(app("board", "owner")).post(`/api/companies/other/costs/runs/${runId}/settlement`).send(body)).status).toBe(403);
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app("board", "owner")).post(settlement).send(body)).status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation, a review revision and a valid run ID", async () => {
    for (const change of [{ confirmStopped: false }, { confirmStopped: undefined }, { expectedRevision: "stale" },
      { estimatedCents: "-1" }, { reason: " " }]) {
      expect((await request(app("board", "owner")).post(settlement).send({ ...body, ...change })).status).toBe(400);
    }
    expect((await request(app("board", "owner")).get(`${path}/runs/bad/settlement`)).status).toBe(400);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});
