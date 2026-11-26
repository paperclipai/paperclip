import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companyPortabilityService } from "../services/company-portability.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { withPluginInteractionOrigin } from "../services/plugin-interaction-context.js";
import { updateAgentInteractionPermissions } from "../services/agent-interaction-permissions.js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, closeFileStorageDb, principalPermissionGrants,
  issues, issueComments, toolApplications, toolConnections, toolConnectionInstalls, toolProfiles, toolProfileBindings, toolMcpGateways,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { AGENT_INTERACTION_PERMISSION_KEYS, resolveAgentInteractionPermissions } from "@paperclipai/shared";
import { agentInteractionPermissionRoutes } from "../routes/agent-interaction-permissions.js";
import { errorHandler } from "../middleware/error-handler.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { preserveAgentInteractionPermissions, assertNoInitialAgentInteractionPermissions } from "../lib/agent-interaction-permissions.js";

const execute = promisify(execFile);

describe("individual agent interaction permissions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let storageHome: string;
  beforeAll(async () => {
    storageHome = await mkdtemp(join(tmpdir(), "interaction-permissions-home-"));
    vi.stubEnv("PAPERCLIP_HOME", storageHome);
    database = await startEmbeddedPostgresTestDatabase("agent-interaction-permissions-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await closeFileStorageDb(db, 1); await db?.$client.end(); await database?.cleanup(); await rm(storageHome, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), peerId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Interaction permissions", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Permission manager", email: `${userId}@example.com`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values([agentId, peerId].map(id => ({ id, companyId, name: id, adapterType: "process", status: "idle",
      permissions: { canCreateAgents: true, unrelated: "preserved" } })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" },
      ...[agentId, peerId].map(principalId => ({ companyId, principalType: "agent", principalId, membershipRole: "member", status: "active" })),
    ]);
    await db.insert(principalPermissionGrants).values(["users:manage_permissions", "agents:read"].map(permissionKey => ({
      companyId, principalType: "user", principalId: userId, permissionKey,
    })));
    return { companyId, agentId, peerId, userId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const board = (f: Fixture): express.Request["actor"] => ({ type: "board", source: "session", userId: f.userId,
    companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }] });
  const actor = (f: Fixture): express.Request["actor"] => ({ type: "agent", source: "agent_key", agentId: f.agentId, companyId: f.companyId });
  function app(identity: express.Request["actor"]) {
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => { req.actor = identity; next(); });
    api.use("/api", agentInteractionPermissionRoutes(db));
    api.use(errorHandler);
    return api;
  }
  const path = (f: Fixture) => `/api/agents/${f.agentId}/interaction-permissions`;
  const read = (f: Fixture) => db.select().from(agents).where(eq(agents.id, f.agentId)).then(rows => rows[0]!);

  it("resolves absent settings without writing defaults, changes only supplied keys, and removes overrides with null", async () => {
    const f = await seed(), api = app(board(f));
    const initial = await read(f);
    const response = await request(api).get(path(f));
    expect(response.status, response.text).toBe(200);
    expect(response.body).toEqual({ agentId: f.agentId, companyId: f.companyId, overrides: {}, effective: resolveAgentInteractionPermissions({}) });
    expect((await read(f)).permissions).toEqual(initial.permissions);
    const first = await request(api).patch(path(f)).send({ canReceiveCommentsFromAgents: false });
    expect(first.status, first.text).toBe(200);
    expect(first.body.overrides).toEqual({ canReceiveCommentsFromAgents: false });
    const second = await request(api).patch(path(f)).send({ canAssignTasksToHumans: true });
    expect(second.body.overrides).toEqual({ canReceiveCommentsFromAgents: false, canAssignTasksToHumans: true });
    const reset = await request(api).patch(path(f)).send({ canReceiveCommentsFromAgents: null, canAssignTasksToHumans: null });
    expect(reset.status, reset.text).toBe(200);
    expect(reset.body.overrides).toEqual({});
    expect((await read(f)).permissions).toEqual(initial.permissions);
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.agentId), eq(activityLog.action, "agent.interaction_permissions_updated")));
    expect(audit).toHaveLength(3);
    expect(audit.every(row => row.actorId === f.userId)).toBe(true);
  });

  it("allows own configuration reads but denies agent/CEO changes, foreign users, and humans without permission management", async () => {
    const f = await seed(), foreign = await seed();
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, f.agentId));
    expect((await request(app(actor(f))).get(path(f))).status).toBe(200);
    expect((await request(app(actor(f))).patch(path(f)).send({ canMentionAgents: false })).status).toBe(403);
    expect((await request(app(board(foreign))).patch(path(f)).send({ canMentionAgents: false })).status).toBe(404);
    await expect(withPluginInteractionOrigin({ companyId: f.companyId, agentId: f.peerId }, () =>
      updateAgentInteractionPermissions(db, board(f), f.companyId, f.agentId, { canMentionAgents: false })))
      .rejects.toMatchObject({ status: 403 });
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.userId), eq(principalPermissionGrants.permissionKey, "users:manage_permissions")));
    expect((await request(app(board(f))).patch(path(f)).send({ canMentionAgents: false })).status).toBe(403);
    expect((await read(f)).permissions).not.toHaveProperty("interactions");
  });

  it("rejects malformed patches and pending hires without side effects", async () => {
    const f = await seed(), api = app(board(f));
    for (const input of [{}, { canMentionAgents: "false" }, { canMentionAgents: false, unexpected: false }]) {
      expect((await request(api).patch(path(f)).send(input)).status).toBe(400);
    }
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, f.agentId));
    expect((await request(api).patch(path(f)).send({ canMentionAgents: false })).status).toBe(409);
    expect((await read(f)).permissions).not.toHaveProperty("interactions");
  });

  it("serializes independent policy patches and preserves restrictions through legacy permission saves", async () => {
    const f = await seed(), api = app(board(f));
    const responses = await Promise.all([
      request(api).patch(path(f)).send({ canMentionAgents: false }),
      request(api).patch(path(f)).send({ canAssignTasksToAgents: false }),
      agentService(db).updatePermissions(f.agentId, { canCreateAgents: false }),
    ]);
    expect(responses.slice(0, 2).map(result => result && "status" in result ? result.status : null)).toEqual([200, 200]);
    const saved = await read(f);
    expect(saved.permissions).toMatchObject({ canCreateAgents: false, unrelated: "preserved",
      interactions: { canMentionAgents: false, canAssignTasksToAgents: false } });
    await expect(agentService(db).updatePermissions(f.agentId, { canCreateAgents: false, interactions: {} }))
      .rejects.toMatchObject({ status: 403 });
    await agentService(db).update(f.agentId, { permissions: { canCreateSkills: true } }, { recordRevision: { createdByUserId: f.userId } });
    expect((await read(f)).permissions.interactions).toEqual(saved.permissions.interactions);
    expect(preserveAgentInteractionPermissions(saved.permissions, {})).toHaveProperty("interactions", saved.permissions.interactions);
    expect(() => assertNoInitialAgentInteractionPermissions({ interactions: {} })).toThrow(/interaction-permissions/);
  });

  it("uses the real CLI against HTTP and PostgreSQL for inspect, all eleven settings, and reset", async () => {
    const f = await seed(), api = app(board(f));
    const server = api.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture unavailable");
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const cli = async (command: string, payload?: Record<string, boolean | null>) => {
      const result = await execute(process.execPath, ["--import", `${repo}cli/node_modules/tsx/dist/loader.mjs`, `${repo}cli/src/index.ts`,
        "agent", command, f.agentId, "--api-base", `http://127.0.0.1:${address.port}`, "--api-key", "fixture-board-token", "--json",
        ...(payload ? ["--payload-json", JSON.stringify(payload)] : [])], {
        cwd: repo, env: { ...process.env, PAPERCLIP_TELEMETRY_DISABLED: "1" }, timeout: 60000,
      });
      return JSON.parse(result.stdout);
    };
    try {
      expect((await cli("interaction-permissions")).overrides).toEqual({});
      expect((await cli("interaction-permissions:update", { canReceiveAssignmentsFromAgents: false })).overrides)
        .toEqual({ canReceiveAssignmentsFromAgents: false });
      const allDisabled = Object.fromEntries(AGENT_INTERACTION_PERMISSION_KEYS.map(key => [key, false]));
      expect((await cli("interaction-permissions:update", allDisabled)).effective).toEqual(allDisabled);
      expect((await read(f)).permissions.interactions).toEqual(allDisabled);
      const peer = await db.select().from(agents).where(eq(agents.id, f.peerId));
      expect(peer[0]!.permissions).not.toHaveProperty("interactions");
      expect((await cli("interaction-permissions:update", Object.fromEntries(AGENT_INTERACTION_PERMISSION_KEYS.map(key => [key, null])))).overrides).toEqual({});
      expect((await read(f)).permissions).not.toHaveProperty("interactions");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("preserves historical mentions on a full configuration save but rejects changed mention-bearing text", async () => {
    const f = await seed();
    const mention = `Existing [@Peer](agent://${f.peerId}) context`;
    await db.update(agents).set({ capabilities: mention }).where(eq(agents.id, f.agentId));
    expect((await request(app(board(f))).patch(path(f)).send({ canMentionAgents: false })).status).toBe(200);
    const options = { recordRevision: { createdByAgentId: f.agentId, source: "interaction-test" } };
    await agentService(db).update(f.agentId, { title: "Updated title", capabilities: mention }, options);
    expect((await read(f)).title).toBe("Updated title");
    await expect(agentService(db).update(f.agentId, { title: "Rejected title", capabilities: `${mention} changed` }, options))
      .rejects.toMatchObject({ status: 403, details: { permission: "canMentionAgents" } });
    expect((await read(f)).title).toBe("Updated title");
    const peer = { ...f, agentId: f.peerId };
    expect((await request(app(board(f))).patch(path(peer)).send({ canReceiveConfigurationChangesFromAgents: false })).status).toBe(200);
    await expect(agentService(db).update(f.peerId, { title: "Prohibited peer change" }, options))
      .rejects.toMatchObject({ status: 403, details: { permission: "canReceiveConfigurationChangesFromAgents" } });
    expect((await read(peer)).title).toBeNull();
  });
  it("blocks protected peer tool assignments without affecting shared profile changes", async () => {
    const f = await seed();
    const target = { ...f, agentId: f.peerId };
    expect((await request(app(board(f))).patch(path(target)).send({ canReceiveConfigurationChangesFromAgents: false })).status).toBe(200);
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: "interaction-tools", name: "Interaction tools" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Tool fixture", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      name: "Tool connection", uid: randomUUID(), transport: "mcp_remote", authKind: "none", enabled: true, status: "active" }).returning();
    const service = toolAccessService(db);
    const source = { actorType: "agent" as const, actorId: f.agentId };
    const denied = { status: 403, details: { permission: "canReceiveConfigurationChangesFromAgents" } };
    await expect(service.bindProfile(profile.id, { targetType: "agent", targetId: f.peerId, priority: 100 }, source)).rejects.toMatchObject(denied);
    await expect(service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.peerId }] }, source)).rejects.toMatchObject(denied);
    await expect(createToolGatewayService(db).createNamedGateway({ companyId: f.companyId,
      body: { name: "Protected gateway", profileId: profile.id, agentId: f.peerId }, actor: { agentId: f.agentId } })).rejects.toMatchObject(denied);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, f.companyId))).toHaveLength(0);
    await service.bindProfile(profile.id, { targetType: "agent", targetId: f.peerId, priority: 100 });
    await withPluginInteractionOrigin({ companyId: f.companyId, agentId: f.agentId }, async () => {
      await service.updateProfile(profile.id, { description: "Shared profile remains editable" });
      await expect(service.unbindProfile(profile.id, { targetType: "agent", targetId: f.peerId })).rejects.toMatchObject(denied);
      const gateway = await createToolGatewayService(db).createNamedGateway({ companyId: f.companyId,
        body: { name: "Own gateway", profileId: profile.id, agentId: f.agentId } });
      await expect(createToolGatewayService(db).updateNamedGateway({ companyId: f.companyId, gatewayId: gateway.id,
        body: { agentId: f.peerId } })).rejects.toMatchObject(denied);
    });
    expect((await service.getProfile(profile.id, f.companyId)).description).toBe("Shared profile remains editable");
  });

  it("preserves importer identity and rolls back forbidden imported work while retaining historical comments", async () => {
    const f = await seed();
    await db.update(agents).set({ name: "Peer" }).where(eq(agents.id, f.peerId));
    const target = { ...f, agentId: f.peerId };
    const files: Record<string, string> = {
      "COMPANY.md": '---\nschema: "agentcompanies/v1"\nname: "Imported"\n---\n',
      "tasks/work/TASK.md": '---\nname: "Imported task"\nassignee: "peer"\n---\nInitial instructions.',
      "tasks/work/doc.md": "Initial document.",
      ".paperclip.yaml": 'schemaVersion: 7\ntasks:\n  work:\n    status: todo\n    comments:\n      - body: "Historical comment"\n        authorType: system\n    documents:\n      - key: spec\n        title: Specification\n        format: markdown\n        path: tasks/work/doc.md\n',
    };
    const input = { source: { type: "inline" as const, files }, include: { company: false, agents: false, projects: false, issues: true },
      target: { mode: "existing_company" as const, companyId: f.companyId }, collisionStrategy: "skip" as const };
    const options = { mode: "agent_safe" as const, sourceCompanyId: f.companyId, actorAgentId: f.agentId, actorAgentCompanyId: f.companyId };
    await request(app(board(f))).patch(path(target)).send({ canReceiveAssignmentsFromAgents: false });
    await expect(companyPortabilityService(db).importBundle(input, null, options))
      .rejects.toMatchObject({ status: 403, details: { permission: "canReceiveAssignmentsFromAgents" } });
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(0);
    await request(app(board(f))).patch(path(target)).send({ canReceiveAssignmentsFromAgents: null, canReceiveCommentsFromAgents: false });
    await request(app(board(f))).patch(path(f)).send({ canMentionAgents: false, canCommentOnOtherTasks: false });
    files["tasks/work/doc.md"] = `[@Peer](agent://${f.peerId})`;
    await expect(companyPortabilityService(db).importBundle(input, null, options))
      .rejects.toMatchObject({ status: 403, details: { permission: "canMentionAgents" } });
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(0);
    files["tasks/work/doc.md"] = "Initial document.";
    await companyPortabilityService(db).importBundle(input, null, options);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual([
      expect.objectContaining({ assigneeAgentId: f.peerId }),
    ]);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toEqual([
      expect.objectContaining({ body: "Historical comment", authorType: "system", authorAgentId: null }),
    ]);
    files["tasks/work/TASK.md"] = '---\nname: "Unassigned imported task"\n---\nInitial instructions.';
    files["agents/new-peer/AGENTS.md"] = '---\nname: "New Peer"\nrole: engineer\n---\nInitial instructions.';
    files[".paperclip.yaml"] += 'agents:\n  new-peer:\n    adapterType: claude_local\n';
    const created = await companyPortabilityService(db).importBundle({ ...input, adapterOverrides: { "new-peer": { adapterType: "claude_local" } }, include: { ...input.include, agents: true },
      target: { mode: "new_company", newCompanyName: "Agent imported company" } }, null, options);
    expect(created.warnings.filter(warning => warning.includes("materialize"))).toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.companyId, created.company.id))).toHaveLength(1);
    expect(await db.select().from(agents).where(eq(agents.companyId, created.company.id))).toEqual([
      expect.objectContaining({ name: "New Peer" }),
    ]);
    await expect(createAgentLifecycle(db).requestHire(f.companyId, { name: "Mentioned hire", adapterType: "process", capabilities: `[@Peer](agent://${f.peerId})` },
      { createdByAgentId: f.agentId })).rejects.toMatchObject({ status: 403, details: { permission: "canMentionAgents" } });
    expect(await db.select().from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.name, "Mentioned hire")))).toHaveLength(0);
  });

});
