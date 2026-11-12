import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
  nativeRunResults } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { nativeRunProjectionWork } from "./native-runtime/native-run-projection-work.js";
import { readRemoteWorkspaceWriterHold } from "./remote-workspace-writer-hold.js";
import { createSavedWorkspaceLoader } from "./remote-workspaces.js";
import { prepareStoppedSandboxForRecovery, readStopOnlyCleanup, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { SUPERSEDED_EXPORT_FILES_GONE, SUPERSEDED_EXPORT_STOP_NOTICE } from "./native-runtime/native-superseded-workspace-export.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { RETAINED_SOURCE_FALLBACK_OUTCOME } from "./workspace-recovery-fallback.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { resumePreservedResultFinalization } from "./preserved-result-finalization.js";
import { acceptedRemoteExport, connectionString, db, run, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

const workspace = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;
const adminText = /sandbox|environment|administrator|board member|owner must|inspect the run/i;

describe("a superseded run whose workspace export failed", () => {
  useWorkspaceRecoveryFixture(targets);
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /**
   * The staging shape: the accepted result's export failed once
   * with remote_workspace_archive_fs_eacces, a newer run had already decided
   * the task, so the finalizer was retired as superseded and the run ended
   * failed. Its ephemeral sandbox was stopped and retained, and the run is
   * still the dirty writer of the task's workspace. No retained-file
   * obligation exists, so nothing ever settles that writer.
   */
  async function supersededExport(stop: "confirmed" | "never_requested" | "destroyed" = "confirmed") {
    const f = await acceptedRemoteExport();
    const now = new Date();
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: null, failureCode: "native_finalization_superseded", failureDetail: {
        message: "remote_workspace_archive_fs_eacces", originalFailureCode: "native_workspace_sync_out_failed",
        failureCause: "remote_workspace_archive_fs_eacces", workspaceFinalizeAttempt: 1,
        recoveryOwner: { kind: "none", reason: "newer_native_decision" } } })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: now, controllerLeaseExpiresAt: null,
      errorCode: "native_finalization_superseded",
      error: "A newer run already decided this task, so this run's result was kept for reference and not applied.",
      resultJson: { ...source.resultJson, failureCode: "native_finalization_superseded",
        failureCause: "remote_workspace_archive_fs_eacces", originalFailureCode: "native_workspace_sync_out_failed",
        finalizationPhase: "terminal_failure" } }).where(eq(heartbeatRuns.id, f.runId));
    // The retirement resolved the finalizer's own recovery action.
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "false_positive", resolvedAt: now,
      cause: "native_workspace_sync_out_failed", evidence: { runId: f.runId } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    const [lease] = await db.update(environmentLeases).set({ leasePolicy: "ephemeral" })
      .where(eq(environmentLeases.id, f.lease.id)).returning();
    if (stop === "never_requested") {
      // The run's own release never stopped its sandbox (for example, the
      // server that owned it was replaced mid-release): no receipt exists.
      const { remoteExecutionTermination: _receipt, ...metadata } = lease.metadata ?? {};
      await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null, metadata })
        .where(eq(environmentLeases.id, f.lease.id));
      return f;
    }
    if (stop === "destroyed") {
      await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: f.providerLeaseId, state: "destroyed" }) } })
        .where(eq(environmentLeases.id, f.lease.id));
      return f;
    }
    const stopping = (await prepareStoppedSandboxForRecovery(db, lease))!;
    await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } });
    return f;
  }

  async function preservation(f: { companyId: string; runId: string }) {
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    return rows.find(row => row.evidence.runId === f.runId && row.evidence.workspaceRestoreRecovery) ?? null;
  }

  async function settleThroughProjectionWorker(f: { companyId: string; issueId: string; runId: string }) {
    const work = nativeRunProjectionWork(db);
    const entries = (await work.load({ companyId: f.companyId })).filter(entry => entry.id === f.runId);
    for (const entry of entries) await work.check(entry);
    return entries.length;
  }

  it("records the files for automatic recovery, saves them from the retained sandbox and frees the workspace", async () => {
    const f = await supersededExport();
    const [result] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    expect(authority).toMatchObject({ writerRunId: f.runId, dirty: true });

    // The native run projection worker finds the ended run at startup and
    // records the retained-file obligation the superseded retirement skipped.
    expect(await settleThroughProjectionWorker(f)).toBe(1);
    const hold = await preservation(f);
    expect(hold).not.toBeNull();
    expect(hold!.evidence).toMatchObject({ supersededWorkspaceExport: { runId: f.runId } });
    expect((await run(f.runId)).resultJson).toMatchObject({ workspaceRestoreRecovery: { leaseIds: [f.lease.id] } });
    // A second pass finds nothing left to do.
    expect(await settleThroughProjectionWorker(f)).toBe(0);

    // While Paperclip saves those files, the workspace waits for that save.
    const held = await readRemoteWorkspaceWriterHold(db, { companyId: f.companyId, authority });
    expect(held).toMatchObject({ kind: "held", writer: { runId: f.runId, ended: true } });

    // The system workspace recovery saves the files from the retained sandbox.
    const input = { ...f.input, actionId: hold!.id };
    await adoptSystemRecovery(db, input);
    await recoverRetainedWorkspace(input);
    const recovered = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold!.id)))[0]!;
    expect(readWorkspaceRecovery(recovered.evidence)?.status).toBe("recovered");
    const saved = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    expect(saved).toMatchObject({ writerRunId: null, dirty: false });
    expect(await readRemoteWorkspaceWriterHold(db, { companyId: f.companyId, authority: saved })).toEqual({ kind: "free" });
    const loaded = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: saved.snapshotId! });
    try { expect(await readFile(path.join(loaded.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await loaded.cleanup(); }

    // The superseded result is never applied, and the task's decision stands.
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBeFalsy();
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "native_finalization_superseded", resultId: result.id });
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0]).toEqual(result);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({
      status: task.status, lastStatusDecisionId: task.lastStatusDecisionId });
  }, 60_000);

  it("continues from the last save with the files attached when every re-export fails", async () => {
    const f = await supersededExport();
    expect(await settleThroughProjectionWorker(f)).toBe(1);
    const hold = (await preservation(f))!;
    const input = { ...f.input, actionId: hold.id };
    await adoptSystemRecovery(db, input);
    // The bounded re-export budget is spent: every save failed the same way.
    const state = readSystemRecovery(hold.evidence) ?? readSystemRecovery((await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, hold.id)))[0]!.evidence)!;
    const current = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0]!;
    await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence, systemRecovery: { ...state,
      revision: state.revision + 6, phase: "preserve_files", state: "exhausted", attempts: 6, retriesUsed: 5,
      attemptId: randomUUID(), firstFailureAt: Date.now() - 30 * 60_000, deadlineAt: Date.now(), nextAttemptAt: null,
      failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "e".repeat(64) } } } })
      .where(eq(issueRecoveryActions.id, hold.id));

    await recoverRetainedWorkspace(input);

    const settled = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0]!;
    expect(settled).toMatchObject({ status: "resolved", outcome: "restored", ownerType: "system",
      resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
    expect(settled.evidence.executionReconciliation).toMatchObject({ runId: f.runId,
      retainedSourceFallback: { outcome: RETAINED_SOURCE_FALLBACK_OUTCOME, quarantine: { state: "captured" } } });
    // Plain words, no request for a person to fix anything.
    const message = readWorkspaceRecovery(settled.evidence)?.message;
    expect(message).toContain("could not save the previous run's unsaved files");
    for (const text of [settled.nextAction, message]) expect(String(text)).not.toMatch(adminText);
    // Only this run's epoch is set aside; its location stays on record and
    // the next run restores the last save into a new root.
    const after = await workspace(f.workspaceId);
    const authority = readRemoteWorkspaceAuthority(after.metadata)!;
    expect(authority).toMatchObject({ writerRunId: null, dirty: false, location: null, epoch: 2 });
    expect(after.metadata?.remoteWorkspaceAbandonedEpochs).toEqual([expect.objectContaining({ epoch: 1, runId: f.runId,
      location: expect.objectContaining({ leaseId: f.lease.id, providerLeaseId: f.providerLeaseId }) })]);
    expect(await readRemoteWorkspaceWriterHold(db, { companyId: f.companyId, authority })).toEqual({ kind: "free" });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "native_finalization_superseded" });
  }, 60_000);

  async function checkThroughProjectionWorker(f: { companyId: string; runId: string }) {
    const work = nativeRunProjectionWork(db);
    const [entry] = (await work.load({ companyId: f.companyId, runId: f.runId })).filter(item => item.id === f.runId);
    return entry ? await work.check(entry) : undefined;
  }
  const endedAgo = (f: { runId: string }, ms: number) => db.update(heartbeatRuns)
    .set({ finishedAt: new Date(Date.now() - ms) }).where(eq(heartbeatRuns.id, f.runId));
  const lease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const notices = async (f: { companyId: string; runId: string }) => (await db.select().from(activityLog)
    .where(eq(activityLog.companyId, f.companyId))).filter(row => row.action === SUPERSEDED_EXPORT_STOP_NOTICE && row.runId === f.runId);
  async function writerHold(f: { companyId: string; workspaceId: string }) {
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    return readRemoteWorkspaceWriterHold(db, { companyId: f.companyId, authority });
  }

  it("checks again every minute while the run's own release may still stop its sandbox", async () => {
    const f = await supersededExport("never_requested");
    const before = Date.now();
    const next = await checkThroughProjectionWorker(f);
    expect(next?.dueAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(next!.dueAt).toBeLessThan(before + 5 * 60_000);
    // Nothing is recorded or stopped yet, and the workspace keeps its writer.
    expect(await preservation(f)).toBeNull();
    expect(await lease(f.lease.id)).toMatchObject({ status: "active" });
    expect(await writerHold(f)).toMatchObject({ kind: "held", writer: { runId: f.runId } });
    expect(await notices(f)).toEqual([]);
  }, 60_000);

  it("stops and keeps the sandbox itself when no stop receipt arrived, and records the files once the late receipt lands", async () => {
    const f = await supersededExport("never_requested");
    await endedAgo(f, 2 * 60 * 60_000);
    const before = Date.now();
    const next = await checkThroughProjectionWorker(f);
    // Paperclip asked for the stop-and-retain; the cleanup sweep dispatches it.
    const stopping = await lease(f.lease.id);
    expect(stopping).toMatchObject({ status: "pending_cleanup" });
    expect(readStopOnlyCleanup(stopping)).toMatchObject({ runId: f.runId, leaseId: f.lease.id });
    // The check is not dropped, and the workspace stays held while the sandbox may still run.
    expect(next?.dueAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(await preservation(f)).toBeNull();
    expect(await writerHold(f)).toMatchObject({ kind: "held", writer: { runId: f.runId } });
    // A second pass does not request another stop.
    await checkThroughProjectionWorker(f);
    expect((await lease(f.lease.id)).metadata).toEqual(stopping.metadata);

    // The provider's late receipt wakes the native run projection work...
    let woken = 0;
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.nativeRunProjection, () => { woken++; });
    try {
      expect(await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata!.pendingCleanupAttemptId),
        receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } })).not.toBeNull();
      await vi.waitFor(() => expect(woken).toBeGreaterThan(0));
    } finally { unsubscribe(); }
    // ...which records the files for the system workspace recovery.
    expect(await checkThroughProjectionWorker(f)).toBeNull();
    const hold = await preservation(f);
    expect(hold?.evidence).toMatchObject({ supersededWorkspaceExport: { runId: f.runId } });
    const input = { ...f.input, actionId: hold!.id };
    await adoptSystemRecovery(db, input);
    await recoverRetainedWorkspace(input);
    expect(await writerHold(f)).toEqual({ kind: "free" });
    expect(await notices(f)).toEqual([]);
  }, 60_000);

  it("names the unconfirmed stop on the task once, and keeps checking, when the provider never confirms it", async () => {
    const f = await supersededExport("never_requested");
    await endedAgo(f, 2 * 60 * 60_000);
    await checkThroughProjectionWorker(f);
    await endedAgo(f, 7 * 60 * 60_000);
    const before = Date.now();
    const next = await checkThroughProjectionWorker(f);
    expect(next?.dueAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    await checkThroughProjectionWorker(f);
    const logged = await notices(f);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ entityType: "issue", entityId: f.issueId, actorType: "system",
      details: { runId: f.runId, reason: "stop_unconfirmed" } });
    // No second writer: the files are not set aside while the sandbox may still run.
    expect(await preservation(f)).toBeNull();
    expect(await writerHold(f)).toMatchObject({ kind: "held", writer: { runId: f.runId } });
  }, 60_000);

  it("continues from the last save when the provider confirms the sandbox is gone", async () => {
    const f = await supersededExport("destroyed");
    expect(await checkThroughProjectionWorker(f)).toBeNull();
    // Only this run's epoch is set aside; the queued runs start from the last save.
    const after = await workspace(f.workspaceId);
    expect(readRemoteWorkspaceAuthority(after.metadata)).toMatchObject({ writerRunId: null, dirty: false, location: null, epoch: 2 });
    expect(after.metadata?.remoteWorkspaceAbandonedEpochs).toEqual([expect.objectContaining({ epoch: 1, runId: f.runId })]);
    expect(await writerHold(f)).toEqual({ kind: "free" });
    const said = (await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)))
      .filter(row => row.action === SUPERSEDED_EXPORT_FILES_GONE);
    expect(said).toEqual([expect.objectContaining({ entityId: f.issueId, runId: f.runId })]);
    // Nothing is left to do, and the superseded result is still not applied.
    expect(await settleThroughProjectionWorker(f)).toBe(0);
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBeFalsy();
    expect(await notices(f)).toEqual([]);
  }, 60_000);

  it("continues from the last save when Paperclip's own stop finds the sandbox already gone", async () => {
    const f = await supersededExport("never_requested");
    await endedAgo(f, 2 * 60 * 60_000);
    await checkThroughProjectionWorker(f);
    const stopping = await lease(f.lease.id);
    // The provider answers the stop-only dispatch with its "gone" receipt
    // (boxd: destroyed; Daytona: not found, reported as destroyed).
    let woken = 0;
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.nativeRunProjection, () => { woken++; });
    try {
      expect(await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata!.pendingCleanupAttemptId),
        receipt: { providerLeaseId: f.providerLeaseId, state: "destroyed" } })).toMatchObject({ status: "released" });
      await vi.waitFor(() => expect(woken).toBeGreaterThan(0));
    } finally { unsubscribe(); }
    expect((await lease(f.lease.id)).metadata).not.toHaveProperty("sandboxStopAndRetainReceipt");
    expect(await checkThroughProjectionWorker(f)).toBeNull();
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata))
      .toMatchObject({ writerRunId: null, dirty: false, epoch: 2 });
    expect(await writerHold(f)).toEqual({ kind: "free" });
    expect(await preservation(f)).toBeNull();
  }, 60_000);

  it("never stops a sandbox a retained warm lease still holds, says so once and keeps checking", async () => {
    const f = await supersededExport("never_requested");
    await endedAgo(f, 2 * 60 * 60_000);
    const source = await lease(f.lease.id);
    const { id: _id, ...shape } = source;
    await db.insert(environmentLeases).values({ ...shape, id: randomUUID(), heartbeatRunId: null, status: "retained",
      leasePolicy: "reuse_by_environment", releasedAt: null, metadata: { remoteCwd: source.metadata?.remoteCwd } });
    const before = Date.now();
    const next = await checkThroughProjectionWorker(f);
    expect(next?.dueAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    // The source lease is untouched: no stop intent was written.
    expect(await lease(f.lease.id)).toEqual(source);
    expect((await notices(f)).map(row => row.details)).toEqual([expect.objectContaining({ reason: "sandbox_in_use" })]);
    expect(await writerHold(f)).toMatchObject({ kind: "held", writer: { runId: f.runId } });
  }, 60_000);

  it("leaves a superseded result alone when it never failed in the workspace export", async () => {
    const f = await supersededExport();
    await db.update(nativeRunFinalizations).set({ failureDetail: { originalFailureCode: "native_status_conflict",
      recoveryOwner: { kind: "none", reason: "newer_native_decision" } } }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await settleThroughProjectionWorker(f)).toBe(0);
    expect(await preservation(f)).toBeNull();
  }, 60_000);
});
