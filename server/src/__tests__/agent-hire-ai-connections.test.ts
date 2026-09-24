import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants, toolConnectionInstalls } from "@paperclipai/db";
import { type AiConnectionBinding } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";

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

describe("agent-created hires use managed AI connections", () => {
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
