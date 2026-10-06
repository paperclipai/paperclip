import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues, plugins, principalPermissionGrants, toolConnectionInstalls } from "@paperclipai/db";
import { type AiConnectionBinding, type AiConnectionPoolMember, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";
import { aiConnectionRouterService } from "../services/ai-connection-router.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { toolAccessService } from "../services/tool-access.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-hire-ai-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "hire-ai");
  database = await startEmbeddedPostgresTestDatabase("paperclip-hire-ai-db-");
  db = createDb(database.connectionString);
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

async function fixture(provider: "anthropic" | "openai", method: "api_key" | "subscription" = "api_key") {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `owner-${companyId}`;
  const binding = { provider, method, mode: "responsible_user" } as const;
  const adapterType = provider === "anthropic" ? "claude_local" : "codex_local";
  await db.insert(companies).values({ id: companyId, name: "Hiring connection test", issuePrefix: `H${companyId.slice(0, 7)}`, defaultResponsibleUserId: userId });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:create" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Manager", role: "ceo", adapterType, runtimeConfig: { aiConnection: binding } });
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", responsibleUserId: userId }).returning();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "agent", agentId, companyId, runId: run!.id, source: "agent_jwt", onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  const credential = method === "api_key" ? "fixture-api-key" : provider === "anthropic" ? "fixture-subscription-token" : JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } });
  const account = await aiConnectionService(db).save(companyId, userId, {
    provider, method, name: "Manager's connection", ownership: "personal", agentIds: [agentId], allAgents: false,
    ...(method === "api_key" ? { apiKey: credential } : { loginSessionId: "fixture" }),
  }, credential);
  return { app, companyId, agentId, userId, binding, adapterType, account, runId: run!.id };
}

function hired(response: request.Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.agent ?? response.body;
}

async function poolFixture(f: Awaited<ReturnType<typeof fixture>>, extraMembers: AiConnectionPoolMember[] = []) {
  await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
  const pluginKey = `fixture.pool-${f.companyId}`;
  const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Pool fixture", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "AI connection pool", description: "Fixture" }, entrypoints: { worker: "worker.js" } };
  await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0", manifestJson: manifest, status: "ready" });
  const member: AiConnectionPoolMember = { id: randomUUID(), binding: { ...f.account, provider: "openai", method: "api_key", mode: "delegated" }, profile: { provider: "codex", model: "gpt-5.6-sol" } };
  const pool = await aiConnectionRouterService(db).save(pluginKey, { companyId: f.companyId, config: { name: "Fixture pool", enabled: true, mode: "round_robin", thresholdPercent: 90, members: [member, ...extraMembers] } }, f.userId);
  return { pool, binding: { mode: "router", connectionId: pool.id } as const, member };
}

