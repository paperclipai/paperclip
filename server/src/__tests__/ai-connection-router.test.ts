import { enableRunFailureReporting } from "./helpers/run-failure-reporting.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, closeRegisteredClients, companies, agents, agentTaskSessions, agentRuntimeState, authUsers, companyMemberships, connectionGrants, plugins, aiConnectionQuotaCooldowns, aiConnectionRouterCursors, aiConnectionTaskPins, toolConnections, companySecrets, heartbeatRuns, issues, principalPermissionGrants, dotAgentBindings, grokBotRoutines } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, type AiConnectionPoolMember, type AiConnectionRouterRequest, type AiConnectionRouterResult, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { aiConnectionRouterService, AiConnectionPoolExhausted, poolMemberRuntimeConfig, applyAiConnectionRouterTaskSettings, quotaIdentityFromSessionSnapshot } from "../services/ai-connection-router.js";
import { aiConnectionSessionCompatibilityInputs } from "../services/ai-connection-session.js";
import { projectPaperclipRunnerTaskConfig, resolvePaperclipRunnerNativeProviderInput } from "../services/native-runtime/provider-profile.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { managedAiSessionFingerprintConfig, prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import express from "express";
import request from "supertest";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService, buildEffectiveRunSessionConfigMetadata, resolveTaskSessionConfigFreshness } from "../services/heartbeat.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { preparePoolAdapterClaim, effectiveRunAgent } from "../services/heartbeat/effective-run-adapter.js";
import { resolveCodexExecutionEngineForRun } from "../../../packages/adapters/codex-local/src/server/acp.js";

const captureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../sentry.js")>(),
  captureRunFailure,
}));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
let db: ReturnType<typeof createDb>;
let home: string;
let isolatedHome: ReturnType<typeof createIsolatedTestHome> | undefined;
const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), secondAgentId = randomUUID(), pluginId = randomUUID();
const pluginKey = "fixture.ai-router";
const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "AI connection pool", description: "Use saved connections" }, entrypoints: { worker: "worker.js" } };
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
const identityFor = async (grantId: string) => {
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
  const ref = grant!.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
  const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
  return `secret:${ref.secretId}:${secret!.aiSessionEpoch}`;
};
const makePool = async (config = {}) => service().save(pluginKey, { companyId, config: { name: randomUUID(), enabled: true, mode: "round_robin", thresholdPercent: 90, members, ...config } }, "alice");

it("keeps V1 plugin pools on the configured legacy harness", async () => {
  await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
  const pool = await makePool();
  const chosen = await resolve(pool.id, randomUUID(), { adapterType: "claude_local" });
  expect(chosen.adapterType).toBe("claude_local");
  expect(chosen.binding.provider).toBe("anthropic");
  const piMember = { ...members[0]!, id: randomUUID(), profile: { provider: "codex" as const, model: "openai/gpt-5.6-sol" } };
  const piPool = await makePool({ members: [piMember] });
  expect(await resolve(piPool.id, randomUUID(), { adapterType: "pi_local" })).toMatchObject({ adapterType: "pi_local", memberId: piMember.id });
});

