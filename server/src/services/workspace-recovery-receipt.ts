import { and, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type ExecutionBlocker } from "@paperclipai/shared";
import { z } from "zod";
import { readNativeWorkspaceSyncReference, type NativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { readMigratedLegacyWorkspaceSource } from "./legacy-workspace-recovery-migration.js";
import { readSnapshot } from "./workspace-recovery-snapshot.js";

export const workspaceRecoverySchema = z.object({
  schema: z.literal("paperclip.workspace-recovery.v1"),
  runId: z.string().guid(),
  status: z.enum(["queued", "recovering", "blocked", "recovered"]),
  stage: z.enum(["verifying_stop", "restoring_files", "saving_receipts"]),
  attempt: z.number().int().nonnegative(),
  attemptLimit: z.number().int().positive().optional(),
  blockerCode: z.enum(["stop", "source", "owner", "writer"]).optional(),
  requestIds: z.array(z.string().guid()),
  retryAt: z.number().optional(),
  retryable: z.boolean().optional(),
  message: z.string().optional(),
});
export type WorkspaceRecovery = z.infer<typeof workspaceRecoverySchema>;
export function readWorkspaceRecovery(evidence: Record<string, unknown> | null) {
  const parsed = workspaceRecoverySchema.safeParse(evidence?.workspaceRecovery);
  return parsed.success ? parsed.data : null;
}

export function completedWorkspaceRecoveryCondition(runId: string | AnyColumn | SQL) {
  const operationIds = sql`case when jsonb_typeof(${issueRecoveryActions.evidence}#>'{systemRecovery,preservationOperationIds}') = 'array'
    then ${issueRecoveryActions.evidence}#>'{systemRecovery,preservationOperationIds}' else '[]'::jsonb end`;
  return and(
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,schema}' = 'paperclip.system-recovery.v1'`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,policyVersion}' = '1'`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,sourceRunId}' = ${runId}::text`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'complete'`,
    sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,schema}' = 'paperclip.workspace-recovery.v1'`,
    sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,runId}' = ${runId}::text`,
    sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' = 'recovered'`,
    sql`jsonb_array_length(${operationIds}) > 0`,
    sql`not exists (select 1 from jsonb_array_elements_text(${operationIds}) saved(id) where not exists (
      select 1 from ${workspaceOperations} op where op.company_id = ${issueRecoveryActions.companyId}
        and op.issue_id = ${issueRecoveryActions.sourceIssueId} and op.heartbeat_run_id::text = ${runId}::text
        and op.id::text = saved.id and op.status = 'succeeded'
        and op.metadata->>'recoveryActionId' = ${issueRecoveryActions.id}::text
        and op.phase in ('workspace_recovery', 'workspace_recovery_snapshot')))`,
    sql`exists (select 1 from ${workspaceOperations} op where op.company_id = ${issueRecoveryActions.companyId}
      and op.issue_id = ${issueRecoveryActions.sourceIssueId} and op.heartbeat_run_id::text = ${runId}::text
      and op.phase = 'workspace_finalize' and op.status = 'succeeded'
      and op.metadata->>'owningService' = 'workspace_recovery'
      and op.metadata->'preservationOperationIds' = ${operationIds})`,
  );
}

export function workspaceRecoveryDisplay(evidence: Record<string, unknown>, runId: string | null): ExecutionBlocker["workspaceRecovery"] {
  const state = readWorkspaceRecovery(evidence);
  if (!state || state.runId !== runId) return undefined;
  return { status: state.status, stage: state.stage,
    canRetry: state.status === "blocked" && state.retryable === true,
    message: state.status === "queued" || state.status === "recovering" ? "Recovering saved work…"
      : state.status === "recovered" ? "Saved work recovered. Send a message to continue."
        : state.message ?? "Paperclip couldn’t safely recover this task. This task needs service attention.",
  };
}

async function verifiedNativeCopybackReceipt(db: Db, input: {
  companyId: string; issueId: string; runId: string; reference: NativeWorkspaceSyncReference;
}) {
  const { reference } = input;
  if (reference.state !== "finalized" || !reference.finalHostSha256) return null;
  const [receipt] = await db.select({ id: workspaceOperations.id, metadata: workspaceOperations.metadata })
    .from(workspaceOperations).where(and(eq(workspaceOperations.companyId, input.companyId),
      eq(workspaceOperations.issueId, input.issueId), eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.phase, "workspace_recovery"), eq(workspaceOperations.status, "succeeded"),
      sql`${workspaceOperations.metadata}->>'leaseId' = ${reference.leaseId}`,
      sql`${workspaceOperations.metadata}->>'providerLeaseId' = ${reference.providerLeaseId}`,
      sql`${workspaceOperations.metadata}->>'descriptorSha256' = ${reference.descriptorSha256}`,
      sql`${workspaceOperations.metadata}->>'finalHostSha256' = ${reference.finalHostSha256}`,
    )).limit(1);
  if (!receipt || typeof receipt.metadata?.recoveryActionId !== "string") return null;
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    eq(issueRecoveryActions.id, receipt.metadata.recoveryActionId)));
  const state = readWorkspaceRecovery(action?.evidence ?? null);
  return state?.runId === input.runId && state.status === "recovered" ? receipt.id : null;
}

/** Only the host writes workspace operations. Adapter output and a user-supplied
 * repair note cannot substitute for this exact copyback receipt. Stop/authority
 * are checked separately at every continuation admission. */
