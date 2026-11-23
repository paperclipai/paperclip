import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, controllerInstanceLeaseDb, controllerInstances, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  RENEW_STATEMENT_TIMEOUT_MS, controllerInstanceLeaseEnabled, proveControllerInstance, registerControllerInstanceDb, registerControllerInstanceLeaseWork,
  resetControllerInstanceLeaseForTests, stopControllerInstanceLease, tickControllerInstanceLease,
} from "../services/controller-instance-lease.js";
import { currentControllerBootId, currentControllerProcessStamp, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../services/environment-lease-controller.js";
import { proveOwnerGone, type LocalOwnerStamp } from "../services/owner-proof.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { beginIdleTrackedWork, readTaskDrain } from "../services/task-admission.js";
import { currentNativeControllerIdentity, evaluateNativeControllerTakeover } from "../services/native-runtime/native-restart-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("controller instance lease: a replaced container's records are provable", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-controller-instance-lease-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "CIL", requireBoardApprovalForNewAgents: false });
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetControllerInstanceLeaseForTests();
    await db.delete(environmentLeases);
    await db.delete(controllerInstances);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  const coordinator = { register: () => ({ ready: Promise.resolve(), wake: vi.fn(), stop: async () => {} }) } as unknown as
    ReturnType<typeof createDeliveryWorkCoordinator>;

  /** A server boot in another container: its own PID space, no platform deployment identity. */
  async function otherBoot(lease: { expiredMsAgo?: number; liveForMs?: number; epoch?: number } = {}) {
    const bootId = `boot-${randomUUID()}`;
    const expires = lease.liveForMs !== undefined ? sql`now() + ${`${lease.liveForMs} milliseconds`}::interval`
      : sql`now() - ${`${lease.expiredMsAgo ?? 120_000} milliseconds`}::interval`;
    await db.insert(controllerInstances).values({ bootId, processSpace: "old-container", pid: 7, leaseExpiresAt: expires,
      ...(lease.epoch !== undefined ? { epoch: lease.epoch } : {}) });
    return bootId;
  }

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const stampOf = (bootId: string, extra: Partial<LocalOwnerStamp> = {}): LocalOwnerStamp => ({
    kind: "local", scope: "test", generation: null, host: null, processSpace: "old-container", bootId, pid: 7,
    processStartedAt: null, processGroupId: null, touchedAt: minutesAgo(10), ...extra });

  /** Registers this boot's lease; a stamp plus one tick creates its row and epoch. */
  async function startHere(options: Parameters<typeof registerControllerInstanceLeaseWork>[2] = {}, stamp = true) {
    registerControllerInstanceDb(db);
    const lost = vi.fn();
    registerControllerInstanceLeaseWork(db, coordinator, { onLost: lost, ...options });
    if (stamp) { currentControllerProcessStamp(); await tickControllerInstanceLease(); }
    const [row] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, currentControllerBootId()));
    return { lost, epoch: row?.epoch ?? null };
  }

  it("proves a replaced container's records gone by fencing its boot, with no Railway environment", async () => {
    for (const key of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_DEPLOYMENT_ID"]) vi.stubEnv(key, "");
    expect(controllerInstanceLeaseEnabled()).toBe(true);
    const replaced = await otherBoot({ expiredMsAgo: 120_000 });
    const another = await otherBoot({ expiredMsAgo: 120_000 });
    const { epoch } = await startHere();
    expect(await proveOwnerGone(stampOf(replaced))).toEqual({ verdict: "gone", reason: "controller_fenced" });
    const [row] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, replaced));
    expect(row).toMatchObject({ fencedByEpoch: epoch });

    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null, status: "active",
      leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `sandbox://fake/${leaseId}`, updatedAt: new Date(minutesAgo(10)),
      metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: { bootId: another, pid: 7, hostHash: "old-container", processStartedAt: null } } });
    const first = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(first.kinds.find(kind => kind.kind === "environment_login_probe_lease")).toMatchObject({
      settled: 1, reasons: { controller_fenced: 1 } });
    const second = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(second.kinds.find(kind => kind.kind === "environment_login_probe_lease")).toMatchObject({ settled: 0 });
  });

  it("treats a live lease as alive", async () => {
    const live = await otherBoot({ liveForMs: 60_000 });
    registerControllerInstanceDb(db);
    expect(await proveOwnerGone(stampOf(live))).toEqual({ verdict: "alive", reason: "controller_lease_held" });
  });

  it("tracks native preparation before a runner exists and proves a fenced foreign controller", async () => {
    const replaced = await otherBoot({ expiredMsAgo: 600_000 });
    await startHere({}, false);
    const owner = await currentNativeControllerIdentity();
    await tickControllerInstanceLease();
    expect(await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, owner.bootId))).toEqual([]);
    currentControllerProcessStamp();
    await tickControllerInstanceLease();
    expect(await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, owner.bootId))).toHaveLength(1);
    const decision = await evaluateNativeControllerTakeover({ now: new Date(), owner: {
      controllerBootId: replaced, controllerPid: 7, controllerHostHash: "old-container",
      controllerProcessStartedAt: new Date(minutesAgo(15)), updatedAt: new Date(minutesAgo(10)),
      leaseOwner: "old-preparation", leaseExpiresAt: new Date(minutesAgo(5)),
    }, isProcessAlive: () => { throw new Error("A foreign PID must not be inspected locally"); } });
    expect(decision).toEqual({ allowed: true, reason: "controller_fenced" });
    expect(await proveControllerInstance(db, replaced, null)).toBe("fenced");
  });

  it("keeps an owner alive (and watched) through the grace, and for work written after an idle lapse", async () => {
    const justExpired = await otherBoot({ expiredMsAgo: 5_000 });
    const resumed = await otherBoot({ expiredMsAgo: 600_000 });
    await startHere();
    expect(await proveOwnerGone(stampOf(justExpired))).toEqual({ verdict: "alive", reason: "controller_lease_grace" });
    expect(await proveOwnerGone(stampOf(resumed, { touchedAt: minutesAgo(1) }))).toEqual({ verdict: "alive", reason: "controller_lease_grace" });
    expect(await proveOwnerGone(stampOf(resumed, { touchedAt: null }))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
    for (const bootId of [justExpired, resumed]) expect(await proveControllerInstance(db, bootId, null)).toBe("expired");
  });

  it("never lets an older epoch fence a newer one", async () => {
    await startHere();
    const newer = await otherBoot({ expiredMsAgo: 600_000, epoch: 9_000_000 });
    expect(await proveOwnerGone(stampOf(newer))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
    expect(await proveControllerInstance(db, newer, null)).toBe("expired");
  });

  it("never fences without a lease row of its own: off, or not registered", async () => {
    const replaced = await otherBoot({ expiredMsAgo: 600_000 });
    registerControllerInstanceDb(db);
    expect(await proveOwnerGone(stampOf(replaced))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
    expect(await proveControllerInstance(db, replaced, null)).toBe("expired");
  });

  it("an idle prover creates its own row on demand, then fences", async () => {
    const replaced = await otherBoot({ expiredMsAgo: 600_000 });
    await startHere({}, false);
    expect(await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, currentControllerBootId()))).toEqual([]);
    expect(await proveOwnerGone(stampOf(replaced))).toEqual({ verdict: "gone", reason: "controller_fenced" });
    const [own] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, currentControllerBootId()));
    const [fenced] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, replaced));
    expect(fenced?.fencedByEpoch).toBe(own?.epoch);
  });

  it("never fences on a read-only pass", async () => {
    const replaced = await otherBoot({ expiredMsAgo: 600_000 });
    await startHere();
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null, status: "active",
      leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `sandbox://fake/${leaseId}`, updatedAt: new Date(minutesAgo(15)),
      metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: { bootId: replaced, pid: 7, hostHash: "old-container", processStartedAt: null } } });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.kinds.find(kind => kind.kind === "environment_login_probe_lease")).toMatchObject({ settled: 0 });
    expect(await proveControllerInstance(db, replaced, null)).toBe("expired");
  });

  it("keeps renewing while this boot holds a native finalizer lease", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
      await startHere();
      vi.setSystemTime(Date.now() + 120_000);
      const holder = { token: "token-1", bootId: currentControllerBootId(), pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null };
      const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Finalizer", adapterType: "codex_local", status: "idle" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Native task" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "on_demand", runtimeMode: "native", nativeIssueId: issueId, issueId });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
        leaseOwner: "token-1", leaseHolder: holder, leaseExpiresAt: new Date(Date.now() + 300_000) });
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      currentControllerProcessStamp(); vi.setSystemTime(Date.now() + 120_000);
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("live");
      await db.delete(nativeRunFinalizations);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
    } finally { vi.useRealTimers(); }
  });

  it("keeps renewing while this boot runs a remote workspace save", async () => {
    let now = 0;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
      await startHere({ now: () => now }, false);
      currentControllerProcessStamp();
      await tickControllerInstanceLease();
      now = 120_000;
      vi.setSystemTime(Date.now() + 120_000);
      const invocation = randomUUID();
      const owner = { bootId: currentControllerBootId(), pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null };
      await db.insert(workspaceOperations).values({ companyId, phase: "remote_workspace_snapshot", status: "running",
        metadata: { boundary: "final", epoch: 1, saveWork: { schema: "paperclip.remote-workspace-save-work.v1", activeIds: [invocation],
          unknown: false, quiescedAt: null, owners: { [invocation]: owner } } } });
      beginIdleTrackedWork()();
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("live");
      await db.delete(workspaceOperations);
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("expired");
    } finally { vi.useRealTimers(); }
  });

  it("keeps renewing while this boot runs a legacy run", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
      await startHere();
      vi.setSystemTime(Date.now() + 120_000);
      const agentId = randomUUID(), runId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Legacy", adapterType: "codex_local", status: "running" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "on_demand",
        runtimeMode: "legacy", controllerBootId: currentControllerBootId() });
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      currentControllerProcessStamp(); vi.setSystemTime(Date.now() + 120_000);
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("live");
      await db.delete(heartbeatRuns);
      await db.delete(agents);
    } finally { vi.useRealTimers(); }
  });

  it("renews on its own connection while the main pool is saturated (deploy overlap traffic switch)", async () => {
    // One main-pool connection, held by a slow statement: before the fix the renewal
    // waited behind it, timed out, and five such timeouts made a healthy server exit.
    const busy = createDb(temporary!.connectionString, { maxConnections: 1 });
    try {
      registerControllerInstanceDb(busy);
      const lost = vi.fn();
      registerControllerInstanceLeaseWork(busy, coordinator, { onLost: lost });
      currentControllerProcessStamp();
      await tickControllerInstanceLease();
      // Drizzle queries are lazy: attach a continuation so the statement starts now.
      const hold = busy.execute(sql`select pg_sleep(12)`).then(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 200));
      const [before] = await db.select({ renewedAt: controllerInstances.renewedAt }).from(controllerInstances)
        .where(eq(controllerInstances.bootId, currentControllerBootId()));
      currentControllerProcessStamp();
      const started = Date.now();
      await tickControllerInstanceLease();
      expect(Date.now() - started).toBeLessThan(5_000);
      const [after] = await db.select({ renewedAt: controllerInstances.renewedAt }).from(controllerInstances)
        .where(eq(controllerInstances.bootId, currentControllerBootId()));
      expect(after.renewedAt!.getTime()).toBeGreaterThan(before.renewedAt!.getTime());
      expect(lost).not.toHaveBeenCalled();
      await hold;
    } finally {
      await stopControllerInstanceLease(busy);
      await busy.$client.end({ timeout: 5 });
    }
  }, 30_000);

  it("has the server cancel a renewal blocked on a row lock, and renews on the same connection next time", async () => {
    // Five renewals failed 15 s apart: a client-timed-out statement kept running on the
    // single lease connection and every next renewal queued behind it.
    const lockDb = createDb(temporary!.connectionString, { maxConnections: 1 });
    // Resolving twice is harmless, so the normal path and the cleanup both release.
    let release: () => void = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let holder: Promise<unknown> = Promise.resolve();
    try {
      registerControllerInstanceDb(db);
      registerControllerInstanceLeaseWork(db, coordinator, { onLost: vi.fn() });
      currentControllerProcessStamp();
      await tickControllerInstanceLease();
      const lease = controllerInstanceLeaseDb(db);
      const backend = async () => (await lease.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>)[0]!.pid;
      const pidBefore = await backend();
      const [before] = await db.select({ renewedAt: controllerInstances.renewedAt }).from(controllerInstances)
        .where(eq(controllerInstances.bootId, currentControllerBootId()));
      let locked!: () => void;
      const lockTaken = new Promise<void>(resolve => { locked = resolve; });
      holder = lockDb.transaction(async tx => {
        await tx.execute(sql`select 1 from controller_instances where boot_id = ${currentControllerBootId()} for update`);
        locked();
        await released;
      });
      await lockTaken;
      currentControllerProcessStamp();
      const started = Date.now();
      await tickControllerInstanceLease();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(RENEW_STATEMENT_TIMEOUT_MS - 500);
      expect(elapsed).toBeLessThan(RENEW_STATEMENT_TIMEOUT_MS + 1_500);
      // Cancelled by the server, not left running behind the client timeout.
      const running = await db.execute(sql`select count(*)::int as count from pg_stat_activity
        where application_name = 'paperclip-controller-instance-lease' and state = 'active'`) as unknown as Array<{ count: number }>;
      expect(running[0]!.count).toBe(0);
      release();
      await holder;
      currentControllerProcessStamp();
      const next = Date.now();
      await tickControllerInstanceLease();
      expect(Date.now() - next).toBeLessThan(2_000);
      const [after] = await db.select({ renewedAt: controllerInstances.renewedAt }).from(controllerInstances)
        .where(eq(controllerInstances.bootId, currentControllerBootId()));
      expect(after.renewedAt!.getTime()).toBeGreaterThan(before.renewedAt!.getTime());
      expect(await backend()).toBe(pidBefore);
    } finally {
      // Free the controller row before the stop record writes it.
      release();
      await holder.catch(() => undefined);
      await stopControllerInstanceLease(db);
      await lockDb.$client.end({ timeout: 5 });
    }
  }, 40_000);

  it("proves a cleanly stopped boot gone at once", async () => {
    const stopped = await otherBoot({ liveForMs: 60_000 });
    await db.update(controllerInstances).set({ stoppedAt: sql`now()` }).where(eq(controllerInstances.bootId, stopped));
    registerControllerInstanceDb(db);
    expect(await proveOwnerGone(stampOf(stopped))).toEqual({ verdict: "gone", reason: "controller_stopped" });
  });

  it("keeps a record that names a process group unprovable: agent processes may outlive their server", async () => {
    const replaced = await otherBoot();
    await startHere();
    expect(await proveOwnerGone(stampOf(replaced, { processGroupId: 7 }))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
  });

  it("issues no statements while idle, and renews in one statement only while it holds stamped work", async () => {
    let now = 0;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
    await startHere({ now: () => now }, false);
    await tickControllerInstanceLease();
    expect(await db.select().from(controllerInstances)).toEqual([]);
    currentControllerProcessStamp();
    await tickControllerInstanceLease();
    const [created] = await db.select().from(controllerInstances);
    expect(created).toMatchObject({ bootId: currentControllerBootId(), processSpace: currentProcessSpaceHash() });
    // Past the stamp window, a record stamped with this boot still holds the lease.
    now = 120_000;
    vi.setSystemTime(Date.now() + 120_000);
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null, status: "active", leasePolicy: "ephemeral",
      metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: { bootId: currentControllerBootId(), pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null } } });
    await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
    await tickControllerInstanceLease();
    expect((await proveControllerInstance(db, currentControllerBootId(), null))).toBe("live");
    // Released, and the server's work settled (every stamped write committed): the next renewal
    // lets the lease lapse and the worker goes quiet.
    await db.delete(environmentLeases);
    beginIdleTrackedWork()();
    await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
    await tickControllerInstanceLease();
    expect((await proveControllerInstance(db, currentControllerBootId(), null))).toBe("expired");
    const renew = vi.fn();
    resetControllerInstanceLeaseForTests();
    registerControllerInstanceLeaseWork(db, coordinator, { renew });
    await tickControllerInstanceLease();
    expect(renew).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("re-checks holdings when other work settles, not on its own run's settle, at most every 5 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
      const wake = vi.fn();
      const capturing = { register: () => ({ ready: Promise.resolve(), wake, stop: async () => {} }) } as unknown as
        ReturnType<typeof createDeliveryWorkCoordinator>;
      registerControllerInstanceDb(db);
      registerControllerInstanceLeaseWork(db, capturing, { renew: async () => "holding" as const });
      currentControllerProcessStamp();
      expect(wake).toHaveBeenCalledTimes(1);
      await tickControllerInstanceLease();
      beginIdleTrackedWork()();
      expect(wake).toHaveBeenCalledTimes(1);
      beginIdleTrackedWork()();
      expect(wake).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 6_000);
      beginIdleTrackedWork()();
      expect(wake).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("never loses a stamp taken while a renewal is in flight", async () => {
    const wake = vi.fn();
    const capturing = { register: () => ({ ready: Promise.resolve(), wake, stop: async () => {} }) } as unknown as
      ReturnType<typeof createDeliveryWorkCoordinator>;
    registerControllerInstanceDb(db);
    registerControllerInstanceLeaseWork(db, capturing, { renew: async () => { currentControllerProcessStamp(); return "idle" as const; } });
    currentControllerProcessStamp();
    wake.mockClear();
    await tickControllerInstanceLease();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("counts a cleanup claim as held only while its attempt is in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
      await startHere();
      vi.setSystemTime(Date.now() + 60_000);
      const leaseId = randomUUID();
      const claim = { bootId: currentControllerBootId(), pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null };
      await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null, status: "pending_cleanup", leasePolicy: "ephemeral",
        metadata: { pendingCleanupController: claim, pendingCleanupInFlight: false } });
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      // A stamp whose record no renewal saw holds the lease until the 10-minute cap.
      currentControllerProcessStamp(); vi.setSystemTime(Date.now() + 120_000);
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("live");
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("expired");
      await db.update(environmentLeases).set({ metadata: { pendingCleanupController: claim, pendingCleanupInFlight: true } });
      currentControllerProcessStamp(); vi.setSystemTime(Date.now() + 120_000);
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("live");
    } finally { vi.useRealTimers(); }
  });

  it("holds an unobserved stamp only until the server's work settles", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
      await startHere();
      vi.setSystemTime(Date.now() + 120_000);
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("live");
      beginIdleTrackedWork()();
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("expired");
    } finally { vi.useRealTimers(); }
  });

  it("keeps a pending stamped write held when a renewal sees another held record", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    try {
      await startHere();
      const agentId = randomUUID(), runId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Legacy", adapterType: "codex_local", status: "running" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "on_demand",
        runtimeMode: "legacy", controllerBootId: currentControllerBootId() });
      // A second stamp whose ownership write has not committed yet.
      currentControllerProcessStamp();
      await tickControllerInstanceLease();
      // The other record finishes; the pending write is still uncommitted past the stamp window.
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      vi.setSystemTime(Date.now() + 120_000);
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("live");
      beginIdleTrackedWork()();
      await db.update(controllerInstances).set({ leaseExpiresAt: sql`now()` });
      await tickControllerInstanceLease();
      expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("expired");
    } finally { vi.useRealTimers(); }
  });

  it("rides out a 45 s database outage: quiesces dispatch, never exits, and resumes", async () => {
    let now = 0, down = true;
    const renew = vi.fn(async () => { if (down) throw new Error("connection refused"); return "holding" as const; });
    const { lost } = await startHere({ now: () => now, renew }, false);
    currentControllerProcessStamp();
    for (now = 0; now <= 45_000; now += 5_000) {
      await tickControllerInstanceLease();
      expect(readTaskDrain(new Date())).not.toBeNull();
    }
    down = false;
    await tickControllerInstanceLease();
    expect(lost).not.toHaveBeenCalled();
    expect(readTaskDrain(new Date())).toBeNull();
  });

  it("bounds a renewal that never answers, counting from the attempt's start", async () => {
    let now = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { lost } = await startHere({ now: () => now, renew: () => new Promise(() => {}) }, false);
      currentControllerProcessStamp();
      const attempt = tickControllerInstanceLease();
      now = 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      await attempt;
      expect(readTaskDrain(new Date())).not.toBeNull();
      for (now = 15_000; now <= 60_000; now += 5_000) {
        const next = tickControllerInstanceLease();
        await vi.advanceTimersByTimeAsync(10_000);
        await next;
      }
      expect(lost).toHaveBeenCalledWith("lease_lost");
    } finally { vi.useRealTimers(); }
  });

  it("stops after a 70 s outage while holding work, and the successor recovers its work exactly once", async () => {
    let now = 0;
    const { lost } = await startHere({ now: () => now, renew: async () => { throw new Error("down"); } }, false);
    currentControllerProcessStamp();
    for (now = 0; now <= 70_000 && !lost.mock.calls.length; now += 5_000) await tickControllerInstanceLease();
    expect(lost).toHaveBeenCalledWith("lease_lost");
    expect(now).toBeGreaterThanOrEqual(60_000);
    expect(now).toBeLessThanOrEqual(70_000);

    // The stopped boot as its successor sees it: lease expired long ago, work last written under it.
    resetControllerInstanceLeaseForTests();
    await db.insert(controllerInstances).values({ bootId: "exited-boot", processSpace: "old-container", pid: 7,
      leaseExpiresAt: sql`now() - interval '3 minutes'`, epoch: 1 });
    await startHere();
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null, status: "active",
      leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `sandbox://fake/${leaseId}`, updatedAt: new Date(minutesAgo(5)),
      metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: { bootId: "exited-boot", pid: 7, hostHash: "old-container", processStartedAt: null } } });
    const passes = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
      passes.push(report.kinds.find(kind => kind.kind === "environment_login_probe_lease")?.settled);
    }
    expect(passes).toEqual([1, 0]);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]).toMatchObject({ status: "pending_cleanup" });
  });

  it("stops at once when a newer boot fenced it", async () => {
    const { lost } = await startHere();
    await db.update(controllerInstances).set({ fencedAt: sql`now()` }).where(eq(controllerInstances.bootId, currentControllerBootId()));
    currentControllerProcessStamp();
    await tickControllerInstanceLease();
    expect(lost).toHaveBeenCalledWith("fenced");
  });

  it("records a graceful stop and keeps native preparation fencing on volume-exclusive deployments", async () => {
    await startHere();
    await stopControllerInstanceLease(db);
    expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("stopped");
    vi.stubEnv("PAPERCLIP_CONTROLLER_INSTANCE_LEASE", "off");
    expect(controllerInstanceLeaseEnabled()).toBe(false);
    vi.unstubAllEnvs();
    for (const [key, value] of [["RAILWAY_PROJECT_ID", "p"], ["RAILWAY_ENVIRONMENT_ID", "e"], ["RAILWAY_SERVICE_ID", "s"], ["RAILWAY_DEPLOYMENT_ID", "d"]]) {
      vi.stubEnv(key!, value!);
    }
    // A stateless Railway service has no deployment-replacement proof, so it keeps the lease.
    expect(controllerInstanceLeaseEnabled()).toBe(true);
    vi.stubEnv("RAILWAY_VOLUME_ID", "v");
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "/data");
    expect(controllerInstanceLeaseEnabled()).toBe(true);
    vi.stubEnv("PAPERCLIP_CONTROLLER_INSTANCE_LEASE", "on");
    expect(controllerInstanceLeaseEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});
