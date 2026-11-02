import { pluginIdleManifestGeneration } from "../services/plugin-idle-catalog.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, plugins, pluginJobs, pluginJobRuns, providerTraceRecords,
  applyPendingMigrations, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { readIdleDeadlineProof } from "../services/idle-deadline-proof.js";
import type { VerifiedIdleCapabilities } from "../services/idle-incoming-wake-capability.js";
import { claimDueTimerHeartbeatForAgent } from "../services/heartbeat/queue.js";
import { pluginJobStore } from "../services/plugin-job-store.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_IDLE_DEADLINE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable domain deadline snapshot with PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("idle-domain-deadlines-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it("reconstructs timers and plugin schedules, preserves actual claims, and retains capture/cleanup debt", async () => {
    const now = Date.now(), companyId = randomUUID(), agentId = randomUUID(), pluginId = randomUUID(), runId = randomUUID();
    const hold = { ownerId: randomUUID(), expiresAt: now + 300_000 };
    const capability = { deadlineCatalog: "domain_deadlines_v1" } as VerifiedIdleCapabilities;
    const read = (quietPluginIds: string[] = []) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      return readIdleDeadlineProof(tx, hold, { now, verifiedCapability: capability, quietPluginIds,
        ...(quietPluginIds.length ? { quietPluginGeneration: "fixture-running-worker", quietPluginCatalog: await tx.select().from(plugins).where(eq(plugins.id, pluginId)).then(rows => rows.map(plugin => ({ pluginId: plugin.id, manifestGeneration: pluginIdleManifestGeneration(plugin.manifestJson) }))) } : {}) });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await db.insert(companies).values({ id: companyId, name: "Deadline fixture", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Timer", role: "engineer", status: "idle", adapterType: "codex_local",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } }, createdAt: new Date(now), lastHeartbeatAt: new Date(now) });
    const initial = await read();
    expect(initial.blocked).toBe(false);
    expect(initial.scheduledWake?.nextWakeAt).toBe(new Date(now + 600_000).toISOString());
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].lastHeartbeatAt?.getTime()).toBe(now);
    // A new database client reconstructs the obligation without any scheduler cache.
    await db.$client.end({ timeout: 1 });
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    expect((await read()).scheduledWake).toEqual(initial.scheduledWake);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 450 } } }).where(eq(agents.id, agentId));
    const earlier = await read();
    expect(earlier.generation).not.toBe(initial.generation);
    expect(earlier.scheduledWake?.nextWakeAt).toBe(new Date(now + 450_000).toISOString());
    await db.update(agents).set({ lastHeartbeatAt: new Date(now - 600_000) }).where(eq(agents.id, agentId));
    expect((await read()).blocked).toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const claimed = await Promise.all([claimDueTimerHeartbeatForAgent(db, agent, new Date(now), 450), claimDueTimerHeartbeatForAgent(db, agent, new Date(now), 450)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect((await read()).scheduledWake?.nextWakeAt).toBe(new Date(now + 450_000).toISOString());
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "timer",
      startedAt: new Date(now - 1000), finishedAt: new Date(now), costAccountingPending: false });
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 450, maxDailyRuns: 1 } } }).where(eq(agents.id, agentId));
    const date = new Date(now);
    expect((await read()).scheduledWake?.nextWakeAt).toBe(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString());
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 450, skipTimerWhenNoActionableWork: true } } }).where(eq(agents.id, agentId));
    expect((await read()).scheduledWake).toBeUndefined();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: "true", intervalSec: 450 } } }).where(eq(agents.id, agentId));
    expect((await read()).blocked).toBe(true);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false } } }).where(eq(agents.id, agentId));
    expect((await read()).scheduledWake).toBeUndefined();

    await db.insert(plugins).values({ id: pluginId, pluginKey: `deadline-${pluginId}`, packageName: "fixture-plugin", version: "1.0.0", status: "ready",
      manifestJson: { id: `deadline-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Fixture", description: "Deadline fixture", author: "Test", categories: [], capabilities: ["jobs.schedule"],
        entrypoints: { worker: "worker.js" }, jobs: [{ jobKey: "hourly", displayName: "Hourly", schedule: "0 * * * *" }] } });
    const store = pluginJobStore(db);
    await store.syncJobDeclarations(pluginId, [{ jobKey: "hourly", displayName: "Hourly", schedule: "0 * * * *" }]);
    const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect((await read([pluginId])).blocked).toBe(true); // startup has not initialized the schedule
    await store.updateRunTimestamps(job.id, new Date(now - 3_600_000), new Date(now + 900_000));
    expect((await read()).blocked).toBe(true); // missing current quiet worker
    expect((await read([pluginId])).scheduledWake?.nextWakeAt).toBe(new Date(now + 900_000).toISOString());
    const pending = await store.createRun({ jobId: job.id, pluginId, trigger: "schedule" });
    expect((await read([pluginId])).blocked).toBe(true);
    await store.completeRun(pending.id, { status: "succeeded", durationMs: 1 });
    expect((await read([pluginId])).blocked).toBe(false);
    await db.update(pluginJobs).set({ status: "paused" }).where(eq(pluginJobs.id, job.id));
    expect((await read()).scheduledWake).toBeUndefined();


    const traceId = randomUUID();
    await db.insert(providerTraceRecords).values({ id: traceId, companyId, runId, provider: "fixture", requestedBy: "fixture", status: "complete",
      traceRef: `${randomUUID()}.ndjson`, expiresAt: new Date(now + 86_400_000) });
    expect((await read()).scheduledWake?.nextWakeAt).toBe(new Date(now + 86_400_000).toISOString());
    await db.update(providerTraceRecords).set({ status: "capturing" }).where(eq(providerTraceRecords.id, traceId));
    expect((await read()).blocked).toBe(true);
    await db.update(providerTraceRecords).set({ status: "deleted", deletedAt: new Date(now), traceRef: `s3-segments-v1:${companyId}/${runId}/${randomUUID()}.ndjson` }).where(eq(providerTraceRecords.id, traceId));
    expect((await read()).blocked).toBe(true);
    // The completed deletion receipt is the existing owner marker, not terminal UI status.
    await db.update(providerTraceRecords).set({ traceRef: "00000000-0000-0000-0000-000000000000.ndjson" }).where(eq(providerTraceRecords.id, traceId));
    expect((await read()).blocked).toBe(false);
    expect(await db.select().from(providerTraceRecords).where(eq(providerTraceRecords.id, traceId))).toHaveLength(1);
    // Fixture rows stay retained for receipt inspection; root drops only the owned test DB after closing all clients.
    expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, pending.id))).toHaveLength(1);
  }, 30_000);
});