describe("agent-created hires use managed AI connections", () => {
  it.each(["agent-hires", "agents"])("%s inherits a manager's pool without copying legacy credentials", async (endpoint) => {
    const f = await fixture("openai");
    const p = await poolFixture(f);
    const secret = await secretService(db).create(f.companyId, {
      name: "Stale manager credential", provider: "local_encrypted", value: "fixture-legacy-key",
    });
    await db.update(agents).set({
      runtimeConfig: { aiConnection: p.binding },
      adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id } } },
    }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({
      name: "Inherited pool teammate", role: "engineer", adapterType: f.adapterType,
    }));
    expect(agent.runtimeConfig.aiConnection).toEqual(p.binding);
    expect(agent.adapterConfig.env?.OPENAI_API_KEY).toBeUndefined();
    const installs = await db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, f.companyId), eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, agent.id)));
    expect(installs.map(i => i.connectionId).sort()).toEqual([p.pool.id, f.account.connectionId].sort());
  });

  it("keeps an inherited pool when copying the caller's native runtime settings", async () => {
    const f = await fixture("openai");
    const p = await poolFixture(f);
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol", lifecycleMode: "per_turn" }, runtimeConfig: { aiConnection: p.binding } }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({
      name: "Native pool teammate", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    }));
    expect(agent.runtimeConfig.aiConnection).toEqual(p.binding);
    expect(agent.adapterConfig).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", lifecycleMode: "per_turn" });
  });

  it("rejects an inherited pool with no compatible harness instead of dropping its binding", async () => {
    const f = await fixture("openai");
    const p = await poolFixture(f);
    await db.update(agents).set({ runtimeConfig: { aiConnection: p.binding } }).where(eq(agents.id, f.agentId));
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Incompatible teammate", role: "engineer", adapterType: "claude_local" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toContain("no compatible harness");
    expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
  });

  it.each(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"])("pool inheritance honors only the child's own provider auth override (%s)", async (key) => {
    const f = await fixture("openai");
    const p = await poolFixture(f);
    await db.update(agents).set({ runtimeConfig: { aiConnection: p.binding } }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Explicit auth teammate", role: "engineer", adapterType: f.adapterType, adapterConfig: { env: { [key]: "fixture-explicit-key" } } }));
    expect(agent.runtimeConfig.aiConnection).toEqual(key === "OPENAI_API_KEY" ? undefined : p.binding);
    expect(agent.adapterConfig.env[key]).toEqual({ type: "plain", value: "fixture-explicit-key" });
  });

  it.each(["agent-hires", "agents"])("%s installs authorized pool members atomically with the new agent", async (endpoint) => {
    const f = await fixture("openai");
    const p = await poolFixture(f);
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({ name: "Pool teammate", role: "engineer", adapterType: f.adapterType, reportsTo: f.agentId, runtimeConfig: { aiConnection: p.binding } }));
    expect(agent.runtimeConfig.aiConnection).toEqual(p.binding);
    const installs = await db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, f.companyId), eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, agent.id)));
    expect(installs.map(i => i.connectionId).sort()).toEqual([p.pool.id, f.account.connectionId].sort());
    const [creation] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, agent.id), eq(activityLog.action, endpoint === "agent-hires" ? "agent.hire_created" : "agent.created")));
    expect(creation.details).toMatchObject({ aiConnectionPoolId: p.pool.id, aiConnectionMemberInstallIds: [f.account.connectionId] });
    const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType: f.adapterType, binding: p.member.binding, config: {} });
    try { expect(runtime.attribution.connectionId).toBe(f.account.connectionId); } finally { await runtime.cleanup(); }
  });

  it("rejects a saved pool binding when no member is installed for that agent", async () => {
    const f = await fixture("openai");
    const p = await poolFixture(f);
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.userId, permissionKey: "agents:configure" });
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.account.connectionId));
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ runtimeConfig: { aiConnection: p.binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.details).toMatchObject({ code: "ai_connection_pool_no_eligible_member" });
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(saved.runtimeConfig.aiConnection).toEqual(f.binding);
  });

  it("does not install a restricted shared connection through pool membership", async () => {
    const f = await fixture("openai");
    const otherOwner = `other-${f.companyId}`;
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: otherOwner, membershipRole: "member", status: "active" });
    const account = await aiConnectionService(db).save(f.companyId, otherOwner, { provider: "openai", method: "api_key", ownership: "shared", name: "Shared credential, restricted installation", apiKey: "fixture", agentIds: [f.agentId], allAgents: false }, "fixture");
    await toolAccessService(db).replaceConnectionGrantMembers(account.connectionId, account.grantId, [f.userId], { userId: otherOwner });
    const member: AiConnectionPoolMember = { id: randomUUID(), binding: { ...account, provider: "openai", method: "api_key", mode: "shared" }, profile: { provider: "codex", model: "gpt-5.6-sol" } };
    const p = await poolFixture(f, [member]);
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agents`).send({ name: "Restricted pool teammate", role: "engineer", adapterType: f.adapterType, runtimeConfig: { aiConnection: p.binding } }));
    const input = { companyId: f.companyId, userId: f.userId, adapterType: f.adapterType, binding: member.binding };
    expect((await aiConnectionService(db).select({ ...input, agentId: f.agentId })).connection.id).toBe(account.connectionId);
    await expect(aiConnectionService(db).select({ ...input, agentId: agent.id })).rejects.toThrow("not permitted for this agent");
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, account.connectionId));
    expect(installs.map(i => i.targetId)).toEqual([f.agentId]);
  });

  it.each([false, true])("rechecks an unchanged pool when the agent harness changes (compatible member: %s)", async (compatible) => {
    const f = await fixture("openai");
    const extra: AiConnectionPoolMember[] = [];
    if (compatible) {
      const account = await aiConnectionService(db).save(f.companyId, f.userId, { provider: "anthropic", method: "api_key", ownership: "personal", name: "Claude fixture", apiKey: "fixture", allAgents: true, agentIds: [] }, "fixture");
      extra.push({ id: randomUUID(), binding: { ...account, provider: "anthropic", method: "api_key", mode: "delegated" }, profile: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } });
    }
    const p = await poolFixture(f, extra);
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.userId, permissionKey: "agents:configure" });
    await db.update(agents).set({ runtimeConfig: { aiConnection: p.binding } }).where(eq(agents.id, f.agentId));
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5" } });
    expect(response.status, JSON.stringify(response.body)).toBe(compatible ? 200 : 422);
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(saved.adapterType).toBe(compatible ? "claude_local" : "codex_local");
    expect(saved.runtimeConfig.aiConnection).toEqual(p.binding);
  });

  for (const operation of ["test", "save"] as const) {
    it.each([401, 403, 429, 503, null])(`${operation} changes API-key health only for a provider rejection (status: %s)`, async (status) => {
      const f = await fixture("anthropic", "api_key");
      await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.userId, permissionKey: "agents:configure" });
      const original = getServerAdapter(f.adapterType);
      registerServerAdapter({ ...original, testEnvironment: async () => ({ adapterType: f.adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
      const network = vi.spyOn(globalThis, "fetch");
      if (status === null) network.mockRejectedValue(new Error("Network unavailable"));
      else network.mockResolvedValue(new Response(null, { status }));
      try {
        const response = operation === "test"
          ? await request(f.app).post(`/api/companies/${f.companyId}/adapters/${f.adapterType}/test-environment`).send({ agentId: f.agentId, aiConnection: f.binding, adapterConfig: {} })
          : await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { model: "changed-model" } });
        expect(response.status, JSON.stringify(response.body)).toBe(operation === "test" ? 200 : 422);
        const rejected = status === 401 || status === 403;
        expect(await aiConnectionService(db).list(f.companyId, f.userId)).toEqual([expect.objectContaining({ status: rejected ? "needs_attention" : "connected" })]);
      } finally { network.mockRestore(); unregisterServerAdapter(f.adapterType); }
    });
  }

  it.each(["test", "save"] as const)("%s marks a hello-test authentication rejection as needing attention and reconnect repairs the same default", async (operation) => {
    const f = await fixture("anthropic", "subscription");
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.userId, permissionKey: "agents:configure" });
    const original = getServerAdapter(f.adapterType);
    registerServerAdapter({ ...original, testEnvironment: async () => ({
      adapterType: f.adapterType, status: "fail", testedAt: new Date().toISOString(),
      checks: [{ code: "claude_hello_probe_auth_required", level: "error", message: "The account needs sign-in." }],
    }) });
    try {
      const response = operation === "test"
        ? await request(f.app).post(`/api/companies/${f.companyId}/adapters/${f.adapterType}/test-environment`).send({ agentId: f.agentId, aiConnection: f.binding, adapterConfig: {} })
        : await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { model: "changed-model" } });
      expect(response.status, JSON.stringify(response.body)).toBe(operation === "test" ? 200 : 422);
      if (operation === "test") expect(response.body.status).toBe("fail");
      const service = aiConnectionService(db);
      expect(await service.list(f.companyId, f.userId)).toEqual([expect.objectContaining({ id: f.account.connectionId, isDefault: true, status: "needs_attention" })]);
      await expect(service.select({ companyId: f.companyId, userId: f.userId, agentId: f.agentId, adapterType: f.adapterType, binding: f.binding })).rejects.toThrow("Reconnect");
      const repaired = await service.save(f.companyId, f.userId, {
        provider: "anthropic", method: "subscription", name: "Ignored reconnect name", ownership: "personal",
        connectionId: f.account.connectionId, allAgents: true, agentIds: [], loginSessionId: "fixture",
      }, "repaired-token");
      expect(repaired).toEqual(f.account);
      expect(await service.list(f.companyId, f.userId)).toEqual([expect.objectContaining({ id: f.account.connectionId, isDefault: true, status: "connected" })]);
      const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.account.connectionId));
      expect(installs).toEqual([expect.objectContaining({ targetType: "agent", targetId: f.agentId })]);
      registerServerAdapter({ ...original, testEnvironment: async () => ({
        adapterType: f.adapterType, status: "pass", testedAt: new Date().toISOString(),
        checks: [{ code: "claude_hello_probe_passed", level: "info", message: "hello" }],
      }) });
      const saved = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { model: "changed-model" } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: f.agentId, responsibleUserId: f.userId, adapterType: f.adapterType, binding: f.binding, config: saved.body.adapterConfig });
      try {
        expect(runtime.attribution.grantId).toBe(f.account.grantId);
        expect((runtime.config.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN).toBe("repaired-token");
      } finally { await runtime.cleanup(); }
    } finally { unregisterServerAdapter(f.adapterType); }
  });

  it.each([false, true])("a failed environment test preserves connection health for a runtime failure or a newer reconnect (reconnected: %s)", async (reconnected) => {
    const f = await fixture("anthropic", "subscription");
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.userId, permissionKey: "agents:configure" });
    const original = getServerAdapter(f.adapterType);
    registerServerAdapter({ ...original, testEnvironment: async () => {
      if (reconnected) await aiConnectionService(db).save(f.companyId, f.userId, {
        provider: "anthropic", method: "subscription", name: "My Claude", ownership: "personal",
        connectionId: f.account.connectionId, allAgents: false, agentIds: [f.agentId], loginSessionId: "fixture",
      }, "newer-token");
      return {
        adapterType: f.adapterType, status: "fail", testedAt: new Date().toISOString(),
        checks: [{ code: reconnected ? "claude_hello_probe_auth_required" : "claude_cli_not_found", level: "error", message: "Test failed." }],
      };
    } });
    try {
      const response = await request(f.app).post(`/api/companies/${f.companyId}/adapters/${f.adapterType}/test-environment`).send({ agentId: f.agentId, aiConnection: f.binding, adapterConfig: {} });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.status).toBe("fail");
      expect(await aiConnectionService(db).list(f.companyId, f.userId)).toEqual([expect.objectContaining({ status: "connected" })]);
    } finally { unregisterServerAdapter(f.adapterType); }
  });

  for (const endpoint of ["agent-hires", "agents"]) {
    it.each([
      ["anthropic", "api_key"], ["anthropic", "subscription"],
      ["openai", "api_key"], ["openai", "subscription"],
    ] as const)(`${endpoint}: %s hires its own provider using the same %s binding`, async (provider, method) => {
      const f = await fixture(provider, method);
      const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({ name: "Teammate", role: "engineer", adapterType: f.adapterType, reportsTo: f.agentId }));
      expect(agent.runtimeConfig.aiConnection).toEqual(f.binding);
      const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType: agent.adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig });
      try {
        expect(runtime.attribution).toMatchObject({ connectionId: f.account.connectionId, grantId: f.account.grantId, method, responsibleUserId: f.userId });
      } finally { await runtime.cleanup(); }
    });
  }

  for (const endpoint of ["agent-hires", "agents"]) {
    it.each([
      ["ANTHROPIC_API_KEY", "child-key"],
      ["ANTHROPIC_API_KEY", ""],
      ["CLAUDE_CONFIG_DIR", "/tmp/child-claude-home"],
      ["ANTHROPIC_BASE_URL", "https://example.invalid"],
    ])(`${endpoint}: preserves an explicit child auth setting %s=%s`, async (key, value) => {
      const f = await fixture("anthropic");
      const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({
        name: "Explicit auth", role: "engineer", adapterType: f.adapterType,
        adapterConfig: { env: { [key]: value } },
      }));
      expect(agent.runtimeConfig.aiConnection).toBeUndefined();
      const [saved] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect((saved.adapterConfig.env as Record<string, unknown>)[key]).toEqual({ type: "plain", value });
    });
  }

  it.each([true, false])("managed bindings do not inherit legacy credentials (managed parent: %s)", async (managedParent) => {
    const f = await fixture("openai");
    const secret = await secretService(db).create(f.companyId, {
      name: "Legacy parent key", provider: "local_encrypted", value: "fixture-legacy-key",
    });
    await db.update(agents).set({
      runtimeConfig: managedParent ? { aiConnection: f.binding } : {},
      adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id } } },
    }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({
      name: "Managed child", role: "engineer", adapterType: f.adapterType,
      ...(managedParent ? {} : { runtimeConfig: { aiConnection: f.binding } }),
    }));
    expect(agent.runtimeConfig.aiConnection).toEqual(f.binding);
    expect(agent.adapterConfig.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps unmanaged parent hires on their existing authentication path", async () => {
    const f = await fixture("openai");
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({
      name: "Legacy authentication", role: "engineer", adapterType: f.adapterType,
    }));
    expect(agent.runtimeConfig.aiConnection).toBeUndefined();
  });

  it.each(["anthropic", "openai"] as const)("%s can hire the other provider before that user connects it", async (provider) => {
    const f = await fixture(provider);
    const otherProvider = provider === "anthropic" ? "openai" : "anthropic";
    const adapterType = otherProvider === "anthropic" ? "claude_local" : "codex_local";
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Other provider", role: "engineer", adapterType }));
    expect(agent.runtimeConfig.aiConnection).toMatchObject({ provider: otherProvider, mode: "responsible_user" });
    await expect(prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig })).rejects.toMatchObject({ details: { code: "ai_connection_default_missing" } });
    expect(agent.status).toBe("idle");
  });

  for (const endpoint of ["agent-hires", "agents"]) {
    it.each([
      ["anthropic", "codex_local", {}, "ANTHROPIC_API_KEY"],
      ["openai", "claude_local", {}, "OPENAI_API_KEY"],
      ["anthropic", "paperclip_runner", { provider: "codex" }, "ANTHROPIC_API_KEY"],
      ["openai", "paperclip_runner", { provider: "acpx", acpxAgent: "claude" }, "OPENAI_API_KEY"],
    ] as const)(`${endpoint}: ignores the %s auth key for a different provider in %s`, async (provider, adapterType, config, key) => {
      const f = await fixture(provider);
      const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({
        name: "Cross-provider config", role: "engineer", adapterType,
        adapterConfig: { ...config, env: { [key]: "leftover-parent-setting" } },
      }));
      expect(agent.runtimeConfig.aiConnection).toMatchObject({
        provider: provider === "anthropic" ? "openai" : "anthropic", mode: "responsible_user",
      });
    });
  }

  it("accepts an explicit personal default before authentication, including approval-gated hires", async () => {
    const f = await fixture("anthropic");
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, f.companyId));
    const binding: AiConnectionBinding = { provider: "openai", method: "subscription", mode: "responsible_user" };
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Future Codex", role: "engineer", adapterType: "codex_local", runtimeConfig: { aiConnection: binding } });
    const agent = hired(response);
    expect(agent.runtimeConfig.aiConnection).toEqual(binding);
    expect(agent.status).toBe("pending_approval");
    expect(response.body.approval.payload.runtimeConfig.aiConnection).toEqual(binding);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).toEqual([]);
  });

  it.each(["anthropic", "openai"] as const)("inherits %s when the hire uses the native runner", async (provider) => {
    const f = await fixture(provider, "subscription");
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Native teammate", role: "engineer", adapterType: "paperclip_runner", adapterConfig: provider === "anthropic" ? { provider: "acpx", acpxAgent: "claude" } : { provider: "codex" } }));
    expect(agent.runtimeConfig.aiConnection).toEqual(f.binding);
    const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType: agent.adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig });
    try { expect(runtime.attribution.connectionId).toBe(f.account.connectionId); } finally { await runtime.cleanup(); }
  });

  it.each([
    ["codex", { provider: "codex", model: "gpt-5.6-sol", codexPermissionMode: "never", lifecycleMode: "per_turn" }],
    ["claude", { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5", acpxPermissionMode: "approve-all", lifecycleMode: "per_turn" }],
  ] as const)("caller runtime inheritance preserves safe %s settings only", async (_name, parentConfig) => {
    const f = await fixture("anthropic", "subscription");
    await db.update(agents).set({
      adapterType: "paperclip_runner",
      adapterConfig: {
        ...parentConfig,
        cwd: "/private/parent-workspace",
        env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "parent-secret" } },
        instructionsFilePath: "/private/parent-instructions.md",
        runtimeSessionId: "parent-session",
      },
    }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({
      name: "Inherited teammate", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    }));
    expect(agent.adapterConfig).toMatchObject(parentConfig);
    expect(agent.adapterConfig).not.toHaveProperty("cwd");
    expect(agent.adapterConfig).not.toHaveProperty("env");
    expect(agent.adapterConfig.instructionsFilePath).not.toBe("/private/parent-instructions.md");
    expect(agent.adapterConfig).not.toHaveProperty("runtimeSessionId");
    expect(agent.runtimeConfig.aiConnection).toMatchObject({
      provider: parentConfig.provider === "codex" ? "openai" : "anthropic",
      mode: "responsible_user",
    });
  });

  it("rejects caller inheritance when the request supplies competing runtime settings", async () => {
    const f = await fixture("anthropic", "subscription");
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } }).where(eq(agents.id, f.agentId));
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({
      name: "Conflicting teammate", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
      adapterConfig: { model: "caller.override" },
    });
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("cannot be combined");
  });

  it.each([true, false])("preserves shared connection access boundaries (company access: %s)", async (allAgents) => {
    const f = await fixture("anthropic");
    const account = await aiConnectionService(db).save(f.companyId, f.userId, { provider: "anthropic", method: "api_key", name: "Shared Claude", ownership: "shared", apiKey: "fixture", agentIds: [f.agentId], allAgents }, "fixture");
    const binding = { provider: "anthropic", method: "api_key", mode: "shared", ...account };
    await db.update(agents).set({ runtimeConfig: { aiConnection: binding } }).where(eq(agents.id, f.agentId));
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Shared teammate", role: "engineer", adapterType: f.adapterType });
    if (!allAgents) {
      expect(response.status).toBe(403);
      expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
    } else {
      const agent = hired(response);
      expect(agent.runtimeConfig.aiConnection).toEqual(binding);
      const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType: agent.adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig });
      try { expect(runtime.attribution.connectionId).toBe(account.connectionId); } finally { await runtime.cleanup(); }
    }
  });

  it("still rejects an explicitly incompatible provider without creating a hire", async () => {
    const f = await fixture("anthropic");
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Wrong provider", role: "engineer", adapterType: "codex_local", runtimeConfig: { aiConnection: f.binding } });
    expect(response.status).toBe(422);
    expect(response.body.details.code).toBe("ai_connection_incompatible");
    expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
  });
});

describe("hired agents sharing a subscription", () => {
  it.each(["openai", "anthropic"] as const)("runs the %s child alongside a live parent and inherits its connection", async (provider) => {
    const f = await fixture(provider, "subscription");
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Concurrent teammate", role: "engineer", adapterType: f.adapterType, reportsTo: f.agentId, adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { heartbeat: { enabled: false } } }));
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Subscription child task", status: "todo", assigneeAgentId: agent.id, responsibleUserId: f.userId, createdByUserId: f.userId }).returning();
    const parentRuntime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: f.agentId, responsibleUserId: f.userId, adapterType: f.adapterType, binding: f.binding, config: { cwd: home } });
    const execute = vi.fn(async () => {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue.id));
      return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
    });
    registerServerAdapter({ ...getServerAdapter(f.adapterType), execute });
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(agent.id, "assignment", { issueId: issue.id, wakeReason: "issue_assigned", responsibleUserId: f.userId }, "system");
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
      const finished = await heartbeat.getRun(run!.id);
      expect(finished?.errorCode).not.toBe("ai_connection_busy");
      expect(finished?.contextSnapshot?.aiConnection).toMatchObject({ connectionId: f.account.connectionId, responsibleUserId: f.userId, method: "subscription" });
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_busy")))).toEqual([]);
    } finally {
      await parentRuntime.cleanup();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(f.adapterType);
    }
  });
});
