import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { persistActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { readTaskRetryIntent } from "./task-retry.js";
import { z } from "zod";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";
import { toExecutionWorkspace } from "./execution-workspaces.js";
import { workspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { isBoundIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { readFailedPreparationSettlement } from "./failed-preparation-settlement.js";
import { taskRetryRunAncestry } from "./recovery-run-ancestry.js";

export type ContinuationReadiness =
  | { mode: "resume_preserved_workspace"; preservationReceiptId: string }
  | { mode: "reuse_current_workspace"; retryIntentId: string; sourceRunId: string; workspaceId: string; cwd: string }
  | { mode: "resume_stopped_native_workspace"; retryIntentId: string; sourceRunId: string; workspaceId: string; cwd: string }
  | { mode: "reuse_issue_workspace"; retryIntentId: string; sourceRunId: string; workspaceId: string; cwd: string }
  | { mode: "fresh_isolated_workspace"; retryIntentId: string; sourceRunId: string; retainedSourceIds: string[] };
const freshReadinessSchema = z.discriminatedUnion("mode", [z.object({
  mode: z.literal("fresh_isolated_workspace"), retryIntentId: z.string().uuid(),
  sourceRunId: z.string().uuid(), retainedSourceIds: z.array(z.string().uuid()),
}), z.object({
  mode: z.literal("reuse_issue_workspace"), retryIntentId: z.string().uuid(),
  sourceRunId: z.string().uuid(), workspaceId: z.string().uuid(), cwd: z.string().min(1),
})]);

const workspaceExportCauses = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"];
const terminalRunStatuses = ["failed", "cancelled", "timed_out", "succeeded", "interrupted"];
const reusableWorkspaceStatuses = ["active", "idle", "in_review"];
// Admission can hold the issue lock, so all Git probes for one workspace share
// one short wall-clock budget, including time queued in the scan scheduler.
const RETAINED_WORKSPACE_GIT_BUDGET_MS = 10_000;

/** Why another writer may still hold the workspace, or null. The successor's
 * own claims do not count. An operation the stopped source started before it
 * settled is history: admission proved that source stopped, so a row still
 * marked running was orphaned by a restart. */
export async function workspaceHasOtherWriter(db: Db, input: {
  companyId: string; workspaceId: string; successorRunId: string;
  stoppedSource?: { id: string; finishedAt: Date | null } | null;
}) {
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.executionWorkspaceId, input.workspaceId),
    or(isNull(environmentLeases.heartbeatRunId), ne(environmentLeases.heartbeatRunId, input.successorRunId)),
    or(isNull(environmentLeases.releasedAt), inArray(environmentLeases.status, ["active", "pending_cleanup"]),
      eq(environmentLeases.cleanupStatus, "failed")),
  )).limit(1);
  const source = input.stoppedSource?.finishedAt ? input.stoppedSource : null;
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, input.workspaceId),
    eq(workspaceOperations.status, "running"),
    or(isNull(workspaceOperations.heartbeatRunId), ne(workspaceOperations.heartbeatRunId, input.successorRunId)),
    source ? sql`not (${workspaceOperations.heartbeatRunId} = ${source.id}
      and ${workspaceOperations.startedAt} <= ${source.finishedAt!.toISOString()}::timestamptz)` : undefined,
  )).limit(1);
  return lease ? "lease_held" as const : operation ? "operation_running" as const : null;
}

/** A task-owned Git workspace must read cleanly from its own root. A broken
 * worktree link must not resolve to an enclosing repository. */
