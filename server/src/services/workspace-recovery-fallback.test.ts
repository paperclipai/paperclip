import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, assets, environmentLeases, executionWorkspaces, heartbeatRuns, issueAttachments, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readRemoteWorkspaceAuthority, type EnvironmentLease } from "@paperclipai/shared";
import { getStorageService } from "../storage/index.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";
import { prepareRemoteWorkspace, reserveRemoteWorkspace, saveRemoteWorkspace } from "./remote-workspaces.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { reconcileRetainedWorkspaces, recoverRetainedWorkspace, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { RETAINED_SOURCE_FALLBACK_OUTCOME, RETAINED_SOURCE_QUARANTINE_PHASE } from "./workspace-recovery-fallback.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { acceptedRemoteExport, action, connectionString, db, run, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

// Recovery text never asks a person to inspect or fix a sandbox.
const adminText = /sandbox|environment|administrator|board member|owner must|inspect the run/i;
const workspace = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;

describe("retained source fallback", () => {
  useWorkspaceRecoveryFixture(targets);
  // Remote workspace storage needs external Postgres and a stable key, for
  // the checkpoint save and the later restore alike.
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /**
   * A child task's run saved a checkpoint (the last committed
   * snapshot), then wrote more files and failed to save them. Its reusable
   * sandbox lease history crosses into the parent task, so the recorded source
   * is refused with allocation_ownership_ambiguous on every attempt.
   */
  async function unverifiableRetainedSource(saved: "old_release" | "fresh" = "old_release") {
    const f = await acceptedRemoteExport("retained");
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const checkpoint = await saveRemoteWorkspace({ db, workspace: await workspace(f.workspaceId), runId: f.runId,
      lease: lease as EnvironmentLease, target: targets.get(f.lease.id)!, assertOwned: async () => {}, boundary: "checkpoint" });
    // The published root a later preparation would otherwise reuse.
    await db.update(executionWorkspaces).set({ providerRef: f.remote }).where(eq(executionWorkspaces.id, f.workspaceId));
    await writeFile(path.join(f.remote, "unverified.txt"), "unsaved work\n");
    const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Parent task" }).returning();
    await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, f.issueId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: lease.environmentId, issueId: parent.id,
      provider: "daytona", providerLeaseId: f.providerLeaseId, status: "expired", leasePolicy: "reuse_by_environment",
      cleanupStatus: "success", releasedAt: new Date(), metadata: { remoteCwd: path.dirname(f.remote) } });
    await db.update(nativeRunFinalizations).set({ failureCode: "native_workspace_sync_out_retry_exhausted" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const oldMessage = "Automatic recovery of saved work stopped after 1 attempts (last failure: allocation_ownership_ambiguous). "
      + "Retry recovery to export and merge from the retained sandbox again; no provider turn is submitted. "
      + "If Retry keeps failing, inspect the run and its environment.";
    if (saved === "old_release") {
      // The exact shape saved by the Nov 3-6 releases.
      const current = readSystemRecovery((await action(f.actionId)).evidence)!;
      await db.update(issueRecoveryActions).set({ ownerType: "board", nextAction: oldMessage, evidence: { ...(await action(f.actionId)).evidence,
        systemRecovery: { ...current, revision: current.revision + 5, phase: "verify_execution", state: "exhausted", attempts: 1,
          attemptId: randomUUID(), firstFailureAt: Date.now() - 60_000, deadlineAt: Date.now() + 60_000, nextAttemptAt: null,
          failure: { code: "allocation_ownership_ambiguous", retryClass: "service_required", evidenceFingerprint: "a".repeat(64) } },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "verifying_stop",
          attempt: 1, attemptLimit: 6, retryable: true, requestIds: [], message: oldMessage } } })
        .where(eq(issueRecoveryActions.id, f.actionId));
    }
    return { ...f, snapshotId: checkpoint.snapshotId, parentIssueId: parent.id };
  }

  async function continuationBlock(f: { companyId: string; issueId: string; runId: string }) {
    const source = await run(f.runId);
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "Please continue" }).returning();
    const reasons: string[] = [];
    await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: source.agentId,
      actorType: "user", actorId: "operator", reason: "issue_commented", commentId: comment.id, successorRunId: randomUUID(),
      dryRun: true, onBlocked: reason => reasons.push(reason) });
    return reasons;
  }

  it.each(["old_release", "fresh"] as const)("continues a cross-task retained hold (%s) from the last save, quarantined and without reusing its root", async saved => {
    const f = await unverifiableRetainedSource(saved);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.workspaceRepairRequired).toBe(true);
    if (saved === "fresh") {
      // A current release records which Blocked status version this hold owns.
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const source = await run(f.runId);
      await db.update(issueRecoveryActions).set({ evidence: { ...(await action(f.actionId)).evidence, workspaceFinalizationBlock: {
        schema: "paperclip.native-workspace-finalization-block.v1", companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        agentId: source.agentId, resultId: f.resultId, resultSha256: "result", contractId: source.completionContractId,
        contractSha256: "contract", identityContextId: null, responsibleUserId: null,
        statusVersion: Number(task.statusVersion), priorDecisionId: task.lastStatusDecisionId } } })
        .where(eq(issueRecoveryActions.id, f.actionId));
    }

    await recoverRetainedWorkspace(f.input);

    const settled = await action(f.actionId);
    expect(settled).toMatchObject({ status: "resolved", outcome: "restored", ownerType: "system",
      resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME, returnOwnerAgentId: (await run(f.runId)).agentId });
    expect(readSystemRecovery(settled.evidence)?.failure?.code).toBe("allocation_ownership_ambiguous");
    const decision = settled.evidence.executionReconciliation as Record<string, unknown>;
    expect(decision).toMatchObject({ runId: f.runId, providerStopped: true, actionOutcome: "completed",
      retainedSourceFallback: { outcome: RETAINED_SOURCE_FALLBACK_OUTCOME, snapshotId: f.snapshotId,
        quarantine: { state: "captured" } } });
    expect(settled.evidence.continuationDelivery).toBe("pending");
    for (const text of [settled.nextAction, readWorkspaceRecovery(settled.evidence)?.message, decision.outcomeEvidence])
      expect(String(text)).not.toMatch(adminText);
    expect(String(decision.outcomeEvidence)).toContain(f.snapshotId);

    // The unverified files are attached to the task, never applied.
    const quarantine = (decision.retainedSourceFallback as { quarantine: { attachmentId: string; sha256: string } }).quarantine;
    const [attachment] = await db.select({ asset: assets }).from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId)).where(eq(issueAttachments.id, quarantine.attachmentId));
    expect(attachment.asset).toMatchObject({ companyId: f.companyId, sha256: quarantine.sha256, contentType: "application/x-tar" });
    const scratch = await mkdtemp(path.join(os.tmpdir(), "quarantine-check-"));
    try {
      const object = await getStorageService().getObject(f.companyId, attachment.asset.objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of object.stream) chunks.push(chunk as Buffer);
      await writeFile(path.join(scratch, "files.tar"), Buffer.concat(chunks));
      const listing = await new Promise<string>((resolve, reject) => execFile("tar", ["-tf", path.join(scratch, "files.tar")],
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      expect(listing).toContain("unverified.txt");
    } finally { await rm(scratch, { recursive: true, force: true }); }

    // The unverified epoch is abandoned: no writer, not dirty, the last save kept, no location.
    const abandoned = await workspace(f.workspaceId);
    const before = (await run(f.runId)).runnerProfileJson!.remoteWorkspace as { epoch: number };
    expect(readRemoteWorkspaceAuthority(abandoned.metadata)).toMatchObject({ epoch: before.epoch + 1, writerRunId: null,
      dirty: false, location: null, snapshotId: f.snapshotId });
    expect(abandoned.providerRef).toBeNull();

    // Every gate is settled: the task hold, the repair flag and the saved-work wait.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // Only a Blocked status this hold owns is restored; an unproven block is kept.
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe(saved === "fresh" ? "todo" : "blocked");
    expect(await continuationBlock(f)).not.toEqual(expect.arrayContaining(["saved_work_recovery_failed"]));
    expect(await continuationBlock(f)).not.toEqual(expect.arrayContaining(["workspace_repair_required"]));

    // One continuation is delivered through the normal reconciled path.
    const wake = vi.fn(async () => ({ id: randomUUID() }));
    await deliverReconciledExecutions(db, wake as never);
    await deliverReconciledExecutions(db, wake as never);
    const calls = wake.mock.calls.filter(call => (call as unknown[])[0] === settled.returnOwnerAgentId);
    expect(calls).toHaveLength(1);
    expect((calls[0] as unknown[])[1]).toMatchObject({ reason: "issue_recovery_action_restored",
      contextSnapshot: { issueId: f.issueId, previousRunId: f.runId, forceFreshSession: true, source: "execution.reconciled" } });

    // The next writer restores the last save into a new root; the old root is untouched.
    const source = await run(f.runId);
    const nextRunId = randomUUID(), nextLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: source.agentId, issueId: f.issueId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issueId } });
    const storage = { ...getStorageService(), provider: "s3" as const };
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: f.issueId, runId: nextRunId,
      agentId: source.agentId, environmentId: f.lease.environmentId!, projectId: null, projectWorkspaceId: null,
      existingWorkspaceId: f.workspaceId, source: { kind: "empty" } });
    const [nextLease] = await db.insert(environmentLeases).values({ id: nextLeaseId, companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: nextRunId, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: f.providerLeaseId,
      status: "active", leasePolicy: "reuse_by_environment" }).returning();
    const oldRoot = await realpath(f.remote), base = path.dirname(path.dirname(oldRoot));
    const sandbox = targets.get(f.lease.id)!;
    // The same sandbox: transfers into it are plain copies.
    const runner = { ...sandbox.runner!, syncIn: async (operations: Parameters<NonNullable<typeof sandbox.runner>["syncOut"] & {}>[0]) => {
      for (const operation of operations) for (const file of operation.files)
        await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
      return { filesTransferred: 1, bytesTransferred: 0, operations: [] };
    } };
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: nextRunId,
      lease: nextLease as EnvironmentLease, target: { ...sandbox, runner, leaseId: nextLeaseId, remoteCwd: base } });
    expect(prepared.remoteRoot).not.toBe(oldRoot);
    expect(path.dirname(prepared.remoteRoot)).toBe(path.dirname(oldRoot));
    expect(await readFile(path.join(prepared.remoteRoot, "saved.txt"), "utf8")).toBe("finished work\n");
    await expect(readFile(path.join(prepared.remoteRoot, "unverified.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.remote, "unverified.txt"), "utf8")).toBe("unsaved work\n");
  }, 60_000);

  it("still continues when the retained root cannot be read, recording why", async () => {
    const f = await unverifiableRetainedSource();
    await rm(f.remote, { recursive: true, force: true });
    await recoverRetainedWorkspace(f.input);
    const settled = await action(f.actionId);
    expect(settled).toMatchObject({ status: "resolved", resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
    const fallback = (settled.evidence.executionReconciliation as { retainedSourceFallback: { quarantine: { state: string; reason: string } } })
      .retainedSourceFallback;
    expect(fallback.quarantine.state).toBe("unreadable");
    expect(fallback.quarantine.reason).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(String(settled.nextAction)).not.toMatch(adminText);
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toMatchObject({ writerRunId: null, dirty: false,
      location: null, snapshotId: f.snapshotId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, f.issueId))).toHaveLength(0);
  }, 60_000);

  it("is idempotent: a second pass changes nothing and delivers no second continuation", async () => {
    const f = await unverifiableRetainedSource();
    const agentId = (await run(f.runId)).agentId;
    await recoverRetainedWorkspace(f.input);
    const first = await action(f.actionId), firstWorkspace = await workspace(f.workspaceId);
    await recoverRetainedWorkspace(f.input);
    expect(await action(f.actionId)).toEqual(first);
    expect(await workspace(f.workspaceId)).toEqual(firstWorkspace);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, RETAINED_SOURCE_QUARANTINE_PHASE)))).toHaveLength(1);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, f.issueId))).toHaveLength(1);
    const wake = vi.fn(async () => ({ id: randomUUID() }));
    await deliverReconciledExecutions(db, wake as never);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake.mock.calls.filter(call => (call as unknown[])[0] === agentId)).toHaveLength(1);
  }, 60_000);

  it("leaves saved user input to continue the task instead of starting a second continuation", async () => {
    const f = await unverifiableRetainedSource();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: (await run(f.runId)).agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "operator",
      payload: { issueId: f.issueId } });
    await recoverRetainedWorkspace(f.input);
    const settled = await action(f.actionId);
    expect(settled).toMatchObject({ status: "resolved", resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
    expect(settled.evidence.continuationDelivery).toBe("not_requested");
  }, 60_000);

  it.each(["live_writer", "pending_side_effect", "uncertain_external_action", "sandbox_in_use"] as const)(
    "keeps the hold and starts no executor with a %s", async fault => {
      const f = await unverifiableRetainedSource();
      const source = await run(f.runId);
      if (fault === "live_writer") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
        issueId: f.issueId, runtimeMode: "native", status: "running", startedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
      if (fault === "sandbox_in_use") {
        // The source allocation has no stop receipt, and another task holds the sandbox.
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        const metadata = { ...lease.metadata }; delete metadata.remoteExecutionTermination;
        await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, f.lease.id));
        await db.update(environmentLeases).set({ status: "active", releasedAt: null }).where(and(
          eq(environmentLeases.issueId, f.parentIssueId), eq(environmentLeases.providerLeaseId, f.providerLeaseId)));
      }
      if (fault === "pending_side_effect" || fault === "uncertain_external_action") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson, apiToolReceipts: {
        effect: fault === "pending_side_effect" ? { state: "pending", operationId: "POST /api/x" }
          : { state: "completed", operationId: "POST /api/x", result: { ok: false, status: 502 } } } } }).where(eq(heartbeatRuns.id, f.runId));
      const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata);
      await recoverRetainedWorkspace(f.input);
      const held = await action(f.actionId);
      expect(held.status).toBe("active");
      expect(held.evidence.executionReconciliation).toBeUndefined();
      expect(held.evidence.continuationDelivery).toBeUndefined();
      expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toEqual(authority);
      expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, f.issueId))).toHaveLength(0);
      const wake = vi.fn(async () => ({ id: randomUUID() }));
      await deliverReconciledExecutions(db, wake as never);
      expect(wake.mock.calls.filter(call => (call as unknown[])[0] === source.agentId)).toHaveLength(0);
      if (fault === "sandbox_in_use") expect(f.runtime.retryPendingSandboxTeardown).not.toHaveBeenCalled();
      // The deferral is recorded: transient waits are checked again later, a
      // permanent refusal waits for new input or a new generation.
      const check = held.evidence.retainedSourceFallbackCheck as { reason: string; nextCheckAt: number | null };
      expect(check.reason).toBe({ live_writer: "writer_active", pending_side_effect: "external_action_uncertain",
        uncertain_external_action: "external_action_uncertain", sandbox_in_use: "allocation_in_use" }[fault]);
      expect(check.nextCheckAt === null).toBe(check.reason === "external_action_uncertain");
    }, 60_000);

  it("obtains a stop receipt for an allocation that was never stopped before continuing", async () => {
    const f = await unverifiableRetainedSource();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const metadata = { ...lease.metadata }; delete metadata.remoteExecutionTermination;
    await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, f.lease.id));
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.retryPendingSandboxTeardown).toHaveBeenCalledOnce();
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
    const [stopped] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(stopped.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped", leaseId: f.lease.id });
  }, 60_000);

  it("is discovered and settled by the recovery worker without any user action", async () => {
    const f = await unverifiableRetainedSource();
    expect(await nextWorkspaceRecoveryAt(db)).toBeLessThanOrEqual(Date.now());
    const onRecovered = vi.fn(async () => undefined);
    const work = await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true);
    await Promise.all(work ?? []);
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
    expect(onRecovered).toHaveBeenCalledOnce();
    const due = await nextWorkspaceRecoveryAt(db);
    expect(due === null || due > Date.now() - 1).toBe(true);
    expect(await retainedWorkspaceCandidates(db, undefined, false, true)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: expect.objectContaining({ id: f.actionId }) })]));
  }, 60_000);

  it("waits until a deferred transient check is due before the worker visits the hold again", async () => {
    const f = await unverifiableRetainedSource();
    const source = await run(f.runId);
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, issueId: f.issueId,
      runtimeMode: "native", status: "running", startedAt: new Date(), contextSnapshot: { issueId: f.issueId } }).returning();
    const work = await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => undefined, true);
    await Promise.all(work ?? []);
    const deferred = await action(f.actionId);
    expect(deferred.status).toBe("active");
    const ids = async () => (await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id);
    expect(await ids()).not.toContain(f.actionId);
    expect(await nextWorkspaceRecoveryAt(db)).toBeGreaterThan(Date.now());
    // Once the writer ended and the check is due, the worker settles the hold.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, writer.id));
    await db.update(issueRecoveryActions).set({ evidence: { ...deferred.evidence, retainedSourceFallbackCheck: {
      ...(deferred.evidence.retainedSourceFallbackCheck as object), nextCheckAt: Date.now() - 1 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    expect(await ids()).toContain(f.actionId);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, async () => undefined, true) ?? []);
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME });
  }, 60_000);

  it("settles a stale exhausted hold as recovered when a sibling action saved the run's files", async () => {
    const f = await acceptedRemoteExport();
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issueRecoveryActions.id, f.actionId));
    const staleId = randomUUID(), now = Date.now();
    await db.insert(issueRecoveryActions).values({ id: staleId, companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board", cause: "native_workspace_sync_out_retry_exhausted",
      fingerprint: randomUUID(), nextAction: "Automatic recovery of saved work stopped after 6 attempts.",
      evidence: { runId: f.runId,
        systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, sourceRunId: f.runId, revision: 54,
          generationId: randomUUID(), intentId: null, phase: "preserve_files", state: "exhausted", attemptId: randomUUID(),
          attempts: 6, retriesUsed: 5, firstFailureAt: now - 60_000, nextAttemptAt: null, deadlineAt: now - 1, providerCooldownAt: null,
          failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "b".repeat(64) },
          preservationOperationIds: [], freshAttemptRunId: null },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "restoring_files",
          attempt: 6, attemptLimit: 6, retryable: true, requestIds: [] } } });

    await recoverRetainedWorkspace({ ...f.input, actionId: staleId });

    const stale = await action(staleId);
    expect(stale).toMatchObject({ status: "resolved", outcome: "restored", ownerType: "system",
      resolutionNote: "workspace_recovered_by_sibling_action" });
    expect(readWorkspaceRecovery(stale.evidence)?.status).toBe("recovered");
    expect(stale.evidence.siblingWorkspaceRecovery).toMatchObject({ recoveryActionId: f.actionId });
    expect(String(stale.nextAction)).not.toMatch(adminText);
    const live = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      inArray(issueRecoveryActions.status, ["active", "escalated"])));
    expect(live).toHaveLength(0);
  }, 60_000);
});
