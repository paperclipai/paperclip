import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  currentControllerBootId,
  currentControllerProcess,
  currentControllerProcessStamp,
  currentProcessSpaceHash,
} from "../services/controller-process-identity.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../services/environment-lease-controller.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { settleEnvironmentRunLease } from "../services/environment-run-lease-settlement.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.js";
import { environmentService } from "../services/environments.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import {
  createOwnershipReportState,
  runOwnershipReconciliationPass,
  settleOwnableKind,
} from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

/** A PID in this PID space whose process has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

suite("environment_run_lease_active on the shared ownership path", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let sandboxEnvironmentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-environment-run-lease-ownership-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    sandboxEnvironmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "ERL",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: sandboxEnvironmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04" } });
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function run(status: string, extra: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "on_demand", status,
      nextEventSeq: 1, ...extra });
    return id;
  }

  /** The state a crash between the terminal run write and the lease release
   * leaves behind: a terminal run whose lease is still active. */
  async function lease(runId: string, holder: Record<string, unknown> | null, sandbox = false) {
    const id = randomUUID();
    await db.insert(environmentLeases).values({ id, companyId, heartbeatRunId: runId, status: "active",
      leasePolicy: "ephemeral",
      ...(sandbox ? { environmentId: sandboxEnvironmentId, provider: "fake", providerLeaseId: `sandbox://fake/${id}` } : {}),
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

  it("stamps the lease holder in the write that makes a lease active, with no extra I/O", async () => {
    const runId = await run("running");
    const acquired = await environmentService(db).acquireLease({ companyId, environmentId: sandboxEnvironmentId,
      heartbeatRunId: runId, provider: "fake", providerLeaseId: "sandbox://fake/stamped", metadata: { driver: "sandbox" } });
    expect(acquired.metadata?.[ENVIRONMENT_LEASE_CONTROLLER_KEY]).toEqual(currentControllerProcessStamp());
    expect(acquired.metadata?.driver).toBe("sandbox");
  });

  it("settles a lease whose holder died after the run went terminal, on the next pass", async () => {
    const runId = await run("failed");
    const leaseId = await lease(runId, await deadHolder());
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(report.kinds.find(kind => kind.kind === "environment_run_lease_active")).toMatchObject({
      settled: 1, reasons: { pid_dead: 1 } });
    expect(await row(leaseId)).toMatchObject({ status: "pending_cleanup", failureReason: "orphaned_active_lease_recovered" });
  });

  it("stops and keeps a dead holder's sandbox instead of destroying it", async () => {
    const runId = await run("succeeded");
    const leaseId = await lease(runId, await deadHolder(), true);
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    const after = await row(leaseId);
    expect(after).toMatchObject({ status: "pending_cleanup", failureReason: "sandbox_stop_pending" });
    expect(after.metadata?.sandboxStopAndRetain).toMatchObject({ leaseId, runId, builtinProvider: "fake",
      recoveredOrphanedRunLease: true, ownerProof: "pid_dead" });
  });

  it("stops a recovered orphan at once, even when the lease was used moments ago; a failed stop backs off", async () => {
    const runId = await run("failed");
    const leaseId = await lease(runId, await deadHolder(), true);
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    const stop = vi.fn(async () => { throw new Error("provider unavailable"); });
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      retryPendingSandboxTeardown: stop } as unknown as HeartbeatEnvironmentRuntime });
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 5 * 60_000 });
    expect(stop).toHaveBeenCalledOnce();
    // The failed first attempt counted; the next one waits out the backoff.
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 5 * 60_000 });
    expect(stop).toHaveBeenCalledOnce();
    expect((await row(leaseId)).status).toBe("pending_cleanup");
  });

  it("reads one bounded page per recovery call, so kept leases never block the leases behind them", async () => {
    const foreign = { bootId: "other", pid: 1, hostHash: "another-pid-space", processStartedAt: null };
    const keptRuns = await Promise.all(Array.from({ length: 100 }, () => run("failed")));
    await db.insert(environmentLeases).values(keptRuns.map((runId, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, companyId, heartbeatRunId: runId,
      status: "active", metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: foreign } })));
    const orphanId = "ffffffff-0000-4000-8000-000000000000";
    await db.insert(environmentLeases).values({ id: orphanId, companyId, heartbeatRunId: await run("failed"), status: "active",
      metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: await deadHolder() } });
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 0 });
    expect((await row(orphanId)).status).toBe("active");
    expect(await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 1 });
    expect((await row(orphanId)).status).toBe("pending_cleanup");
  });

  it("waits for native settlement only while the lease's environment exists to release it", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Native settlement" });
    const contractId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "result-worker-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "result-worker-v1", objective: "Finish", criteria: [] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    const native = { runtimeMode: "native", nativeIssueId: issueId, issueId, completionContractId: contractId };
    const kept = await run("succeeded", native);
    const orphaned = await run("succeeded", native);
    const goneEnvironmentId = randomUUID();
    await db.insert(environments).values({ id: goneEnvironmentId, name: "Deleted", driver: "sandbox", status: "active",
      config: { provider: "fake", image: "ubuntu:24.04" } });
    for (const runId of [kept, orphaned]) {
      const resultId = randomUUID();
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
        serverFingerprint: "fixture", schemaStatus: "accepted", resultJson: {}, canonicalSha256: "a".repeat(64) });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "committed", resultId });
    }
    const keptLease = await lease(kept, await deadHolder(), true);
    const orphanedLease = await lease(orphaned, await deadHolder(), true);
    await db.update(environmentLeases).set({ environmentId: goneEnvironmentId }).where(eq(environmentLeases.id, orphanedLease));
    await db.delete(environments).where(eq(environments.id, goneEnvironmentId));
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect((await row(keptLease)).status).toBe("active");
    expect((await row(orphanedLease)).status).toBe("pending_cleanup");
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunResults);
    await db.delete(heartbeatRuns);
    await db.delete(completionContracts);
    await db.delete(issues).where(eq(issues.id, issueId));
  });

  it("keeps a lease while its run is active, whatever its holder", async () => {
    const runId = await run("running");
    const leaseId = await lease(runId, await deadHolder());
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    await settleOwnableKind(db, "environment_run_lease_active", { currentProcessIdle: true, skipRunIds: new Set() });
    expect((await row(leaseId)).status).toBe("active");
  });

  it("keeps a lease whose holder is alive: another live PID, or another PID space", async () => {
    const runId = await run("failed");
    const self = await currentControllerProcess();
    const alive = await lease(runId, { ...self, bootId: "another-boot" });
    const foreign = await lease(runId, { bootId: "other", pid: 1, hostHash: "another-pid-space", processStartedAt: null });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(report.kinds.find(kind => kind.kind === "environment_run_lease_active")).toMatchObject({
      settled: 0, reasons: { pid_alive: 1, different_process_space: 1 } });
    expect((await row(alive)).status).toBe("active");
    expect((await row(foreign)).status).toBe("active");
  });

  it("leaves a current-process lease to this process: settled only when it is not executing the run", async () => {
    const runId = await run("failed");
    const leaseId = await lease(runId, currentControllerProcessStamp());
    // The periodic pass cannot see this process's executions.
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect((await row(leaseId)).status).toBe("active");
    // The executor is still in its finally: it releases the lease itself.
    expect(await settleOwnableKind(db, "environment_run_lease_active", { runIds: [runId],
      skipRunIds: new Set([runId]), currentProcessIdle: true })).toEqual([]);
    expect((await row(leaseId)).status).toBe("active");
    // Without the idle claim, the current process stays alive.
    expect(await settleOwnableKind(db, "environment_run_lease_active", { runIds: [runId] })).toEqual([]);
    const settled = await settleOwnableKind(db, "environment_run_lease_active", { runIds: [runId],
      skipRunIds: new Set(), currentProcessIdle: true });
    expect(settled).toEqual([{ kind: "environment_run_lease_active", recordId: leaseId, runId, reason: "current_process_idle" }]);
    expect((await row(leaseId)).status).toBe("pending_cleanup");
  });

  it("never settles on a read-only pass", async () => {
    const runId = await run("failed");
    const leaseId = await lease(runId, await deadHolder());
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.kinds.find(kind => kind.kind === "environment_run_lease_active")).toMatchObject({
      settled: 0, verdicts: { gone: 1 } });
    expect((await row(leaseId)).status).toBe("active");
  });

  it("does not settle a lease re-stamped by a new holder after the proof", async () => {
    const runId = await run("failed");
    const leaseId = await lease(runId, await deadHolder());
    const original = (await row(leaseId)).metadata!;
    const [record] = await OWNABLE_KINDS.find(kind => kind.id === "environment_run_lease_active")!.listForRuns!(db, [runId]);
    await db.update(environmentLeases).set({ metadata: { ...original,
      [ENVIRONMENT_LEASE_CONTROLLER_KEY]: currentControllerProcessStamp() } }).where(eq(environmentLeases.id, leaseId));
    expect(await settleEnvironmentRunLease(db, record!, { now: new Date(), proof: { verdict: "gone", reason: "pid_dead" } }))
      .toEqual({ settled: false, reason: "owner_changed_since_proof" });
    expect((await row(leaseId)).status).toBe("active");
  });

  describe("leases saved before holders were stamped", () => {
    it("keeps the run fact alone for one release on a single-host server", async () => {
      const runId = await run("failed");
      const leaseId = await lease(runId, null);
      await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
      expect((await row(leaseId)).status).toBe("pending_cleanup");
    });

    it("never releases one whose run this boot owns (a hot-restart adoption may be releasing it)", async () => {
      const runId = await run("failed", { controllerBootId: currentControllerBootId() });
      const leaseId = await lease(runId, null);
      await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
      expect((await row(leaseId)).status).toBe("active");
      // This process knows it is not executing the run: the local path settles it.
      expect(await settleOwnableKind(db, "environment_run_lease_active", { runIds: [runId],
        skipRunIds: new Set([randomUUID()]), currentProcessIdle: true })).toHaveLength(1);
      expect((await row(leaseId)).status).toBe("pending_cleanup");
    });

    it("names no owner on an ephemeral server, where the host cannot be known", async () => {
      vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
      const runId = await run("failed");
      const leaseId = await lease(runId, null);
      const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
      expect(report.kinds.find(kind => kind.kind === "environment_run_lease_active")).toMatchObject({
        settled: 0, verdicts: { unprovable: 1 }, reasons: { no_owner_stamp: 1 } });
      expect(report.violations.some(violation => violation.recordId === leaseId && violation.rule === "I1_owned")).toBe(true);
      expect((await row(leaseId)).status).toBe("active");
    });
  });
});
