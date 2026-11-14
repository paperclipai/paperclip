import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issueRecoveryActions, workspaceOperations } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { attachPreservedRemoteWorkspaceSnapshots } from "./remote-workspace-recovery-attachments.js";
import { useWorkspaceRecoveryFixture, db, failedRemotePreparation, root, run } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

// A predecessor whose recovery receipt cannot be verified is skipped, never
// fatal: preparation attaches nothing unverified and leaves its saved state.
describe("remote workspace recovery receipt fallback", () => {
  useWorkspaceRecoveryFixture(targets);

  // Nov 10 staging: a continuation into a fresh workspace failed
  // with remote_workspace_recovery_receipt_invalid. Its predecessor restored the
  // committed save, failed before provider work, and kept a restore hold with
  // no recovery receipt. It saved the very snapshot it restored, so it left no
  // unsaved files to attach. A source that saved anything else is not attached
  // either: without a receipt it is skipped, and its saved state stays as it was.
  it.each(["restored_unchanged", "saved_other_snapshot", "restore_not_succeeded", "restored_other_epoch"] as const)(
    "decides a receipt-less restore hold of a source that %s", async variant => {
      const f = await failedRemotePreparation();
      const template = await run(f.runId);
      const restoredSnapshotId = randomUUID(), sourceId = randomUUID(), leaseId = randomUUID();
      await db.insert(executionWorkspaceSnapshots).values({ id: restoredSnapshotId, companyId: f.companyId,
        executionWorkspaceId: f.workspaceId, sourceOperationId: randomUUID(), sourceRunId: randomUUID(),
        generation: 4, epoch: 3, status: "committed", sha256: "a".repeat(64) });
      await db.insert(heartbeatRuns).values({ id: sourceId, companyId: f.companyId, agentId: template.agentId,
        nativeIssueId: f.issueId, issueId: f.issueId, status: "failed", runtimeMode: "native", finishedAt: new Date(),
        contextSnapshot: { issueId: f.issueId },
        errorCode: "native_continuation_requires_reconciliation",
        error: "native_controller_recovery_missing_evidence:retained_sandbox_binding",
        runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", epoch: 6, state: "saved",
          leaseId, providerLeaseId: randomUUID(), remoteCwd: `/home/daytona/paperclip-workspace/.paperclip-workspaces/${f.workspaceId}-6-${leaseId}`,
          workspaceId: f.workspaceId, snapshotId: variant === "saved_other_snapshot" ? randomUUID() : restoredSnapshotId } },
        resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          workspaceRestoreFailure: "restore_failed",
          workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } } });
      await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: sourceId,
        executionWorkspaceId: f.workspaceId, phase: "remote_workspace_restore",
        status: variant === "restore_not_succeeded" ? "failed" : "succeeded",
        metadata: { epoch: variant === "restored_other_epoch" ? 5 : 6, snapshotId: restoredSnapshotId } });
      const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: template.agentId,
        issueId: f.issueId, status: "running", responsibleUserId: "local-board", contextSnapshot: { issueId: f.issueId } }).returning();
      const destination = path.join(root, writer.id); await mkdir(destination);
      const attach = attachPreservedRemoteWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
        runId: writer.id, workspaceId: randomUUID(), sourceRunIds: [sourceId], cwd: destination });
      await expect(attach).resolves.toEqual([]);
      expect(await readdir(destination)).toEqual([]);
      expect((await run(sourceId)).resultJson).toMatchObject({ workspaceRestoreRecovery: { leaseIds: [leaseId] } });
    }, 30_000);

  // Nov 10 staging, after a deploy: Retry of a task whose previous run failed
  // with native_controller_recovery_missing_evidence:runner_not_settled failed in
  // setup with remote_workspace_recovery_receipt_invalid, and every later Retry
  // would fail the same way. A predecessor whose receipt cannot be verified must
  // not dead-end the task: the Retry starts from the workspace's newest verified
  // save, attaches nothing unverified, and leaves the source's saved snapshot,
  // restore hold and receipts exactly as they were.
  it.each([
    "receipt_without_reference", "unreadable_reference_with_hold", "receipt_on_prepared_reference",
    "superseded_snapshot_with_hold", "receipt_from_other_epoch", "receipt_for_other_run",
  ] as const)("starts a Retry from the newest verified save when a predecessor has %s", async variant => {
    const f = await failedRemotePreparation();
    const template = await run(f.runId);
    const sourceId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID(), savedSnapshotId = randomUUID();
    const sourceWorkspaceId = variant === "receipt_on_prepared_reference" ? f.workspaceId : randomUUID();
    if (sourceWorkspaceId !== f.workspaceId) await db.insert(executionWorkspaces).values({ id: sourceWorkspaceId,
      companyId: f.companyId, sourceIssueId: f.issueId, name: "Previous run workspace", providerType: "cloud_sandbox",
      mode: "isolated_workspace", strategyType: "project_primary", cwd: `/workspaces/${sourceWorkspaceId}` });
    await db.insert(executionWorkspaceSnapshots).values({ id: savedSnapshotId, companyId: f.companyId,
      executionWorkspaceId: sourceWorkspaceId, sourceOperationId: randomUUID(), sourceRunId: sourceId,
      generation: 7, epoch: 6, status: variant === "superseded_snapshot_with_hold" ? "superseded" : "committed",
      sha256: "b".repeat(64) });
    const reference = { schema: "paperclip.remote-workspace-run.v1", epoch: 6,
      state: variant === "receipt_on_prepared_reference" ? "prepared" : "saved", leaseId, providerLeaseId,
      remoteCwd: `/home/daytona/paperclip-workspace/.paperclip-workspaces/${sourceWorkspaceId}-6-${leaseId}`,
      workspaceId: sourceWorkspaceId, snapshotId: variant === "receipt_on_prepared_reference" ? null : savedSnapshotId,
      ...(variant === "unreadable_reference_with_hold" ? { savedBy: "previous-release" } : {}) };
    const hold = { workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } };
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId: f.companyId, agentId: template.agentId,
      nativeIssueId: f.issueId, issueId: f.issueId, status: "failed", runtimeMode: "native",
      finishedAt: new Date(Date.now() - 60_000), createdAt: new Date(Date.now() - 120_000), contextSnapshot: { issueId: f.issueId },
      errorCode: "native_continuation_requires_reconciliation",
      error: "native_controller_recovery_missing_evidence:runner_not_settled",
      runnerProfileJson: variant === "receipt_without_reference" ? {} : { remoteWorkspace: reference },
      resultJson: { stopReason: "adapter_failed", ...hold } });
    const [recoveryAction] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "board", cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-workspace:${sourceId}`, nextAction: "Recover saved work",
      evidence: { runId: sourceId, ...hold, workspaceRecovery: { schema: "paperclip.workspace-recovery.v1",
        runId: variant === "receipt_for_other_run" ? randomUUID() : sourceId, status: "recovered", stage: "saving_receipts",
        attempt: 1, requestIds: [] } } }).returning();
    if (variant !== "unreadable_reference_with_hold" && variant !== "superseded_snapshot_with_hold")
      await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: sourceId,
        executionWorkspaceId: sourceWorkspaceId, phase: "workspace_recovery", status: "succeeded", finishedAt: new Date(),
        metadata: { recoveryActionId: recoveryAction.id, leaseId, providerLeaseId, snapshotId: savedSnapshotId,
          generation: 7, sha256: "b".repeat(64), storage: "remote_workspace",
          epoch: variant === "receipt_from_other_epoch" ? 5 : 6 } });
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: template.agentId,
      nativeIssueId: f.issueId, issueId: f.issueId, status: "running", runtimeMode: "native", retryOfRunId: sourceId,
      responsibleUserId: "local-board", contextSnapshot: { issueId: f.issueId, taskRetryRequestId: randomUUID() } }).returning();
    const destination = path.join(root, writer.id); await mkdir(destination);
    const before = { source: await run(sourceId), operations: await db.select().from(workspaceOperations)
      .where(eq(workspaceOperations.heartbeatRunId, sourceId)), snapshots: await db.select().from(executionWorkspaceSnapshots)
      .where(eq(executionWorkspaceSnapshots.id, savedSnapshotId)) };
    const attach = attachPreservedRemoteWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      runId: writer.id, workspaceId: f.workspaceId, sourceRunIds: [writer.id], cwd: destination });
    await expect(attach).resolves.toEqual([]);
    expect(await readdir(destination)).toEqual([]);
    // The fallback attaches nothing unverified and never touches the source's saved state.
    expect(await run(sourceId)).toEqual(before.source);
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, sourceId))).toEqual(before.operations);
    expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, savedSnapshotId)))
      .toEqual(before.snapshots);
  }, 30_000);
});
