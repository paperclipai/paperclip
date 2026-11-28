import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, environmentLeases, environments } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { currentControllerProcess, currentControllerProcessStamp, currentProcessSpaceHash, readControllerProcess } from "../services/controller-process-identity.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../services/environment-lease-controller.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { settleEnvironmentLoginProbeLease } from "../services/environment-login-probe-lease-settlement.js";
import { heartbeatService } from "../services/heartbeat.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "environment_login_probe_lease";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

suite("environment_login_probe_lease on the shared ownership path", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let environmentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-login-probe-lease-ownership-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "LPL",
      requireBoardApprovalForNewAgents: false });
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04" } });
  }, 30_000);

  afterEach(async () => { vi.unstubAllEnvs(); await db.delete(environmentLeases); });
  afterAll(async () => { await temporary?.cleanup(); });

  async function lease(holder: Record<string, unknown> | null, providerLeaseId?: string) {
    const id = randomUUID();
    await db.insert(environmentLeases).values({ id, companyId, environmentId, heartbeatRunId: null, status: "active",
      leasePolicy: "ephemeral", provider: "fake", providerLeaseId: providerLeaseId ?? `sandbox://fake/${id}`,
      updatedAt: new Date(Date.now() - 60 * 60_000),
      metadata: holder ? { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: holder } : {} });
    return id;
  }
  async function row(id: string) {
    const [found] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, id));
    return found!;
  }
  async function deadHolder() {
    return { bootId: "earlier-boot", pid: await exitedPid(), hostHash: currentProcessSpaceHash(), processStartedAt: null };
  }
  const pass = (record = true) => runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record });

  it("moves a dead holder's lease to cleanup on the next pass, due at once", async () => {
    const leaseId = await lease(await deadHolder());
    const report = await pass();
    expect(report.kinds.find(kind => kind.kind === KIND)).toMatchObject({ settled: 1, reasons: { pid_dead: 1 } });
    const after = await row(leaseId);
    expect(after).toMatchObject({ status: "pending_cleanup", failureReason: "orphaned_active_lease_recovered" });
    expect(after.metadata?.recoveredRunlessLease).toEqual({ ownerProof: "pid_dead" });
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    expect(report.newViolations.filter(violation => violation.kind === KIND)).toEqual([]);
  });

  it("never takes a live holder's lease, however long it has been idle", async () => {
    const self = await currentControllerProcess();
    const alive = await lease({ ...self, bootId: "another-boot" });
    const mine = await lease(currentControllerProcessStamp());
    const foreign = await lease({ bootId: "other", pid: 1, hostHash: "another-pid-space", processStartedAt: null });
    const report = await pass();
    expect(report.kinds.find(kind => kind.kind === KIND)).toMatchObject({ settled: 0 });
    expect(await heartbeatService(db).sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 0 });
    for (const id of [alive, mine, foreign]) expect((await row(id)).status).toBe("active");
  });

  it("never settles on a read-only pass", async () => {
    const leaseId = await lease(await deadHolder());
    const report = await pass(false);
    expect(report.kinds.find(kind => kind.kind === KIND)).toMatchObject({ settled: 0, verdicts: { gone: 1 } });
    expect((await row(leaseId)).status).toBe("active");
  });

  it("does not settle a lease re-stamped by a new holder after the proof", async () => {
    const leaseId = await lease(await deadHolder());
    const { records } = await OWNABLE_KINDS.find(kind => kind.id === KIND)!.listInProgress!(db, 10, 0);
    const record = records.find(candidate => candidate.recordId === leaseId)!;
    await db.update(environmentLeases).set({ metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: currentControllerProcessStamp() } })
      .where(eq(environmentLeases.id, leaseId));
    expect(await settleEnvironmentLoginProbeLease(db, record, { now: new Date(), proof: { verdict: "gone", reason: "pid_dead" } }))
      .toEqual({ settled: false, reason: "owner_changed_since_proof" });
    expect((await row(leaseId)).status).toBe("active");
  });

  it("keeps a lease whose provider resource another live lease still holds", async () => {
    const shared = "sandbox://fake/shared";
    const orphan = await lease(await deadHolder(), shared);
    await lease(currentControllerProcessStamp(), shared);
    await pass();
    expect((await row(orphan)).status).toBe("active");
  });

  it("still recovers a legacy lease saved before holders were stamped, after the idle backoff", async () => {
    const legacy = await lease(null);
    const report = await pass();
    expect(report.kinds.find(kind => kind.kind === KIND)).toMatchObject({ settled: 0 });
    expect(await heartbeatService(db).sweepOrphanedActiveLeases({ backoffMs: 5 * 60_000 })).toEqual({ recovered: 1 });
    expect((await row(legacy)).status).toBe("pending_cleanup");
  });

  function railway(deploymentId: string) {
    vi.stubEnv("RAILWAY_PROJECT_ID", "project"); vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "production");
    vi.stubEnv("RAILWAY_SERVICE_ID", "server"); vi.stubEnv("RAILWAY_DEPLOYMENT_ID", deploymentId);
    vi.stubEnv("RAILWAY_VOLUME_ID", "volume"); vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "/data");
  }

  it("stamps the platform deployment so a redeploy can prove the old holder gone", async () => {
    railway("deployment-old");
    const stamp = currentControllerProcessStamp();
    expect(stamp.deployment).toEqual({ worker: { provider: "railway", projectId: "project", environmentId: "production",
      serviceId: "server", deploymentId: "deployment-old" }, exclusiveVolume: true, volumeId: "volume" });
    expect(readControllerProcess(JSON.parse(JSON.stringify(stamp)))).toEqual(stamp);
    const replaced = await lease({ ...stamp, bootId: "old-boot", hostHash: "old-container", pid: 7 });
    const sameDeployment = await lease({ ...stamp, bootId: "sibling-boot", hostHash: "sibling-container", pid: 8 });
    await db.update(environmentLeases).set({ metadata: { leaseController: { ...stamp, bootId: "sibling-boot", hostHash: "sibling-container", pid: 8,
      deployment: { ...stamp.deployment, worker: { ...stamp.deployment!.worker, deploymentId: "deployment-new" } } } } })
      .where(eq(environmentLeases.id, sameDeployment));
    railway("deployment-new");
    const report = await pass();
    expect(report.kinds.find(kind => kind.kind === KIND)).toMatchObject({ settled: 1,
      reasons: { deployment_replaced: 1, different_process_space: 1 } });
    expect((await row(replaced)).status).toBe("pending_cleanup");
    expect((await row(sameDeployment)).status).toBe("active");
  });
});
