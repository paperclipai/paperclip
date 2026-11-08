import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, controllerInstances, createDb, environmentLeases } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  controllerInstanceLeaseEnabled, proveControllerInstance, registerControllerInstanceDb, resetControllerInstanceLeaseForTests,
  startControllerInstanceLease, stopControllerInstanceLease, tickControllerInstanceLease,
} from "../services/controller-instance-lease.js";
import { currentControllerBootId, currentControllerProcessStamp } from "../services/controller-process-identity.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../services/environment-lease-controller.js";
import { proveOwnerGone, type LocalOwnerStamp } from "../services/owner-proof.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { readTaskDrain } from "../services/task-admission.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MANUAL = { renewEveryMs: 3_600_000, retryMs: 3_600_000 };

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

  async function startHere(options: Parameters<typeof startControllerInstanceLease>[1] = {}) {
    registerControllerInstanceDb(db);
    const lost = vi.fn();
    const started = await startControllerInstanceLease(db, { onLost: lost, ...MANUAL, ...options });
    return { lost, epoch: started.epoch };
  }

  it("proves a replaced container's records gone by fencing its expired boot, with no Railway environment", async () => {
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

  it("never fences inside the grace, for work touched after an idle lapse, or a newer epoch", async () => {
    const justExpired = await otherBoot({ expiredMsAgo: 5_000 });
    const resumed = await otherBoot({ expiredMsAgo: 600_000 });
    const newer = await otherBoot({ expiredMsAgo: 600_000, epoch: 9_000_000 });
    await startHere();
    expect(await proveOwnerGone(stampOf(justExpired))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
    expect(await proveOwnerGone(stampOf(resumed, { touchedAt: minutesAgo(1) }))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
    expect(await proveOwnerGone(stampOf(newer))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
    expect(await proveOwnerGone(stampOf(resumed, { touchedAt: null }))).toEqual({ verdict: "unprovable", reason: "different_process_space" });
    for (const bootId of [justExpired, resumed, newer]) expect(await proveControllerInstance(db, bootId, null)).toBe("expired");
  });

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

  it("lets the lease lapse while idle, with no query, and renews on the next stamp", async () => {
    let holding = false;
    const renew = vi.fn(async () => "renewed" as const);
    await startHere({ holdsWork: () => holding, renew });
    await tickControllerInstanceLease();
    expect(renew).not.toHaveBeenCalled();
    holding = true;
    currentControllerProcessStamp();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
  });

  it("rides out a 45 s database outage: quiesces dispatch, never exits, and resumes", async () => {
    let now = 0, down = true;
    const renew = vi.fn(async () => { if (down) throw new Error("connection refused"); return "renewed" as const; });
    const { lost } = await startHere({ now: () => now, holdsWork: () => true, renew });
    for (now = 0; now <= 45_000; now += 5_000) {
      await tickControllerInstanceLease();
      expect(readTaskDrain(new Date())).not.toBeNull();
    }
    down = false;
    await tickControllerInstanceLease();
    expect(lost).not.toHaveBeenCalled();
    expect(readTaskDrain(new Date())).toBeNull();
  });

  it("stops after a 70 s outage while holding work, and the successor recovers its work exactly once", async () => {
    let now = 0;
    const { lost } = await startHere({ now: () => now, holdsWork: () => true, renew: async () => { throw new Error("down"); } });
    for (now = 0; now <= 70_000 && !lost.mock.calls.length; now += 5_000) await tickControllerInstanceLease();
    expect(lost).toHaveBeenCalledWith("lease_lost");
    expect(now).toBeGreaterThanOrEqual(60_000);
    expect(now).toBeLessThanOrEqual(70_000);

    // The stopped boot, as its successor sees it: lease expired past the grace, work last touched under it.
    resetControllerInstanceLeaseForTests();
    await db.update(controllerInstances).set({ bootId: "exited-boot", processSpace: "old-container",
      leaseExpiresAt: sql`now() - interval '2 minutes'` }).where(eq(controllerInstances.bootId, currentControllerBootId()));
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

  it("does not stop after a long outage once it holds no work, and stops at once when fenced", async () => {
    let now = 0, holding = true;
    const { lost } = await startHere({ now: () => now, holdsWork: () => holding, renew: async () => { throw new Error("down"); } });
    await tickControllerInstanceLease();
    holding = false;
    for (now = 5_000; now <= 120_000; now += 5_000) await tickControllerInstanceLease();
    expect(lost).not.toHaveBeenCalled();

    resetControllerInstanceLeaseForTests();
    await db.delete(controllerInstances);
    const fenced = await startHere({ holdsWork: () => true });
    await db.update(controllerInstances).set({ fencedAt: sql`now()` }).where(eq(controllerInstances.bootId, currentControllerBootId()));
    await tickControllerInstanceLease();
    expect(fenced.lost).toHaveBeenCalledWith("fenced");
  });

  it("records a graceful stop, and is off on Railway or when disabled", async () => {
    await startHere();
    await stopControllerInstanceLease();
    expect(await proveControllerInstance(db, currentControllerBootId(), null)).toBe("stopped");
    vi.stubEnv("PAPERCLIP_CONTROLLER_INSTANCE_LEASE", "off");
    expect(controllerInstanceLeaseEnabled()).toBe(false);
    vi.unstubAllEnvs();
    for (const [key, value] of [["RAILWAY_PROJECT_ID", "p"], ["RAILWAY_ENVIRONMENT_ID", "e"], ["RAILWAY_SERVICE_ID", "s"], ["RAILWAY_DEPLOYMENT_ID", "d"]]) {
      vi.stubEnv(key!, value!);
    }
    expect(controllerInstanceLeaseEnabled()).toBe(false);
  });
});