async function readableOwnGitRoot(workspace: typeof executionWorkspaces.$inferSelect, real: string) {
  const marker = await lstat(path.join(real, ".git")).catch(() => null);
  if (!marker && workspace.providerType !== "git_worktree") return true;
  const signal = AbortSignal.timeout(RETAINED_WORKSPACE_GIT_BUDGET_MS);
  const scan = (args: string[], operation: string) => workspaceGitOperationScheduler.run({
    workspacePath: real, args, operation, cacheTtlMs: 0, bypassSingleFlight: true, signal,
    timeoutMs: RETAINED_WORKSPACE_GIT_BUDGET_MS, fairnessKeys: [`company:${workspace.companyId}`, `workspace:${workspace.id}`],
  });
  try {
    const root = (await scan(["rev-parse", "--show-toplevel"], "retry.retained_workspace_root")).stdout.trim();
    if (!root || await realpath(root).catch(() => null) !== real) return false;
    await scan(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no"], "retry.retained_workspace_status");
    return true;
  } catch {
    return false;
  }
}

/** Whether a workspace row is the task's own local directory, outside remote
 * storage authority and not closed. Shared by reuse and the prior-files hint. */
export function isTaskOwnedLocalWorkspace(workspace: typeof executionWorkspaces.$inferSelect, issueId: string) {
  return Boolean(workspace.cwd) && workspace.sourceIssueId === issueId && workspace.mode !== "shared_workspace" &&
    reusableWorkspaceStatuses.includes(workspace.status) && ["local_fs", "git_worktree"].includes(workspace.providerType) &&
    (workspace.metadata?.remoteWorkspace ?? null) === null;
}

/** A recovery generation that is scheduled or running may still export or
 * repair the source tree. A settled projection is only status text. */
export function recoveryGenerationSettled(evidence: Record<string, unknown> | null, sourceRunId: string) {
  if (evidence?.systemRecovery === undefined) return true;
  const recovery = readSystemRecovery(evidence);
  return Boolean(recovery && recovery.sourceRunId === sourceRunId && ["complete", "exhausted"].includes(recovery.state));
}

/** R2: a Retry that would otherwise start a fresh attempt keeps the task's own
 * local workspace when that is provably safe, so uncommitted files and Git
 * history stay with the task. Admission has already proven that the source
 * executor stopped. This adds the workspace facts: it is the one local
 * directory the source used, still bound to and owned by this task, with no
 * other lease, running operation, unsettled recovery generation, export
 * obligation or remote owner, and its Git state can still be read. Otherwise
 * the caller keeps the fresh isolated attempt and the directory stays untouched.
 * Pass one `gitProbes` map when checking several holds for the same run. */
export async function retainedIssueWorkspaceForRetry(db: Db, input: {
  companyId: string; issueId: string; agentId: string; successorRunId: string; cause: string | null;
  source: Pick<typeof heartbeatRuns.$inferSelect, "id" | "resultJson" | "status" | "finishedAt" | "controllerLeaseExpiresAt">;
  evidence: Record<string, unknown> | null; gitProbes?: Map<string, Promise<boolean>>;
}): Promise<{ id: string; cwd: string } | null> {
  const keepFresh = (reason: string) => {
    logger.info({ companyId: input.companyId, issueId: input.issueId, sourceRunId: input.source.id,
      successorRunId: input.successorRunId, reason }, "Retry keeps a fresh attempt; the task workspace is not reusable");
    return null;
  };
  if (!recoveryGenerationSettled(input.evidence, input.source.id)) return keepFresh("recovery_generation_unsettled");
  if (!terminalRunStatuses.includes(input.source.status) || !input.source.finishedAt ||
      adapterExecutionControls.has(input.source.id) ||
      (input.source.controllerLeaseExpiresAt && input.source.controllerLeaseExpiresAt > new Date())) return keepFresh("source_not_settled");
  if ((input.cause && workspaceExportCauses.includes(input.cause)) ||
      input.source.resultJson?.workspaceRestoreFailure || hasRequiredWorkspaceRecovery(input.source.resultJson))
    return keepFresh("workspace_repair_required");
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, input.source.id),
  ));
  if (!leases.length || leases.some(lease => lease.provider !== "local" || !lease.releasedAt ||
      lease.cleanupStatus === "failed" || !lease.executionWorkspaceId)) return keepFresh("source_lease_not_local_released");
  const sourceWorkspaceIds = new Set(leases.map(lease => lease.executionWorkspaceId));
  const [bound] = await db.select({ workspace: executionWorkspaces }).from(issues).innerJoin(executionWorkspaces, and(
    eq(executionWorkspaces.companyId, issues.companyId), eq(executionWorkspaces.id, issues.executionWorkspaceId),
  )).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
    eq(issues.assigneeAgentId, input.agentId))).limit(1);
  const workspace = bound?.workspace;
  if (!workspace?.cwd || sourceWorkspaceIds.size !== 1 || !sourceWorkspaceIds.has(workspace.id))
    return keepFresh("binding_not_source_workspace");
  if (!isTaskOwnedLocalWorkspace(workspace, input.issueId)) return keepFresh("workspace_not_task_owned_local");
  const writer = await workspaceHasOtherWriter(db, { companyId: input.companyId, workspaceId: workspace.id,
    successorRunId: input.successorRunId, stoppedSource: input.source });
  if (writer) return keepFresh(writer);
  // The directory must still be the recorded one, not a replacement link.
  const stat = await lstat(workspace.cwd).catch(() => null);
  const real = stat?.isDirectory() && !stat.isSymbolicLink() ? await realpath(workspace.cwd).catch(() => null) : null;
  if (!real) return keepFresh("directory_missing");
  let probe = input.gitProbes?.get(real);
  if (!probe) {
    probe = readableOwnGitRoot(workspace, real);
    input.gitProbes?.set(real, probe);
  }
  if (!await probe) return keepFresh("git_unreadable");
  return { id: workspace.id, cwd: workspace.cwd };
}