it("rejects an unknown model before enabling a central harness pool", async () => {
  const { harnessPoolService } = await import("../services/harness-pools.js");
  const member = members[0]!;
  await expect(harnessPoolService(db).save(companyId, { config: { schemaVersion: 2, kind: "harness_pool", name: "Invalid model", enabled: true, mode: "failover", members: [
    { id: randomUUID(), harness: { type: "codex" }, connection: member.binding as Exclude<typeof member.binding, { mode: "responsible_user" }>, model: "definitely-not-a-model" },
  ] } }, "alice")).rejects.toMatchObject({ status: 422 });
});
beforeAll(async () => {
  isolatedHome = createIsolatedTestHome();
  home = isolatedHome.home;
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "router-fixture");
  if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
  else { database = await startEmbeddedPostgresTestDatabase("paperclip-router-db-"); db = createDb(database.connectionString); }
  await db.insert(companies).values([{ id: companyId, name: "Router fixture", issuePrefix: "RTF" }, { id: otherCompanyId, name: "Other", issuePrefix: "RTO" }]);
  await db.insert(agents).values([agentId, secondAgentId].map(id => ({ id, companyId, name: "Router agent", adapterType: "paperclip_runner" })));
  await db.insert(authUsers).values(["alice", "bob"].map(id => ({ id, name: id, email: `${id}@router.example.test`, createdAt: new Date(), updatedAt: new Date() }))).onConflictDoNothing();
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
afterAll(async () => {
  await waitForPendingRunFailureReports();
  if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
  await db?.$client.end();
  await database?.cleanup(); vi.unstubAllEnvs(); isolatedHome?.cleanup();
});

describe("durable, authorized connection routing", () => {
  it("manages central harness pools without exposing V2 records to legacy clients", async () => {
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } as typeof req.actor; next(); });
    app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    const url = `/api/companies/${companyId}/harness-pools`;
    const native = members[0]!;
    const config = { schemaVersion: 2, kind: "harness_pool", name: "Smart", enabled: true, mode: "failover", members: [
      { id: native.id, harness: { type: "codex" }, connection: native.binding, model: native.profile.model },
      { id: randomUUID(), harness: { type: "codex" }, connection: native.binding, model: "gpt-6-sol" },
    ] };
    const created = await request(app).post(url).send({ config });
    expect(created.status).toBe(200);
    const pool = created.body;
    expect(pool).toMatchObject({ ...config, companyId, revision: 1 });
    const choices = await request(app).get(`${url}/choices`);
    expect(choices.status).toBe(200);
    expect(choices.body).toContainEqual({ id: pool.id, name: "Smart", enabled: true, revision: 1 });
    expect(Object.keys(choices.body.find((item: { id: string }) => item.id === pool.id))).toEqual(["id", "name", "enabled", "revision"]);
    expect(await (await import("../services/harness-pools.js")).harnessPoolService(db).choices(companyId, "bob")).toEqual([]);

    expect((await request(app).get(url)).body.some((item: { id: string }) => item.id === pool.id)).toBe(true);
    await db.insert(principalPermissionGrants).values({ companyId, principalId: "alice", principalType: "user", permissionKey: "agents:configure", scope: {} });
    const { agentRoutes } = await import("../routes/agents.js");
    const agentApp = express(); agentApp.use(express.json());
    agentApp.use((req, _res, next) => { req.actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId] } as typeof req.actor; next(); });
    agentApp.use("/api", agentRoutes(db)); agentApp.use(errorHandler);
    const nativeFlag = (await instanceSettingsService(db).getExperimental()).enableNativeRunner;
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    for (const id of [agentId, secondAgentId]) {
      const bound = await request(agentApp).patch(`/api/agents/${id}`).send({ runtimeConfig: { harnessPool: { poolId: pool.id } } });
      expect(bound.status, JSON.stringify(bound.body)).toBe(200);
      expect(bound.body.runtimeConfig).toMatchObject({ harnessPool: { poolId: pool.id } });
    }
    const mid = await request(app).post(url).send({ config: { ...config, name: "Mid" } });
    expect(mid.status).toBe(200);
    expect((await request(agentApp).patch(`/api/agents/${secondAgentId}`).send({ runtimeConfig: { harnessPool: { poolId: mid.body.id } } })).status).toBe(200);
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.runtimeConfig.harnessPool).toEqual({ poolId: pool.id });
    await db.insert(principalPermissionGrants).values({ companyId, principalId: "alice", principalType: "user", permissionKey: "agents:create", scope: {} });
    const hired = await request(agentApp).post(`/api/companies/${companyId}/agent-hires`).send({ name: "Pool hire fixture", role: "general", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: { harnessPool: { poolId: pool.id } }, budgetMonthlyCents: 0 });
    expect(hired.status, JSON.stringify(hired.body)).toBe(201);
    expect(hired.body.agent.runtimeConfig).toMatchObject({ harnessPool: { poolId: pool.id } });

    expect((await request(agentApp).patch(`/api/agents/${agentId}`).send({ adapterType: "claude_local", runtimeConfig: { harnessPool: { poolId: pool.id } } })).status).toBe(422);
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.companyId, companyId));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: nativeFlag });

    expect((await request(app).get(`/api/companies/${companyId}/ai-connection-pools`)).body.some((item: { id: string }) => item.id === pool.id)).toBe(false);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/harness-pools`)).status).toBe(403);
    expect((await request(app).post(url).send({ id: pool.id, expectedRevision: 99, config })).status).toBe(409);
    expect((await request(app).post(url).send({ id: pool.id, expectedRevision: 1, config: { ...config, name: "Renamed" } })).body).toMatchObject({ id: pool.id, revision: 2, name: "Renamed" });
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: 2 })).status).toBe(200);
    expect((await request(app).get(url)).body.some((item: { id: string }) => item.id === pool.id)).toBe(false);
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
  });
  it("checks every V2 pool account against the managing agent's connection scope", async () => {
    const seed = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { schemaVersion: 2, kind: "harness_pool", name: "Scoped pool", enabled: true, mode: "failover", thresholdPercent: 90, members: [members[0]!] } }, "alice");
    const legacy = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: "Scoped legacy", enabled: true, mode: "failover", thresholdPercent: 90, members: [members[1]!] } }, "alice");
    const [manager] = await db.insert(agents).values({ companyId, name: "Scoped manager", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } }).returning();
    await db.insert(companyMemberships).values({ companyId, principalId: manager!.id, principalType: "agent", membershipRole: "member", status: "active" });
    const [userGrant] = await db.insert(principalPermissionGrants).values({ companyId, principalId: "alice", principalType: "user", permissionKey: "tools:manage_connections", scope: {} }).returning();
    await db.insert(principalPermissionGrants).values({ companyId, principalId: manager!.id, principalType: "agent", permissionKey: "tools:manage_connections", scope: { connectionIds: [members[0]!.binding.connectionId, seed.id, legacy.id] } });
    await db.insert(principalPermissionGrants).values([
      { companyId, principalId: manager!.id, principalType: "agent", permissionKey: "agents:configure", scope: {} },
      { companyId, principalId: "alice", principalType: "user", permissionKey: "agents:configure", scope: {} },
    ]).onConflictDoNothing();
    const [userProfileGrant] = await db.insert(principalPermissionGrants).values({ companyId, principalId: "alice", principalType: "user", permissionKey: "tools:manage_profiles", scope: {} }).returning();
    await db.insert(principalPermissionGrants).values({ companyId, principalId: manager!.id, principalType: "agent", permissionKey: "tools:manage_profiles", scope: { connectionIds: [members[0]!.binding.connectionId, seed.id, legacy.id] } });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: manager!.id, status: "running", responsibleUserId: "alice" }).returning();
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = { type: "agent", source: "agent_jwt", agentId: manager!.id, companyId, runId: run!.id, onBehalfOfUserId: "alice", onBehalfOfMemberships: [{ companyId, status: "active", membershipRole: "member" }] } as typeof req.actor; next(); }); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    const config = (member: AiConnectionPoolMember) => ({ schemaVersion: 2, kind: "harness_pool", name: "Scoped pool", enabled: true, mode: "failover", members: [{ id: member.id, connection: member.binding, harness: { type: member.profile.provider === "codex" ? "codex" : "claude_code" }, model: member.profile.model }] });
    try {
      const allowed = await request(app).post(`/api/companies/${companyId}/harness-pools`).send({ id: seed.id, expectedRevision: 1, config: config(members[0]!) });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      const outside = await request(app).post(`/api/companies/${companyId}/harness-pools`).send({ id: seed.id, expectedRevision: 2, config: config(members[1]!) });
      expect(outside.status, JSON.stringify(outside.body)).toBe(403);
      expect((await request(app).post(`/api/companies/${companyId}/harness-pools/${legacy.id}/convert`).send({ expectedRevision: 1, preview: true })).status).toBe(403);
    } finally { await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, userGrant!.id)); await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, userProfileGrant!.id)); }
  });
  it("previews and converts only a current built-in pool without replacing its pin", async () => {
    const { harnessPoolService } = await import("../services/harness-pools.js");
    const facade = harnessPoolService(db);
    const old = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: "Mid", enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
    const pinned = await resolve(old.id, "preserved-v1");
    await expect(facade.convertV1(companyId, old.id, old.revision + 1, true, "alice")).rejects.toThrow("changed");
    expect(await facade.convertV1(companyId, old.id, old.revision, true, "alice")).toMatchObject({ id: old.id, name: "Mid", schemaVersion: 2 });
    expect((await service().list(companyId)).find(item => item.id === old.id)?.kind).toBeUndefined();
    expect(await facade.convertV1(companyId, old.id, old.revision, false, "alice")).toMatchObject({ id: old.id, revision: old.revision + 1 });
    expect((await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, old.id)))[0]?.selection).toEqual(pinned);
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const pluginPool = await makePool();
    await expect(facade.convertV1(companyId, pluginPool.id, pluginPool.revision, false, "alice")).rejects.toThrow("Only legacy");
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
  });
  it("freezes a Pool harness target before native claim without changing the agent", async () => {
    const { harnessPoolService } = await import("../services/harness-pools.js");
    const native = members[0]!;
    const pool = await harnessPoolService(db).save(companyId, { config: { schemaVersion: 2, kind: "harness_pool", name: "Smart native", enabled: true, mode: "failover",
      members: [{ id: native.id, connection: native.binding, harness: { type: "codex" }, model: native.profile.model }] } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Pool agent", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "inactive-primary" }, runtimeConfig: { harnessPool: { poolId: pool.id } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Pool task", status: "in_progress", assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, issueId: issue!.id, scopeKind: "issue", status: "queued", contextSnapshot: { issueId: issue!.id } }).returning();
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    const prepared = await preparePoolAdapterClaim(db, run!, agent!, "alice");
    expect(prepared.adapterDispatch).toMatchObject({ adapterType: "paperclip_runner", poolId: pool.id, memberId: native.id });
    expect(prepared.context).toMatchObject({ harnessPoolSelection: { schemaVersion: 2, poolId: pool.id, memberId: native.id, memberSnapshot: { model: native.profile.model } }, aiRouterSelection: { runtimeConfig: { provider: "codex", model: native.profile.model } } });
    const effective = effectiveRunAgent({ ...run!, contextSnapshot: prepared.context, runnerProfileJson: { adapterDispatch: prepared.adapterDispatch } }, agent!);
    expect(effective.adapterConfig.model).toBe(native.profile.model);
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]?.adapterConfig.model).toBe("inactive-primary");
    const revised = await harnessPoolService(db).save(companyId, { id: pool.id, expectedRevision: pool.revision, config: { schemaVersion: 2, kind: "harness_pool", name: "Renamed", enabled: true, mode: "failover", members: [{ id: native.id, connection: native.binding, harness: { type: "codex" }, model: "gpt-6-sol" }] } }, "alice");
    const historical = await preparePoolAdapterClaim(db, run!, agent!, "alice");
    expect(historical.context.harnessPoolSelection).toMatchObject({ poolRevision: revised.revision, poolName: "Renamed", memberSnapshot: { model: native.profile.model } });
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    expect((await preparePoolAdapterClaim(db, run!, agent!, "alice")).adapterDispatch.poolPreparationFailure).toMatchObject({ kind: "configuration" });
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    expect((await preparePoolAdapterClaim(db, { ...run!, issueId: null, scopeKind: "company" }, agent!, "alice")).adapterDispatch.poolPreparationFailure).toMatchObject({ message: "Pool harness requires a task" });
    await harnessPoolService(db).archive(companyId, pool.id, revised.revision, "alice");
    expect((await preparePoolAdapterClaim(db, run!, agent!, "alice")).adapterDispatch.poolPreparationFailure).toMatchObject({ kind: "configuration" });
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });

  });
  it("pins the effective Codex adapter for a configured Claude agent", async () => {
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [members[0]!],
    } }, "alice");
    const selection = await resolve(pool.id, randomUUID(), { adapterType: "claude_local" });
    expect(selection).toMatchObject({ adapterType: "codex_local", memberId: members[0]!.id });
    expect(poolMemberRuntimeConfig(members[0]!, "claude_local")).toMatchObject({ adapterType: "codex_local" });
    expect(applyAiConnectionRouterTaskSettings({ command: "claude", cwd: home, permissions: "retained" }, selection, "claude_local"))
      .toEqual({ ...selection.runtimeConfig, cwd: home, permissions: "retained" });
  });
  it("reopens an unstarted initial Pool wait when configuration or accounts change", async () => {
    const { reopenNativeQuotaPoolWaits } = await import("../services/native-runtime/native-quota-wake.js");
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: "Initial wait", enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
    const [task] = await db.insert(issues).values({ companyId, title: "Initial pool wait", status: "in_progress", assigneeAgentId: agentId }).returning();
    const context = { issueId: task!.id, aiRouterPoolId: pool.id };
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, scopeKind: "issue", issueId: task!.id, status: "cancelled", contextSnapshot: context,
      resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } }).returning();
    const deadline = new Date(Date.now() + 3_600_000);
    const [waiting] = await db.insert(heartbeatRuns).values({ companyId, agentId, scopeKind: "issue", issueId: task!.id, status: "scheduled_retry", contextSnapshot: context,
      retryOfRunId: source!.id, scheduledRetryReason: "ai_connection_pool_wait", scheduledRetryAt: deadline }).returning();
    expect(await db.transaction(tx => reopenNativeQuotaPoolWaits(tx as unknown as ReturnType<typeof createDb>, { companyId, poolId: pool.id }))).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiting!.id)))[0]!.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 1000);
  });
  it("shares quota across five model members and agents but scopes runner cooldowns by environment", async () => {
    const { harnessPoolService } = await import("../services/harness-pools.js");
    const { poolRunnerCooldownIdentity } = await import("../services/ai-connection-pool-cooldown.js");
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Scoped pool fixture", apiKey: "scoped-pool-fixture", agentIds: [], allAgents: true }, randomUUID());
    const connection = { mode: "delegated" as const, provider: "openai" as const, method: "api_key" as const, ...account };
    const pool = await harnessPoolService(db).save(companyId, { config: { schemaVersion: 2, kind: "harness_pool", name: "Five models", enabled: true, mode: "failover", members: Array.from({ length: 5 }, (_, index) => ({ id: randomUUID(), harness: { type: "codex" as const }, connection, model: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"][index]! })) } }, "alice");
    const first = await resolve(pool.id, "scope-first", { environmentId: "environment-a" });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    const ref = grant!.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    const identity = `secret:${secret!.id}:${secret!.aiSessionEpoch}`;
    const deadline = new Date(Date.now() + 300_000);
    await service().recordQuotaCooldown(companyId, account.connectionId, poolRunnerCooldownIdentity(identity, first.runtimeConfig, "environment-a"), deadline, identity);
    await expect(resolve(pool.id, "scope-blocked", { environmentId: "environment-a" })).rejects.toBeInstanceOf(AiConnectionPoolExhausted);
    const otherEnvironment = await resolve(pool.id, "scope-other", { agentId: secondAgentId, environmentId: "environment-b" });
    expect(otherEnvironment.memberId).toBe(first.memberId);
    expect(await service().accountCooldown(companyId, account.connectionId, identity)).toBeNull();
    await service().recordQuotaCooldown(companyId, account.connectionId, identity, deadline);
    for (const candidate of [agentId, secondAgentId]) await expect(resolve(pool.id, randomUUID(), { agentId: candidate, environmentId: "environment-b" })).rejects.toBeInstanceOf(AiConnectionPoolExhausted);
  });
  it("refuses cross-provider execution when source CLI policy cannot be preserved", () => {
    const target = { poolId: randomUUID(), memberId: members[1]!.id, binding: members[1]!.binding,
      adapterType: "claude_local", runtimeConfig: poolMemberRuntimeConfig(members[1]!, "codex_local").config, notes: [] };
    for (const source of [
      { engine: "cli", extraArgs: ["--sandbox", "read-only"] },
      { dangerouslyBypassApprovalsAndSandbox: false },
      { command: "codex-policy-wrapper" },
      { agentCommand: "node restricted-codex-acp.js" },
    ]) expect(() => applyAiConnectionRouterTaskSettings(source, target, "codex_local")).toThrow("preserve");
    expect(() => applyAiConnectionRouterTaskSettings({ dangerouslyBypassApprovalsAndSandbox: false }, { ...target, adapterType: undefined }, "codex_local"))
      .toThrow("preserve");
    expect(() => applyAiConnectionRouterTaskSettings({ alwaysApprove: false }, target, "grok_local")).toThrow("preserve");
  });
  it("clears standard source ACP commands and retains portable ACP permission modes", () => {
    const target = { poolId: randomUUID(), memberId: members[1]!.id, binding: members[1]!.binding,
      adapterType: "claude_local", runtimeConfig: poolMemberRuntimeConfig(members[1]!, "codex_local").config, notes: [] };
    const config = applyAiConnectionRouterTaskSettings({ engine: "acp", agentCommand: "codex-acp", acpAgentCommand: "codex-acp", permissionMode: "deny-all" }, target, "codex_local");
    expect(config.permissionMode).toBe("deny-all");
    expect(config).not.toHaveProperty("agentCommand"); expect(config).not.toHaveProperty("acpAgentCommand");
  });
  it("qualifies actual native harness changes and clears the source ACP command", () => {
    const grok = { adapterType: "paperclip_runner", poolId: randomUUID(), memberId: randomUUID(), binding: members[1]!.binding,
      runtimeConfig: { provider: "acpx", acpxAgent: "grok", model: "grok-4" }, notes: [] };
    const source = { provider: "acpx", acpxAgent: "claude", agentCommand: "claude-agent-acp", acpxPermissionMode: "deny-all" };
    expect(applyAiConnectionRouterTaskSettings(source, grok, "paperclip_runner"))
      .toEqual({ provider: "acpx", acpxAgent: "grok", model: "grok-4", acpxPermissionMode: "deny-all" });
    expect(() => applyAiConnectionRouterTaskSettings({ ...source, extraArgs: ["--allowedTools", "Read"] }, grok, "paperclip_runner")).toThrow("preserve");
    const codex = { ...grok, runtimeConfig: { provider: "codex", model: "gpt-5.6-sol" } };
    expect(() => applyAiConnectionRouterTaskSettings(source, codex, "paperclip_runner")).toThrow("preserve");
  });
  it("preserves the explicit CLI engine for Claude to Codex in-place workspace execution", async () => {
    const target = { poolId: randomUUID(), memberId: members[0]!.id, binding: members[0]!.binding,
      adapterType: "codex_local", runtimeConfig: poolMemberRuntimeConfig(members[0]!, "claude_local").config, notes: [] };
    const config = applyAiConnectionRouterTaskSettings({ engine: "cli", cwd: home }, target, "claude_local");
    expect(config.engine).toBe("cli");
    await expect(resolveCodexExecutionEngineForRun({ config, executionTarget: { kind: "local", workspaceRealization: { mode: "in_place" } } as never }))
      .resolves.toEqual({ engine: "cli", explicit: true });
  });
  it("does not allocate an account that would weaken the source execution policy", async () => {
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [members[1]!],
    } }, "alice");
    await expect(resolve(pool.id, randomUUID(), { adapterType: "codex_local", sourceAdapterConfig: { engine: "cli", extraArgs: ["--sandbox", "read-only"] } }))
      .rejects.toThrow("preserve");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
  });
  it("does not move a failed pin to an account with an incompatible permission policy", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members,
    } }, "alice");
    const taskKey = randomUUID();
    const source = await resolve(pool.id, taskKey, { adapterType: "codex_local" });
    if (source.binding.mode === "responsible_user") throw new Error("Expected explicit account");
    await service().recordQuotaCooldown(companyId, source.binding.connectionId, await identityFor(source.binding.grantId), new Date(Date.now() + 60_000));
    try {
      expect(await db.transaction(tx => aiConnectionRouterService(tx as unknown as typeof db).transitionQuotaPin({ companyId,
        poolId: pool.id, agentId, taskKey, userId: "alice", adapterType: "codex_local", expectedSelection: source,
        attemptedMemberIds: [source.memberId], sourceAdapterConfig: { dangerouslyBypassApprovalsAndSandbox: false } }))).toMatchObject({ kind: "unavailable" });
      expect((await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id)))[0]?.selection.memberId).toBe(source.memberId);
    } finally { await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId)); }
  });
  it("claims a builtin pool without delaying dispatch for an external usage probe", async () => {
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [members[1]!],
    } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Fast pool claim", adapterType: "claude_local",
      runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "queued" }).returning();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("A claim must not probe provider usage"));
    try {
      expect((await preparePoolAdapterClaim(db, run!, agent!, "alice")).adapterDispatch).toMatchObject({ adapterType: "claude_local", poolId: pool.id });
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)); }
  });
  it("pins the earliest cooling account including the source for a deferred new round", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members,
    } }, "alice");
    const taskKey = randomUUID();
    const source = await resolve(pool.id, taskKey, { adapterType: "claude_local" });
    const { adapterType: _oldAdapterType, ...preUpgradeSelection } = source;
    await db.update(aiConnectionTaskPins).set({ selection: preUpgradeSelection }).where(and(
      eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.taskKey, taskKey)));
    await service().recheckLegacyPinnedPoolAccount({ companyId, agentId, userId: "alice", taskKey, selection: source });
    const earliest = new Date(Date.now() + 60_000);
    await service().recordQuotaCooldown(companyId, members[0]!.binding.connectionId, await identityFor(members[0]!.binding.grantId), earliest);
    await service().recordQuotaCooldown(companyId, members[1]!.binding.connectionId, await identityFor(members[1]!.binding.grantId), new Date(Date.now() + 120_000));
    try {
      const result = await db.transaction(tx => aiConnectionRouterService(tx as unknown as typeof db).transitionQuotaPin({ companyId,
        poolId: pool.id, agentId, taskKey, expectedSelection: source, userId: "alice", adapterType: "claude_local",
        attemptedMemberIds: [], allowCoolingSelection: true }));
      expect(result).toMatchObject({ kind: "selected", selection: { memberId: members[0]!.id, adapterType: "codex_local" }, retryAt: earliest });
    } finally { await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId)); }
  });
  it("continues a healthy Codex pin despite an old Claude task session", async () => {
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [members[0]!],
    } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Pinned followup", adapterType: "claude_local",
      runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).returning();
    const taskKey = randomUUID();
    await service().resolve({ companyId, poolId: pool.id, agentId: agent!.id, userId: "alice", adapterType: "claude_local", taskKey });
    await db.insert(agentTaskSessions).values({ companyId, agentId: agent!.id, adapterType: "claude_local", taskKey,
      sessionDisplayId: "old-claude", sessionParamsJson: { paperclipAiCredentialIdentity: `${members[1]!.binding.grantId}:alice:no-auth` } });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "queued", contextSnapshot: { taskId: taskKey } }).returning();
    const prepared = await preparePoolAdapterClaim(db, run!, agent!, "alice");
    expect(prepared.adapterDispatch).toMatchObject({ adapterType: "codex_local", configuredAdapterType: "claude_local", poolId: pool.id });
    const admitted = { ...run!, runnerProfileJson: { adapterDispatch: prepared.adapterDispatch }, contextSnapshot: prepared.context };
    expect(effectiveRunAgent(admitted, agent!).adapterType).toBe("codex_local");
    expect(() => effectiveRunAgent(admitted, { ...agent!, adapterType: "grok_local" })).toThrow("Agent adapter changed");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, members[0]!.binding.grantId));
    try {
      const refused = await preparePoolAdapterClaim(db, run!, agent!, "alice");
      expect(refused).toMatchObject({ adapterDispatch: { adapterType: "codex_local", poolPreparationFailure: { kind: "configuration" } },
        context: { aiRouterTaskKey: taskKey, aiRouterSelection: { memberId: members[0]!.id } } });
    } finally {
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[0]!.binding.grantId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    }
  });
  it("executes a mixed pool Codex turn without changing the configured Claude adapter", async () => {
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [members[0]!],
    } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Mixed pool Claude", adapterType: "claude_local",
      adapterConfig: { cwd: home, engine: "cli", model: "claude-sonnet-5" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Mixed provider dispatch", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const execute = vi.fn(async (ctx: AdapterExecutionContext) => {
      const saved = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId)).then(rows => rows[0]);
      expect(saved?.runnerProfileJson?.adapterDispatch).toMatchObject({ adapterType: "codex_local", configuredAdapterType: "claude_local" });
      expect(ctx.agent.adapterType).toBe("codex_local");
      expect(ctx.config.model).toBe(members[0]!.profile.model);
      throw new Error("fixture stopped before provider start");
    });
    registerServerAdapter({ ...getServerAdapter("codex_local"), execute });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, responsibleUserId: "alice" }, triggerDetail: "system" });
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("failed");
      expect(execute).toHaveBeenCalledOnce();
      expect(await db.select({ adapterType: agents.adapterType }).from(agents).where(eq(agents.id, agent!.id))).toEqual([{ adapterType: "claude_local" }]);
    } finally { await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter("codex_local"); }
  }, 30_000);
  it("gives a taskless manual pooled run its own session affinity instead of a foreign provider session", async () => {
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [members[0]!],
    } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Manual pool affinity", adapterType: "claude_local",
      adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    await db.insert(agentRuntimeState).values({ companyId, agentId: agent!.id, adapterType: "claude_local", sessionId: randomUUID() });
    const execute = vi.fn(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      expect(ctx.runtime.taskKey).toBe(ctx.runId);
      expect(ctx.runtime.sessionId).toBeNull();
      throw new Error("manual affinity fixture stopped before provider start");
    });
    registerServerAdapter({ ...getServerAdapter("codex_local"), execute });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "on_demand", reason: "manual", triggerDetail: "manual", contextSnapshot: { responsibleUserId: "alice", wakeReason: "manual" } });
      await heartbeat.drainActiveRunExecutions();
      expect(execute).toHaveBeenCalledOnce();
      expect((await heartbeat.getRun(run!.id))?.error).toContain("manual affinity fixture");
    } finally { await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter("codex_local"); }
  }, 30_000);
  it.each([false, true])("continues a quota-interrupted Claude turn on Codex through the public heartbeat lifecycle (reconnect=%s)", async reconnect => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Isolated continuation", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "member" });
    const accounts = aiConnectionService(db);
    const codex = await accounts.save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Codex", apiKey: "fixture", agentIds: [], allAgents: true }, "continuation-codex");
    const claude = await accounts.save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Claude", loginSessionId: "fixture", agentIds: [], allAgents: true }, "continuation-claude");
    const members: AiConnectionPoolMember[] = [
      { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...codex }, profile: { provider: "codex", model: "gpt-5.6-sol", effort: "low" } },
      { id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...claude }, profile: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } },
    ];
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    await instanceSettingsService(db).updateExperimental({ enableWorktreeRunExecution: true });
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [members[1]!, members[0]!],
    } }, "alice");
    const workdir = path.join(home, `continuation-${randomUUID()}`);
    await mkdir(workdir, { recursive: true });
    const [agent] = await db.insert(agents).values({ companyId, name: "Claude to Codex lifecycle", adapterType: "claude_local",
      adapterConfig: { cwd: workdir, engine: "cli", model: "claude-sonnet-5" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Keep completed file and continue remaining work", description: "Keep the completed marker; finish the remaining work.", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    let sourceRunId: string | undefined;
    let sourceCwd: string | undefined;
    const primary = vi.fn(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      sourceRunId = ctx.runId; sourceCwd = String(ctx.config.cwd);
      await ctx.onDispatch?.();
      await writeFile(path.join(sourceCwd, "completed-marker.txt"), "completed exactly once");
      await ctx.onLog("stdout", "Completed marker file. Quota interrupted the remaining work.\n");
      if (reconnect) await service().recordQuotaCooldown(companyId, members[0]!.binding.connectionId,
        await identityFor(members[0]!.binding.grantId), new Date(Date.now() + 3 * 60 * 60_000));
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "provider_quota", errorFamily: "provider_quota", errorMessage: "Provider quota exhausted",
        sessionId: randomUUID(), summary: "Completed marker file. Remaining work needs another turn.",
        executionSettlement: { providerStopped: true, workspaceSettled: true, actionOutcomes: "unknown" } };
    });
    const backup = vi.fn(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      ctx.onDispatch?.();
      expect(ctx.agent.adapterType).toBe("codex_local");
      expect(ctx.config.cwd).toBe(sourceCwd);
      expect(await readFile(path.join(String(ctx.config.cwd), "completed-marker.txt"), "utf8")).toBe("completed exactly once");
      expect(ctx.runtime.sessionId).toBeNull();
      expect(ctx.context.previousRunId).toBe(sourceRunId);
      expect(ctx.executionContinuation).toMatchObject({ issueId: issue!.id, objective: expect.stringContaining("Keep the completed marker") });
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue!.id));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: randomUUID(), summary: "Finished remaining work without repeating the completed marker.",
        executionSettlement: { providerStopped: true, workspaceSettled: true, actionOutcomes: "unknown" } };
    });
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute: primary });
    registerServerAdapter({ ...getServerAdapter("codex_local"), execute: backup });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline usage fixture"));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    try {
      const source = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, responsibleUserId: "alice" }, triggerDetail: "system" });
      await heartbeat.drainActiveRunExecutions();
      await expect.poll(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id))).length, { timeout: 20_000 }).toBe(1);
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id));
      expect(successor?.contextSnapshot).toMatchObject({ previousRunId: source!.id, forceFreshSession: true, aiRouterSelection: { adapterType: reconnect ? "claude_local" : "codex_local", memberId: members[reconnect ? 1 : 0]!.id } });
      if (reconnect) {
        expect(successor!.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
        await aiConnectionService(db).save(companyId, "alice", { connectionId: members[0]!.binding.connectionId,
          provider: "openai", method: "api_key", ownership: "personal", name: "Codex", apiKey: "reconnected-fixture",
          agentIds: [], allAgents: true }, "reconnected-fixture");
        const reopened = await heartbeat.getRun(successor!.id);
        expect(reopened!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
      }
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
      await heartbeat.drainActiveRunExecutions();
      await expect.poll(async () => (await heartbeat.getRun(successor!.id))?.status, { timeout: 20_000 }).toBe("succeeded");
      expect(primary).toHaveBeenCalledOnce(); expect(backup).toHaveBeenCalledOnce();
      expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]?.status).toBe("done");
      expect((await heartbeat.getRun(source!.id))?.resultJson?.executionSettlement).toMatchObject({ providerStopped: true, workspaceSettled: true });
      expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]?.adapterType).toBe("claude_local");
    } finally {
      fetch.mockRestore(); await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter("claude_local"); unregisterServerAdapter("codex_local");
      await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    }
  }, 60_000);
  it("normalizes runtime snapshots without interpreting user identifiers", () => {
    const grant = randomUUID(), secret = randomUUID();
    expect(quotaIdentityFromSessionSnapshot(grant, `${grant}:user:with:colons:${secret}:4`)).toBe(`secret:${secret}:4`);
    expect(quotaIdentityFromSessionSnapshot(grant, `${grant}:alice:no-auth`)).toBe(`grant:${grant}:no-auth`);
    expect(quotaIdentityFromSessionSnapshot(grant, `${randomUUID()}:alice:${secret}:4`)).toBeNull();
    expect(quotaIdentityFromSessionSnapshot(grant, `${grant}:alice:${secret}:invalid`)).toBeNull();
  });
  it("atomically moves only the expected builtin pin to the next eligible account", async () => {
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
    const taskKey = randomUUID();
    const first = await resolve(pool.id, taskKey);
    await expect(resolve(pool.id, taskKey, { adapterType: "claude_local", persisted: first })).rejects.toThrow("Persisted pool adapter is inconsistent");
    if (first.binding.mode === "responsible_user") throw new Error("Expected an explicit pool account");
    await service().recordQuotaCooldown(companyId, first.binding.connectionId, await identityFor(first.binding.grantId), new Date(Date.now() + 60_000));
    const input = { companyId, poolId: pool.id, agentId, taskKey, expectedSelection: first, userId: "alice", adapterType: "paperclip_runner", attemptedMemberIds: [first.memberId] };
    const result = await db.transaction(tx => aiConnectionRouterService(tx as unknown as typeof db, worker).transitionQuotaPin(input));
    expect(result).toMatchObject({ kind: "selected", selection: { memberId: members[1]!.id } });
    const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.taskKey, taskKey)));
    expect(pin?.selection.memberId).toBe(members[1]!.id);
    expect(await db.transaction(tx => aiConnectionRouterService(tx as unknown as typeof db, worker).transitionQuotaPin(input))).toMatchObject({ kind: "unavailable" });
  });
  it("rechecks and fails over the same pinned account after task model and effort overrides change", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: {
      name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members,
    } }, "alice");
    const taskKey = randomUUID();
    const original = await resolve(pool.id, taskKey, { adapterType: "claude_local" });
    const changed = await resolve(pool.id, taskKey, { adapterType: "claude_local", overrides: { model: "gpt-5.6-terra", modelReasoningEffort: "high" } });
    expect(changed.memberId).toBe(original.memberId);
    expect(changed.runtimeConfig).not.toEqual(original.runtimeConfig);
    await service().recheckLegacyPinnedPoolAccount({ companyId, agentId, taskKey, userId: "alice", selection: changed });
    if (changed.binding.mode === "responsible_user") throw new Error("Expected explicit account");
    await service().recordQuotaCooldown(companyId, changed.binding.connectionId, await identityFor(changed.binding.grantId), new Date(Date.now() + 60_000));
    try {
      const result = await db.transaction(tx => aiConnectionRouterService(tx as unknown as typeof db).transitionQuotaPin({ companyId,
        poolId: pool.id, agentId, taskKey, userId: "alice", adapterType: "claude_local", expectedSelection: changed, attemptedMemberIds: [changed.memberId] }));
      expect(result).toMatchObject({ kind: "selected", selection: { memberId: members[1]!.id, adapterType: "claude_local" } });
    } finally { await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId)); }
  });
  it("routes a built-in ordered pool without the plugin flag or worker", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const builtin = aiConnectionRouterService(db);
    const pool = await builtin.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: "Built-in pool", enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
    expect((await builtin.catalog()).find(entry => entry.aiConnectionRouter?.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY)?.availability?.available).toBe(true);
    expect((await builtin.selectable(companyId, "alice")).some(entry => entry.id === pool.id)).toBe(true);
    const input = { companyId, poolId: pool.id, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey: randomUUID() };
    expect((await builtin.resolve(input)).memberId).toBe(members[0]!.id);
    await builtin.recordQuotaCooldown(companyId, members[0]!.binding.connectionId, await identityFor(members[0]!.binding.grantId), new Date(Date.now() + 60_000));
    expect((await builtin.resolve({ ...input, taskKey: randomUUID() })).memberId).toBe(members[1]!.id);
    await expect(builtin.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: "Invalid", enabled: true, mode: "round_robin", thresholdPercent: 90, members } }, "alice")).rejects.toThrow("ordered failover");
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    await builtin.remove(companyId, pool.id, pool.revision, "alice");
  });
  it("persists account quota cooldowns across service instances without shortening them", async () => {
    const member = members[0]!;
    const later = new Date(Date.now() + 4 * 60 * 60_000);
    const earlier = new Date(Date.now() + 60_000);
    await service().recordQuotaCooldown(companyId, member.binding.connectionId, await identityFor(member.binding.grantId), later);
    await service().recordQuotaCooldown(companyId, member.binding.connectionId, await identityFor(member.binding.grantId), earlier);
    expect(await service().accountCooldown(companyId, member.binding.connectionId, await identityFor(member.binding.grantId))).toEqual(later);
    expect(await service().accountCooldown(otherCompanyId, member.binding.connectionId, await identityFor(member.binding.grantId))).toBeNull();
  });
  it("scopes cooldown to the credential and epoch", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const member = members[0]!;
    const identity = await identityFor(member.binding.grantId);
    const retryAt = new Date(Date.now() + 60_000);
    await service().recordQuotaCooldown(companyId, member.binding.connectionId, identity, retryAt);
    expect(await service().accountCooldown(companyId, member.binding.connectionId, identity)).toEqual(retryAt);
    expect(await service().accountCooldown(companyId, member.binding.connectionId, `secret:${randomUUID()}:0`)).toBeNull();
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, member.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    await db.update(companySecrets).set({ aiSessionEpoch: secret!.aiSessionEpoch + 1 }).where(eq(companySecrets.id, ref.secretId));
    try {
      const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
      expect((await resolve(pool.id, randomUUID())).memberId).toBe(member.id);
      expect(await service().accountCooldown(companyId, member.binding.connectionId, await identityFor(member.binding.grantId))).toBeNull();
    } finally {
      await db.update(companySecrets).set({ aiSessionEpoch: secret!.aiSessionEpoch }).where(eq(companySecrets.id, ref.secretId));
      await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    }
  });
  it("shares a cooldown across connections and grants using the same secret", async () => {
    const [first] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[0]!.binding.grantId));
    const [second] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    await db.update(connectionGrants).set({ credentialSecretRefs: first!.credentialSecretRefs }).where(eq(connectionGrants.id, second!.id));
    try {
      const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
      await service().recordQuotaCooldown(companyId, members[0]!.binding.connectionId, await identityFor(first!.id), new Date(Date.now() + 60_000));
      await expect(resolve(pool.id, randomUUID())).rejects.toBeInstanceOf(AiConnectionPoolExhausted);
    } finally {
      await db.update(connectionGrants).set({ credentialSecretRefs: second!.credentialSecretRefs }).where(eq(connectionGrants.id, second!.id));
      await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    }
  });
  it("selects the first available account in a failover pool without probing a cooling account", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    try {
      const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
      await service().recordQuotaCooldown(companyId, members[0]!.binding.connectionId, await identityFor(members[0]!.binding.grantId), new Date(Date.now() + 60_000));
      const result = await resolve(pool.id, randomUUID());
      expect(result.memberId).toBe(members[1]!.id);
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    }
  });
  it("keeps a selected Codex account pinned for a configured Claude agent", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const claude = members[0]!;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider unavailable"));
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members } }, "alice");
    try {
      const taskKey = randomUUID();
      const result = await resolve(pool.id, taskKey, { adapterType: "claude_local" });
      expect(result.memberId).toBe(claude.id);
      expect(result.binding.provider).toBe("openai");
      expect(poolMemberRuntimeConfig(members[0]!, "claude_local").adapterType).toBe("codex_local");
      await service().recordQuotaCooldown(companyId, claude.binding.connectionId, await identityFor(claude.binding.grantId), new Date(Date.now() + 60_000));
      expect(await resolve(pool.id, taskKey, { adapterType: "claude_local", persisted: result,
        requireExisting: true, existingGrantId: claude.binding.grantId })).toEqual(result);
      await expect(resolve(pool.id, taskKey, { adapterType: "claude_local", persisted: result,
        requireExisting: true, existingGrantId: randomUUID() })).rejects.toThrow("Reset this task session");
      expect((await resolve(pool.id, randomUUID(), { adapterType: "claude_local" })).binding.provider).toBe("anthropic");
    } finally { fetch.mockRestore(); await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId)); }
  });
  it("uses a second legacy Claude account when preflight confirms the first is exhausted", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const first = members[1]!;
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, first.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "legacy-claude-first", preserveAiSessionEpoch: true }, { userId: "alice" });
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Backup Claude", loginSessionId: "fixture", agentIds: [], allAgents: true }, "legacy-claude-second");
    const second: AiConnectionPoolMember = { ...first, id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...account } };
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [first, second] } }, "alice");
    const reset = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: reset }, extra_usage: { is_enabled: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: reset }, extra_usage: { is_enabled: false } })));
    try {
      const selected = await resolve(pool.id, randomUUID(), { adapterType: "claude_local" });
      expect(selected.memberId).toBe(second.id);
      expect(await service().accountCooldown(companyId, first.binding.connectionId, await identityFor(first.binding.grantId))).toEqual(new Date(reset));
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { fetch.mockRestore(); await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId)); }
  });
  it("dispatches the selected legacy Claude account through the unchanged adapter", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const first = members[1]!;
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, first.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "legacy-dispatch-primary", preserveAiSessionEpoch: true }, { userId: "alice" });
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Dispatch backup", loginSessionId: "fixture", agentIds: [], allAgents: true }, "legacy-dispatch-backup");
    const second: AiConnectionPoolMember = { ...first, id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...account } };
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [first, second] } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Legacy Claude preflight", adapterType: "claude_local",
      adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Legacy Claude dispatch", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const execute = vi.fn(async () => { throw new Error("fixture stopped before provider start"); });
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    await service().recordQuotaCooldown(companyId, first.binding.connectionId, await identityFor(first.binding.grantId), new Date(Date.now() + 2 * 60 * 60_000));
    const reset = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: reset }, extra_usage: { is_enabled: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: reset }, extra_usage: { is_enabled: false } })));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, responsibleUserId: "alice" }, triggerDetail: "system" });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("failed");
      const saved = await heartbeat.getRun(run!.id);
      expect(saved?.contextSnapshot?.aiRouterSelection).toMatchObject({ poolId: pool.id, memberId: second.id, binding: { grantId: account.grantId } });
      expect(saved?.runnerProfileJson?.adapterDispatch).toMatchObject({ adapterType: "claude_local" });
      expect(saved?.runnerProfileJson?.legacyQuotaPrestartFence).toMatchObject({ schema: "paperclip.legacy-quota-prestart.v1", runId: run!.id, state: "consumed" });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore(); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions();
      await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    }
  }, 30_000);
  it("moves a newly pinned Claude account when a concurrent quota observation arrives before startup", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const primary = await aiConnectionService(db).save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Concurrent primary", loginSessionId: "fixture", agentIds: [], allAgents: true }, "concurrent-claude-primary");
    const first: AiConnectionPoolMember = { ...members[1]!, id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...primary } };
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Concurrent backup", loginSessionId: "fixture", agentIds: [], allAgents: true }, "concurrent-claude-backup");
    const second: AiConnectionPoolMember = { ...first, id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...account } };
    const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [first, second] } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Concurrent quota", adapterType: "claude_local",
      adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Concurrent quota task", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const execute = vi.fn(async () => { throw new Error("fixture stopped before actual provider"); });
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline fixture"));
    const selections: string[] = [];
    const heartbeat = heartbeatService(db, { runtimeEnv: {}, afterLegacyPoolSelection: async (_runId, selection) => {
      selections.push(selection.memberId);
      if (selection.memberId === first.id) await service().recordQuotaCooldown(companyId, first.binding.connectionId,
        await identityFor(first.binding.grantId), new Date(Date.now() + 3_600_000));
    } });
    try {
      const source = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, responsibleUserId: "alice" }, triggerDetail: "system" });
      expect(source).not.toBeNull();
      await expect.poll(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id))).length, { timeout: 20_000 }).toBe(1);
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id));
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.taskKey, issue!.id)));
      expect(selections[0]).toBe(first.id);
      expect(pin?.selection.memberId).toBe(second.id);
      expect(successor?.scheduledRetryReason).toBe("ai_connection_pool_wait");
      const wait = successor?.resultJson?.executionWait as { cause?: string; runId?: string } | undefined;
      if (wait) expect(wait).toMatchObject({ cause: "execution_owner_active", runId: source!.id });
      else expect(successor?.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 10_000);
      expect((await heartbeat.getRun(source!.id))?.runnerProfileJson?.legacyQuotaPrestartFence).toMatchObject({ state: "preparing" });
    } finally {
      fetch.mockRestore(); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions();
      await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    }
  }, 30_000);
  it("uses an account-wide Claude usage observation only for an unpinned task", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const claude = members[1]!;
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, claude.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-preflight", preserveAiSessionEpoch: true }, { userId: "alice" });
    let utilization = 12;
    const reset = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      five_hour: { utilization, resets_at: reset }, extra_usage: { is_enabled: false },
    })));
    try {
      const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [claude, members[0]!] } }, "alice");
      const taskKey = randomUUID();
      expect((await resolve(pool.id, taskKey)).memberId).toBe(claude.id);
      utilization = 100;
      await secretService(db).rotate(ref.secretId, { value: "fixture-preflight-new", preserveAiSessionEpoch: true }, { userId: "alice" });
      expect((await resolve(pool.id, taskKey)).memberId).toBe(claude.id);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((await resolve(pool.id, randomUUID())).memberId).toBe(members[0]!.id);
      expect(await service().accountCooldown(companyId, claude.binding.connectionId, await identityFor(claude.binding.grantId))).toEqual(new Date(reset));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect((await resolve(pool.id, randomUUID())).memberId).toBe(members[0]!.id);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
      await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    }
  });
  it("does not treat uncertain Claude usage as account-wide exhaustion", async () => {
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, companyId));
    const claude = members[1]!;
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, claude.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    let body: Record<string, unknown> = {};
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body)));
    try {
      const pool = await service().save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: randomUUID(), enabled: true, mode: "failover", thresholdPercent: 90, members: [claude, members[0]!] } }, "alice");
      const future = new Date(Date.now() + 60_000).toISOString();
      const cases = [
        { seven_day_sonnet: { utilization: 100, resets_at: future }, extra_usage: { is_enabled: false } },
        { five_hour: { utilization: 100, resets_at: future } },
        { five_hour: { utilization: 100, resets_at: new Date(Date.now() - 1000).toISOString() }, extra_usage: { is_enabled: false } },
        { five_hour: { utilization: 99, resets_at: future }, extra_usage: { is_enabled: false } },
      ];
      for (const [index, value] of cases.entries()) {
        body = value;
        await secretService(db).rotate(ref.secretId, { value: `fixture-preflight-unknown-${index}`, preserveAiSessionEpoch: true }, { userId: "alice" });
        expect((await resolve(pool.id, randomUUID())).memberId).toBe(claude.id);
        expect(await service().accountCooldown(companyId, claude.binding.connectionId, await identityFor(claude.binding.grantId))).toBeNull();
      }
    } finally { fetch.mockRestore(); }
  });
  it("does not assign the built-in failover policy to a plugin-owned pool", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    try { await expect(makePool({ mode: "failover" })).rejects.toThrow("requires the built-in pool"); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false }); }
  });
  it("does not reuse a pinned account for a session belonging to a different grant", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    try {
      const pool = await makePool();
      const taskKey = randomUUID();
      const selected = await resolve(pool.id, taskKey);
      if (selected.binding.mode === "responsible_user") throw new Error("Expected an explicit pool account");
      const selectedGrantId = selected.binding.grantId;
      const other = members.find(member => member.binding.grantId !== selectedGrantId)!;
      await expect(resolve(pool.id, taskKey, { requireExisting: true, existingGrantId: other.binding.grantId }))
        .rejects.toThrow("Reset this task session");
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    }
  });
  it("defaults off and does not expose selectable pools before opt-in", async () => {
    for (const pool of await service().list(companyId)) {
      if (pool.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY) await service().remove(companyId, pool.id, pool.revision, "alice");
    }
    expect((await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters).toBe(false);
    expect((await service().catalog())[0]?.availability).toEqual({ available: false, reason: "Ask your instance operator to enable AI connection routing." });
    await expect(makePool()).rejects.toThrow("instance operator");
    expect(await service().selectable(companyId, "alice")).toEqual([]);
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
  });
  it("registers native connectors only for declared installed routers", async () => {
    const entry = (await service().catalog())[0]!;
    expect(entry.name).toBe("AI connection pool");
    expect(entry.aiConnectionRouter).toEqual({ pluginKey });
    expect(entry.availability?.available).toBe(true);
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try {
      expect((await service().catalog())[0]?.availability?.available).toBe(false);
      await db.update(plugins).set({ status: "uninstalled" }).where(eq(plugins.id, pluginId));
      expect((await service().catalog()).map(entry => entry.aiConnectionRouter?.pluginKey)).toEqual([BUILTIN_AI_FAILOVER_ROUTER_KEY]);
    } finally { await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("native connector removal retains durable pins and ordinary updates cannot bypass pool revisions", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "catalog-removal");
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "alice", source: "local_implicit", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } as typeof req.actor; next(); });
    app.use("/api", toolAccessRoutes(db)); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    expect((await request(app).patch(`/api/tool-connections/${pool.id}`).send({ name: "Bypass" })).status).toBe(400);
    expect((await request(app).delete(`/api/tool-connections/${pool.id}`)).status).toBe(400);
    expect((await request(app).delete(`/api/companies/${companyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision + 1 })).status).toBe(409);
    expect((await request(app).delete(`/api/companies/${companyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(200);
    expect((await service().list(companyId)).some(row => row.id === pool.id)).toBe(false);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    expect(await resolve(pool.id, "catalog-removal", { persisted: selected })).toEqual(selected);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, members[0]!.binding.connectionId)))[0]?.status).toBe("active");
  });
  it("requires company connection management authority on pool configuration routes", async () => {
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
    const app = express(); app.use(express.json());
    let actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); }); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    const pool = await makePool(); const url = `/api/companies/${companyId}/ai-connection-pools`;
    expect((await request(app).get(url)).status).toBe(200);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/ai-connection-pools`)).status).toBe(403);
    expect((await request(app).delete(`/api/companies/${otherCompanyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
    actor = { ...actor, memberships: [{ companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).post(url).send({ pluginKey, config: pool })).status).toBe(403);
    expect((await request(app).get(`${url}/${pool.id}/inspection`)).status).toBe(403);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    actor = { type: "agent", agentId, companyId, source: "agent_jwt" } as unknown as typeof actor;
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
    actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision + 1 })).status).toBe(409);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(200);
    expect((await request(app).get(url)).body.some((entry: { id: string }) => entry.id === pool.id)).toBe(false);
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
  });
  it("deletes pools without erasing pins, cursors, or admitted recovery evidence", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "retained");
    await expect(service().remove(otherCompanyId, pool.id, pool.revision, "alice")).rejects.toThrow("not found");
    await expect(service().remove(companyId, pool.id, pool.revision + 1, "alice")).rejects.toThrow("reload before deleting");
    await service().remove(companyId, pool.id, pool.revision, "alice");
    expect((await service().list(companyId)).some(entry => entry.id === pool.id)).toBe(false);
    expect((await service().selectable(companyId, "alice")).some(entry => entry.id === pool.id)).toBe(false);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
    await expect(resolve(pool.id, "new")).rejects.toThrow("choose another AI connection");
    expect(await resolve(pool.id, "retained", { persisted: selected })).toEqual(selected);
    const { name, enabled, mode, thresholdPercent, members: savedMembers } = pool;
    await expect(service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision + 1, config: { name, enabled, mode, thresholdPercent, members: savedMembers } }, "alice")).rejects.toThrow("not found");
  });
  it("does not commit a selection when its pool is deleted during a proposal", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => { await service().remove(companyId, pool.id, pool.revision, "alice"); return { kind: "selected", memberId: members[0]!.id }; });
    await expect(resolve(pool.id, "deleted-during-selection")).rejects.toThrow("choose another AI connection");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(0);
  });
  it("allows cleanup while experimental routing and its plugin are disabled", async () => {
    const pool = await makePool();
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try { await expect(service().remove(companyId, pool.id, pool.revision, "alice")).resolves.toEqual({ ok: true }); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
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
    const claudeEffort = poolMemberRuntimeConfig(members[1]!, "paperclip_runner", { modelReasoningEffort: "xhigh" });
    expect(claudeEffort.config).toMatchObject({ provider: "acpx", acpxAgent: "claude", modelReasoningEffort: "xhigh" });
    expect(claudeEffort.notes).toEqual([]);
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
  it("uses mixed legacy members and makes reassignment an independent pin", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "legacy", { adapterType: "claude_local" })).memberId).toBe(members[0]!.id);
    expect((await resolve(pool.id, "legacy", { agentId: secondAgentId, adapterType: "codex_local" })).memberId).toBe(members[1]!.id);
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
    const [initialGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const initialRef = initialGrant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(initialRef.secretId, { value: "fixture-observation-cache", preserveAiSessionEpoch: true }, { userId: "alice" });
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
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.status, "queued")));
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
      expect(cancelled?.runnerProfileJson?.legacyQuotaPrestartFence).toMatchObject({ schema: "paperclip.legacy-quota-prestart.v1", runId: run!.id, state: "preparing" });
      expect(cancelled?.resultJson).toMatchObject({
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        cancellation: {
          source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Waiting for an AI connection pool account",
          recordedAt: cancelled!.finishedAt!.toISOString(),
        },
      });
      expect(legacyExecutionNeedsReconciliation(cancelled!)).toBe(false);
      expect(legacyExecutionNeedsReconciliation({ ...cancelled!, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
      await expect.poll(async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")))).length, { timeout: 5000 }).toBe(1);
      const [retry] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")));
      await waitForPendingRunFailureReports();
      expect(captureRunFailure.mock.calls.filter(([report]) => report.runId === run!.id)).toHaveLength(0);
      expect(retry?.resultJson?.cancellation).toBeUndefined();
      expect(retry?.contextSnapshot?.aiRouterTaskKey).toBe(issue!.id); expect(retry?.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 }); expect(execute).not.toHaveBeenCalled();
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent!.id))); expect(pin?.selection).toEqual(pinned);
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.agentId, agent!.id));
    } finally { fetch.mockRestore(); proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("keeps unexpected pool policy failures reportable before provider work", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Unexpected router failure", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Router failure fixture", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    proposal.mockRejectedValueOnce(new Error("Synthetic unexpected router policy failure"));
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: "alice" }, triggerDetail: "system" });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("failed");
      const failed = await heartbeat.getRun(run!.id);
      expect(failed?.errorCode).toBe("configuration_incomplete");
      expect(failed?.resultJson).toMatchObject({ configurationIncomplete: { reason: "ai_connection_unavailable" } });
      expect(failed?.resultJson?.cancellation).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      await expect.poll(() => captureRunFailure.mock.calls.filter(([report]) => report.runId === run!.id)).toHaveLength(1);
      expect(captureRunFailure).toHaveBeenCalledWith(expect.objectContaining({ runId: run!.id, runStatus: "failed", errorCode: "configuration_incomplete" }));
    } finally { proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
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
    try { await expect(resolve(pool.id, "recovery")).rejects.toMatchObject({ status: 422, details: { code: "ai_connection_router_disabled" } }); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); }
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
  it("admits a healthy pool member when the saved Grok connection is held", async () => {
    const original = await instanceSettingsService(db).getExperimental();
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true,
      enableNativeRunner: true, enableGrokBot: true, enablePublicMcp: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[0]!] });
    const bindingId = randomUUID();
    const workspace = path.join(home, "routed-grok-work");
    await mkdir(workspace);
    const [agent] = await db.insert(agents).values({ companyId, name: "Routed Grok fixture", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot", externalBindingId: bindingId, cwd: workspace },
      runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
    await db.insert(dotAgentBindings).values({ id: bindingId, companyId, agentId: agent.id,
      operatorId: "alice", providerKind: "grok_bot", status: "connected" });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[0]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await db.insert(grokBotRoutines).values({ companyId, agentId: agent.id, bindingId, bindingGeneration: 1,
      botName: "Unused held Bot", secretId: ref.secretId, secretVersion: 1,
      recoveryRequiredAt: new Date(), recoveryReason: "work_session" });
    expect(await dotRunnerBroker(db).canStartNewWork(companyId, agent.id, bindingId)).toBe(false);
    const readiness = vi.spyOn(dotRunnerBroker(db), "canStartNewWork");
    const beforeNative = vi.fn(async () => {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
      throw new Error("fixture stopped before provider start");
    });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {},
      beforeNativeRuntimeSelection: beforeNative,
      nativeSessionBackendFactory: () => { throw new Error("Unexpected provider start"); } });
    const [issue] = await db.insert(issues).values({ companyId, title: "Healthy routed task", status: "todo",
      assigneeAgentId: agent.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    try {
      const run = await heartbeat.wakeup(agent.id, { source: "assignment", reason: "issue_assigned", triggerDetail: "system",
        payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id, responsibleUserId: "alice" } });
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const saved = await heartbeat.getRun(run!.id);
      expect(saved?.contextSnapshot?.aiRouterSelection).toMatchObject({ poolId: pool.id,
        memberId: members[0]!.id, runtimeConfig: { provider: "codex" } });
      expect(saved?.error).toContain("fixture stopped before provider start");
      expect(beforeNative).toHaveBeenCalledExactlyOnceWith(run!.id);
      expect(readiness).not.toHaveBeenCalled();
    } finally {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
      await heartbeat.drainActiveRunExecutions();
      readiness.mockRestore();
      await instanceSettingsService(db).updateExperimental(original);
    }
  }, 30_000);

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


enableRunFailureReporting();
