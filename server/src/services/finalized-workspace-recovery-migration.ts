import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, nativeRunResults,
  workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { isLegacyWorkspaceTaskRelated, type LegacyWorkspaceRecoverySource } from "./legacy-workspace-recovery-migration.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { readSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { inspectWorkspaceRecoverySource, terminalWorkspaceRunStates } from "./workspace-recovery-source.js";

type ReadDb = Pick<Db, "select">;
type Recovery = Pick<typeof issueRecoveryActions.$inferSelect,
  "id" | "sourceIssueId" | "kind" | "cause" | "evidence" | "status" | "updatedAt">;
export type FinalizedWorkspaceRecoveryHold = {
  actionId: string; runId: string; sourceWorkspaceId: string; fingerprint: string;
  source: LegacyWorkspaceRecoverySource | null;
};

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function inspectFinalizedWorkspaceRecoveryHold(db: ReadDb, input: {
  companyId: string; workspaceId: string; recovery: Recovery;
}): Promise<FinalizedWorkspaceRecoveryHold | null> {
  const action = input.recovery;
  if (action.kind !== "active_run_watchdog" || typeof action.evidence.runId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(action.evidence.runId)) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, action.evidence.runId)));
  const reference = readNativeWorkspaceSyncReference(run?.runnerProfileJson?.nativeWorkspaceSync);
  if (!run || run.runtimeMode !== "native" || run.nativeIssueId !== action.sourceIssueId
    || !terminalWorkspaceRunStates.includes(run.status) || !reference || reference.state !== "finalized"
    || !reference.finalHostSha256 || run.runnerProfileJson?.remoteWorkspace != null
    || adapterExecutionControls.has(run.id) || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return null;
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, run.id),
    eq(nativeRunFinalizations.issueId, action.sourceIssueId)));
  if (!owner || owner.leaseOwner) return null;
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
  if (!workspace || !await isLegacyWorkspaceTaskRelated(db, { companyId: input.companyId,
    issueId: run.nativeIssueId, sourceIssueId: workspace.sourceIssueId })) return null;
  if (reference.workspaceId !== input.workspaceId && !readRemoteWorkspaceAuthority(workspace.metadata)
    && (!workspace.cwd || !["local_fs", "git_worktree"].includes(workspace.providerType))) return null;
  let finalizeReceipt: string | null = null;
  if (!["committed", "terminal_failure"].includes(owner.phase)) {
    if (owner.phase !== "retryable_failure" || !owner.resultId || !run.completionContractId) return null;
    const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, input.companyId), eq(nativeRunResults.issueId, action.sourceIssueId),
      eq(nativeRunResults.runId, run.id), eq(nativeRunResults.id, owner.resultId),
      eq(nativeRunResults.completionContractId, run.completionContractId), eq(nativeRunResults.schemaStatus, "accepted")));
    const [receipt] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, action.sourceIssueId),
      eq(workspaceOperations.heartbeatRunId, run.id), eq(workspaceOperations.phase, "workspace_finalize"),
      eq(workspaceOperations.status, "succeeded")));
    if (!result || !receipt) return null;
    finalizeReceipt = receipt.id;
  }
  const fileKeys = ["systemRecovery", "workspaceRecovery", "workspaceRestoreRecovery", "historicalWorkspaceSource"];
  let source: LegacyWorkspaceRecoverySource | null = null;
  if (fileKeys.some(key => action.evidence[key] != null)) {
    const system = readSystemRecovery(action.evidence), recovery = readWorkspaceRecovery(action.evidence);
    if (!system || system.sourceRunId !== run.id || system.state === "running" || !recovery || recovery.runId !== run.id
      || ["queued", "recovering"].includes(recovery.status)
      || action.evidence.workspaceRestoreRecovery != null
        && !isDeepStrictEqual(action.evidence.workspaceRestoreRecovery, run.resultJson?.workspaceRestoreRecovery)) return null;
    try {
      const inspected = await inspectWorkspaceRecoverySource(db as Db, {
        companyId: input.companyId, issueId: action.sourceIssueId, runId: run.id, actionId: action.id,
      });
      source = { runId: run.id, issueId: action.sourceIssueId, reference,
        recoveryAllocations: inspected.sources.map(item => ({ leaseId: item.lease.id,
          providerLeaseId: item.lease.providerLeaseId!, remoteCwd: item.remoteCwd })).sort((a, b) => a.leaseId.localeCompare(b.leaseId)) };
    } catch (error) {
      if (error instanceof SystemRecoveryFailure) return null;
      throw error;
    }
  }
  return { actionId: action.id, runId: run.id, sourceWorkspaceId: reference.workspaceId,
    source: reference.workspaceId === input.workspaceId ? source : null,
    fingerprint: createHash("sha256").update(canonical({ action, reference,
      status: run.status, controllerLeaseExpiresAt: run.controllerLeaseExpiresAt?.toISOString() ?? null,
      completionContractId: run.completionContractId, restoreRecovery: run.resultJson?.workspaceRestoreRecovery,
      owner, finalizeReceipt, source })).digest("hex") };
}
