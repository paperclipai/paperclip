import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { museQualificationRoutes } from "../routes/muse-qualification.js";
const mocks = vi.hoisted(() => ({ beginQualification: vi.fn(), endQualification: vi.fn(), readQualificationEvidence: vi.fn(), decide: vi.fn(), getById: vi.fn() }));
vi.mock("../services/muse-runner-broker.js", () => ({ museRunnerBroker: () => mocks }));
vi.mock("../services/access.js", () => ({ accessService: () => mocks }));
vi.mock("../services/agents.js", () => ({ agentService: () => mocks }));
const companyId = "10000000-0000-4000-8000-000000000001", agentId = "20000000-0000-4000-8000-000000000001";
const bindingId = "30000000-0000-4000-8000-000000000001", qualificationId = "40000000-0000-4000-8000-000000000001";
const path = `/companies/${companyId}/agents/${agentId}/muse-binding/qualification`;
const body = { bindingId, qualificationId, generation: 1, expectedRevision: 2 };
function app(actor: Record<string, unknown> = { type: "board", source: "board_key", userId: "operator", companyIds: [companyId] }) {
  const result = express(); result.use(express.json());
  result.use((req, _res, next) => { Object.assign(req, { actor }); next(); });
  result.use(museQualificationRoutes({} as Db));
  result.use((error: { status?: number; name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ error: "request_rejected" });
  });
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getById.mockResolvedValue({ id: agentId, companyId });
  mocks.decide.mockResolvedValue({ allowed: true });
  mocks.beginQualification.mockResolvedValue({ qualificationId, startedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-01-02T00:00:00.000Z", revision: 3 });
  mocks.endQualification.mockResolvedValue(undefined);
  mocks.readQualificationEvidence.mockResolvedValue({ assignments: [], contacts: [] });
});
describe("operator-only Muse qualification routes", () => {
  it("uses current operator permission and a server-bounded 24h deadline", async () => {
    const before = Date.now();
    const response = await request(app()).post(path).send(body);
    expect(response.status).toBe(201); expect(response.headers["cache-control"]).toBe("no-store");
    const input = mocks.beginQualification.mock.calls[0]![0];
    expect(input).toMatchObject({ ...body, companyId, agentId, operatorId: "operator" });
    expect(input.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(input.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "agent_config:update", scope: { requiresChangeGrant: true } }));
  });
  it("rejects agent, human-MCP, implicit and cross-company callers before starting", async () => {
    for (const actor of [
      { type: "agent", source: "agent_key", agentId, companyId },
      { type: "board", source: "mcp_oauth", userId: "operator", companyIds: [companyId] },
      { type: "board", source: "local_implicit", userId: "operator", companyIds: [companyId] },
      { type: "board", source: "board_key", userId: "operator", companyIds: [] },
    ]) expect((await request(app(actor)).post(path).send(body)).status).toBe(403);
    expect(mocks.beginQualification).not.toHaveBeenCalled();
  });
  it("honors current permission denial and does not allow a caller-selected duration", async () => {
    mocks.decide.mockResolvedValueOnce({ allowed: false, explanation: "Not allowed" });
    expect((await request(app()).post(path).send(body)).status).toBe(403);
    expect((await request(app()).post(path).send({ ...body, expiresAt: "2099-12-31T00:00:00Z" })).status).toBe(400);
    expect(mocks.beginQualification).not.toHaveBeenCalled();
  });
  it("requires matching agent/company for evidence and cleanup", async () => {
    mocks.getById.mockResolvedValue({ id: agentId, companyId: "50000000-0000-4000-8000-000000000001" });
    expect((await request(app()).get(path).query({ bindingId, qualificationId })).status).toBe(404);
    expect((await request(app()).delete(path).send({ bindingId, qualificationId })).status).toBe(404);
    expect(mocks.readQualificationEvidence).not.toHaveBeenCalled(); expect(mocks.endQualification).not.toHaveBeenCalled();
  });
  it("stops only the exact selected qualification and exposes non-cacheable evidence", async () => {
    const read = await request(app()).get(path).query({ bindingId, qualificationId });
    expect(read.status).toBe(200); expect(read.headers["cache-control"]).toBe("no-store");
    expect(mocks.readQualificationEvidence).toHaveBeenCalledWith(companyId, agentId, bindingId, qualificationId);
    expect((await request(app()).delete(path).send({ bindingId, qualificationId })).status).toBe(204);
    expect(mocks.endQualification).toHaveBeenCalledWith({ companyId, agentId, operatorId: "operator", bindingId, qualificationId });
  });
});
