import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { workspacePreferenceRoutes } from "../routes/workspace-preferences.js";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), findCompany: vi.fn() }));
vi.mock("../services/workspace-preferences.js", () => ({ workspacePreferenceService: () => mocks }));
const companyId = "11111111-1111-4111-8111-111111111111";
const url = `/api/companies/${companyId}/workspace-preferences/me`;
const viewer: Express.Request["actor"] = {
  type: "board", source: "session", userId: "alice", companyIds: [companyId],
  memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
};
const app = (identity: Express.Request["actor"] = viewer) => {
  const result = express(); result.use(express.json());
  result.use((req, _res, next) => { req.actor = identity; next(); });
  result.use("/api", workspacePreferenceRoutes({ query: { companies: { findFirst: mocks.findCompany } } } as never));
  result.use(errorHandler); return result;
};
describe("workspace preference authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCompany.mockResolvedValue({ id: companyId });
    mocks.get.mockImplementation(async userId => ({ userId, coordinatorWorkspaceEnabled: false, updatedAt: null }));
    mocks.set.mockImplementation(async (_companyId, userId, enabled) => ({ userId, coordinatorWorkspaceEnabled: enabled, updatedAt: null }));
  });
  it("reads only the caller and allows a non-admin viewer to save their own choice", async () => {
    const response = await request(app()).get("/api/workspace-preferences/me").expect(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.get).toHaveBeenCalledWith("alice");
    await request(app()).put(url).send({ coordinatorWorkspaceEnabled: true }).expect(200);
    expect(mocks.set).toHaveBeenCalledWith(companyId, "alice", true);
  });
  it.each([
    { type: "none", source: "none" },
    { type: "agent", source: "agent_key", companyId, agentId: "agent" },
    { type: "board", source: "session", companyIds: [companyId] },
  ])("rejects callers without a human principal: $type", async identity => {
    await request(app(identity as Express.Request["actor"])).get("/api/workspace-preferences/me").expect(403);
    await request(app(identity as Express.Request["actor"])).put(url).send({ coordinatorWorkspaceEnabled: true }).expect(403);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
  });
  it("does not accept someone else's identity or silently coerce the preference", async () => {
    for (const body of [{ coordinatorWorkspaceEnabled: true, userId: "bob" }, { coordinatorWorkspaceEnabled: "true" }, {}]) {
      await request(app()).put(url).send(body).expect(400);
    }
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rejects foreign or inactive audit context, including instance admins without company access", async () => {
    for (const identity of [{ ...viewer, companyIds: [] }, { ...viewer, memberships: [] }, { ...viewer, companyIds: [], isInstanceAdmin: true }]) {
      await request(app(identity)).put(url).send({ coordinatorWorkspaceEnabled: true }).expect(403);
    }
    mocks.findCompany.mockResolvedValue(null);
    await request(app()).put(url).send({ coordinatorWorkspaceEnabled: true }).expect(404);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("accepts the existing local implicit principal", async () => {
    await request(app({ type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true }))
      .put(url).send({ coordinatorWorkspaceEnabled: false }).expect(200);
    expect(mocks.set).toHaveBeenCalledWith(companyId, "local-board", false);
  });
  it("reports a failed save rather than claiming the shell changed", async () => {
    mocks.set.mockRejectedValue(new Error("Database unavailable"));
    await request(app()).put(url).send({ coordinatorWorkspaceEnabled: true }).expect(500);
  });
});
