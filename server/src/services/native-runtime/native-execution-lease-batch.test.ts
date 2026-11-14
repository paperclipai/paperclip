import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, closeLivenessDb, companies, createDb, heartbeatRuns, issues, livenessDb, nativeRunFinalizations,
} from "@paperclipai/db";
import {
  renewNativeExecutionLeasesNow, startNativeSessionExecutionLeaseRenewal, type NativeExecutionLeaseRenewal,
} from "./native-execution-lease.js";
import { REMOTE_CONTROLLER_LEASE_MS } from "./native-runner-recovery-contract.js";
import { meterDatabaseStatements } from "../../__tests__/helpers/database-statement-meter.js";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping batched native lease renewal tests: ${support.reason ?? "unsupported environment"}`);

const controller = { bootId: `boot-${randomUUID()}`, pid: 5151, processStartedAt: new Date("2026-11-13T08:00:00.000Z") };

/**
 * One server process renews the native execution leases of all its runs in
 * one shared transaction per tick, on the private two-connection liveness pool.
 */
describeEmbeddedPostgres("batched native execution lease renewal", () => {
  let db!: ReturnType<typeof createDb>;
  let owner!: ReturnType<typeof createDb>;
  let meter!: ReturnType<typeof meterDatabaseStatements>;
  let connectionString!: string;
  let stopDatabase: (() => Promise<void>) | undefined;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-native-lease-batch-");
    stopDatabase = started.cleanup;
    connectionString = started.connectionString;
    db = createDb(connectionString);
    owner = createDb(connectionString);
    meter = meterDatabaseStatements(livenessDb(owner), connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease batch", issuePrefix: "LBT",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: {}, permissions: {} });
  }, 120_000);

  afterAll(async () => {
    if (owner) await closeLivenessDb(owner, 1).catch(() => undefined);
    await owner?.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await stopDatabase?.();
  });

  type Seeded = { runId: string; issueId: string; leaseOwner: string };

  async function seedRuns(count: number, leaseMs = 30_000): Promise<Seeded[]> {
    const runs = Array.from({ length: count }, () => ({ runId: randomUUID(), issueId: randomUUID(),
      leaseOwner: `runner:${randomUUID()}` }));
    await db.insert(issues).values(runs.map(run => ({ id: run.issueId, companyId, identifier: `LBT-${run.runId.slice(0, 8)}`,
      title: "batch", status: "in_progress", priority: "medium", workMode: "standard", assigneeAgentId: agentId })));
    await db.insert(heartbeatRuns).values(runs.map(run => ({ id: run.runId, companyId, agentId, status: "running",
      runtimeMode: "native", nativeIssueId: run.issueId, invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: run.issueId } })));
    await db.insert(nativeRunFinalizations).values(runs.map(run => ({ runId: run.runId, companyId, issueId: run.issueId,
      phase: "observed", attempt: 1, leaseOwner: run.leaseOwner,
      leaseExpiresAt: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
      controllerBootId: controller.bootId, controllerPid: controller.pid,
      controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 })));
    return runs;
  }

  function start(run: Seeded, overrides: { remote?: boolean; controllerGeneration?: number } = {}) {
    const onLost = vi.fn(async () => undefined);
    const guard = startNativeSessionExecutionLeaseRenewal({ db: owner, companyId, ...run, attempt: 1, controller,
      remote: overrides.remote ?? true, controllerGeneration: overrides.controllerGeneration,
      confirmedDeadline: performance.now() + 25_000, onLost });
    return { run, guard, onLost };
  }

  async function expiries(runIds: string[]) {
    const rows = await db.select({ runId: nativeRunFinalizations.runId, expiresAt: nativeRunFinalizations.leaseExpiresAt,
      leaseOwner: nativeRunFinalizations.leaseOwner })
      .from(nativeRunFinalizations).where(inArray(nativeRunFinalizations.runId, runIds));
    return new Map(rows.map(row => [row.runId, row]));
  }

  async function stopAll(guards: NativeExecutionLeaseRenewal[]) {
    await Promise.all(guards.map(guard => guard.stop().catch(() => undefined)));
  }

  async function renewCost(count: number) {
    const runs = await seedRuns(count);
    const started = runs.map(run => start(run));
    try {
      // Warm the pool so connection setup is not counted.
      await renewNativeExecutionLeasesNow(owner);
      const before = meter.read();
      await renewNativeExecutionLeasesNow(owner);
      const after = meter.read();
      for (const { guard, onLost } of started) {
        expect(onLost).not.toHaveBeenCalled();
        expect(guard.remainingMs()).toBeGreaterThan(REMOTE_CONTROLLER_LEASE_MS - 5_000);
      }
      const saved = await expiries(runs.map(run => run.runId));
      for (const run of runs) expect(saved.get(run.runId)!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
      return { transactions: after.transactions - before.transactions, statements: after.statements - before.statements };
    } finally {
      await stopAll(started.map(item => item.guard));
    }
  }

  it("renews every lease of the process in one transaction whose size does not grow with the run count", async () => {
    const few = await renewCost(3);
    const many = await renewCost(60);
    expect(few.transactions).toBe(1);
    expect(many.transactions).toBe(1);
    expect(many.statements).toBe(few.statements);
  }, 60_000);

  it("splits a very large tick into bounded transactions", async () => {
    const cost = await renewCost(450);
    expect(cost.transactions).toBe(3);
  }, 120_000);

  it("fails only the runs whose lease is no longer theirs and renews the rest", async () => {
    const runs = await seedRuns(6);
    const [healthy, other, takenOver, newAttempt, otherBoot, expired] = runs;
    await db.update(nativeRunFinalizations).set({ leaseOwner: `native-finalizer:${randomUUID()}` })
      .where(eq(nativeRunFinalizations.runId, takenOver!.runId));
    await db.update(nativeRunFinalizations).set({ attempt: 2 }).where(eq(nativeRunFinalizations.runId, newAttempt!.runId));
    await db.update(nativeRunFinalizations).set({ controllerBootId: `boot-${randomUUID()}` })
      .where(eq(nativeRunFinalizations.runId, otherBoot!.runId));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(nativeRunFinalizations.runId, expired!.runId));
    const before = await expiries(runs.map(run => run.runId));
    const started = runs.map(run => start(run));
    try {
      await renewNativeExecutionLeasesNow(owner);
      // A newer attempt under the same owner is the owner's own executor
      // moving on: not extended and not lost, as for a single renewal.
      const [ok, ok2, takenOverRenewal, advanced, otherBootRenewal, expiredRenewal] = started;
      const lost = [takenOverRenewal!, otherBootRenewal!, expiredRenewal!];
      expect(advanced!.onLost).not.toHaveBeenCalled();
      for (const item of [ok!, ok2!]) {
        expect(item.onLost).not.toHaveBeenCalled();
        await expect(item.guard.stop()).resolves.toBeUndefined();
      }
      for (const item of lost) {
        await vi.waitFor(() => expect(item.onLost).toHaveBeenCalledTimes(1));
        await expect(item.guard.stop()).rejects.toThrow("native_session_lease_lost");
      }
      const after = await expiries(runs.map(run => run.runId));
      for (const run of [healthy!, other!]) {
        expect(after.get(run.runId)!.expiresAt!.getTime()).toBeGreaterThan(before.get(run.runId)!.expiresAt!.getTime());
      }
      // Nothing the batch could not extend was written, and the expired owner stays expired.
      for (const run of [takenOver!, newAttempt!, otherBoot!, expired!]) expect(after.get(run.runId)).toEqual(before.get(run.runId));
    } finally {
      await stopAll(started.map(item => item.guard));
    }
  }, 60_000);

  it("never revives an owner that expired while another writer held its row, and does not wait for that row", async () => {
    const [contended, healthy] = await seedRuns(2, 1_500);
    // Another actor (for example restart recovery) holds the coordinator row
    // from before the lease expires until after it expired, then commits.
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${contended!.runId} for update`);
      locked();
      await held;
    });
    await acquired;
    const contendedRenewal = start(contended!);
    const healthyRenewal = start(healthy!);
    try {
      const renewing = renewNativeExecutionLeasesNow(owner);
      // The busy row does not hold up the rest of the batch.
      await vi.waitFor(async () => expect((await expiries([healthy!.runId])).get(healthy!.runId)!.expiresAt!.getTime())
        .toBeGreaterThan(Date.now() + 50_000), { timeout: 5_000 });
      await new Promise(resolve => setTimeout(resolve, 2_000));
      expect((await expiries([contended!.runId])).get(contended!.runId)!.expiresAt!.getTime()).toBeLessThan(Date.now());
      release();
      await writer;
      await renewing;
      await vi.waitFor(() => expect(contendedRenewal.onLost).toHaveBeenCalledTimes(1));
      await expect(contendedRenewal.guard.stop()).rejects.toThrow("native_session_lease_lost");
      expect((await expiries([contended!.runId])).get(contended!.runId)!.expiresAt!.getTime()).toBeLessThan(Date.now());
      expect(healthyRenewal.onLost).not.toHaveBeenCalled();
    } finally {
      release();
      await writer.catch(() => undefined);
      await stopAll([contendedRenewal.guard, healthyRenewal.guard]);
    }
  }, 60_000);

  it("never revives an owner whose row a takeover rewrote while the batch waited", async () => {
    const [run] = await seedRuns(1, 60_000);
    const renewal = start(run!);
    // A takeover commits between the batch's statements on another connection;
    // the batch locks the row and reads its committed owner, so it extends nothing.
    await db.update(nativeRunFinalizations).set({ leaseOwner: `native-cleanup:${randomUUID()}`,
      leaseExpiresAt: sql`clock_timestamp() + interval '5 minutes'` }).where(eq(nativeRunFinalizations.runId, run!.runId));
    const before = await expiries([run!.runId]);
    try {
      await renewNativeExecutionLeasesNow(owner);
      await vi.waitFor(() => expect(renewal.onLost).toHaveBeenCalledTimes(1));
      expect(await expiries([run!.runId])).toEqual(before);
    } finally {
      await renewal.guard.stop().catch(() => undefined);
    }
  }, 60_000);

  it("confines a binding that makes the shared statement fail to its own run", async () => {
    const runs = await seedRuns(5);
    const before = await expiries(runs.map(run => run.runId));
    const healthy = runs.slice(1).map(run => start(run));
    // An attempt outside the integer range: PostgreSQL rejects the whole
    // shared UPDATE (22003) for every run in it.
    const poison = { run: runs[0]!, onLost: vi.fn(async () => undefined), guard: startNativeSessionExecutionLeaseRenewal({
      db: owner, companyId, ...runs[0]!, attempt: 2 ** 40, controller, remote: true,
      confirmedDeadline: performance.now() + 25_000, onLost: async () => { await poison.onLost(); } }) };
    try {
      await renewNativeExecutionLeasesNow(owner);
      const after = await expiries(runs.map(run => run.runId));
      for (const { run, onLost, guard } of healthy) {
        expect(onLost).not.toHaveBeenCalled();
        expect(after.get(run.runId)!.expiresAt!.getTime()).toBeGreaterThan(before.get(run.runId)!.expiresAt!.getTime());
        expect(guard.remainingMs()).toBeGreaterThan(REMOTE_CONTROLLER_LEASE_MS - 5_000);
      }
      expect(after.get(poison.run.runId)).toEqual(before.get(poison.run.runId));
      // The healthy runs go back to one shared transaction; nothing is stuck busy.
      const cost = meter.read();
      await renewNativeExecutionLeasesNow(owner);
      const healthyCost = meter.read();
      expect(healthyCost.transactions - cost.transactions).toBe(1);
      for (const { onLost } of healthy) expect(onLost).not.toHaveBeenCalled();
      // Only the bad binding's own run is lost.
      await vi.waitFor(() => expect(poison.onLost).toHaveBeenCalledTimes(1));
    } finally {
      await stopAll([...healthy.map(item => item.guard), poison.guard]);
    }
  }, 60_000);

  it("handles an error thrown while the shared statement is built and leaves no lease busy", async () => {
    const runs = await seedRuns(3);
    const healthy = runs.slice(1).map(run => start(run));
    const onLost = vi.fn(async () => undefined);
    // An invalid date throws in toISOString() while the VALUES list is built.
    const broken = startNativeSessionExecutionLeaseRenewal({ db: owner, companyId, ...runs[0]!, attempt: 1,
      controller: { ...controller, processStartedAt: new Date(Number.NaN) }, remote: true,
      confirmedDeadline: performance.now() + 25_000, onLost });
    try {
      await renewNativeExecutionLeasesNow(owner);
      const after = await expiries(runs.map(run => run.runId));
      for (const { run, onLost: healthyLost } of healthy) {
        expect(healthyLost).not.toHaveBeenCalled();
        expect(after.get(run.runId)!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
      }
      // Every lease settled: a second call renews again instead of finding them busy.
      const before = meter.read();
      await renewNativeExecutionLeasesNow(owner);
      expect(meter.read().transactions - before.transactions).toBe(1);
      for (const { guard } of healthy) expect(guard.remainingMs()).toBeGreaterThan(REMOTE_CONTROLLER_LEASE_MS - 5_000);
      await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1));
    } finally {
      await stopAll([...healthy.map(item => item.guard), broken]);
    }
  }, 60_000);

  it("renews local and remote leases together, each for its own lease length", async () => {
    const [remote, local] = await seedRuns(2);
    const started = [start(remote!), start(local!, { remote: false, controllerGeneration: 1 })];
    try {
      const before = meter.read();
      await renewNativeExecutionLeasesNow(owner);
      expect(meter.read().transactions - before.transactions).toBe(1);
      const saved = await expiries([remote!.runId, local!.runId]);
      expect(saved.get(remote!.runId)!.expiresAt!.getTime()).toBeLessThan(Date.now() + 2 * 60_000);
      expect(saved.get(local!.runId)!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
      expect(started[1]!.guard.remainingMs()).toBeGreaterThan(15 * 60_000);
    } finally {
      await stopAll(started.map(item => item.guard));
    }
  }, 60_000);
});
