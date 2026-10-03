import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, companies, agents, companyMemberships, connectionGrants, plugins, aiConnectionRouterCursors, aiConnectionTaskPins, toolConnections, companySecrets, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import type { AiConnectionPoolMember, AiConnectionRouterRequest, AiConnectionRouterResult, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { aiConnectionRouterService, AiConnectionPoolExhausted, poolMemberRuntimeConfig, applyAiConnectionRouterTaskSettings } from "../services/ai-connection-router.js";
import { aiConnectionSessionCompatibilityInputs } from "../services/ai-connection-session.js";
import { projectPaperclipRunnerTaskConfig, resolvePaperclipRunnerNativeProviderInput } from "../services/native-runtime/provider-profile.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { managedAiSessionFingerprintConfig, prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import express from "express";
import request from "supertest";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService, buildEffectiveRunSessionConfigMetadata, resolveTaskSessionConfigFreshness } from "../services/heartbeat.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), secondAgentId = randomUUID(), pluginId = randomUUID();
const pluginKey = "fixture.ai-router";
const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], entrypoints: { worker: "worker.js" } };
let members: AiConnectionPoolMember[];
const proposal = vi.fn(async (_id: string, _method: string, request: AiConnectionRouterRequest): Promise<AiConnectionRouterResult> => {
  const next = (request.memberOrder.indexOf(request.lastMemberId ?? "") + 1) % request.memberOrder.length;
  const order = request.pinnedMemberId ? [request.pinnedMemberId] : [...request.memberOrder.slice(next), ...request.memberOrder.slice(0, next)];
  const selected = order.find(id => request.candidates.some(candidate => candidate.member.id === id));
  return selected ? { kind: "selected", memberId: selected } : { kind: "unavailable", skipped: {} };
});
const worker = { isRunning: () => true, call: proposal } as unknown as PluginWorkerManager;
const defaultProposal = proposal.getMockImplementation()!;
const service = () => aiConnectionRouterService(db, worker);
const resolve = (poolId: string, taskKey: string, extra = {}) => service().resolve({ companyId, poolId, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey, ...extra });
const makePool = async (config = {}) => service().save(pluginKey, { companyId, config: { name: randomUUID(), enabled: true, mode: "round_robin", thresholdPercent: 90, members, ...config } }, "alice");
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-router-tests-"));
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "router-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-router-db-"); db = createDb(database.connectionString);
  await db.insert(companies).values([{ id: companyId, name: "Router fixture", issuePrefix: "RTF" }, { id: otherCompanyId, name: "Other", issuePrefix: "RTO" }]);
  await db.insert(agents).values([agentId, secondAgentId].map(id => ({ id, companyId, name: "Router agent", adapterType: "paperclip_runner" })));
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
  await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: pluginKey, version: "0.1.0", manifestJson: manifest, status: "ready" });
  const accounts = aiConnectionService(db);
  const codex = await accounts.save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Codex", apiKey: "fixture", agentIds: [], allAgents: true }, "fixture-codex");
  const claude = await accounts.save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Claude", loginSessionId: "fixture", agentIds: [], allAgents: true }, "fixture-claude");
  members = [
    { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...codex }, profile: { provider: "codex", model: "gpt-5.6-sol", effort: "low" } },
    { id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...claude }, profile: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } },
  ];
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("durable, authorized connection routing", () => {
  it("defaults off and does not expose selectable pools before opt-in", async () => {
    expect((await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters).toBe(false);
    await expect(makePool()).rejects.toThrow("Experimental");
    expect(await service().selectable(companyId, "alice")).toEqual([]);
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
  });
  it("requires company connection management authority on pool configuration routes", async () => {
    const app = express(); app.use(express.json());
    let actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); }); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    const pool = await makePool(); const url = `/api/companies/${companyId}/ai-connection-pools`;
    expect((await request(app).get(url)).status).toBe(200);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/ai-connection-pools`)).status).toBe(403);
    actor = { ...actor, memberships: [{ companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).post(url).send({ pluginKey, config: pool })).status).toBe(403);
    expect((await request(app).get(`${url}/${pool.id}/inspection`)).status).toBe(403);
    actor = { type: "agent", agentId, companyId, source: "agent_jwt" } as unknown as typeof actor;
    expect((await request(app).get(url)).status).toBe(403);
  });
  it("rotates new tasks across qualified backends and retains pins on turns, resets and service restart", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "one")).memberId).toBe(members[0]!.id);
    expect((await resolve(pool.id, "two")).memberId).toBe(members[1]!.id);
    expect((await resolve(pool.id, "one", { overrides: { model: "claude-sonnet-5", modelReasoningEffort: "high" } })).memberId).toBe(members[0]!.id);
    expect((await aiConnectionRouterService(db, worker).resolve({ companyId, poolId: pool.id, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey: "one" })).memberId).toBe(members[0]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(2);
  });
  it("commits one allocation for duplicate starts and serializes concurrent tasks", async () => {
    const pool = await makePool();
    const same = await Promise.all(Array.from({ length: 8 }, () => resolve(pool.id, "duplicate")));
    expect(new Set(same.map(s => s.memberId)).size).toBe(1);
    const many = await Promise.all(Array.from({ length: 8 }, (_, n) => resolve(pool.id, `concurrent-${n}`)));
    expect(many.filter(s => s.memberId === members[0]!.id)).toHaveLength(4);
    const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id)); expect(pins).toHaveLength(9);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(9);
  });
  it("rolls back both pin and cursor on a failure during commit", async () => {
    const pool = await makePool();
    await db.execute(`CREATE FUNCTION fixture_router_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit crash'; END $$`);
    await db.execute(`CREATE TRIGGER fixture_router_crash BEFORE UPDATE ON ai_connection_router_cursors FOR EACH ROW EXECUTE FUNCTION fixture_router_crash()`);
    try { await expect(resolve(pool.id, "crash")).rejects.toThrow(); } finally { await db.execute(`DROP TRIGGER fixture_router_crash ON ai_connection_router_cursors`); await db.execute(`DROP FUNCTION fixture_router_crash()`); }
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
    const selected = await resolve(pool.id, "crash"); expect(selected.memberId).toBe(members[0]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
  });
  it("rechecks config revisions after a proposal and preserves removed member snapshots", async () => {
    const pool = await makePool(); const old = await resolve(pool.id, "existing");
    const saved = await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: "Edited", enabled: true, mode: "round_robin", thresholdPercent: 90, members: [members[1]!] } }, "alice");
    await expect(service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: saved }, "alice")).rejects.toThrow();
    expect((await resolve(pool.id, "existing")).binding).toEqual(old.binding);
    expect((await resolve(pool.id, "future")).memberId).toBe(members[1]!.id);
  });
  it("keeps account and harness pinned through independent composer fallback", async () => {
    const pool = await makePool();
    const first = await resolve(pool.id, "composer");
    const changed = await resolve(pool.id, "composer", { overrides: { model: "claude-sonnet-5", modelReasoningEffort: "high" } });
    expect(changed.binding).toEqual(first.binding); expect(changed.runtimeConfig).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", modelReasoningEffort: "high" }); expect(changed.notes).toHaveLength(1);
    const claude = poolMemberRuntimeConfig(members[1]!, "paperclip_runner", { model: "gpt-5.6-sol", modelReasoningEffort: "ultra" });
    expect(claude.config).toMatchObject({ provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }); expect(claude.notes).toHaveLength(2);
    const overrides = applyAiConnectionRouterTaskSettings({ model: "claude-sonnet-5", effort: "invalid", cwd: "/fixture" }, changed);
    const native = resolvePaperclipRunnerNativeProviderInput({ backend: "codex_app_server", adapterConfig: projectPaperclipRunnerTaskConfig("codex_app_server", changed.runtimeConfig, overrides) });
    expect(native).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", codexReasoningEffort: "high" });
    expect(overrides).toMatchObject({ cwd: "/fixture" }); expect(overrides).not.toHaveProperty("effort");
  });
  it("retries a changed config proposal without advancing the abandoned selection", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => {
      await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: pool.name, enabled: true, mode: pool.mode, thresholdPercent: pool.thresholdPercent, members: [members[1]!] } }, "alice");
      return { kind: "selected", memberId: members[0]!.id };
    });
    expect((await resolve(pool.id, "revision-conflict")).memberId).toBe(members[1]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
  });
  it("fails closed when the experimental flag changes during a proposal", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false }); return { kind: "selected", memberId: members[0]!.id }; });
    try { await expect(resolve(pool.id, "disabled-in-flight")).rejects.toThrow("disabled during allocation"); expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); }
  });
  it("uses only compatible legacy members and makes reassignment an independent pin", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "legacy", { adapterType: "claude_local" })).memberId).toBe(members[1]!.id);
    expect((await resolve(pool.id, "legacy", { agentId: secondAgentId, adapterType: "codex_local" })).memberId).toBe(members[0]!.id);
    const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id)); expect(pins).toHaveLength(2);
  });
  it("adopts a valid existing account and requires explicit reset for an unrelated session", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "adopt", { requireExisting: true, existingGrantId: members[1]!.binding.grantId })).memberId).toBe(members[1]!.id);
    await expect(resolve(pool.id, "foreign-session", { requireExisting: true, existingGrantId: randomUUID() })).rejects.toThrow("Reset");
    expect((await resolve(pool.id, "foreign-session")).memberId).toBe(members[0]!.id);
  });
  it("rejects cross-company access and unauthorized plugin proposals", async () => {
    const pool = await makePool();
    await expect(resolve(pool.id, "foreign", { companyId: otherCompanyId })).rejects.toThrow();
    proposal.mockResolvedValueOnce({ kind: "selected", memberId: randomUUID() });
    await expect(resolve(pool.id, "bad-proposal")).rejects.toThrow("unauthorized");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
  });
  it("does not grant members to another responsible user or move revoked pins", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "revoke");
    await expect(resolve(pool.id, "revoke", { userId: "bob" })).rejects.toThrow();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.binding.mode === "responsible_user" ? "" : selected.binding.grantId));
    try { await expect(resolve(pool.id, "revoke")).rejects.toThrow(); expect((await resolve(pool.id, "new")).memberId).toBe(members[1]!.id); }
    finally { await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[0]!.binding.grantId)); }
  });
  it("never probes pure rotation, caches authorized observations, and invalidates on credential change", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 12 } })));
    try {
      const pure = await makePool(); await resolve(pure.id, "pure"); expect(spy).not.toHaveBeenCalled();
      const aware = await makePool({ mode: "usage_aware", members: [members[1]!] }); await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(1); await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(1);
      expect((await service().inspect(companyId, aware.id, "alice"))[members[1]!.id]?.checkedAt).not.toBeNull();
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId)); const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
      await secretService(db).rotate(ref.secretId, { value: "fixture-refreshed", preserveAiSessionEpoch: true }, { userId: "alice" });
      expect((await service().inspect(companyId, aware.id, "alice"))[members[1]!.id]?.checkedAt).toBeNull();
      await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(2);
      proposal.mockResolvedValueOnce({ kind: "exhausted", retryAt: new Date(Date.now() + 60_000).toISOString(), skipped: {} });
      await expect(resolve(aware.id, "aware")).rejects.toBeInstanceOf(AiConnectionPoolExhausted);
      const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, aware.id)); expect(pins).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it("shares an in-flight usage observation across concurrent allocations", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-shared-probe", preserveAiSessionEpoch: true }, { userId: "alice" });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response(JSON.stringify({ five_hour: { utilization: 12 } }));
    });
    try {
      const pool = await makePool({ mode: "usage_aware", members: [members[1]!] });
      await Promise.all(Array.from({ length: 6 }, (_, index) => resolve(pool.id, `shared-probe-${index}`)));
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
  it("expires a usage observation at a reported reset", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-reset-cache", preserveAiSessionEpoch: true }, { userId: "alice" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 200).toISOString() } })));
    try {
      const pool = await makePool({ mode: "usage_aware", members: [members[1]!] }); await resolve(pool.id, "reset-cache"); expect(spy).toHaveBeenCalledTimes(1);
      await new Promise(resolve => setTimeout(resolve, 250)); await resolve(pool.id, "reset-cache"); expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it("treats unfinished probes as unknown within the shared selection budget", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-slow-probe", preserveAiSessionEpoch: true }, { userId: "alice" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    try { const pool = await makePool({ mode: "usage_aware", members: [members[1]!] }); const start = Date.now(); expect((await resolve(pool.id, "slow-probe")).memberId).toBe(members[1]!.id); expect(Date.now() - start).toBeLessThan(20_000); expect(proposal.mock.calls.at(-1)?.[2].candidates[0]?.usage).toBeUndefined(); }
    finally { spy.mockRestore(); }
  }, 25_000);
  it("persists run-key affinity before policy calls and reuses it across allocation recovery", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Run-key fixture", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    let affinity: string | undefined;
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    proposal.mockImplementationOnce(async (_id, _method, request) => {
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.status, "running")));
      expect(run?.contextSnapshot?.aiRouterTaskKey).toBe(run?.id);
      expect(request.taskKey).toBe(run?.id);
      affinity = run!.id;
      throw new Error("fixture policy interruption");
    });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "on_demand", reason: "manual", triggerDetail: "manual", contextSnapshot: { responsibleUserId: "alice", wakeReason: "manual" } });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("failed");
      expect(affinity).toBe(run!.id);
      expect((await heartbeat.getRun(run!.id))?.contextSnapshot?.aiRouterTaskKey).toBe(affinity);
      expect(execute).not.toHaveBeenCalled();
      const input = { agentId: agent!.id, adapterType: "claude_local" };
      const committed = await resolve(pool.id, affinity!, input);
      expect(await aiConnectionRouterService(db, worker).resolve({ companyId, poolId: pool.id, agentId: agent!.id, userId: "alice", adapterType: "claude_local", taskKey: affinity! })).toEqual(committed);
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
      expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    } finally { proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("defers a pinned task before provider work and schedules a retry with its affinity intact", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Quota fixture", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Quota fixture", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const pinned = await resolve(pool.id, issue!.id, { agentId: agent!.id, adapterType: "claude_local" });
    await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: pool.name, enabled: true, mode: "usage_aware", thresholdPercent: 90, members: [members[1]!] } }, "alice");
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 100 } })));
    proposal.mockResolvedValueOnce({ kind: "exhausted", retryAt: new Date(Date.now() + 60_000).toISOString(), skipped: { [members[1]!.id]: "Exhausted" } });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: "alice" }, triggerDetail: "system" });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("cancelled");
      const cancelled = await heartbeat.getRun(run!.id); expect(cancelled?.errorCode).toBe("ai_connection_pool_exhausted");
      expect(legacyExecutionNeedsReconciliation(cancelled!)).toBe(false);
      expect(legacyExecutionNeedsReconciliation({ ...cancelled!, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
      await expect.poll(async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")))).length, { timeout: 5000 }).toBe(1);
      const [retry] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")));
      expect(retry?.contextSnapshot?.aiRouterTaskKey).toBe(issue!.id); expect(retry?.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 }); expect(execute).not.toHaveBeenCalled();
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent!.id))); expect(pin?.selection).toEqual(pinned);
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.agentId, agent!.id));
    } finally { fetch.mockRestore(); proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("repairs the failed pool account without replacing the pool or adopting the configured provider", async () => {
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Pool repair", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Pool repair", status: "in_progress", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const selection = await resolve(pool.id, issue!.id, { agentId: agent!.id });
    const runtime = await prepareManagedAiRuntime(db, { companyId, agentId: agent!.id, responsibleUserId: "alice", adapterType: "paperclip_runner", config: selection.runtimeConfig, binding: selection.binding });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "failed", errorCode: "acpx_auth_required", responsibleUserId: "alice", startedAt: new Date(), contextSnapshot: { issueId: issue!.id, aiRouterTaskKey: issue!.id, aiRouterSelection: selection, aiConnection: { ...runtime!.attribution, identity: runtime!.identity } } }).returning();
    try {
      const intents = connectionIntentService(db);
      const card = await intents.requestForRunAuthFailure(run!.id);
      expect(card?.service).toBe("anthropic"); expect(card?.state).toBe("needs_user_action");
      const options = await intents.setupOptions(card!.interactionId!);
      expect(options.aiConnection).toEqual(selection.binding); expect(options.aiConnectionRequiresAdoption).toBeUndefined();
      const [failedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId)); expect(failedGrant?.status).toBe("needs_reauthorization");
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[1]!.binding.grantId));
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, members[1]!.binding.connectionId));
      expect(await intents.complete(card!.interactionId!, members[1]!.binding.connectionId, "alice")).toMatchObject({ status: "accepted" });
      const [savedAgent] = await db.select().from(agents).where(eq(agents.id, agent!.id)); expect(savedAgent?.runtimeConfig.aiConnection).toEqual({ mode: "router", connectionId: pool.id });
      expect((await resolve(pool.id, issue!.id, { agentId: agent!.id })).binding).toEqual(selection.binding);
      await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: randomUUID() } } }).where(eq(agents.id, agent!.id));
      await expect(intents.setupOptions(card!.interactionId!)).rejects.toThrow("configuration changed");
    } finally {
      await runtime?.cleanup();
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[1]!.binding.grantId));
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, members[1]!.binding.connectionId));
    }
  });
  it("rejects disabled routing but recovers server-owned native evidence after disable/uninstall", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "recovery");
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    try { await expect(resolve(pool.id, "recovery")).rejects.toThrow("Experimental"); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); }
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try { await expect(resolve(pool.id, "new")).rejects.toThrow("plugin"); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); await db.delete(toolConnections).where(eq(toolConnections.id, pool.id)); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); }
    finally { await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("resumes a responsible-user session through a delegated pool using real managed account configurations", async () => {
    await aiConnectionService(db).setDefault(companyId, "alice", members[0]!.binding.grantId!);
    const pool = await makePool({ members: [members[0]!] });
    const selected = await resolve(pool.id, "managed-mode-adoption", { requireExisting: true, existingGrantId: members[0]!.binding.grantId });
    const directBinding = { mode: "responsible_user" as const, provider: "openai" as const, method: "api_key" as const };
    const prepare = { companyId, agentId, responsibleUserId: "alice", adapterType: "paperclip_runner", config: selected.runtimeConfig };
    const before = await prepareManagedAiRuntime(db, { ...prepare, binding: directBinding });
    const after = await prepareManagedAiRuntime(db, { ...prepare, binding: selected.binding });
    try {
      expect(before.config.managedAiConnection.mode).toBe("responsible_user");
      expect(after.config.managedAiConnection.mode).toBe("delegated");
      expect(after.sessionIdentity).toBe(before.sessionIdentity);
      const common = { adapterType: "paperclip_runner", issueOverrides: null, workspaceConfig: {}, environment: {}, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [], agentConfigRevision: null };
      const previous = await buildEffectiveRunSessionConfigMetadata({ ...common, effectiveAdapterConfig: before.config, managedAiHome: before.home, agentRuntimeConfig: { aiConnection: directBinding } });
      const currentInput = { ...common, effectiveAdapterConfig: after.config, managedAiHome: after.home, agentRuntimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } };
      const current = await buildEffectiveRunSessionConfigMetadata(currentInput);
      const alternatives = aiConnectionSessionCompatibilityInputs({ ...currentInput, originalIssueOverrides: null, binding: selected.binding, router: true, storedIdentity: before.sessionIdentity, sessionIdentity: after.sessionIdentity, credentialIdentity: after.identity, revisions: [] });
      const compatibleConfigMetadata = await Promise.all(alternatives.map(candidate => buildEffectiveRunSessionConfigMetadata({ ...currentInput, ...candidate })));
      expect(resolveTaskSessionConfigFreshness({ hasTaskSession: true, configuredModel: String(selected.runtimeConfig.model), taskSessionParams: { __paperclipConfiguredModel: selected.runtimeConfig.model, __paperclipConfigFingerprint: previous.fingerprint, __paperclipConfigFingerprintVersion: previous.version, __paperclipConfigCategoryFingerprints: previous.categoryFingerprints }, configMetadata: current, compatibleConfigMetadata }).reset).toBe(false);
    } finally { await before.cleanup(); await after.cleanup(); }
  });
  it("keeps session identity and fingerprints stable on authenticated refresh, but changes them on manual replacement", async () => {
    const input = { companyId, agentId, responsibleUserId: "alice", adapterType: "paperclip_runner", binding: members[0]!.binding, config: { provider: "codex", model: "gpt-5.6-sol" } };
    const first = await prepareManagedAiRuntime(db, input);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[0]!.binding.grantId)); const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    try {
      await secretService(db).rotate(ref.secretId, { value: "fixture-new-token", preserveAiSessionEpoch: true }, { userId: "alice" });
      const refreshed = await prepareManagedAiRuntime(db, input);
      try { expect(refreshed.identity).not.toBe(first.identity); expect(refreshed.sessionIdentity).toBe(first.sessionIdentity); expect(managedAiSessionFingerprintConfig(refreshed.config, refreshed.home)).toEqual(managedAiSessionFingerprintConfig(first.config, first.home)); } finally { await refreshed.cleanup(); }
      await secretService(db).rotate(ref.secretId, { value: "fixture-replacement" }, { userId: "alice" });
      const replaced = await prepareManagedAiRuntime(db, input); try { expect(replaced.sessionIdentity).not.toBe(first.sessionIdentity); } finally { await replaced.cleanup(); }
      const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId))); expect(secret!.aiSessionEpoch).toBeGreaterThan(0);
    } finally { await first.cleanup(); }
  });
});
