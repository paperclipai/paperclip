import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDb, agents, approvals, principalPermissionGrants, authUsers, companies, companyMemberships, dotAgentBindings, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { dotInvitationService } from "../services/dot-invitations.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { dotRunnerRoutes } from "../routes/dot-runner.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { HttpError } from "../errors.js";
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let root: string;
beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("dot-invitations-");
  db = createDb(temporary.connectionString);
  root = await mkdtemp(join(tmpdir(), "dot-invite-home-"));
  vi.stubEnv("PAPERCLIP_HOME", root);
  vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
  await instanceSettingsService(db).updateExperimental({ enableOpenAiDot: true, enablePublicMcp: true });
}, 120000);
afterAll(async () => { await temporary?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function fixture(requireApproval = false) {
  const userId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [company] = await db.insert(companies).values({ name: "Dot invitation", issuePrefix: "DI" + randomBytes(3).toString("hex"), requireBoardApprovalForNewAgents: requireApproval }).returning();
  await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(principalPermissionGrants).values({ companyId: company!.id, principalType: "user", principalId: userId, permissionKey: "agents:create" });
  return { userId, companyId: company!.id };
}
it("atomically resumes one pending invite across retries and never persists a pairing secret", async () => {
  const f = await fixture();
  const service = dotInvitationService(db);
  const [a, b] = await Promise.all([service.create(f.companyId, f.userId), service.create(f.companyId, f.userId)]);
  expect(a.agent.id).toBe(b.agent.id);
  expect(a.agent.status).toBe("paused");
  expect((await db.select().from(agents).where(eq(agents.id, a.agent.id)))[0]!.lifecycleState).toBe("preparing");
  expect(await service.resume(f.companyId, f.userId)).toMatchObject({ agent: { id: a.agent.id } });
  expect(await service.resume(f.companyId, randomUUID())).toBeNull();
  expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
  const code = await dotRunnerBroker(db).createPairing({ ...f, operatorId: f.userId, agentId: a.agent.id });
  const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
  expect(JSON.stringify(logs)).not.toContain(code.pairingCode);
  expect(JSON.stringify(await service.resume(f.companyId, f.userId))).not.toContain(code.pairingCode);
});
it("honors hiring approval before issuing a pairing capability", async () => {
  const f = await fixture(true);
  const invite = await dotInvitationService(db).create(f.companyId, f.userId);
  expect(invite.agent.status).toBe("pending_approval");
  expect(invite.approvalId).toBeTruthy();
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, invite.approvalId!));
  expect(approval).toMatchObject({ status: "pending", type: "hire_agent", payload: { agentId: invite.agent.id } });
  await expect(dotRunnerBroker(db).createPairing({ ...f, operatorId: f.userId, agentId: invite.agent.id })).rejects.toThrow("approved");
  expect((await dotInvitationService(db).create(f.companyId, f.userId)).approvalId).toBe(invite.approvalId);
});
it("replaces only the named pending capability and refuses to revoke a connected binding", async () => {
  const f = await fixture(); const broker = dotRunnerBroker(db);
  const invite = await dotInvitationService(db).create(f.companyId, f.userId);
  const input = { companyId: f.companyId, agentId: invite.agent.id, operatorId: f.userId };
  const first = await broker.createPairing(input);
  const second = await broker.createPairing({ ...input, replaceBindingId: first.bindingId });
  expect(second.bindingId).not.toBe(first.bindingId);
  const [old] = await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id, first.bindingId));
  expect(old).toMatchObject({ status: "revoked", pairingCodeHash: null });
  await expect(broker.createPairing({ ...input, replaceBindingId: first.bindingId })).rejects.toThrow("changed");
  await db.update(dotAgentBindings).set({ status: "connected" }).where(eq(dotAgentBindings.id, second.bindingId));
  await expect(broker.createPairing({ ...input, replaceBindingId: second.bindingId })).rejects.toThrow("changed");
});
it("keeps invite routes company-scoped and denies viewers and agent actors", async () => {
  const f = await fixture();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const mode = req.headers["x-test-actor"];
    req.actor = mode === "agent" ? { type: "agent", agentId: randomUUID(), companyId: f.companyId }
      : { type: "board", source: "session", userId: f.userId, companyIds: [f.companyId],
        memberships: [{ companyId: f.companyId, membershipRole: mode === "viewer" ? "viewer" : "owner", status: "active" }] };
    next();
  });
  app.use(dotRunnerRoutes(db, "https://paperclip.example/mcp/runner"));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: error.message });
  });
  const path = `/companies/${f.companyId}/dot-invitations`;
  for (const actor of ["viewer", "agent"]) expect((await request(app).post(path).set("x-test-actor", actor).send({})).status).toBe(403);
  expect((await request(app).post(`/companies/${randomUUID()}/dot-invitations`).send({})).status).toBe(403);
  const result = await request(app).post(path).send({});
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.agent.id).toBeTruthy();
  expect((await request(app).get(path)).body.agent.id).toBe(result.body.agent.id);
  expect(await db.select().from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.lifecycleState, "preparing")))).toHaveLength(1);
});

it("does not trust editable agent metadata as an invitation ownership receipt", async () => {
  const f = await fixture();
  const [spoof] = await db.insert(agents).values({ companyId: f.companyId, name: "Unrelated agent", adapterType: "paperclip_runner",
    adapterConfig: { provider: "openai_dot" }, metadata: { dotInvitation: { operatorId: f.userId } } }).returning();
  const service = dotInvitationService(db);
  expect(await service.resume(f.companyId, f.userId)).toBeNull();
  expect((await service.create(f.companyId, f.userId)).agent.id).not.toBe(spoof!.id);
});