/** This chooses a strategy, never establishes termination or effect safety.
 * Admission verifies those independently before it can persist this receipt. */
export async function canSelectFreshWorkspace(input: {
  db: Db; companyId: string; issueId: string; agentId: string; actorId: string;
  sourceRunId: string; evidence: Record<string, unknown>; taskRetryRequestId?: string;
  queuedRequestId?: string;
}): Promise<string | null> {
  const system = readSystemRecovery(input.evidence);
  const requestId = input.taskRetryRequestId ?? input.queuedRequestId;
  if (!requestId || !system || system.sourceRunId !== input.sourceRunId || system.freshAttemptRunId) return null;
  if (system.providerCooldownAt !== null && system.providerCooldownAt > Date.now()) return null;
  const [wake] = await input.db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, requestId),
    eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
  ));
  if (!wake) return null;
  if (input.taskRetryRequestId) {
    const retry = readTaskRetryIntent(wake.payload);
    if (retry?.generationId !== wake.id ||
        retry.actorId !== input.actorId || wake.requestedByActorId !== input.actorId) return null;
    if (retry.sourceRunId !== input.sourceRunId && (system.intentId !== wake.id ||
      !(await taskRetryRunAncestry({ db: input.db, companyId: input.companyId, issueId: input.issueId,
        agentId: input.agentId, sourceRunId: retry.sourceRunId }))?.includes(input.sourceRunId))) return null;
    return wake.id;
  }
  const [source] = await input.db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId),
  ));
  const recoveryPolicy = source?.context?.automaticRecovery as Record<string, unknown> | undefined;
  if (recoveryPolicy?.allowFreshWorkspace === false) return null;
  // Saved input can use the automatic fallback only after maintenance settled.
  // A pending export keeps its current attempt; it cannot spawn another agent.
  return ["complete", "exhausted"].includes(system.state) ? wake.id : null;
}

