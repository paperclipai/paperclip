import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { registerPluginTaskCredentialHandoff } from "../services/plugin-task-credential-writeback.js";
import { executeEnvironmentTask, settleDispatchedEnvironmentTask } from "../services/environment-task-runtime.js";
import { secretService } from "../services/secrets.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: async () => {} }));
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const auth = (token: string, year = 2020) => JSON.stringify({ tokens: { account_id: "fixture-account", access_token: "fixture-access", refresh_token: token }, last_refresh: `${year}-01-01T00:00:00Z` });

suite("durable plugin task credential handoff", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "plugin-task-secret-")));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "plugin-task-fixture");
    database = await startEmbeddedPostgresTestDatabase("plugin-task-credential-"); db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  async function fixture(dispatched = true) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), pluginId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const owner = `fixture-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Task credential fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const service = aiConnectionService(db);
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: "Fixture Codex", loginSessionId: "fixture", agentIds: [], allAgents: true }, auth("fixture-original"));
    const [selection] = await service.quotaAccounts(companyId, owner);
    const managed = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "paperclip_runner",
      binding: { mode: "responsible_user", provider: "openai", method: "subscription" }, config: { provider: "codex" } });
    expect(managed.credentialWriteback).toBeDefined();
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "plugin", status: "active", config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-tasks", version: "1.0.0", status: "ready", manifestJson: {
      capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }],
    } as never });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, provider: `plugin:${pluginId}:tasks`, providerLeaseId: "fixture-task", status: "active",
      metadata: { driver: "plugin", pluginId, driverKey: "tasks", runnerTaskLease: true, runnerTaskDispatched: dispatched, runnerTaskExecutionStopped: false } });
    await registerPluginTaskCredentialHandoff(db, { companyId, leaseId }, managed.sessionIdentity, managed.credentialWriteback!);
    // Recovery must not depend on the original controller or its private home.
    await rm(managed.home!, { recursive: true, force: true });
    const calls: string[] = [];
    let failExport = false;
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }),
      call: async (_plugin: string, _method: string, params: any) => {
        calls.push(params.operation.kind);
        expect(params.companyId).toBe(companyId); expect(params.taskId).toBe("fixture-task");
        if (params.operation.kind === "status") return { kind: "status", taskId: "fixture-task", phase: "cancelled", executionStopped: true };
        if (params.operation.kind === "credentials") {
          expect(params.operation.accountIdentity).toBe(managed.sessionIdentity);
          if (failExport) throw new Error("fixture export unavailable");
          return { kind: "credentials", taskId: "fixture-task", credential: { type: "codex-auth-json", authJson: auth("fixture-refreshed", 2021) } };
        }
        return { kind: "accepted", taskId: "fixture-task" };
      } } as unknown as PluginWorkerManager;
    const lease = () => db.select().from(environmentLeases).where(and(eq(environmentLeases.id, leaseId), eq(environmentLeases.companyId, companyId))).then(rows => rows[0]!);
    return { companyId, agentId, runId, environmentId, leaseId, owner, selection: selection!, managed, workers, calls, lease,
      failExport(value: boolean) { failExport = value; }, credential: () => service.credential(selection!),
      settle: () => settleDispatchedEnvironmentTask(db, workers, { companyId, id: leaseId }) };
  }
  it("persists refreshed credentials before completing a stopped task, after controller files disappear", async () => {
    const f = await fixture();
    expect(await f.settle()).toBe(true);
    expect(await f.credential()).toBe(auth("fixture-refreshed", 2021));
    expect(f.calls.indexOf("credentials")).toBeLessThan(f.calls.indexOf("complete"));
    const saved = await f.lease();
    expect(saved.metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete" });
    expect(JSON.stringify(saved.metadata)).not.toContain("fixture-refreshed");
    expect(JSON.stringify(saved.metadata)).not.toContain(f.managed.home!);
  });
  it("keeps a failed transfer pending and recovers through a fresh cleanup after run and environment deletion", async () => {
    const f = await fixture(); f.failExport(true);
    await expect(f.settle()).rejects.toThrow("termination is unconfirmed");
    expect(f.calls).not.toContain("complete");
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "pending" });
    expect(await f.credential()).toBe(auth("fixture-original"));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(environments).where(eq(environments.id, f.environmentId));
    f.failExport(false);
    expect(await f.settle()).toBe(true);
    expect(await f.credential()).toBe(auth("fixture-refreshed", 2021));
    expect(f.calls.at(-1)).toBe("complete");
  });
  it("does not overwrite an explicit account replacement", async () => {
    const f = await fixture();
    await secretService(db).rotate(f.managed.credentialWriteback!.secretId, { value: auth("fixture-reconnected", 2022) }, { userId: f.owner });
    expect(await f.settle()).toBe(true);
    expect(f.calls).not.toContain("credentials");
    expect(await f.credential()).toBe(auth("fixture-reconnected", 2022));
  });
  it("allows concurrent cleanup to complete the same durable handoff", async () => {
    const f = await fixture();
    expect(await Promise.all([f.settle(), f.settle()])).toEqual([true, true]);
    expect(await f.credential()).toBe(auth("fixture-refreshed", 2021));
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete" });
  });
  it("retires an undispatched task without exporting credentials and blocks a late submit", async () => {
    const f = await fixture(false);
    expect(await f.settle()).toBe(false);
    expect(f.calls).toEqual([]);
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete" });
    await expect(executeEnvironmentTask(db, f.workers, { companyId: f.companyId, leaseId: f.leaseId, operation: {
      kind: "submit", projectIds: [], bootstrapTicket: "fixture-ticket", runner: { harness: "codex", protocolMin: 1, protocolMax: 3,
        runnerId: "runner", leaseId: f.leaseId, runId: f.runId, sessionId: "session", turnId: "turn", itemId: "item" },
    } })).rejects.toThrow("not active");
    expect(f.calls).toEqual([]);
  });
});
