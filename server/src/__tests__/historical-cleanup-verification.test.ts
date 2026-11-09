import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentCustomImageSetupSessions, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { historicalCleanupVerificationService } from "../services/historical-cleanup-verification.js";
import { withoutCleanupVerification } from "../services/cleanup-verification-proof.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const now = Date.UTC(2020, 0, 1), ownerId = randomUUID();
const owned = (): IdleSleepDrainStatus => ({ ownerId, draining: true, startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping historical cleanup database tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("historical cleanup verification", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("historical-cleanup-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { await db.execute(sql`SET client_min_messages = warning; TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const read = () => readIdleSleepSafety(db, owned, () => now, ownerId, async () => "none", undefined, undefined, true, true);
  const state = async () => (await read()).backgroundWork;
  async function seed(adHoc = false) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup fixture", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Idle fixture", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "failed", finishedAt: new Date(now) });
    const [environment] = await db.insert(environments).values({ name: "Remote fixture", driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
      heartbeatRunId: adHoc ? null : runId, status: "failed", leasePolicy: "ephemeral", provider: "daytona",
      providerLeaseId: randomUUID(), releasedAt: new Date(now), cleanupStatus: "success", metadata: { driver: "sandbox" } }).returning();
    return { companyId, runId, environment: environment!, lease: lease! };
  }
  function verifier(leaseState = "destroyed", setupState = "destroyed") {
    return historicalCleanupVerificationService(db, {
      inspectLease: async row => ({ providerLeaseId: row.providerLeaseId, state: leaseState }),
      inspectSetup: async row => ({ providerLeaseId: row.providerLeaseId, state: setupState }),
    });
  }
  it.each([false, true])("accepts exact deletion proof without changing outcomes or granting run authority (ad-hoc %s)", async adHoc => {
    const f = await seed(adHoc); expect(await state()).toBe("present");
    const service = verifier(); expect(await service.sweep()).toMatchObject({ checked: 1, verified: 1, failed: 0 });
    expect(await state()).toBe("none");
    const [current] = await db.select().from(environmentLeases);
    expect(current).toMatchObject({ status: "failed", cleanupStatus: "success", heartbeatRunId: adHoc ? null : f.runId });
    expect(current!.metadata).not.toHaveProperty("remoteExecutionTermination");
    expect(await service.sweep()).toMatchObject({ checked: 0, verified: 0 });
  });
  it.each(["active", "stopped", "unknown"])("retains %s allocations", async status => {
    await seed(); expect(await verifier(status).sweep()).toMatchObject({ verified: 0, deferred: 1 });
    expect(await state()).toBe("present");
  });
  it.each(["old_worker", "wrong_id", "provider_error"])("does not manufacture proof from %s", async mode => {
    await seed();
    const service = historicalCleanupVerificationService(db, { inspectSetup: async () => undefined,
      inspectLease: async () => { if (mode === "provider_error") throw new Error("private credential failure");
        return mode === "old_worker" ? undefined : { providerLeaseId: "wrong", state: "destroyed" }; } });
    expect((await service.sweep()).verified).toBe(0); expect(await state()).toBe("present");
  });
  it.each(["resume", "resource", "environment", "metadata", "run", "accounting", "retry"])("loses verification when %s changes during provider inspection", async change => {
    const f = await seed();
    const service = historicalCleanupVerificationService(db, { inspectSetup: async () => undefined, inspectLease: async row => {
      if (change === "resume") await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, row.id));
      if (change === "resource") await db.update(environmentLeases).set({ providerLeaseId: "replacement" }).where(eq(environmentLeases.id, row.id));
      if (change === "environment") await db.update(environmentLeases).set({ environmentId: null }).where(eq(environmentLeases.id, row.id));
      if (change === "metadata") await db.update(environmentLeases).set({ metadata: { driver: "sandbox", nativeWorkspaceExportResume: {} } }).where(eq(environmentLeases.id, row.id));
      if (["run", "accounting", "retry"].includes(change)) await db.update(heartbeatRuns).set(change === "run" ? { status: "running", finishedAt: null }
        : change === "accounting" ? { costAccountingPending: true } : { scheduledRetryAt: new Date(now + 1000) }).where(eq(heartbeatRuns.id, f.runId));
      return { providerLeaseId: row.providerLeaseId, state: "destroyed" };
    } });
    expect((await service.sweep()).verified).toBe(0); expect(await state()).toBe("present");
  });
  it.each(["retained", "pending_cleanup"])("does not inspect a resource with another %s owner", async status => {
    const f = await seed();
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id,
      provider: "daytona", providerLeaseId: f.lease.providerLeaseId, status });
    expect(await verifier().sweep()).toMatchObject({ checked: 0, verified: 0 });
    expect(await state()).toBe("present");
  });
  it("invalidates a previously accepted proof when the lease row changes", async () => {
    const f = await seed(); await verifier().sweep(); expect(await state()).toBe("none");
    await db.update(environmentLeases).set({ updatedAt: new Date(0) }).where(eq(environmentLeases.id, f.lease.id));
    expect(await state()).toBe("present");
  });
  it("keeps provider work tracked through the observation and coalesces concurrent sweeps", async () => {
    await seed(); let finish!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { finish = resolve; });
    const inspectLease = vi.fn(async (row: typeof environmentLeases.$inferSelect) => { entered(); await paused; return { providerLeaseId: row.providerLeaseId, state: "destroyed" }; });
    const service = historicalCleanupVerificationService(db, { inspectLease, inspectSetup: async () => undefined });
    const before = idleWorkSnapshot().active; const first = service.sweep(); const second = service.sweep();
    expect(first).toBe(second); await started; expect(idleWorkSnapshot().active).toBe(before + 1);
    expect(await state()).toBe("present"); finish(); await first;
    expect(inspectLease).toHaveBeenCalledTimes(1); expect(idleWorkSnapshot().active).toBe(before);
  });
  async function setup() {
    const f = await seed(); await db.delete(environmentLeases);
    const [row] = await db.insert(environmentCustomImageSetupSessions).values({ environmentId: f.environment.id,
      provider: "daytona", providerLeaseId: randomUUID(), status: "promoted", finishedAt: new Date(now), metadata: { setupRpcCompanyId: f.companyId } }).returning();
    return { ...f, setup: row! };
  }
  it("requires deletion proof for terminal image sessions and preserves their history", async () => {
    const f = await setup(); expect(await state()).toBe("present");
    expect(await verifier().sweep()).toMatchObject({ verified: 1 }); expect(await state()).toBe("none");
    expect((await db.select().from(environmentCustomImageSetupSessions))[0]).toMatchObject({ status: "promoted", providerLeaseId: f.setup.providerLeaseId });
  });
  it.each(["secret", "live", "provider", "scope"])("rejects image-session %s changes during inspection", async change => {
    await setup();
    const service = historicalCleanupVerificationService(db, { inspectLease: async () => undefined, inspectSetup: async row => {
      await db.update(environmentCustomImageSetupSessions).set(change === "secret" ? { connectionSecretRef: "secret://fixture" }
        : change === "live" ? { status: "waiting_for_user", finishedAt: null }
        : change === "provider" ? { provider: "other" } : { metadata: { setupRpcCompanyId: randomUUID() } }).where(eq(environmentCustomImageSetupSessions.id, row.id));
      return { providerLeaseId: row.providerLeaseId, state: "destroyed" };
    } });
    expect((await service.sweep()).verified).toBe(0); expect(await state()).toBe("present");
  });
  it("keeps image setup blocked when a retained lease owns the same allocation", async () => {
    const f = await setup(); await db.insert(environmentLeases).values({ companyId: f.companyId,
      environmentId: f.environment.id, provider: "daytona", providerLeaseId: f.setup.providerLeaseId, status: "retained" });
    expect(await verifier().sweep()).toMatchObject({ checked: 0 }); expect(await state()).toBe("present");
  });
});

it("removes host-owned cleanup evidence from provider metadata", () => {
  expect(withoutCleanupVerification({ paperclipCleanupVerification: { state: "destroyed" }, driver: "sandbox" })).toEqual({ driver: "sandbox" });
});