async function reusableDirectoryAfterPreparationFailure(db: Db, source: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const validation = source.resultJson?.workspaceValidation as Record<string, unknown> | undefined;
  const recovery = source.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (source.status !== "failed" || !source.finishedAt || source.runtimeMode !== "legacy" ||
      source.errorCode !== "workspace_validation_failed" || source.executionStage !== "preparing" ||
      validation?.reason !== "git_worktree_base_not_git_checkout" || validation.issueId !== issueId ||
      validation.resolvedWorkspaceSource !== "task_session" || validation.requestedExecutionWorkspaceMode !== "isolated_workspace" ||
      validation.issueExecutionWorkspacePreference !== "reuse_existing" || recovery?.kind !== "bootstrap" ||
      recovery.providerWorkStarted !== false || Object.keys(recovery).some(key => !["kind", "providerWorkStarted"].includes(key)) ||
      source.resultJson?.stopReason !== "adapter_failed" ||
      adapterExecutionControls.has(source.id) || (source.controllerLeaseExpiresAt && source.controllerLeaseExpiresAt > new Date()) ||
      [source.runtimeModeResolvedAt, source.runtimeModeResolverVersion, source.runtimeModeReason, source.runnerInstanceId,
        source.nativeIssueId, source.nativePhase, source.nativeSessionId, source.driverKind, source.driverVersion,
        source.completionContractId, source.completionContractSha256, source.sessionIdAfter, source.externalRunId,
        source.processPid, source.processGroupId, source.processStartedAt, source.logStore, source.logRef,
        source.logBytes, source.logSha256, source.stdoutExcerpt, source.stderrExcerpt, source.lastOutputAt,
        source.lastOutputStream, source.lastOutputBytes, source.exitCode, source.signal].some(value => value !== null) ||
      source.lastOutputSeq !== 0 || source.logCompressed ||
      Object.keys(source.usageJson ?? {}).some(key => key !== "ledgerScope") ||
      Object.keys(source.runnerProfileJson ?? {}).some(key => !["adapterDispatch", "chatControlRecoveryAdmission", "aiConnectionNonAssigneeCommentWake"].includes(key)) ||
      Object.keys(source.resultJson ?? {}).some(key => !["effectiveTimeoutSec", "executionRecovery", "stopReason", "timeoutConfigured", "timeoutFired", "timeoutSource", "workspaceValidation"].includes(key))) return null;
  const settlement = await readFailedPreparationSettlement(db, source);
  const warning = settlement?.unsupportedHarnessWarning;
  if (!settlement || warning && (warning.message !== "Company observability was not applied: this harness is not supported."
    || !z.string().uuid().safeParse(warning.revision).success)) return null;
  const [executionEvidence] = await db.execute<{ present: boolean }>(sql`select
    exists(select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${source.companyId} and ${environmentLeases.heartbeatRunId} = ${source.id})
    or exists(select 1 from ${nativeRunResults} where ${nativeRunResults.companyId} = ${source.companyId} and ${nativeRunResults.runId} = ${source.id})
    or exists(select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.companyId} = ${source.companyId} and ${nativeRunFinalizations.runId} = ${source.id}) as present`);
  if (executionEvidence?.present !== false) return null;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, source.companyId), eq(issues.id, issueId)));
  if (!task || task.assigneeAgentId !== source.agentId || task.executionWorkspacePreference !== "reuse_existing" ||
      task.executionWorkspaceId !== validation.issueExecutionWorkspaceId || task.projectId !== validation.issueProjectId ||
      task.projectWorkspaceId !== validation.issueProjectWorkspaceId) return null;
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, source.companyId), eq(executionWorkspaces.id, task.executionWorkspaceId!),
  ));
  if (!workspace || workspace.cwd !== validation.resolvedWorkspaceCwd || !await isBoundIsolatedTaskDirectory({
    companyId: source.companyId, issueId, workspaceId: task.executionWorkspaceId, workspace: toExecutionWorkspace(workspace) })) return null;
  const prior = await db.select({ runId: environmentLeases.heartbeatRunId }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, source.companyId), eq(environmentLeases.executionWorkspaceId, workspace.id),
  ));
  for (const { runId } of prior) if (runId && await hasPendingRunCleanup(db, source.companyId, runId)) return null;
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, source.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    eq(workspaceOperations.status, "running"),
  )).limit(1);
  return operation ? null : workspace;
}

