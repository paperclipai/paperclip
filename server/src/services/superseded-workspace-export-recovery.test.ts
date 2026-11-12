import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
  nativeRunResults } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { nativeRunProjectionWork } from "./native-runtime/native-run-projection-work.js";
import { readRemoteWorkspaceWriterHold } from "./remote-workspace-writer-hold.js";
import { createSavedWorkspaceLoader } from "./remote-workspaces.js";
import { prepareStoppedSandboxForRecovery, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
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
  async function supersededExport() {
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

  it("leaves a superseded result alone when it never failed in the workspace export", async () => {
    const f = await supersededExport();
    await db.update(nativeRunFinalizations).set({ failureDetail: { originalFailureCode: "native_status_conflict",
      recoveryOwner: { kind: "none", reason: "newer_native_decision" } } }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await settleThroughProjectionWorker(f)).toBe(0);
    expect(await preservation(f)).toBeNull();
  }, 60_000);
});
