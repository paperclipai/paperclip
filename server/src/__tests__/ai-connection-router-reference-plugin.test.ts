import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, closeRegisteredClients, companies, agents, authUsers, companyMemberships, plugins, aiConnectionTaskPins, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { pluginManifestV1Schema, type AiConnectionPoolMember, type AiConnectionRouterRequest } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { aiConnectionRouterService, AiConnectionPoolExhausted } from "../services/ai-connection-router.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { setPluginEventBus } from "../services/activity-log.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { probeAiConnectionUsage } from "../services/ai-connection-usage.js";
import { routeAiConnection } from "../../../packages/plugins/examples/plugin-ai-connection-router/src/policy.js";
import manifest from "../../../packages/plugins/examples/plugin-ai-connection-router/src/manifest.js";
import plugin from "../../../packages/plugins/examples/plugin-ai-connection-router/src/worker.js";

// The reference router's own worker definition answers the host's routing calls and
// receives the host's run lifecycle events; its plugin state is the SDK's in-memory store.
// The adapter is a fake: no provider is called and no live quota is used.
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
let db: ReturnType<typeof createDb>;
let isolatedHome: ReturnType<typeof createIsolatedTestHome>;
let members: AiConnectionPoolMember[];
const companyId = randomUUID(), pluginId = randomUUID();
const harness = createTestHarness({ manifest });
const routeCalls: AiConnectionRouterRequest[] = [];
const worker = {
  isRunning: () => true,
  call: async (_id: string, method: string, params: AiConnectionRouterRequest) => {
    if (method !== "routeAiConnection") throw new Error(`Unexpected worker method ${method}`);
    routeCalls.push(params);
    return plugin.definition.onRouteAiConnection!(params);
  },
} as unknown as PluginWorkerManager;
const service = () => aiConnectionRouterService(db, worker);

beforeAll(async () => {
  isolatedHome = createIsolatedTestHome();
  vi.stubEnv("PAPERCLIP_HOME", isolatedHome.home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "reference-router");
  if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
  else { database = await startEmbeddedPostgresTestDatabase("paperclip-reference-router-db-"); db = createDb(database.connectionString); }
  await db.insert(companies).values({ id: companyId, name: "Reference router", issuePrefix: "RRF" });
  await db.insert(authUsers).values({ id: "alice", name: "alice", email: "alice@router.example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "member" });
  await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@paperclipai/plugin-ai-connection-router", version: manifest.version, manifestJson: manifest, status: "ready" });
  const accounts = aiConnectionService(db);
  members = await Promise.all(["First", "Second"].map(async (name) => {
    const saved = await accounts.save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name, loginSessionId: "fixture", agentIds: [], allAgents: true }, `fixture-${name}`);
    return { id: randomUUID(), binding: { mode: "delegated" as const, provider: "anthropic" as const, method: "subscription" as const, ...saved }, profile: { provider: "acpx" as const, acpxAgent: "claude" as const, model: "claude-sonnet-5" } };
  }));
  await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
  const bus = createPluginEventBus();
  for (const type of ["agent.run.failed", "agent.run.finished"] as const) bus.forPlugin(manifest.id).subscribe(type, event => harness.emit(event.eventType, event.payload, event));
  setPluginEventBus(bus);
  await plugin.definition.setup(harness.ctx);
}, 90_000);
afterAll(async () => {
  if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
  await db?.$client.end();
  await database?.cleanup(); vi.unstubAllEnvs(); isolatedHome?.cleanup();
});