async function stoppedNativeContinuationWorkspace(db: Db, source: typeof heartbeatRuns.$inferSelect,
  input: { runId: string; issueId: string; retryIntentId: string }) {
  if (source.runtimeMode !== "native" || source.status !== "failed" ||
      source.errorCode !== "native_session_cleanup_quarantined" || !source.nativeSessionId || !source.runnerInstanceId) return null;
  const [proof] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, source.companyId), eq(heartbeatRunEvents.runId, source.id),
    eq(heartbeatRunEvents.agentId, source.agentId), eq(heartbeatRunEvents.eventType, "native.stopped_conversation_verified"),
    isNull(heartbeatRunEvents.sourceEventId),
    sql`${heartbeatRunEvents.payload}->>'successorRunId' = ${input.runId}`,
    sql`${heartbeatRunEvents.payload}->>'taskRetryRequestId' = ${input.retryIntentId}`,
  )).limit(1);
  if (!proof) return null;
  const parsed = z.object({ schema: z.literal("paperclip.stopped_native_conversation.v1"),
    runId: z.literal(source.id), nativeSessionId: z.literal(source.nativeSessionId), runnerInstanceId: z.literal(source.runnerInstanceId),
    executionWorkspaceId: z.string().uuid(), workspaceCwd: z.string().min(1),
  }).safeParse(proof.payload);
  if (!parsed.success) throw new Error("Verified native continuation workspace is unavailable");
  if (parsed.data.executionWorkspaceId === source.id) return null;
  const [bound] = await db.select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd }).from(issues).innerJoin(executionWorkspaces, and(
    eq(executionWorkspaces.companyId, issues.companyId), eq(executionWorkspaces.id, issues.executionWorkspaceId),
  )).where(and(eq(issues.companyId, source.companyId), eq(issues.id, input.issueId),
    eq(issues.assigneeAgentId, source.agentId), eq(executionWorkspaces.id, parsed.data.executionWorkspaceId),
    eq(executionWorkspaces.cwd, parsed.data.workspaceCwd), eq(executionWorkspaces.status, "active"),
    eq(executionWorkspaces.providerType, "local_fs"),
    or(isNull(executionWorkspaces.sourceIssueId), eq(executionWorkspaces.sourceIssueId, input.issueId)),
  )).limit(1);
  if (!bound) throw new Error("Verified native continuation workspace binding changed");
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, source.companyId), eq(workspaceOperations.executionWorkspaceId, bound.id),
    eq(workspaceOperations.status, "running"), or(isNull(workspaceOperations.heartbeatRunId), ne(workspaceOperations.heartbeatRunId, input.runId)),
  )).limit(1);
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, source.companyId), eq(environmentLeases.executionWorkspaceId, bound.id),
    or(isNull(environmentLeases.heartbeatRunId), ne(environmentLeases.heartbeatRunId, input.runId)),
    or(isNull(environmentLeases.releasedAt), inArray(environmentLeases.status, ["active", "pending_cleanup"])),
  )).limit(1);
  if (operation || lease) throw new Error("Verified native continuation workspace cleanup is pending");
  return { mode: "resume_stopped_native_workspace" as const, retryIntentId: input.retryIntentId,
    sourceRunId: source.id, workspaceId: bound.id, cwd: parsed.data.workspaceCwd };
}

