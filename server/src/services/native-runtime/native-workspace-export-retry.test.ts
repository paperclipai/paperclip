import { heartbeatService } from "../heartbeat.js";
import { issueService } from "../issues.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
const probe = vi.hoisted(() => vi.fn());
vi.mock("../environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: async () => ({ kind: "remote", transport: "sandbox", remoteCwd: "/work", runner: { execute: probe } }) }));
import { recoverLegacyUnsafeWorkspaceExports, registerUnsafeWorkspaceExportWork } from "./native-workspace-export-recovery.js";
import { recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { recoveryService } from "../recovery/service.js";
import { retryNativeWorkspaceExport } from "./native-workspace-export-retry.js";
import { releaseCompletedNativeWorkspaceExportRetention } from "./native-workspace-export-resume.js";

describe("board retry of accepted workspace export", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_EXPORT_RETRY_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("workspace-export-retry-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Export repair", issuePrefix: "EXP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Exporter", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: `Retained ${environmentId}`, driver: "sandbox" });
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function seed(cause = "native_workspace_sync_out_retry_exhausted") {
    probe.mockReset().mockResolvedValue({ exitCode: 0, timedOut: false });
    const issueId = randomUUID(), runId = randomUUID(), resultId = randomUUID(), contractId = randomUUID(), leaseId = randomUUID(), actionId = randomUUID(), providerLeaseId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve accepted work", status: "blocked", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { objective: "Preserve accepted work" }, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId, nativePhase: "terminal_failure", completionContractId: contractId,
      runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "keep_running" } } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: { work: "already finished" }, canonicalSha256: resultId });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", resultId, failureCode: cause, failureDetail: { workspaceFinalizeAttempt: 1 } });
    const identity = { id: leaseId, companyId, heartbeatRunId: runId, provider: "daytona", providerLeaseId };
    await db.insert(environmentLeases).values({ ...identity, environmentId, issueId, status: "released", releasedAt: new Date(), cleanupStatus: "success", leasePolicy: "reuse_by_environment", metadata: { pluginId: randomUUID(), remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId, state: "stopped" }) } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: agentId, cause, fingerprint: runId, evidence: { runId }, nextAction: "Repair saved files" });
    const request = { db, companyId, issueId, actionId, runId, actorId: "board", repairNote: "Restored provider transport availability and preserved the saved work.", environmentRuntime: {
      resumeRunLease: vi.fn().mockResolvedValue({ providerLeaseId, metadata: { remoteCwd: "/work" } }),
      retryPendingSandboxTeardown: vi.fn().mockResolvedValue({ providerLeaseId, state: "stopped" }),
    } as never };
    return { ...request, request, resultId, leaseId };
  }
  it("rejects manual unsafe-export admission without contacting the provider", async () => {
    const f = await seed("native_workspace_sync_out_unsafe_archive");
    await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow("no longer current");
    expect(probe).not.toHaveBeenCalled();
    expect((f.request.environmentRuntime as { resumeRunLease: ReturnType<typeof vi.fn> }).resumeRunLease).not.toHaveBeenCalled();
  });
  it("queues only the existing result and lease, audits once, and deduplicates a pending click", async () => {
    const f = await seed();
    const accepted = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    expect(await retryNativeWorkspaceExport(f.request)).toMatchObject({ runId: f.runId, resultId: f.resultId, leaseId: f.leaseId, status: "queued" });
    await retryNativeWorkspaceExport(f.request);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ args: ["-c", "true"], bypassSession: true }));
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual(accepted);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toMatchObject({ phase: "result_accepted", resultId: f.resultId, nextAttemptAt: null });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toMatchObject({ status: "active", releasedAt: null });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))).toHaveLength(1);
  });
  it("reopens the stopped provider lifecycle before probing its exact sandbox", async () => {
    const f = await seed(); let providerAdmissionOpen = false;
    const resume = (f.request.environmentRuntime as { resumeRunLease: ReturnType<typeof vi.fn> }).resumeRunLease;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    resume.mockImplementation(async () => { providerAdmissionOpen = true; return { providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/work" } }; });
    probe.mockImplementation(async () => { if (!providerAdmissionOpen) throw new Error("Released provider admission is closed"); return { exitCode: 0, timedOut: false }; });
    await expect(retryNativeWorkspaceExport(f.request)).resolves.toMatchObject({ status: "queued" });
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ id: f.leaseId, providerLeaseId: lease.providerLeaseId }) }));
  });
  it("retries exhausted transient export of an ephemeral allocation without another provider turn", async () => {
    const f = await seed();
    await db.update(nativeRunFinalizations).set({ failureCode: "native_workspace_sync_out_retry_exhausted", failureDetail: { workspaceFinalizeAttempt: 3 } }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted" }).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral" }).where(eq(environmentLeases.id, f.leaseId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, nativeWorkspaceSync: { ...(run.runnerProfileJson!.nativeWorkspaceSync as object), resourceDisposition: "destroy" } } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(retryNativeWorkspaceExport(f.request)).resolves.toMatchObject({ status: "queued", resultId: f.resultId, leaseId: f.leaseId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
  });
  it.each(["unsafe", "transient"])("records stop-only preservation atomically with %s terminal export failure", async kind => {
    const f = await seed();
    await db.update(nativeRunFinalizations).set({ phase: "result_accepted", failureCode: null, failureDetail: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "result_accepted" }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "active", leasePolicy: "ephemeral", releasedAt: null, metadata: { pluginId: "plugin-test", pendingCleanupRetryAfterMs: Date.now() + 600_000, pendingCleanupRetryAttempts: 7 } }).where(eq(environmentLeases.id, f.leaseId));
    for (let attempt = 1; attempt <= (kind === "unsafe" ? 1 : 3); attempt++) {
      await recordNativeFinalizationFailure({ db, runId: f.runId,
        error: new Error(kind === "unsafe" ? "native_workspace_sync_out_unsafe_archive" : "native_workspace_sync_out_failed"),
        failureScope: "workspace", projectRunStatus: true, permanent: kind === "unsafe" });
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      if (kind === "transient" && attempt < 3) expect(lease.status).toBe("active");
      else {
        expect(lease).toMatchObject({ status: "pending_cleanup", metadata: {
          nativeWorkspaceExportResume: { runId: f.runId, leaseId: f.leaseId, resultId: f.resultId },
          pendingCleanupInFlight: false, pendingCleanupRetryAfterMs: 0, pendingCleanupRetryAttempts: 0,
        } });
        expect(lease.metadata?.remoteExecutionTermination).toBeUndefined();
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
      }
    }
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].schemaStatus).toBe("accepted");
  });
  it.each(["complete", "committed_failed", "committed_cancelled", "running", "unexported", "wrong_result", "uncommitted_run", "wrong_allocation", "competing_owner"])("releases ephemeral retention only after exact committed copyback: %s", async kind => {
    const f = await seed();
    await retryNativeWorkspaceExport(f.request);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ status: kind === "running" ? "running" : kind === "committed_cancelled" ? "cancelled" : ["uncommitted_run", "committed_failed"].includes(kind) ? "failed" : "succeeded",
      nativePhase: kind === "uncommitted_run" ? "terminal_failure" : "committed",
      runnerProfileJson: { ...run.runnerProfileJson, nativeWorkspaceSync: { ...(run.runnerProfileJson!.nativeWorkspaceSync as object),
        state: kind === "unexported" ? "prepared" : "finalized", finalHostSha256: "c".repeat(64), resourceDisposition: "destroy",
        ...(kind === "wrong_allocation" ? { providerLeaseId: randomUUID() } : {}) } },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed", ...(kind === "wrong_result" ? { resultId: null } : {}) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    if (kind === "competing_owner") await db.insert(environmentLeases).values({ companyId, environmentId, status: "active", provider: lease.provider, providerLeaseId: lease.providerLeaseId });
    const released = await releaseCompletedNativeWorkspaceExportRetention(db, lease);
    const committed = ["complete", "committed_failed", "committed_cancelled"].includes(kind);
    if (committed) expect(released).toMatchObject({ id: lease.id, metadata: expect.not.objectContaining({ nativeWorkspaceExportResume: expect.anything() }) });
    else expect(released).toBeNull();
    const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(Boolean(after.metadata?.nativeWorkspaceExportResume)).toBe(!committed);
  });
  it("records a recoverable stop-only intent before the provider can resume", async () => {
    const f = await seed();
    const runtime = f.request.environmentRuntime as { resumeRunLease: ReturnType<typeof vi.fn>; retryPendingSandboxTeardown: ReturnType<typeof vi.fn> };
    runtime.resumeRunLease.mockImplementation(async () => {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      expect(lease).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed", metadata: {
        nativeWorkspaceExportResume: { runId: f.runId, leaseId: f.leaseId, resultId: f.resultId },
        pendingCleanupInFlight: true,
      } });
      expect(lease.metadata?.remoteExecutionTermination).toBeUndefined();
      return { providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/work" } };
    });
    await expect(retryNativeWorkspaceExport(f.request)).resolves.toMatchObject({ status: "queued" });
    expect(runtime.retryPendingSandboxTeardown).not.toHaveBeenCalled();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease.status).toBe("active");
    expect(lease.metadata?.nativeWorkspaceExportResume).toMatchObject({ runId: f.runId, resultId: f.resultId });
  });
  it.each(["resume_reply_lost", "probe_failed", "admission_changed", "cancelled", "completed", "stop_failed"])("tracks and compensates a failed export resume: %s", async kind => {
    const f = await seed();
    const runtime = f.request.environmentRuntime as { resumeRunLease: ReturnType<typeof vi.fn>; retryPendingSandboxTeardown: ReturnType<typeof vi.fn> };
    if (kind === "resume_reply_lost") runtime.resumeRunLease.mockRejectedValueOnce(new Error("reply lost after provider resumed"));
    else probe.mockImplementationOnce(async () => {
      if (kind === "admission_changed") {
        await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.issueId, status: "failed", createdAt: new Date(Date.now() + 1000) });
        return { exitCode: 0, timedOut: false };
      }
      if (kind === "cancelled" || kind === "completed") {
        await db.update(heartbeatRuns).set({ status: kind === "cancelled" ? "cancelled" : "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
        return { exitCode: 0, timedOut: false };
      }
      throw new Error("probe unavailable");
    });
    if (kind === "stop_failed") runtime.retryPendingSandboxTeardown.mockRejectedValueOnce(new Error("provider stop unavailable"));
    await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow();
    expect(runtime.retryPendingSandboxTeardown).toHaveBeenCalledOnce();
    expect(runtime.retryPendingSandboxTeardown).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ id: f.leaseId, heartbeatRunId: f.runId }) }));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease).toMatchObject(kind === "stop_failed" ? { status: "pending_cleanup", cleanupStatus: "failed" } : { status: "released", cleanupStatus: "success" });
    if (kind === "stop_failed") {
      expect(lease.metadata?.remoteExecutionTermination).toBeUndefined();
      expect(lease.metadata?.pendingCleanupInFlight).toBe(false);
      expect(lease.metadata?.nativeWorkspaceExportResume).toMatchObject({ runId: f.runId, leaseId: f.leaseId });
    } else expect(lease.metadata?.remoteExecutionTermination).toMatchObject({ runId: f.runId, leaseId: f.leaseId, state: "stopped" });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toMatchObject({ phase: "terminal_failure", resultId: f.resultId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
  });
  it.each(["rebound_lease", "competing_owner", "retained_owner", "late_stop_receipt"])("does not stop or overwrite a newer sandbox owner: %s", async kind => {
    const f = await seed();
    const runtime = f.request.environmentRuntime as { retryPendingSandboxTeardown: ReturnType<typeof vi.fn> };
    const rebound = async () => db.update(environmentLeases).set({ status: "active", heartbeatRunId: null,
      metadata: { newOwner: true }, cleanupStatus: null, releasedAt: null }).where(eq(environmentLeases.id, f.leaseId));
    probe.mockImplementationOnce(async () => {
      if (kind === "rebound_lease") await rebound();
      if (kind === "competing_owner" || kind === "retained_owner") {
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
        await db.insert(environmentLeases).values({ companyId, environmentId, status: kind === "retained_owner" ? "retained" : "active", provider: lease.provider, providerLeaseId: lease.providerLeaseId });
      }
      throw new Error("probe failed after ownership changed");
    });
    if (kind === "late_stop_receipt") runtime.retryPendingSandboxTeardown.mockImplementationOnce(async ({ lease }) => {
      await rebound(); return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
    });
    await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow();
    expect(runtime.retryPendingSandboxTeardown).toHaveBeenCalledTimes(kind === "late_stop_receipt" ? 1 : 0);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    if (kind !== "competing_owner" && kind !== "retained_owner") expect(lease).toMatchObject({ status: "active", heartbeatRunId: null, metadata: { newOwner: true }, cleanupStatus: null });
    expect(lease.metadata?.remoteExecutionTermination).toBeUndefined();
  });
  it.each(["missing", "replacement", "wrong_root"])("refuses an unproven resume without probing or acquiring replacement: %s", async kind => {
    const f = await seed();
    const resume = (f.request.environmentRuntime as { resumeRunLease: ReturnType<typeof vi.fn> }).resumeRunLease;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    resume.mockResolvedValue({ providerLeaseId: kind === "missing" ? null : kind === "replacement" ? randomUUID() : lease.providerLeaseId,
      metadata: { remoteCwd: kind === "wrong_root" ? "/other" : "/work" } });
    await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow("Resume and repair");
    expect(probe).not.toHaveBeenCalled();
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0].status).toBe("released");
  });
  it("fences an old failure whose transaction arrives after explicit repair admission", async () => {
    const f = await seed();
    let release!: () => void, captured!: () => void;
    const ready = new Promise<void>(resolve => { captured = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction.bind(db);
    const interception = vi.spyOn(db, "transaction").mockImplementationOnce(async (...args) => {
      captured(); await wait; return transaction(...args);
    });
    const lateFailure = recordNativeFinalizationFailure({ db, runId: f.runId,
      error: new Error("native_workspace_sync_out_failed"), failureScope: "workspace", projectRunStatus: true });
    await ready;
    try { await retryNativeWorkspaceExport(f.request); } finally { release(); }
    await lateFailure; interception.mockRestore();
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toMatchObject({ phase: "result_accepted", failureCode: null, nextAttemptAt: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toMatchObject({ status: "running", nativePhase: "result_accepted" });
  });
  it.each(["foreign_company", "missing_result", "newer_run", "lease_rebound", "other_lease", "retained_lease", "unconfirmed_stop", "destroyed"])("rejects %s before probing or changing finalization", async (kind) => {
    const f = await seed();
    if (kind === "foreign_company") f.request.companyId = randomUUID();
    if (kind === "missing_result") await db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "newer_run") await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.issueId, status: "failed", createdAt: new Date(Date.now() + 1000) });
    if (kind === "other_lease" || kind === "retained_lease") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      await db.insert(environmentLeases).values({ companyId, environmentId, issueId: f.issueId, status: kind === "retained_lease" ? "retained" : "active", provider: lease.provider, providerLeaseId: lease.providerLeaseId });
    }
    if (kind === "lease_rebound") await db.update(environmentLeases).set({ heartbeatRunId: null }).where(eq(environmentLeases.id, f.leaseId));
    if (kind === "unconfirmed_stop" || kind === "destroyed") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      await db.update(environmentLeases).set({ metadata: kind === "unconfirmed_stop" ? {} : { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } }).where(eq(environmentLeases.id, f.leaseId));
    }
    await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("terminal_failure");
  });
  it("leaves repair intact when the exact sandbox is not running", async () => {
    const f = await seed(); probe.mockRejectedValueOnce(new Error("stopped"));
    await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow("Resume and repair");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0].status).toBe("released");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("terminal_failure");
  });
  it("revalidates the lease after the read-only probe", async () => {
    const f = await seed(); probe.mockImplementationOnce(async () => { await db.update(environmentLeases).set({ heartbeatRunId: null }).where(eq(environmentLeases.id, f.leaseId)); return { exitCode: 0 }; });
    await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow("no longer current");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("terminal_failure");
  });
  it("does not take ownership from an active exporter", async () => {
    const f = await seed();
    await withNativeWorkspaceFinalizationOwnership(f, async () => {
      await expect(retryNativeWorkspaceExport(f.request)).rejects.toThrow("still owned");
    });
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(["native_workspace_sync_out_retry_exhausted", "native_workspace_sync_out_unsafe_archive"])("does not dispatch another provider turn from a pending accepted export: %s", async cause => {
    const f = await seed(cause);
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", status: "claimed", runId: f.runId, payload: { issueId: f.issueId } });
    await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0]).toMatchObject({ status: "active", ownerType: "board" });
  });

  it.each(["eligible", "newer_run", "competing_action", "other_lease", "unaccepted_result", "changed_contract", "cancelled", "owned"])("quietly recovers historical unsafe exports with ownership fences: %s", async kind => {
    const f = await seed("native_workspace_sync_out_unsafe_archive");
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolutionNote: "new_source_execution_path", resolvedAt: new Date() }).where(eq(issueRecoveryActions.id, f.actionId));
    if (kind === "newer_run") await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.issueId, status: "failed", createdAt: new Date(Date.now() + 1000) });
    if (kind === "competing_action") await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board", cause: "other_repair", fingerprint: "other", nextAction: "Preserve another repair" });
    if (kind === "other_lease") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      await db.insert(environmentLeases).values({ companyId, environmentId, status: "active", provider: lease.provider, providerLeaseId: lease.providerLeaseId });
    }
    if (kind === "unaccepted_result") await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.id, f.resultId));
    if (kind === "changed_contract") {
      const [old] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
      await db.insert(completionContracts).values({ ...old, id: randomUUID(), canonicalSha256: randomUUID(), revision: old.revision + 1 });
    }
    if (kind === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    if (kind === "owned") await withNativeWorkspaceFinalizationOwnership(f, async () => recoverLegacyUnsafeWorkspaceExports(db, [f.runId]));
    else await recoverLegacyUnsafeWorkspaceExports(db, [f.runId]);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action.status).toBe("resolved");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe(["eligible", "other_lease"].includes(kind) ? "result_accepted" : "terminal_failure");
    expect(probe).not.toHaveBeenCalled();
    expect((f.request.environmentRuntime as { resumeRunLease: ReturnType<typeof vi.fn> }).resumeRunLease).not.toHaveBeenCalled();
  });

  describe("unsafe-export scoped recovery", () => {
    const unsafe = "native_workspace_sync_out_unsafe_archive";
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let admitted = true;
    const errors: unknown[] = [];
    beforeEach(async () => {
      await db.update(nativeRunFinalizations).set({ failureCode: "unrelated_test_history" })
        .where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.failureCode, unsafe)));
      admitted = true; errors.length = 0;
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    });
    afterEach(async () => {
      await coordinator?.stop(); coordinator = undefined;
      vi.useRealTimers(); vi.restoreAllMocks();
      expect(errors).toEqual([]);
    });
    async function start() {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
        onError: error => errors.push(error) });
      await registerUnsafeWorkspaceExportWork(db, coordinator, () => admitted).ready;
    }
    async function flush() {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator!.nextWakeAt()).toBeNull();
      }, { timeout: 15_000 });
    }
    async function quiet() {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try { await vi.advanceTimersByTimeAsync(120_000); expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); }
      finally { select.mockRestore(); transaction.mockRestore(); }
    }
    const phase = async (runId: string) => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase;
    async function seedBeforeFailure() {
      const f = await seed(unsafe);
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
      await db.update(nativeRunFinalizations).set({ phase: "result_accepted", failureCode: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(heartbeatRuns).set({ status: "running", nativePhase: "result_accepted" }).where(eq(heartbeatRuns.id, f.runId));
      return f;
    }
    function failExport(f: Awaited<ReturnType<typeof seed>>, owner = db) {
      return recordNativeFinalizationFailure({ db: owner, runId: f.runId, error: new Error(unsafe),
        failureScope: "workspace", projectRunStatus: true, permanent: true });
    }
    function gate() {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    }

    it("stays quiet with no matching work", async () => {
      await seed(); await start(); await flush(); await quiet(); expect(probe).not.toHaveBeenCalled();
    });
    it.each(["newer_run", "older_active_run", "competing_action", "cancelled", "changed_contract", "explicit_settlement", "cancelled_action", "null_settlement", "rejected"])("does not poll dormant history: %s", async kind => {
      const f = await seed(unsafe);
      await db.update(issueRecoveryActions).set({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" }).where(eq(issueRecoveryActions.id, f.actionId));
      if (["newer_run", "older_active_run"].includes(kind)) await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.issueId,
        status: kind === "older_active_run" ? "running" : "failed", createdAt: new Date(Date.now() + (kind === "older_active_run" ? -60_000 : 60_000)) });
      if (kind === "competing_action") await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board", cause: "other_repair", fingerprint: randomUUID(), nextAction: "Keep this repair", evidence: {} });
      if (kind === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      if (kind === "changed_contract") {
        const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
        await db.insert(completionContracts).values({ ...contract, id: randomUUID(), revision: contract.revision + 1, canonicalSha256: randomUUID() });
      }
      if (["explicit_settlement", "null_settlement"].includes(kind)) await db.update(issueRecoveryActions).set({ resolutionNote: kind === "null_settlement" ? null : "operator_resolved" }).where(eq(issueRecoveryActions.id, f.actionId));
      if (kind === "cancelled_action") await db.update(issueRecoveryActions).set({ status: "cancelled" }).where(eq(issueRecoveryActions.id, f.actionId));
      if (kind === "rejected") await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.id, f.resultId));
      await start(); await flush(); expect(await phase(f.runId)).toBe("terminal_failure"); await quiet();
      expect(probe).not.toHaveBeenCalled();
    });
    it("retires a stale action even when a newer run prevents result readmission", async () => {
      const f = await seed(unsafe);
      await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.issueId, status: "failed", createdAt: new Date(Date.now() + 60_000) });
      await start(); await flush();
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0]).toMatchObject({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" });
      expect(await phase(f.runId)).toBe("terminal_failure"); await quiet();
    });
    it("discovers a newer accepted result after retiring an older unsafe notice", async () => {
      const older = await seed(unsafe);
      const [oldRun] = await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(heartbeatRuns.id, older.runId)).returning();
      const [oldResult] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, older.resultId));
      const runId = randomUUID(), resultId = randomUUID();
      await db.insert(heartbeatRuns).values({ ...oldRun, id: runId, createdAt: new Date() });
      await db.insert(nativeRunResults).values({ ...oldResult, id: resultId, runId,
        serverFingerprint: resultId, canonicalSha256: resultId });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: older.issueId,
        phase: "terminal_failure", resultId, failureCode: unsafe });
      const accepted = await db.select().from(nativeRunResults).where(eq(nativeRunResults.issueId, older.issueId));



      await start(); await flush();
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, older.actionId)))[0])
        .toMatchObject({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" });
      expect(await phase(older.runId)).toBe("terminal_failure");
      expect(await phase(runId)).toBe("result_accepted");
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.issueId, older.issueId))).toEqual(accepted);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, older.issueId))).toHaveLength(2);
      expect(probe).not.toHaveBeenCalled();
      await quiet();
    });
    it("wakes from a real finalization failure and readmits only the accepted result", async () => {
      const f = await seedBeforeFailure(); await start(); await flush(); await quiet();
      await failExport(f); await flush(); expect(await phase(f.runId)).toBe("result_accepted");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
      expect(probe).not.toHaveBeenCalled(); await quiet();
    });
    it.each(["commit", "rollback"] as const)("waits for the outer failure transaction to %s", async outcome => {
      const f = await seedBeforeFailure(); await start(); await flush();
      const entered = gate(), release = gate();
      const writing = db.transaction(async tx => {
        await failExport(f, tx as unknown as typeof db); entered.release(); await release.promise;
        if (outcome === "rollback") throw new Error("rollback unsafe export");
      }).then(() => null, error => error);
      await entered.promise; await vi.advanceTimersByTimeAsync(2000);
      expect(await phase(f.runId)).toBe("result_accepted"); release.release();
      const error = await writing;
      if (outcome === "rollback") expect(error).toMatchObject({ message: "rollback unsafe export" });
      else expect(error).toBeNull();
      await flush(); expect(await phase(f.runId)).toBe("result_accepted");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.status).toBe("running"); await quiet();
    });
    it.each(["restart", "drain"])("recovers saved work after %s", async mode => {
      const f = await seedBeforeFailure();
      if (mode === "drain") { await start(); await flush(); admitted = false; }
      await failExport(f);
      if (mode === "restart") await start();
      else { await quiet(); expect(await phase(f.runId)).toBe("terminal_failure"); admitted = true; await vi.advanceTimersByTimeAsync(30_000); }
      await flush(); expect(await phase(f.runId)).toBe("result_accepted"); await quiet();
    });
    it("retains a concrete coordinator lease until its owner releases it", async () => {
      const f = await seed(unsafe);
      await db.update(nativeRunFinalizations).set({ leaseOwner: "still-owned", leaseExpiresAt: new Date(Date.now() + 300_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      await start(); expect(await phase(f.runId)).toBe("terminal_failure"); expect(coordinator!.nextWakeAt()).not.toBeNull();
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(await phase(f.runId)).toBe("result_accepted"); await quiet();
    });
    it("waits for physical workspace ownership without stealing or discarding the obligation", async () => {
      const f = await seed(unsafe);
      const owned = await withNativeWorkspaceFinalizationOwnership(f, async () => {
        await start();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await phase(f.runId)).toBe("terminal_failure");
        await vi.waitFor(() => {
          expect(idleWorkSnapshot().active).toBe(0);
          expect(coordinator!.nextWakeAt()).not.toBeNull();
        });
        expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].status).toBe("active");
      });
      expect(owned.acquired).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000); await flush();
      expect(await phase(f.runId)).toBe("result_accepted");
      expect(probe).not.toHaveBeenCalled(); await quiet();
    });
    it.each(["admin", "stale_lock_recovery"])("reactivates dormant history after %s releases an older run's locks", async mode => {
      const f = await seed(unsafe);
      await db.update(issueRecoveryActions).set({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" }).where(eq(issueRecoveryActions.id, f.actionId));
      const [older] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.issueId,
        status: "failed", createdAt: new Date(Date.now() - 60_000) }).returning();
      await db.update(issues).set({ checkoutRunId: older.id, executionRunId: older.id }).where(eq(issues.id, f.issueId));
      await start(); await flush();
      expect(await phase(f.runId)).toBe("terminal_failure"); await quiet();
      if (mode === "admin") await issueService(db).adminForceRelease(f.issueId);
      else expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks()).issueIds).toContain(f.issueId);
      await flush(); expect(await phase(f.runId)).toBe("result_accepted");
      expect(probe).not.toHaveBeenCalled(); await quiet();
    });
    it("stops pending retries and reconstructs them on restart", async () => {
      const f = await seed(unsafe);
      await db.update(nativeRunFinalizations).set({ leaseOwner: "still-owned", leaseExpiresAt: new Date(Date.now() + 300_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      await start(); expect(coordinator!.nextWakeAt()).not.toBeNull();
      await coordinator!.stop(); coordinator = undefined;
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      await quiet(); expect(await phase(f.runId)).toBe("terminal_failure");
      await start(); await flush(); expect(await phase(f.runId)).toBe("result_accepted"); await quiet();
    });
    it("revalidates task cancellation while a physical owner delays recovery", async () => {
      const f = await seed(unsafe);
      await withNativeWorkspaceFinalizationOwnership(f, async () => {
        await start();
        await issueService(db).update(f.issueId, { status: "cancelled" });
      });
      await vi.advanceTimersByTimeAsync(30_000); await flush();
      expect(await phase(f.runId)).toBe("terminal_failure");
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].status).toBe("resolved");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("failed");
      expect(probe).not.toHaveBeenCalled(); await quiet();
    });
    it("discovers and drains more than one page of stale notices", async () => {
      const fixtures = [];
      for (let index = 0; index < 103; index++) {
        const f = await seed(unsafe);
        await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
        fixtures.push(f);
      }
      await start(); await flush();
      for (const f of fixtures) {
        expect(await phase(f.runId)).toBe("terminal_failure");
        expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0]).toMatchObject({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" });
      }
      expect(probe).not.toHaveBeenCalled(); await quiet();
    }, 30_000);
    it("reactivates dormant history when the real cancellation path settles an older queued run", async () => {
      const f = await seed(unsafe);
      await db.update(issueRecoveryActions).set({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" }).where(eq(issueRecoveryActions.id, f.actionId));
      const [older] = await db.insert(heartbeatRuns).values({ companyId, agentId, contextSnapshot: { issueId: f.issueId },
        status: "queued", runtimeMode: "legacy", createdAt: new Date(Date.now() - 60_000) }).returning();
      await start(); await flush(); expect(await phase(f.runId)).toBe("terminal_failure"); await quiet();
      await heartbeatService(db).cancelRun(older.id);
      await flush(); expect(await phase(f.runId)).toBe("result_accepted");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, older.id)))[0].status).toBe("cancelled");
      expect(probe).not.toHaveBeenCalled(); await quiet();
    });
    it("retries failed discovery after admission resumes", async () => {
      const f = await seed(unsafe);
      const read = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("injected unsafe discovery failure"); });
      await start(); await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0)); read.mockRestore();
      errors.length = 0; admitted = false; await quiet(); admitted = true;
      await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(await phase(f.runId)).toBe("result_accepted"); await quiet();
    });
    it("does not wake dormant history for unchanged action metadata or repeated resolution", async () => {
      const f = await seed(unsafe);
      await db.update(issueRecoveryActions).set({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" }).where(eq(issueRecoveryActions.id, f.actionId));
      const actionInput = { companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog" as const,
        ownerType: "board" as const, cause: "other_repair", fingerprint: randomUUID(), nextAction: "Wait for repair" };
      const service = issueRecoveryActionService(db);
      const other = await service.upsertSourceScoped(actionInput);
      await start(); await flush(); await quiet();
      await service.upsertSourceScoped({ ...actionInput, nextAction: "Updated operator guidance" });
      expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
      const resolution = { companyId, sourceIssueId: f.issueId, actionId: other.id,
        status: "resolved" as const, outcome: "restored" as const, resolutionNote: "Other repair finished" };
      await service.resolveActiveForIssue(resolution); await flush();
      expect(await phase(f.runId)).toBe("result_accepted");
      await service.resolveActiveForIssue(resolution);
      expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
    });
    it("reactivates dormant history from the real recovery-action resolution", async () => {
      const f = await seed(unsafe);
      await db.update(issueRecoveryActions).set({ status: "resolved", resolutionNote: "unsafe_export_automatic_recovery" }).where(eq(issueRecoveryActions.id, f.actionId));
      const [other] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board", cause: "other_repair", fingerprint: randomUUID(), nextAction: "Wait for repair" }).returning();
      await start(); await flush(); await quiet();
      await issueRecoveryActionService(db).resolveActiveForIssue({ companyId, sourceIssueId: f.issueId, actionId: other.id,
        status: "resolved", outcome: "restored", resolutionNote: "Other repair finished" });
      await flush(); expect(await phase(f.runId)).toBe("result_accepted"); await quiet();
    });
    it("reactivates dormant history from a real task update", async () => {
      const f = await seed(unsafe);
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      await start(); await flush(); await quiet();
      await issueService(db).update(f.issueId, { status: "blocked" });
      await flush(); expect(await phase(f.runId)).toBe("result_accepted"); await quiet();
    });
  });

});
