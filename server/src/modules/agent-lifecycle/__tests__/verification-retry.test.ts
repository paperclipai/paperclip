import { randomUUID } from "node:crypto";
import { agents, companies, createDb, applyPendingMigrations, closeRegisteredClients, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { startAgentLifecycle } from "../index.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import type { LifecycleAgent } from "../application/ports.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_LIFECYCLE_VERIFICATION_RETRY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("failed lifecycle verification retries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: Array<{ stop(): Promise<void> }> = [];
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-verification-retry-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (external) await closeRegisteredClients(external); else await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Verification retry", issuePrefix: `V${companyId.slice(0, 7)}` });
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    // Retire only this test's synthetic records so later coordinator reads stay isolated.
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  async function failed(code = "harness_test_failed") {
    const runHost = vi.fn(async (agent: LifecycleAgent) => {
      if (agent.lifecycleState === "verifying") throw Object.assign(new Error("private provider detail"), { code });
      return "complete" as const;
    });
    const driver = { requiredPluginIds: async () => [], runHost, runPlugin: async () => "complete" as const };
    const work = configureAgentLifecycle(db, driver); workers.push(work);
    const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Retry fixture", adapterType: "process", adapterConfig: { command: "missing-command" } });
    await work.process(agent.id);
    if (code === "harness_test_failed") {
      for (let retry = 0; retry < 2; retry++) {
        expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
        await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
        await work.process(agent.id);
      }
    }
    return { agent: await current(agent.id), work, driver, runHost };
  }

  it("persists a failed test across worker restarts without scanning, claiming, or probing it again", async () => {
    const { agent, work, driver, runHost } = await failed();
    expect(agent).toMatchObject({ lifecycleState: "verifying", status: "paused", lifecycleOperation: { retryRequired: true } });
    expect(agent.lifecycleOperation).not.toHaveProperty("retryAt");
    expect(agent.lifecycleOperation).not.toHaveProperty("leaseOwner");
    expect(agent.lifecycleError).toContain("Automatic verification is paused");
    expect(agent.lifecycleError).not.toContain("private provider detail");
    await work.stop();
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), driver, () => true); workers.push(restarted);
    const calls = runHost.mock.calls.length;
    expect(await restarted.hasPending()).toBe(false);
    expect(restarted.nextRunAt()).toBeNull();
    await restarted.sweep();
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await store.pending(100, tomorrow)).not.toContain(agent.id);
    expect(await store.claim(agent.id, "new-owner", tomorrow)).toBeNull();
    await work.process(agent.id);
    expect(runHost).toHaveBeenCalledTimes(calls);
    expect((await current(agent.id)).lifecycleOperation).toEqual(agent.lifecycleOperation);
  });

  it("permits an explicit retry of the same operation and completes verification before readiness", async () => {
    const { agent, work, runHost } = await failed();
    runHost.mockResolvedValue("complete");
    await createAgentLifecycle(db).retry(agent.id);
    expect((await current(agent.id)).lifecycleOperation).not.toHaveProperty("retryRequired");
    expect((await current(agent.id)).lifecycleOperation!.id).toBe(agent.lifecycleOperation!.id);
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle", lifecycleError: null });
  });

  it("recovers from a generic failed test before the automatic retry budget is exhausted", async () => {
    const { agent, work, runHost } = await failed("harness_probe_timed_out");
    runHost.mockRejectedValueOnce(Object.assign(new Error("temporary test failure"), { code: "harness_test_failed" }));
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
    runHost.mockResolvedValue("complete");
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("rechecks changed execution configuration but leaves a name edit waiting", async () => {
    const { agent, work, runHost } = await failed();
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.updateConfiguration(agent.id, { name: "Renamed fixture" });
    expect((await current(agent.id)).lifecycleOperation!.retryRequired).toBe(true);
    runHost.mockResolvedValue("complete");
    await lifecycle.updateConfiguration(agent.id, { adapterConfig: { command: process.execPath } });
    const changed = await current(agent.id);
    expect(changed.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(changed.lifecycleOperation!.id).not.toBe(agent.lifecycleOperation!.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("does not let a stale verification failure park newly saved configuration", async () => {
    const { agent, work } = await failed("harness_auth_failed");
    await work.stop();
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    await store.change(agent.id, "retry");
    const claimed = await store.claim(agent.id, "old-verification", new Date());
    expect(claimed).not.toBeNull();
    await createAgentLifecycle(db).updateConfiguration(agent.id, { adapterConfig: { command: process.execPath } });
    expect(await store.defer(claimed!, "old-verification", "Old failure", new Date(), { retryRequired: true })).toBe(false);
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
  });

  it.each(["harness_probe_timed_out", "test_environment_unavailable", "ECONNRESET", "unclassified"])("keeps automatic recovery for %s", async code => {
    const { agent } = await failed(code);
    expect(agent.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(Date.parse(agent.lifecycleOperation!.retryAt!)).toBeGreaterThan(Date.now());
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    expect(await store.pending(100, new Date(Date.now() + 120_000))).toContain(agent.id);
    expect(await store.claim(agent.id, "automatic-retry", new Date(Date.now() + 120_000))).not.toBeNull();
  });

  it("still completes termination and cleanup when verification needs repair", async () => {
    const { agent, work, runHost } = await failed();
    runHost.mockResolvedValue("complete");
    await createAgentLifecycle(db).terminateAgent(agent.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
    expect(runHost.mock.calls.map(([a]) => a.lifecycleState)).toContain("cleaning_up");
  });
});