/** Preparation trusts the committed admission receipt, not a raw wake payload. */
export async function readFreshWorkspaceReadiness(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId" | "contextSnapshot">): Promise<ContinuationReadiness | null> {
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  if (typeof issueId !== "string") return null;
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    sql`${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,runId}' = ${run.id}`,
    sql`${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,readiness,mode}' in ('fresh_isolated_workspace', 'reuse_issue_workspace')`,
    // Historical sibling holds also record the continuation, but only the
    // recovery generation owns its committed fresh attempt. Select that proof.
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,freshAttemptRunId}' = ${run.id}`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,sourceRunId}' = ${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,readiness,sourceRunId}'`,
    sql`${issueRecoveryActions.evidence}->>'runId' = ${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,readiness,sourceRunId}'`,
  )).limit(1);
  if (!action) {
    const [wake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
      eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.reason, "task_retry"),
      eq(agentWakeupRequests.status, "coalesced"), eq(agentWakeupRequests.requestedByActorType, "user"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )).limit(1);
    const intent = readTaskRetryIntent(wake?.payload);
    if (!wake || !intent || intent.canonicalIntentId ||
        intent.generationId !== wake.id || intent.actorId !== wake.requestedByActorId ||
        run.contextSnapshot?.taskRetryRequestId !== wake.id ||
        !["evaluate", "continue", "fresh_isolated_workspace"].includes(intent.strategy)) return null;
    if (intent.chatActionId) {
      const [chatWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
        eq(agentWakeupRequests.id, intent.chatActionId), eq(agentWakeupRequests.runId, run.id),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      ));
      if (!chatWake || (run.contextSnapshot?.chatFailedRunRetry as Record<string, unknown> | undefined)?.actionId !== chatWake.id)
        return null;
    }
    const [source] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
      eq(heartbeatRuns.id, intent.sourceRunId), sql`coalesce(${heartbeatRuns.nativeIssueId}::text,
        ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
    )).limit(1);
    if (!source) throw new Error("Fresh retry source changed");
    if (intent.strategy !== "fresh_isolated_workspace") {
      const stoppedWorkspace = await stoppedNativeContinuationWorkspace(db, source, { runId: run.id, issueId, retryIntentId: wake.id });
      if (stoppedWorkspace) return stoppedWorkspace;
      const preservationReceiptId = await verifiedWorkspaceRepairReceipt(db, source);
      if (preservationReceiptId) return { mode: "resume_preserved_workspace", preservationReceiptId };
      const [bound] = await db.select({ id: executionWorkspaces.id, metadata: executionWorkspaces.metadata }).from(issues)
        .innerJoin(executionWorkspaces, and(eq(executionWorkspaces.companyId, issues.companyId),
          eq(executionWorkspaces.id, issues.executionWorkspaceId)))
        .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
      const authority = readRemoteWorkspaceAuthority(bound?.metadata);
      if (bound && authority && !authority.dirty && !authority.writerRunId && authority.snapshotId) {
        const recovered = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
          nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
          contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId')`,
          runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object('remoteWorkspace', ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace',
            'nativeWorkspaceSync', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync')`,
        }).from(issueRecoveryActions)
          .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
            sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`))
          .where(and(eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
            eq(heartbeatRuns.agentId, run.agentId),
            sql`${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,runId}' = ${run.id}`,
            sql`${heartbeatRuns.runnerProfileJson}#>>'{remoteWorkspace,workspaceId}' = ${bound.id}`,
            sql`${heartbeatRuns.runnerProfileJson}#>>'{remoteWorkspace,snapshotId}' = ${authority.snapshotId}`)).limit(1);
        for (const writer of recovered) {
          const remote = remoteWorkspaceRunReferenceSchema.safeParse(writer.runnerProfileJson?.remoteWorkspace);
          if (!remote.success || remote.data.state !== "saved" || remote.data.workspaceId !== bound.id
            || remote.data.epoch !== authority.epoch || remote.data.snapshotId !== authority.snapshotId) continue;
          const receipt = await verifiedWorkspaceRepairReceipt(db, writer);
          if (receipt) return { mode: "resume_preserved_workspace", preservationReceiptId: receipt };
        }
      }
      const workspace = run.contextSnapshot?.previousRunId === source.id
        ? await reusableDirectoryAfterPreparationFailure(db, source, issueId) : null;
      if (workspace?.cwd) {
        const readiness: ContinuationReadiness = { mode: "reuse_current_workspace", retryIntentId: wake.id,
          sourceRunId: source.id, workspaceId: workspace.id, cwd: workspace.cwd };
        await db.transaction(async tx => {
          const changed = await tx.update(agentWakeupRequests).set({
            payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"continue"'::jsonb)`,
          }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.runId, run.id),
            sql`${agentWakeupRequests.payload}#>>'{taskRetry,strategy}' = 'evaluate'`)).returning({ id: agentWakeupRequests.id });
          if (changed.length) await persistActivity(tx as unknown as Db, { companyId: run.companyId,
            actorType: "system", actorId: "task-recovery", action: "issue.retry_workspace_reused",
            entityType: "issue", entityId: issueId, runId: run.id, details: readiness });
        });
        return readiness;
      }
      // R2: a Retry whose source has no admitted fresh receipt (for example a
      // blocked recovery without a generation) also keeps a safe task workspace.
      // Every hold recorded for the source must permit the reuse.
      const holds = await db.select({ cause: issueRecoveryActions.cause, evidence: issueRecoveryActions.evidence })
        .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId), sql`${issueRecoveryActions.evidence}->>'runId' = ${source.id}`));
      let retained: { id: string; cwd: string } | null = null;
      const gitProbes = new Map<string, Promise<boolean>>();
      for (const hold of holds.length ? holds : [{ cause: null, evidence: null }]) {
        const checked = await retainedIssueWorkspaceForRetry(db, { companyId: run.companyId, issueId,
          agentId: run.agentId, successorRunId: run.id, cause: hold.cause, source, evidence: hold.evidence, gitProbes });
        if (!checked || (retained && retained.id !== checked.id)) { retained = null; break; }
        retained = checked;
      }
      if (retained) {
        const readiness: ContinuationReadiness = { mode: "reuse_issue_workspace", retryIntentId: wake.id,
          sourceRunId: source.id, workspaceId: retained.id, cwd: retained.cwd };
        await db.transaction(async tx => {
          const changed = await tx.update(agentWakeupRequests).set({
            payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"continue"'::jsonb)`,
          }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.runId, run.id),
            sql`${agentWakeupRequests.payload}#>>'{taskRetry,strategy}' = 'evaluate'`)).returning({ id: agentWakeupRequests.id });
          if (changed.length) await persistActivity(tx as unknown as Db, { companyId: run.companyId,
            actorType: "system", actorId: "task-recovery", action: "issue.retry_workspace_reused",
            entityType: "issue", entityId: issueId, runId: run.id, details: readiness });
        });
        return readiness;
      }
    }
    const leases = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, source.id),
    ));
    const readiness: ContinuationReadiness = { mode: "fresh_isolated_workspace",
      retryIntentId: wake.id, sourceRunId: source.id, retainedSourceIds: leases.map(lease => lease.id) };
    await db.transaction(async tx => {
      const changed = await tx.update(agentWakeupRequests).set({
        payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"fresh_isolated_workspace"'::jsonb)`,
      }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.runId, run.id),
        sql`${agentWakeupRequests.payload}#>>'{taskRetry,strategy}' in ('evaluate', 'continue')`)).returning({ id: agentWakeupRequests.id });
      if (changed.length) await persistActivity(tx as unknown as Db, { companyId: run.companyId,
        actorType: "system", actorId: "task-recovery", action: "issue.fresh_workspace_selected",
        entityType: "issue", entityId: issueId, runId: run.id, details: { ...readiness } });
    });
    return readiness;
  }
  const authorization = action?.evidence.explicitUserContinuation as Record<string, unknown> | undefined;
  const parsed = freshReadinessSchema.safeParse(authorization?.readiness);
  if (!parsed.success) return null;
  const readiness = parsed.data;
  const recovery = readSystemRecovery(action.evidence);
  if (action.evidence.runId !== readiness.sourceRunId || recovery?.sourceRunId !== readiness.sourceRunId ||
      recovery.freshAttemptRunId !== run.id) return null;
  const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, readiness.retryIntentId),
    eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, run.id),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  )).limit(1);
  if (!wake) throw new Error("Fresh workspace admission lost its input receipt");
  return readiness;
}
