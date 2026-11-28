import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, companyMemberships, heartbeatRuns, issues, issueThreadInteractions,
  connectionIntentDeliveries, toolApplications, toolConnections, connectionGrants, aiProviderDefaults, plugins, aiConnectionTaskPins, aiConnectionRouterCursors, createDb } from "@paperclipai/db";
import type { AiConnectionRouterRequest } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { aiConnectionRouterService } from "../services/ai-connection-router.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { readAiConnectionConfigurationFailure } from "../services/ai-connection-configuration-failure.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { connectionIntentDeliveryService, wakeConnectionIntentAfterResolution } from "../services/connection-intent-delivery.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("queued agent setup uses task connection cards", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("agent-setup-card-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture(separateSetupUser = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), userId = randomUUID();
    const setupUserId = separateSetupUser ? randomUUID() : userId;
    await db.insert(companies).values({ id: companyId, name: "Setup card", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    if (setupUserId !== userId) await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: setupUserId, status: "active", membershipRole: "member" });
    const binding = { mode: "responsible_user", provider: "openrouter", method: "api_key" } as const;
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", status: "paused", lifecycleState: "verifying", lifecycleHolds: [],
      lifecycleRequiredPluginIds: [], lifecycleOperation: { responsibleUserId: setupUserId, id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 1, retryRequired: true },
      adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" }, runtimeConfig: { aiConnection: binding } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review after setup", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", responsibleUserId: userId, contextSnapshot: { issueId } });
    const service = connectionIntentService(db);
    const claims = { sub: agentId, company_id: companyId, run_id: runId, responsible_user_id: userId };
    return { companyId, agentId, issueId, runId, userId, setupUserId, binding, service, claims };
  }
  async function repair(f: Awaited<ReturnType<typeof fixture>>, userId = f.setupUserId) {
    const [app] = await db.insert(toolApplications).values({ companyId: f.companyId, applicationKey: `setup-openrouter-${userId}`, name: `OpenRouter ${userId}`, type: "mcp_http", metadata: { sourceTemplateKey: "openrouter" } }).returning();
    const [account] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: app!.id, name: "Review account", uid: randomUUID(), connectionPurpose: "ai", transport: "runtime_auth", authKind: "api_key", credentialPolicy: "per_user", healthStatus: "ok", status: "active", enabled: true, config: { sourceTemplateKey: "openrouter", ai: { provider: "openrouter", method: "api_key" } } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: account!.id, kind: "user", subjectUserId: userId, createdByUserId: userId }).returning();
    await db.insert(aiProviderDefaults).values({ companyId: f.companyId, userId: userId, provider: "openrouter", grantId: grant!.id });
    return account!;
  }
  const cards = (issueId: string) => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));

  it.each(["verifying", "resuming"] as const)("repairs %s through one inline card and the same queued turn", async phase => {
    const f = await fixture();
    if (phase === "resuming") await db.update(agents).set({ lifecycleState: phase,
      lifecycleOperation: sql`${agents.lifecycleOperation} || '{"resumeState":"ready"}'::jsonb` }).where(eq(agents.id, f.agentId));
    await expect(f.service.validate(f.claims)).rejects.toThrow("no longer active");
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const pending = await cards(f.issueId);
    expect(pending).toHaveLength(1);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId)))
      .filter(row => row.action === "issue.thread_interaction_created")).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "connection_intent", status: "pending", sourceRunId: f.runId, addresseeUserId: f.userId,
      payload: { purpose: "ai", serviceSlug: "openrouter", agentSetup: true } });
    expect((await f.service.setupOptions(pending[0]!.id)).aiConnection).toEqual(f.binding);
    const account = await repair(f);
    await f.service.complete(pending[0]!.id, account.id, f.userId);
    const wakeup = vi.fn();
    const delivery = connectionIntentDeliveryService(db, { wakeup } as never);
    await delivery.deliver(pending[0]!.id);
    await delivery.deliver(pending[0]!.id);
    expect(wakeup).not.toHaveBeenCalled();
    const [held] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(held!.lifecycleState).toBe(phase);
    expect(held!.lifecycleOperation).not.toHaveProperty("retryRequired");
    const onReady = vi.fn();
    const host = vi.fn(async () => "complete" as const);
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: host, runPlugin: async () => "complete" as const, onReady });
    try { await worker.process(f.agentId); await worker.process(f.agentId); }
    finally { await worker.stop(); }
    expect(host).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId)))).toMatchObject([{ id: f.runId, status: "queued", startedAt: null }]);
    expect((await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, pending[0]!.id)))[0]!.deliveredAt).not.toBeNull();
  });

  it.each([{ taskAccountReady: false, companyDefault: false }, { taskAccountReady: true, companyDefault: false },
    { taskAccountReady: false, companyDefault: true }])("repairs the verifier's user without changing task authority: %j", async ({ taskAccountReady, companyDefault }) => {
    const f = await fixture(true);
    if (companyDefault) {
      await db.update(companies).set({ defaultResponsibleUserId: f.setupUserId }).where(eq(companies.id, f.companyId));
      await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'responsibleUserId'` }).where(eq(agents.id, f.agentId));
    }
    if (taskAccountReady) await repair(f, f.userId);
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const [card] = await cards(f.issueId);
    expect(card).toMatchObject({ addresseeUserId: f.setupUserId, sourceRunId: f.runId, payload: { agentSetup: true } });
    const account = await repair(f);
    await f.service.complete(card!.id, account.id, f.setupUserId);
    const wakeup = vi.fn();
    await connectionIntentDeliveryService(db, { wakeup } as never).deliver(card!.id);
    const onReady = vi.fn();
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete" as const,
      runHost: async agent => {
        const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
        const verificationUserId = agent.lifecycleOperation?.responsibleUserId ?? company!.defaultResponsibleUserId;
        expect(verificationUserId).toBe(f.setupUserId);
        await aiConnectionService(db).select({ companyId: f.companyId, agentId: f.agentId,
          userId: verificationUserId, adapterType: "paperclip_runner", runnerProvider: "opencode",
          model: "openrouter/deepseek/deepseek-v4.1-flash-1017", binding: f.binding });
        return "complete";
      }, onReady });
    try { await worker.process(f.agentId); } finally { await worker.stop(); }
    expect(onReady).toHaveBeenCalledOnce();
    expect(wakeup).not.toHaveBeenCalled();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(source).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: f.userId });
    expect(source!.contextSnapshot).toEqual({ issueId: f.issueId });
  });

  it("repairs a router's pinned lifecycle account without rerouting the task or changing its pool", async () => {
    const f = await fixture();
    const account = await aiConnectionService(db).save(f.companyId, f.setupUserId, { provider: "openai", method: "api_key",
      ownership: "personal", name: "Router setup account", apiKey: "fixture", agentIds: [], allAgents: true }, "fixture-key");
    const pluginKey = `fixture.setup-router-${f.companyId}`;
    await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0", status: "ready", manifestJson: {
      id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Setup router", description: "Fixture", author: "Tests",
      categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "Setup pool", description: "Saved accounts" }, entrypoints: { worker: "worker.js" } } });
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const route = vi.fn(async (_id: string, _method: string, input: AiConnectionRouterRequest) =>
      ({ kind: "selected", memberId: input.candidates[0]!.member.id }));
    const router = aiConnectionRouterService(db, { isRunning: () => true, call: route } as unknown as PluginWorkerManager);
    const binding = { mode: "delegated", provider: "openai", method: "api_key", ...account } as const;
    const pool = await router.save(pluginKey, { companyId: f.companyId, config: { name: "Lifecycle setup pool", enabled: true,
      mode: "round_robin", thresholdPercent: 90, members: [{ id: randomUUID(), binding,
        profile: { provider: "codex", model: "gpt-5.6-sol", effort: "low" } }] } }, f.setupUserId);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const routerBinding = { mode: "router", connectionId: pool.id };
    await db.update(agents).set({ runtimeConfig: { aiConnection: routerBinding } }).where(eq(agents.id, f.agentId));
    const input = { companyId: f.companyId, poolId: pool.id, agentId: f.agentId, userId: f.setupUserId,
      adapterType: "paperclip_runner", taskKey: `lifecycle:${agent!.lifecycleOperation!.id}` };
    const selected = await router.resolve(input);
    await db.update(toolConnections).set({ healthStatus: "error" }).where(eq(toolConnections.id, account.connectionId));
    try { await router.resolve(input); throw new Error("Expected owned account refusal"); }
    catch (error) { expect(readAiConnectionConfigurationFailure(error)).toBe("ai_connection_unavailable"); }
    route.mockClear();
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const [card] = await cards(f.issueId);
    expect(card).toMatchObject({ status: "pending", sourceRunId: f.runId, payload: { purpose: "ai", serviceSlug: "openai", agentSetup: true } });
    expect((await f.service.setupOptions(card!.id)).aiConnection).toEqual(binding);
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, account.connectionId));
    const alternate = await aiConnectionService(db).save(f.companyId, f.setupUserId, { provider: "openai", method: "api_key",
      ownership: "personal", name: "Unselected router account", apiKey: "fixture", agentIds: [], allAgents: true }, "fixture-alternate-key");
    await expect(f.service.complete(card!.id, alternate.connectionId, f.setupUserId)).rejects.toMatchObject({ status: 409 });
    await f.service.complete(card!.id, account.connectionId, f.setupUserId);
    const wakeup = vi.fn();
    await connectionIntentDeliveryService(db, { wakeup } as never).deliver(card!.id);
    const [repaired] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(repaired!.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(repaired!.runtimeConfig.aiConnection).toEqual(routerBinding);
    expect((await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.agentId, f.agentId))))
      .toMatchObject([{ taskKey: input.taskKey, selection: selected }]);
    expect((await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)))[0]!.version).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.contextSnapshot).toEqual({ issueId: f.issueId });
    expect(route).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("supersedes a setup card when the lifecycle operation changes on the same queued turn", async () => {
    const f = await fixture();
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const [old] = await cards(f.issueId);
    const operationId = randomUUID();
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} || ${JSON.stringify({ id: operationId })}::jsonb` }).where(eq(agents.id, f.agentId));
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const all = await cards(f.issueId);
    expect(all).toHaveLength(2);
    expect(all.find(card => card.id === old!.id)).toMatchObject({ status: "expired", result: { outcome: "superseded" } });
    expect(all.find(card => card.status === "pending")).toMatchObject({ sourceRunId: f.runId,
      payload: { agentSetupOperationId: operationId } });
    await expect(f.service.setupOptions(old!.id)).rejects.toMatchObject({ status: 409 });
  });

  it("replaces a stopped turn's setup card and repairs the current queued turn", async () => {
    const f = await fixture();
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const [stoppedCard] = await cards(f.issueId);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "queued", responsibleUserId: f.userId, contextSnapshot: { issueId: f.issueId } }).returning();
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const current = await cards(f.issueId);
    expect(current).toHaveLength(2);
    const replacement = current.find(card => card.sourceRunId === next!.id)!;
    expect(replacement).toMatchObject({ status: "pending", payload: { agentSetup: true } });
    expect(current.find(card => card.id === stoppedCard!.id)).toMatchObject({ status: "expired",
      result: { outcome: "superseded", supersededByInteractionId: replacement.id } });
    const account = await repair(f);
    await f.service.complete(replacement.id, account.id, f.userId);
    const wakeup = vi.fn();
    await connectionIntentDeliveryService(db, { wakeup } as never).deliver(replacement.id);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.lifecycleOperation)
      .not.toHaveProperty("retryRequired");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "cancelled", startedAt: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id)))[0])
      .toMatchObject({ status: "queued", startedAt: null, responsibleUserId: f.userId });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each(["retry", "continuation"] as const)("restores an inline setup card through full recovery for a retained %s", async kind => {
    const f = await fixture();
    if (kind === "retry") {
      const [prior] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "failed", finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } }).returning();
      await db.update(heartbeatRuns).set({ retryOfRunId: prior!.id }).where(eq(heartbeatRuns.id, f.runId));
    } else await db.update(heartbeatRuns).set({ continuationAttempt: 1 }).where(eq(heartbeatRuns.id, f.runId));
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    deps.getAgentInvokability.mockImplementation(agent => evaluateAgentInvokabilityFromDb(db, agent));
    const queue = createHeartbeatQueue(db, deps);
    await queue.startNextQueuedRunForAgent(f.agentId);
    expect(await cards(f.issueId)).toHaveLength(0);
    await queue.resumeFreshQueuedRunsAtStartup();
    expect(await cards(f.issueId)).toHaveLength(0);
    expect(deps.executeRun).not.toHaveBeenCalledWith(f.runId);
    // The global startup pass may dispatch unrelated ready fixtures. The full
    // recovery below is scoped to this retained turn’s company.
    deps.executeRun.mockClear();
    await queue.resumeQueuedRunsAfterDrain({ companyId: f.companyId });
    await queue.resumeQueuedRunsAfterDrain({ companyId: f.companyId });
    expect(await cards(f.issueId)).toMatchObject([{ status: "pending", sourceRunId: f.runId, payload: { agentSetup: true } }]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "queued", startedAt: null, responsibleUserId: f.userId });
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["decline", "stop", "reassign", "setup_owner_changed", "setup_operation_changed"] as const)("does not dispatch or lift verification after %s", async action => {
    const f = await fixture();
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const [card] = await cards(f.issueId);
    if (action === "decline") await f.service.decline(card!.id, f.userId);
    else {
      const account = await repair(f);
      await f.service.complete(card!.id, account.id, f.userId);
      if (action === "stop") await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      else if (action === "reassign") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      else if (action === "setup_owner_changed") await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} || ${JSON.stringify({ responsibleUserId: randomUUID() })}::jsonb` }).where(eq(agents.id, f.agentId));
      else await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} || ${JSON.stringify({ id: randomUUID() })}::jsonb` }).where(eq(agents.id, f.agentId));
    }
    const wakeup = vi.fn();
    await connectionIntentDeliveryService(db, { wakeup } as never).deliver(card!.id);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.lifecycleOperation?.retryRequired).toBe(true);
    expect((await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, card!.id)))[0]!.deliveredAt).not.toBeNull();
  });

  it.each(["manual_pause", "started", "foreign_company"] as const)("does not create a setup card for %s", async state => {
    const f = await fixture();
    if (state === "manual_pause") await db.update(agents).set({ lifecycleState: "paused", lifecycleHolds: ["manual"] }).where(eq(agents.id, f.agentId));
    if (state === "started") await db.update(heartbeatRuns).set({ startedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await f.service.requestForQueuedAgentSetup(state === "foreign_company" ? randomUUID() : f.companyId, f.agentId);
    expect(await cards(f.issueId)).toHaveLength(0);
  });

  it("does not disclose a private task to a different setup account owner", async () => {
    const f = await fixture(true);
    await db.update(issues).set({ visibility: "private", responsibleUserId: f.userId }).where(eq(issues.id, f.issueId));
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    expect(await cards(f.issueId)).toHaveLength(0);
  });

  it("keeps setup-card outcomes out of the generic provider wake path", async () => {
    const wakeup = vi.fn();
    await wakeConnectionIntentAfterResolution({ wakeup } as never, { loaded: { issue: { id: "task", status: "in_progress", assigneeAgentId: "agent" }, interaction: { id: "card", payload: { purpose: "ai", agentSetup: true } } }, status: "accepted", actorId: "user" });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
