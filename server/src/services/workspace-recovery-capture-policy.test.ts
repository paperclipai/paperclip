import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getExecutionBlocker } from "./execution-blocker.js";
import { REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION } from "./remote-workspace-snapshot-archive.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { reconcileRetainedWorkspaces, recoverRetainedWorkspace, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import { acceptedRemoteExport, action, connectionString, db, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

const adminText = /sandbox|environment|administrator|board member|owner must|inspect the run/i;

describe("saves exhausted under an older workspace capture policy", () => {
  useWorkspaceRecoveryFixture(targets);
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /**
   * The staging shape (Nov 10): the run's save was refused with
   * `remote_workspace_archive_unsafe_symlink` because a headless Chromium
   * profile in the workspace linked its SingletonSocket by absolute path into
   * /tmp. Automatic recovery then spent its whole budget on the same refusal,
   * recorded as `export_interrupted` with cause `provider_error`, and handed
   * the hold to the board. This is the exact evidence that release saved.
   */
  async function exhaustedCaptureHold(policyVersion?: number) {
    const f = await acceptedRemoteExport("retained");
    const outside = path.join(path.dirname(f.remote), "sandbox-tmp");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SingletonSocket"), "SYNTHETIC_SANDBOX_ONLY\n");
    await mkdir(path.join(f.remote, "node_modules", "tool"), { recursive: true });
    await mkdir(path.join(f.remote, "node_modules", ".bin"));
    await writeFile(path.join(f.remote, "node_modules", "tool", "cli.js"), "cli\n");
    await symlink("../tool/cli.js", path.join(f.remote, "node_modules", ".bin", "tool"));
    await mkdir(path.join(f.remote, ".review-chrome"));
    await symlink(path.join(outside, "SingletonSocket"), path.join(f.remote, ".review-chrome", "SingletonSocket"));
    await symlink("../sandbox-tmp/SingletonSocket", path.join(f.remote, "escape"));
    const prior = await action(f.actionId);
    const current = readSystemRecovery(prior.evidence)!;
    const firstFailureAt = Date.now() - 60 * 60_000;
    const nextAction = "Automatic recovery of saved work stopped after 6 attempts (last failure: export_interrupted, cause: provider_error). "
      + "Retry to try again; the agent will not repeat its work.";
    const { capturePolicyVersion: _omitted, ...saved } = current as typeof current & { capturePolicyVersion?: number };
    await db.update(issueRecoveryActions).set({ ownerType: "board", nextAction, evidence: { ...prior.evidence,
      systemRecovery: { ...saved, ...(policyVersion === undefined ? {} : { capturePolicyVersion: policyVersion }),
        revision: 18, phase: "preserve_files", state: "exhausted", attempts: 6, retriesUsed: 5,
        attemptId: randomUUID(), firstFailureAt, deadlineAt: firstFailureAt + 30 * 60_000, nextAttemptAt: null,
        failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "9".repeat(64),
          cause: { code: null, label: "provider_error", status: null } } },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "restoring_files",
        attempt: 6, attemptLimit: 6, retryable: true, message: nextAction, requestIds: [] } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    return f;
  }

  it("retries once under the new policy and saves the files without a person", async () => {
    const f = await exhaustedCaptureHold();

    // The recovery worker discovers the hold and wakes for it.
    expect(await nextWorkspaceRecoveryAt(db)).toBeLessThanOrEqual(Date.now());
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).toContain(f.actionId);
    const onRecovered = vi.fn(async () => undefined);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true) ?? []);

    const settled = await action(f.actionId);
    const state = readSystemRecovery(settled.evidence)!;
    expect(state).toMatchObject({ state: "complete", capturePolicyVersion: REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION });
    expect(state.preservationOperationIds.length).toBeGreaterThan(0);
    expect(readWorkspaceRecovery(settled.evidence)?.status).toBe("recovered");
    expect(settled.evidence.capturePolicyRecovery).toMatchObject({ schema: "paperclip.capture-policy-recovery.v1",
      policyVersion: REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION });
    expect(settled.ownerType).toBe("system");
    expect(String(settled.nextAction)).not.toMatch(adminText);
    expect(onRecovered).toHaveBeenCalledTimes(1);

    const authority = readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, f.workspaceId)))[0]!.metadata)!;
    expect(authority).toMatchObject({ dirty: false });
    expect(authority.snapshotId).not.toBeNull();
    // The source workspace is untouched; nothing followed the outside links.
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");

    const rearmed = await db.select().from(activityLog).where(eq(activityLog.action, "issue.workspace_recovery_rearmed"));
    expect(rearmed).toEqual([expect.objectContaining({ actorType: "system", entityId: f.issueId, runId: f.runId,
      details: expect.objectContaining({ reason: "capture_policy_changed" }) })]);
  }, 60_000);

  /**
   * The full staging record of the same incident. The run's export hold
   * (cause native_workspace_sync_out_retry_exhausted) names its source through
   * historicalWorkspaceSource and the run's workspaceRestoreRecovery. A later
   * "try again" comment opened a second, no-replay hold for the same run
   * (native_continuation_requires_reconciliation, preserve_without_replay_v1).
   * Its six attempts failed the same way and it was recorded
   * resolved-but-blocked. That second hold is the task's execution blocker.
   */
  async function stagingIncident(failureBlock: boolean) {
    const f = await exhaustedCaptureHold();
    const exportHold = await action(f.actionId);
    const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] };
    const source = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    await db.update(heartbeatRuns).set({ errorCode: "native_workspace_sync_out_retry_exhausted",
      error: "Saving the workspace failed after 3 attempts. The agent's result is kept; follow the run's recovery action to repair the workspace. "
        + "Last cause: remote_workspace_archive_unsafe_symlink",
      resultJson: { ...source.resultJson, failureCode: "native_workspace_sync_out_retry_exhausted",
        failureCause: "remote_workspace_archive_unsafe_symlink", nextAttemptAt: null, finalizationPhase: "terminal_failure",
        originalFailureCode: "native_workspace_sync_out_failed", workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: recovery, systemRecoveryAdoption: { actionId: f.actionId, policyVersion: 1 } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issueRecoveryActions).set({ kind: "active_run_watchdog", returnOwnerAgentId: source.agentId, maxAttempts: 3,
      evidence: { ...exportHold.evidence, coordinatorAttempt: 1, originalFailureCode: "native_workspace_sync_out_failed",
        systemRecoveryActiveAt: Date.now() - 50 * 60_000, workspaceFinalizeAttempt: 3, previousWorkspaceRecovery: null,
        historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: f.runId, leaseIds: [f.lease.id] } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const exhausted = readSystemRecovery((await action(f.actionId)).evidence)!;
    const [task] = await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId)).returning();
    const noReplayHoldId = randomUUID(), resolvedAt = new Date(Date.now() - 30 * 60_000);
    await db.insert(issueRecoveryActions).values({ id: noReplayHoldId, companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board", resolvedAt,
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-workspace:${f.runId}`,
      nextAction: exportHold.nextAction, evidence: { runId: f.runId,
        systemRecovery: { ...exhausted, generationId: randomUUID(), attemptId: randomUUID() },
        automaticRecovery: { runId: f.runId, policy: "preserve_without_replay_v1", replay: "blocked",
          recordedAt: resolvedAt.toISOString(), actionOutcome: "unknown" },
        workspaceRecovery: exportHold.evidence.workspaceRecovery,
        originalFailureCode: "native_workspace_sync_out_retry_exhausted", continuationDelivery: "invalidated",
        systemRecoveryActiveAt: Date.now() - 40 * 60_000, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: recovery, previousWorkspaceRecovery: null,
        // Rows of the same release that recorded the Blocked status their run's
        // failure set, and the historical source an older adoption named.
        ...(failureBlock ? { nativeFailureBlock: { runId: f.runId, statusVersion: Number(task.statusVersion) },
          historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: f.runId, leaseIds: [f.lease.id] } } : {}) } });
    // The user's "try again" comment waits for the task to be free.
    const [waiting] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: source.agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "operator",
      payload: { issueId: f.issueId } }).returning();
    return { ...f, noReplayHoldId, waitingInputId: waiting.id };
  }

  it.each([["as recorded on staging", false], ["that owns the task's Blocked status", true]] as const)(
    "settles the export hold and a resolved no-replay sibling %s without a person", async (_shape, failureBlock) => {
    const f = await stagingIncident(failureBlock);
    // As on staging: the no-replay sibling is the execution blocker, and it
    // offers no task Retry.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.noReplayHoldId,
      workspaceRepairRequired: true, canRetry: false });

    // The recovery worker's own discovery, as after a deploy: it runs while
    // work is due and goes idle once nothing is.
    const blockersSeenByContinuation: unknown[] = [];
    // Normal dispatch consumes the saved input once nothing blocks the task.
    const onRecovered = vi.fn(async () => {
      const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
      blockersSeenByContinuation.push(blocker);
      if (!blocker) await db.update(agentWakeupRequests).set({ status: "queued" }).where(eq(agentWakeupRequests.id, f.waitingInputId));
    });
    let passes = 0;
    for (; passes < 6; passes += 1) {
      const due = await nextWorkspaceRecoveryAt(db);
      if (due === null || due > Date.now()) break;
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true) ?? []);    }
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(6);

    const saved = await action(f.actionId);
    expect(readSystemRecovery(saved.evidence)).toMatchObject({ state: "complete", capturePolicyVersion: REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION });
    expect(readWorkspaceRecovery(saved.evidence)?.status).toBe("recovered");
    expect(saved.ownerType).toBe("system");

    // The no-replay sibling of the same run is settled by that save and no
    // longer holds the task. Settling it replays nothing.
    const sibling = await action(f.noReplayHoldId);
    expect(sibling).toMatchObject({ status: "resolved", outcome: "restored", ownerType: "system",
      resolutionNote: "workspace_recovered_by_sibling_action" });
    expect(sibling.evidence.automaticRecovery).toBeUndefined();
    expect(sibling.evidence.siblingWorkspaceRecovery).toMatchObject({ recoveryActionId: f.actionId });
    expect(readWorkspaceRecovery(sibling.evidence)?.status).toBe("recovered");
    expect(String(sibling.nextAction)).not.toMatch(adminText);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // The continuation hook ran once the task was free, so saved input is dispatched.
    expect(blockersSeenByContinuation.at(-1)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(row => row.id)).toEqual([f.runId]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.waitingInputId)))[0]!.status).toBe("queued");
    // A hold that owned the Blocked status releases it; otherwise the status is
    // left to the run's own result finalization.
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    if (failureBlock) expect(task!.status).toBe("todo");
    // Bounded: one re-arm, and the worker has nothing left to do.
    const next = await nextWorkspaceRecoveryAt(db);
    expect(next === null || next > Date.now()).toBe(true);
    expect((await db.select().from(activityLog).where(eq(activityLog.action, "issue.workspace_recovery_rearmed")))
      .filter(row => row.entityId === f.issueId)).toHaveLength(1);
    // A later pass, even with new saved input, never selects or hands off the settled hold again.
    await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution" }).where(eq(agentWakeupRequests.id, f.waitingInputId));
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).not.toContain(f.noReplayHoldId);
    expect((await retainedWorkspaceCandidates(db)).map(row => row.action.id)).not.toContain(f.noReplayHoldId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true) ?? []);
    expect(await action(f.noReplayHoldId)).toEqual(sibling);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  }, 90_000);

  it("re-arms a save whose finished coordinator still names a lapsed finalizer owner", async () => {
    const f = await stagingIncident(false);
    const exportHold = await action(f.actionId);
    const source = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    await db.update(issueRecoveryActions).set({ evidence: { ...exportHold.evidence, workspaceFinalizationBlock: {
      schema: "paperclip.native-workspace-finalization-block.v1", runId: f.runId, agentId: source.agentId, issueId: f.issueId,
      companyId: f.companyId, resultId: f.resultId, contractId: source.completionContractId, resultSha256: "5".repeat(64),
      contractSha256: "0".repeat(64), statusVersion: 7, priorDecisionId: null, identityContextId: randomUUID(),
      responsibleUserId: "board" } } }).where(eq(issueRecoveryActions.id, f.actionId));
    const lapsedOwner = `native-finalizer:${randomUUID()}`;
    await db.update(nativeRunFinalizations).set({ leaseOwner: lapsedOwner, leaseExpiresAt: new Date(Date.now() - 8 * 60 * 60_000),
      controllerBootId: randomUUID(), controllerPid: 2_147_000_000 }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure" });

    expect(await nextWorkspaceRecoveryAt(db)).toBeLessThanOrEqual(Date.now());
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).toContain(f.actionId);
    let passes = 0;
    for (; passes < 6; passes += 1) {
      const due = await nextWorkspaceRecoveryAt(db);
      if (due === null || due > Date.now()) break;
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => undefined, true) ?? []);
    }
    expect(passes).toBeLessThan(6);

    const saved = await action(f.actionId);
    expect(readSystemRecovery(saved.evidence)).toMatchObject({ state: "complete", capturePolicyVersion: REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION });
    expect(readWorkspaceRecovery(saved.evidence)?.status).toBe("recovered");
    expect(saved.evidence.capturePolicyRecovery).toMatchObject({ releasedLapsedOwner: true });
    expect(saved.ownerType).toBe("system");
    expect(String(saved.nextAction)).not.toMatch(adminText);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]?.leaseOwner)
      .not.toBe(lapsedOwner);
  }, 90_000);

  it("does not re-arm a save that the current policy already exhausted", async () => {
    const f = await exhaustedCaptureHold(REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION);
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).not.toContain(f.actionId);
    const next = await nextWorkspaceRecoveryAt(db);
    expect(next === null || next > Date.now()).toBe(true);
    await recoverRetainedWorkspace(f.input);
    const held = await action(f.actionId);
    expect(readSystemRecovery(held.evidence)).toMatchObject({ state: "exhausted", failure: { code: "export_interrupted" } });
    expect(held.evidence.capturePolicyRecovery).toBeUndefined();
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
  }, 60_000);
});
