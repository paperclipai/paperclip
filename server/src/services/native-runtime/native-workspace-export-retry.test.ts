import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
const probe = vi.hoisted(() => vi.fn());
vi.mock("../environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: async () => ({ kind: "remote", transport: "sandbox", remoteCwd: "/work", runner: { execute: probe } }) }));
import { recoverLegacyUnsafeWorkspaceExports } from "./native-workspace-export-recovery.js";
import { recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { recoveryService } from "../recovery/service.js";
import { retryNativeWorkspaceExport } from "./native-workspace-export-retry.js";
import { releaseCompletedNativeWorkspaceExportRetention } from "./native-workspace-export-resume.js";

describe("board retry of accepted workspace export", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("workspace-export-retry-"); db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Export repair", issuePrefix: "EXP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Exporter", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: `Retained ${environmentId}`, driver: "sandbox" });
  }, 30_000);
  afterAll(async () => { await temporary.cleanup(); });
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

});
