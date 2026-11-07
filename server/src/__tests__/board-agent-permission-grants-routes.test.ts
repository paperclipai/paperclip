import { ZodError } from "zod";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
const mocks = vi.hoisted(() => ({
  canUser: vi.fn(), hasPermission: vi.fn(), getMemberById: vi.fn(), getMembership: vi.fn(), isInstanceAdmin: vi.fn(),
  setMemberPermissions: vi.fn(), listPrincipalGrants: vi.fn(), listMembers: vi.fn(), listAgentMembers: vi.fn(), getById: vi.fn(), logActivity: vi.fn(),
}));
vi.mock("../services/access.js", () => ({ accessService: () => mocks }));
vi.mock("../services/agents.js", () => ({ agentService: () => ({ getById: mocks.getById }) }));
vi.mock("../modules/agent-lifecycle/index.js", () => ({ createAgentLifecycle: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.logActivity }));
import { accessRoutes } from "../routes/access.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const member = { id: memberId, companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" };
function app(actor?: Express.Request["actor"]) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor ?? { type: "board", source: "session", userId: "owner", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
    next();
  });
  app.use("/api", accessRoutes({} as Db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof ZodError ? 400 : error.status ?? 500).json({ error: error.message }));
  return app;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.canUser.mockResolvedValue(true); mocks.getMemberById.mockResolvedValue(member);
  mocks.getById.mockResolvedValue({ id: agentId, companyId, name: "Morgan" });
  mocks.setMemberPermissions.mockResolvedValue(member);
  mocks.getMembership.mockResolvedValue({ status: "active", membershipRole: "owner" });
  mocks.isInstanceAdmin.mockResolvedValue(false); mocks.listAgentMembers.mockResolvedValue([{ ...member, grants: [] }]);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.listPrincipalGrants.mockResolvedValue([{ permissionKey: "agents:configure", scope: null }]);
});
describe("board administration of agent principal grants", () => {
  it("updates the existing company-scoped agent membership through the member permissions route", async () => {
    const grants = [{ permissionKey: "agents:configure", scope: { agentIds: [agentId] } }];
    const response = await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants });
    expect(response.status).toBe(200);
    expect(mocks.setMemberPermissions).toHaveBeenCalledWith(companyId, memberId, grants, "owner");
    expect(response.body).toMatchObject({ id: memberId, principalType: "agent", principalId: agentId });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId, actorType: "user", actorId: "owner", entityId: memberId }));
  });
  it("discovers actual same-company agent membership IDs only under an explicit board query", async () => {
    const response = await request(app()).get(`/api/companies/${companyId}/members?principalType=agent`);
    expect(response.status).toBe(200); expect(mocks.listAgentMembers).toHaveBeenCalledWith(companyId);
    expect(response.body.members).toEqual([{ ...member, grants: [] }]); expect(response.body.members[0]).not.toHaveProperty("user");
  });
  it("preserves the complete operational replacement and revokes with an empty list", async () => {
    const grants = [{ permissionKey: "agents:configure" }, { permissionKey: "users:invite" }, { permissionKey: "tools:use", scope: { toolIds: ["one"] } }, { permissionKey: "tasks:assign" }];
    expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants })).status).toBe(200);
    expect(mocks.setMemberPermissions).toHaveBeenLastCalledWith(companyId, memberId, grants, "owner");
    mocks.listPrincipalGrants.mockResolvedValue([]);
    const revoked = await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [] });
    expect(revoked.status).toBe(200); expect(revoked.body.grants).toEqual([]); expect(mocks.setMemberPermissions).toHaveBeenLastCalledWith(companyId, memberId, [], "owner");
  });
  it.each(["users:manage_permissions", "joins:approve"])("rejects protected agent authority %s without mutation", async permissionKey => {
    expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [{ permissionKey }] })).status).toBe(403);
    expect(mocks.setMemberPermissions).not.toHaveBeenCalled(); expect(mocks.logActivity).not.toHaveBeenCalled();
  });
  it("rejects agent self-grants and discovery even with the management key", async () => {
    const actor = { type: "agent", agentId, companyId, source: "agent_key" } as Express.Request["actor"];
    expect((await request(app(actor)).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [{ permissionKey: "users:invite" }] })).status).toBe(403);
    expect((await request(app(actor)).get(`/api/companies/${companyId}/members?principalType=agent`)).status).toBe(403);
    expect(mocks.setMemberPermissions).not.toHaveBeenCalled(); expect(mocks.listAgentMembers).not.toHaveBeenCalled();
  });
  it("denies an unauthorized board and cross-company actor", async () => {
    mocks.canUser.mockResolvedValue(false);
    expect((await request(app()).get(`/api/companies/${companyId}/members?principalType=agent`)).status).toBe(403);
    expect(mocks.listAgentMembers).not.toHaveBeenCalled();
    expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [] })).status).toBe(403);
    mocks.canUser.mockResolvedValue(true);
    expect((await request(app({ type: "board", source: "session", userId: "stranger", companyIds: [] } as Express.Request["actor"]))
      .patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [] })).status).toBe(403);
    expect(mocks.setMemberPermissions).not.toHaveBeenCalled();
  });
  it("rejects a foreign or missing actual agent behind the membership", async () => {
    for (const target of [null, { id: agentId, companyId: "foreign" }]) {
      mocks.getById.mockResolvedValue(target);
      expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [] })).status).toBe(404);
    }
    expect(mocks.setMemberPermissions).not.toHaveBeenCalled();
  });
  it("keeps existing human self, owner and instance-admin protections", async () => {
    for (const target of [
      { ...member, principalType: "user", principalId: "owner", membershipRole: "owner" },
      { ...member, principalType: "user", principalId: "peer", membershipRole: "owner" },
      { ...member, principalType: "user", principalId: "platform-admin", membershipRole: "operator" },
    ]) {
      mocks.getMemberById.mockResolvedValue(target); mocks.isInstanceAdmin.mockResolvedValue(target.principalId === "platform-admin");
      expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [] })).status).toBe(403);
    }
    expect(mocks.setMemberPermissions).not.toHaveBeenCalled(); expect(mocks.getById).not.toHaveBeenCalled();
  });

  it("rejects malformed principal filters and unknown permission keys", async () => {
    expect((await request(app()).get(`/api/companies/${companyId}/members?principalType=unknown`)).status).toBe(400);
    expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/permissions`).send({ grants: [{ permissionKey: "instance:admin" }] })).status).toBe(400);
    expect(mocks.setMemberPermissions).not.toHaveBeenCalled();
  });
  it("does not open agent membership role or status mutations", async () => {
    expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}`).send({ status: "suspended" })).status).toBe(403);
    expect((await request(app()).patch(`/api/companies/${companyId}/members/${memberId}/role-and-grants`).send({ membershipRole: "admin", grants: [] })).status).toBe(403);
    expect(mocks.setMemberPermissions).not.toHaveBeenCalled();
  });

});