export async function verifiedWorkspaceRepairReceipt(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "issueId" | "contextSnapshot" | "runnerProfileJson">) {
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  const parsedRemote = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  const remote = parsedRemote.success && parsedRemote.data.state === "saved" ? parsedRemote.data : null;
  if ((run.runnerProfileJson?.remoteWorkspace != null && !parsedRemote.success) || reference && parsedRemote.success) return null;
  if (typeof issueId === "string" && (reference?.state === "prepared" || reference?.state === "finalized"
    && run.runnerProfileJson?.finalizedWorkspaceRecoveryMigration != null || !reference && !parsedRemote.success
    && run.runnerProfileJson?.legacyWorkspaceRecoveryMigration != null)) {
    let migrated;
    try { migrated = await readMigratedLegacyWorkspaceSource(db, { companyId: run.companyId, runId: run.id, reference }); }
    catch (error) { if (error instanceof Error && error.message === "legacy_workspace_migration_receipt_invalid") return null; throw error; }
    if (migrated) {
      const allocations = migrated.recoveryAllocations ?? (reference
        ? [{ leaseId: reference.leaseId, providerLeaseId: reference.providerLeaseId }] : null);
      if (!allocations?.length) return null;
      let receiptId: string | null = null;
      for (const allocation of allocations) {
        const [saved] = await db.select({ id: workspaceOperations.id, metadata: workspaceOperations.metadata,
          evidence: issueRecoveryActions.evidence }).from(workspaceOperations).innerJoin(issueRecoveryActions, and(
          eq(issueRecoveryActions.companyId, workspaceOperations.companyId), eq(issueRecoveryActions.sourceIssueId, workspaceOperations.issueId),
          sql`${issueRecoveryActions.id}::text = ${workspaceOperations.metadata}->>'recoveryActionId'`,
        )).where(and(eq(workspaceOperations.companyId, run.companyId), eq(workspaceOperations.issueId, issueId),
          eq(workspaceOperations.heartbeatRunId, run.id), eq(workspaceOperations.phase, "workspace_recovery_snapshot"),
          eq(workspaceOperations.status, "succeeded"),
          sql`${workspaceOperations.metadata}->>'leaseId' = ${allocation.leaseId}`,
          sql`${workspaceOperations.metadata}->>'providerLeaseId' = ${allocation.providerLeaseId}`,
          sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,runId}' = ${run.id}`,
          sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' = 'recovered'`,
        )).orderBy(desc(workspaceOperations.createdAt)).limit(1);
        if (!saved || readWorkspaceRecovery(saved.evidence)?.status !== "recovered") {
          const copyback = reference && allocation.leaseId === reference.leaseId
            && allocation.providerLeaseId === reference.providerLeaseId
            ? await verifiedNativeCopybackReceipt(db, { companyId: run.companyId, issueId, runId: run.id, reference }) : null;
          if (!copyback) return null;
          receiptId = copyback;
          continue;
        }
        try { readSnapshot(saved.metadata, run.companyId, run.id); } catch { return null; }
        receiptId = saved.id;
      }
      return receiptId;
    }
  }
  if (typeof issueId !== "string" || (!remote && (!reference || reference.state !== "finalized" || !reference.finalHostSha256))) return null;
  if (!remote) return verifiedNativeCopybackReceipt(db, { companyId: run.companyId, issueId, runId: run.id, reference: reference! });
  const [receipt] = await db.select({ id: workspaceOperations.id, metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, run.companyId), eq(workspaceOperations.issueId, issueId),
    eq(workspaceOperations.heartbeatRunId, run.id), eq(workspaceOperations.phase, "workspace_recovery"),
    eq(workspaceOperations.status, "succeeded"),
    remote ? sql`${workspaceOperations.metadata}->>'snapshotId' = ${remote.snapshotId}` : undefined,
  )).limit(1);
  const proof = receipt?.metadata;
  if (!proof || typeof proof.recoveryActionId !== "string") return null;
  if (remote) {
    const [workspace] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, remote.workspaceId),
    ));
    const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
    if (!authority || authority.dirty || authority.writerRunId || authority.epoch !== remote.epoch
      || authority.snapshotId !== remote.snapshotId || proof.storage !== "remote_workspace"
      || proof.leaseId !== remote.leaseId || proof.providerLeaseId !== remote.providerLeaseId || proof.epoch !== remote.epoch) return null;
    const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.companyId, run.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, remote.workspaceId),
      eq(executionWorkspaceSnapshots.id, remote.snapshotId!), eq(executionWorkspaceSnapshots.status, "committed"),
      eq(executionWorkspaceSnapshots.epoch, remote.epoch), eq(executionWorkspaceSnapshots.sourceRunId, run.id),
    ));
    if (!snapshot || snapshot.sha256 !== proof.sha256 || snapshot.generation !== proof.generation) return null;
  }
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.id, proof.recoveryActionId),
  )).limit(1);
  const state = readWorkspaceRecovery(action?.evidence ?? null);
  return state?.runId === run.id && state.status === "recovered" ? receipt.id : null;
}

export async function hasVerifiedWorkspaceRepair(...args: Parameters<typeof verifiedWorkspaceRepairReceipt>) {
  return (await verifiedWorkspaceRepairReceipt(...args)) !== null;
}
