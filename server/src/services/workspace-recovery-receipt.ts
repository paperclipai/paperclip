import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type ExecutionBlocker } from "@paperclipai/shared";
import { z } from "zod";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";

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
  if (typeof issueId !== "string" || (!remote && (!reference || reference.state !== "finalized" || !reference.finalHostSha256))) return null;
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
  } else if (!reference || proof.leaseId !== reference.leaseId || proof.providerLeaseId !== reference.providerLeaseId
    || proof.descriptorSha256 !== reference.descriptorSha256 || proof.finalHostSha256 !== reference.finalHostSha256) return null;
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
