import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues,
  nativeRunFinalizations } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerCancelledWorkspacePreservationWork } from "./native-failed-workspace-recovery.js";

(recoveryPostgresSupport.supported ? describe : describe.skip)("cancelled workspace preservation idle cost", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const fixtures = new Set<string>();

  async function seed(input: { launched: boolean; lease: "destroyed" | "active" }) {
    if (!database) {
      database = await startRecoveryPostgres("cancelled-workspace-idle-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const leaseId = randomUUID(), environmentId = randomUUID(), providerLeaseId = `allocation-${randomUUID()}`;
    fixtures.add(runId);
    await db.insert(companies).values({ id: companyId, name: "Stopped native files", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", adapterType: "paperclip_runner",
      status: "terminated", lifecycleState: "terminating" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stopped task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Idle ${runId}`, driver: "sandbox" });
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId,
      scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), acknowledgedAt: new Date().toISOString(),
      effects: ["release_run_resources"] };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", runtimeModeResolvedAt: new Date(), status: "cancelled", errorCode: "cancelled",
      error: "Agent lifecycle stop requested", finishedAt: new Date(), contextSnapshot: { issueId },
      nextEventSeq: input.launched ? 2 : 1,
      runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy" } },
      resultJson: { nativeCancellation, startupCancellation: { beforeNativeSelection: false } } });
    await db.insert(nativeRunFinalizations).values(input.launched
      ? { runId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" }
      : { runId, companyId, issueId, phase: "observed", attempt: 1, controllerGeneration: 1,
          leaseOwner: `executor-${runId}`, leaseExpiresAt: new Date(Date.now() - 60_000) });
    if (input.launched) await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "native.process_start_requested", stream: "system", level: "info", message: "Runner launch requested" });
    const destroyed = input.lease === "destroyed";
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, issueId,
      provider: "daytona", providerLeaseId, leasePolicy: "ephemeral", status: destroyed ? "expired" : "active",
      releasedAt: destroyed ? new Date() : null, cleanupStatus: destroyed ? "success" : null,
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work",
        ...(destroyed ? { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "destroyed",
          runId, leaseId, companyId, provider: "daytona", providerLeaseId, confirmedAt: new Date().toISOString() } } : {}) } });
    return { companyId, runId, leaseId };
  }

  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    if (fixtures.size) await db.update(heartbeatRuns).set({ status: "failed" }).where(inArray(heartbeatRuns.id, [...fixtures]));
    fixtures.clear();
  });

  async function idleStatements(minutes: number) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction"), writes = vi.spyOn(db, "update");
    await vi.advanceTimersByTimeAsync(minutes * 60_000);
    const count = reads.mock.calls.length + transactions.mock.calls.length + writes.mock.calls.length;
    reads.mockRestore(); transactions.mockRestore(); writes.mockRestore(); vi.useRealTimers();
    return count;
  }

  it("leaves a stopped run that never started a runner alone, before and after a restart", async () => {
    const f = await seed({ launched: false, lease: "destroyed" });
    for (let boot = 0; boot < 2; boot++) {
      const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const checks = vi.spyOn(db, "update");
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        expect(checks.mock.calls.length).toBe(boot === 0 ? 1 : 0);
        checks.mockRestore();
        expect(worker.nextWakeAt()).toBeNull();
        expect(await idleStatements(30)).toBe(0);
      } finally { checks.mockRestore(); await worker.stop(); }
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.runnerProfileJson).not.toHaveProperty("nativeWorkspaceSync");
    expect(run.runnerProfileJson).toHaveProperty("nativeWorkspaceSyncReleasedUnchanged.state", "prepared");
    expect(run.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
  }, 120_000);

  it("still preserves the files of a stopped run that started a runner, then goes idle", async () => {
    const f = await seed({ launched: true, lease: "active" });
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.resultJson).toMatchObject({ workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1",
        leaseIds: [f.leaseId] } });
      expect(worker.nextWakeAt()).toBeNull();
      expect(await idleStatements(30)).toBe(0);
    } finally { await worker.stop(); }
  }, 120_000);
});