describe("reference AI connection router plugin", () => {
  it("passes host manifest validation with only the documented capabilities", () => {
    expect(pluginManifestV1Schema.parse(manifest).capabilities).toEqual(["ai.connections.route", "events.subscribe", "plugin.state.read", "plugin.state.write"]);
  });

  it.each([
    { window: "seven_day_sonnet", model: "claude-sonnet-5", skipped: true },
    { window: "seven_day_opus", model: "claude-opus-5", skipped: true },
    { window: "seven_day_opus", model: "claude-sonnet-5", skipped: false },
  ])("applies the host's legacy $window window to a $model member (fake usage response)", async ({ window, model, skipped }) => {
    const body = { five_hour: { utilization: 10, resets_at: "2026-01-01T05:00:00Z" }, [window]: { utilization: 100, resets_at: "2026-01-02T00:00:00Z" } };
    const request = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const observed = await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" } as never, "fixture-token", { request });
    expect(observed.limits.find(entry => entry.id === window)?.scope).toBe(window);
    const binding = { mode: "delegated" as const, provider: "anthropic" as const, method: "subscription" as const, connectionId: "c-1", grantId: "g-1" };
    const member = { id: "m-1", binding, profile: { provider: "acpx" as const, acpxAgent: "claude" as const, model } };
    const candidate = { member, runtimeConfig: {}, notes: [], usage: { ...observed, connectionId: "c-1", grantId: "g-1" } } as AiConnectionRouterRequest["candidates"][number];
    const routed = (pinnedMemberId?: string) => routeAiConnection({ companyId, agentId: "a-1", taskKey: "t-1", lastMemberId: null, cursorVersion: 0, memberOrder: ["m-1"], now: "2026-01-01T00:00:00.000Z",
      pool: { id: "p-1", companyId, pluginKey: manifest.id, revision: 1, name: "Pool", enabled: true, mode: "usage_aware", thresholdPercent: 90, members: [member] }, candidates: [candidate], ...(pinnedMemberId ? { pinnedMemberId } : {}) } as AiConnectionRouterRequest, new Map());
    for (const result of [routed(), routed("m-1")]) expect(result.kind).toBe(skipped ? "exhausted" : "selected");
  });

  it("fails new tasks over after a learned provider_quota cool-down and keeps the pinned task waiting on its account", async () => {
    const pool = await service().save(manifest.id, { companyId, config: { name: "Reference pool", enabled: true, mode: "round_robin", thresholdPercent: 90, members } }, "alice");
    const [agent] = await db.insert(agents).values({ companyId, name: "Reference router agent", adapterType: "claude_local", adapterConfig: { cwd: isolatedHome.home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Quota fixture", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const execute = vi.fn(async () => ({ exitCode: 1, signal: null, timedOut: false, errorCode: "provider_quota", errorFamily: "provider_quota", errorMessage: "Fixture: usage limit reached" }));
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute } as never);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", triggerDetail: "system", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: "alice" } });
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.errorCode, { timeout: 20_000 }).toBe("provider_quota");
      expect(execute).toHaveBeenCalledTimes(1);
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.taskKey, issue!.id)));
      expect(pin?.selection.memberId).toBe(members[0]!.id);
      const cooldownKey = { scopeKind: "agent" as const, scopeId: agent!.id, namespace: "cooldowns", stateKey: `${members[0]!.binding.connectionId}:${members[0]!.binding.grantId}` };
      await expect.poll(() => harness.getState(cooldownKey), { timeout: 5_000 }).toMatchObject({ strikes: 1, lastRunId: run!.id });

      // Round robin alone would alternate; the cool-down sends both new tasks to the second account.
      const resolve = (taskKey: string) => service().resolve({ companyId, poolId: pool.id, agentId: agent!.id, userId: "alice", adapterType: "claude_local", taskKey });
      expect((await resolve("new-task-1")).memberId).toBe(members[1]!.id);
      expect((await resolve("new-task-2")).memberId).toBe(members[1]!.id);

      // The pinned task is not moved: the host waits on its original account.
      await expect(resolve(issue!.id)).rejects.toBeInstanceOf(AiConnectionPoolExhausted);
      expect(routeCalls.at(-1)).toMatchObject({ taskKey: issue!.id, pinnedMemberId: members[0]!.id });
      const [after] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.taskKey, issue!.id)));
      expect(after?.selection).toEqual(pin?.selection);
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.status, "scheduled_retry")));
      unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions();
    }
  }, 60_000);
});
