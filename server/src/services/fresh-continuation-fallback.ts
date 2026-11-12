import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests, agents, approvals, companies, executionWorkspaces, heartbeatRuns, issueApprovals, issueRecoveryActions,
  issueThreadInteractions, issues, nativeRunFinalizations, toolInvocations, type Db,
} from "@paperclipai/db";
import {
  EXECUTION_RECONCILIATION_CAUSES, readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type ExecutionReconciliation,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { isAcknowledgedNativeReassignmentStop, isAcknowledgedNativeStop } from "./acknowledged-native-stop.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { isInterruptedNativePreparationCandidate } from "./cancelled-native-startup.js";
import { notifyDeferredWakesForIssue } from "./deferred-execution-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { issueService } from "./issues.js";
import { holdOwnsBlockedStatus } from "./recovery-hold-blocked-status.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "./remote-workspace-epoch-abandonment.js";
import { notifyRoutineExecutionStatus } from "./routine-execution-status-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { readRunCancellation } from "./run-cancellation.js";
import { readSystemRecovery } from "./system-recovery-state.js";

/**
 * Fresh-continuation fallback: exact resumption of an unfinished run is an
 * optimization, never a requirement.
 *
 * When a run ended without finishing its work and nothing exact follows it
 * (no resumed session, no replacement, no scheduled retry, no saved input),
 * `ensureFreshContinuation` starts the task again in a fresh session from its
 * last verified saved workspace and its conversation. It needs no person and
 * no proof that the old executor stopped:
 *
 * - The old run keeps its own fencing. Its remote workspace epoch is abandoned
 *   when it still owns it, so its writer can never publish again and the next
 *   run restores the last committed save into a new root on a new allocation.
 *   The unverified files stay in the abandoned root (recorded on the
 *   workspace), unapplied.
 * - The opening context of the continuation names the cut-off run and every
 *   action whose outcome is unknown, so the agent checks before repeating a
 *   side effect.
 *
 * Eligibility is by classification, not by an allowlist: every failure is
 * eligible except the causes a person must resolve (`PERSON_OWNED_FAILURE_CODES`
 * and the task-level waits in `personOwnedTaskWait`). A failure code added
 * later falls back without a change here.
 *
 * Idempotent per source run: the task row lock serializes callers on every
 * server, and the recorded `freshContinuation.sourceRunId` (or any newer run of
 * the task) makes later calls a no-op. Bounded per task, not per failure: at
 * most `FRESH_CONTINUATIONS_PER_HOUR` continuations in a rolling hour, then it
 * backs off and is checked again; it never charges the task's failure budget.
 */

export const FRESH_CONTINUATION_SCHEMA = "paperclip.fresh-continuation.v1" as const;
export const FRESH_CONTINUATION_ACTOR = "fresh-continuation" as const;
/** Cause of the record written when the run left no hold of its own. Not an execution blocker. */
export const FRESH_CONTINUATION_CAUSE = "fresh_continuation" as const;
/** Evidence key for the last check that did not continue (and when to check again). */
export const FRESH_CONTINUATION_CHECK_KEY = "freshContinuationCheck" as const;
/** The restart lane's bound, reused: continuations per task per rolling hour. */
// Literal values (an import would be undefined under the heartbeat module's
// import cycle); a test pins them to SERVER_RESTART_RETRY_MAX_ATTEMPTS/_WINDOW_MS.
export const FRESH_CONTINUATIONS_PER_HOUR = 6;
export const FRESH_CONTINUATION_WINDOW_MS = 60 * 60_000;
const PERSON_RECHECK_MS = 60 * 60_000;
const EXACT_RECOVERY_RECHECK_MS = 2 * 60_000;

/**
 * Run failure codes that only a person can resolve: they stopped the work, a
 * credential or access they must share, a configuration choice they must make,
 * a budget stop, or a provider usage limit that is waiting as designed. Every
 * other code, including codes that do not exist yet, gets the fallback.
 */
export const PERSON_OWNED_FAILURE_CODES = [
  // A person stopped or paused the work.
  "cancelled", "operator_cancelled", "issue_cancelled", "issue_paused", "agent_paused",
  // A credential, secret or access the person must share.
  "configuration_incomplete", "slack_configuration_incomplete", "signing_secret_unconfigured",
  "user_secret_missing", "user_secret_definition_missing", "user_secret_definition_inactive",
  "github_access_denied", "github_repo_not_accessible", "github_auth_required", "project_access_denied",
  "permission_denied", "responsible_user_unauthorized", "oauth_access_projection_disabled",
  "continuation_user_authorization_missing", "chat_failed_run_retry_not_authorized",
  "acpx_auth_required", "codex_auth_required", "claude_auth_required", "provider_auth_failed", "hermes_gateway_auth_failed",
  // A configuration choice the person must change.
  "native_provider_model_rejected", "provider_tool_definition_invalid", "turn_limit_exhausted",
  // Budget stops.
  "budget_blocked", "budget_hard_stop", "budget_exceeded",
  // Provider usage limits that wait (and resume) as designed.
  "provider_quota", "provider_limit_wait", "native_provider_usage_limit",
  // An approval the person must give.
  "approval_required", "formal_approval_unavailable",
] as const;

export function isPersonOwnedFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && (PERSON_OWNED_FAILURE_CODES as readonly string[]).includes(code);
}

const UNFINISHED_STATUSES = ["failed", "timed_out", "interrupted", "cancelled"];
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const EXACT_RECOVERY_STATES = ["scheduled", "running", "awaiting_evidence"];

export type FreshContinuationTrigger = "recovery_refused" | "held_recovery" | "continuation_wake";

export type FreshContinuationResult =
  | { kind: "continued"; recoveryActionId: string; delivery: "recorded" | "caller_owns" | "saved_input" }
  | { kind: "already_continued"; recoveryActionId: string }
  | { kind: "successor_exists" }
  | { kind: "dependency_wait" }
  | { kind: "person_owned"; reason: string }
  | { kind: "backoff"; retryAt: Date }
  | { kind: "exact_recovery_pending"; reason: string; retryAt: Date }
  | { kind: "not_applicable"; reason: string };

type Input = {
  companyId: string;
  runId: string;
  trigger: FreshContinuationTrigger;
  now?: Date;
  /**
   * `record`: record one durable continuation that the execution-continuation
   * worker delivers. `caller_owns`: the caller is admitting a wake for this
   * task in the same transaction, and that wake is the continuation.
   */
  delivery?: "record" | "caller_owns";
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function holdRunId(evidence: Record<string, unknown>): string | null {
  const value = evidence.runId ?? evidence.sourceRunId;
  return typeof value === "string" ? value : null;
}

/** Task-level waits that belong to a person. Read under the task lock. */
async function personOwnedTaskWait(tx: Db, input: { companyId: string; issue: typeof issues.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect }): Promise<string | null> {
  const { companyId, issue, run } = input;
  const [approval] = await tx.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, companyId),
  )).where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.issueId, issue.id),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (approval) return "approval_pending";
  const [question] = await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issue.id),
    eq(issueThreadInteractions.status, "pending"))).limit(1);
  if (question) return "question_pending";
  const [agent] = await tx.select({ status: agents.status, lifecycleState: agents.lifecycleState }).from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, run.agentId)));
  if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status) || agent.lifecycleState !== "ready")
    return "agent_not_available";
  const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
  if (company && company.status !== "active") return "company_paused";
  return null;
}

/** Actions of the source run that ended with an unknown outcome. */
async function unverifiedActions(tx: Db, run: typeof heartbeatRuns.$inferSelect): Promise<string[]> {
  const names = new Set<string>();
  for (const receipt of Object.values(object(object(run.resultJson).apiToolReceipts)).map(object)) {
    if (receipt.state !== "completed" || object(receipt.result).outcome === "unknown")
      names.add(typeof receipt.toolName === "string" ? receipt.toolName : "a Paperclip API call");
  }
  const rows = await tx.select({ toolName: toolInvocations.toolName }).from(toolInvocations).where(and(
    eq(toolInvocations.companyId, run.companyId), eq(toolInvocations.runId, run.id),
    sql`${toolInvocations.riskLevel} is distinct from 'read'`,
    inArray(toolInvocations.status, ["executing", "failed", "timed_out"]))).limit(20);
  for (const row of rows) names.add(row.toolName);
  return [...names].slice(0, 20);
}

/** The opening context of the continuation. It names no person who must act. */
export function freshContinuationNote(input: { runId: string; unverified: string[]; workspace: "restored_last_save" | "kept" }) {
  const actions = input.unverified.length
    ? `These actions of that run have unverified outcomes: ${input.unverified.join(", ")}. Check whether each one took effect before repeating it.`
    : "No action of that run is recorded with an unknown outcome, but check the task's recent history before repeating any side effect.";
  const files = input.workspace === "restored_last_save"
    ? "Its unsaved file changes could not be verified, so this run starts from the last saved version of the workspace; those changes were not applied."
    : "This run starts from the task's saved workspace.";
  return `The previous attempt (run ${input.runId}) was cut off before it finished. ${files} ${actions}`;
}

const USER_TEXT = "The previous run was cut off. Paperclip continues the task in a fresh run from its last saved work.";

/** Abandons the source run's remote workspace epoch when it still owns it. */
async function fenceSourceWorkspace(tx: Db, run: typeof heartbeatRuns.$inferSelect) {
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(object(run.runnerProfileJson).remoteWorkspace);
  if (!parsed.success || parsed.data.state !== "prepared") return null;
  const reference = parsed.data;
  const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
  let authority;
  try { authority = readRemoteWorkspaceAuthority(workspace?.metadata); } catch { return null; }
  if (!authority?.location || authority.writerRunId !== run.id || authority.epoch !== reference.epoch) return null;
  try {
    const abandoned = await tx.transaction(savepoint => abandonUnverifiedRemoteWorkspaceEpoch(savepoint, {
      companyId: run.companyId, workspaceId: reference.workspaceId, runId: run.id, epoch: authority.epoch,
      snapshotId: authority.snapshotId, location: authority.location! }));
    return { workspaceId: reference.workspaceId, abandonedEpoch: authority.epoch, epoch: abandoned.authority.epoch,
      snapshotId: authority.snapshotId,
      quarantine: { state: "retained_unapplied" as const, remoteCwd: authority.location.remoteCwd,
        providerLeaseId: authority.location.providerLeaseId } };
  } catch (error) {
    if (error instanceof Error && error.message === "remote_workspace_authority_changed") return null;
    throw error;
  }
}

export async function ensureFreshContinuation(db: Db, input: Input): Promise<FreshContinuationResult> {
  return db.transaction(tx => continueFreshInTransaction(tx as unknown as Db, input));
}

/**
 * The fallback inside the caller's transaction. Locks in the shared order
 * (task, coordinator, run, recovery actions, workspace); rows the caller
 * already locked are locked again harmlessly.
 */
export async function continueFreshInTransaction(tx: Db, input: Input): Promise<FreshContinuationResult> {
  const now = input.now && Number.isFinite(input.now.getTime()) ? input.now : new Date();
  const { companyId } = input;
  const [peek] = await tx.select({ issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.runId)));
  if (!peek) return { kind: "not_applicable", reason: "run_missing" };
  const contextIssueId = object(peek.contextSnapshot).issueId;
  const issueId = peek.nativeIssueId ?? peek.issueId ?? (typeof contextIssueId === "string" ? contextIssueId : null);
  if (!issueId) return { kind: "not_applicable", reason: "run_has_no_task" };
  const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
  const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, input.runId))).for("update");
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.id, input.runId))).for("update");
  if (!issue || !run) return { kind: "not_applicable", reason: "run_missing" };
  if (!UNFINISHED_STATUSES.includes(run.status) || !run.finishedAt) return { kind: "not_applicable", reason: "run_not_unfinished" };
  if (!issue.assigneeAgentId || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId
    || ["done", "cancelled"].includes(issue.status)) return { kind: "not_applicable", reason: "task_changed" };

  const holds = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issue.id),
    or(sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`, sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${run.id}`)))
    .orderBy(asc(issueRecoveryActions.createdAt), asc(issueRecoveryActions.id)).for("update");
  const prior = holds.find(hold => object(hold.evidence.freshContinuation).sourceRunId === run.id);
  if (prior) return { kind: "already_continued", recoveryActionId: prior.id };

  // (a) Something already follows this run: a newer run of the task, a linked
  // replacement, or an operator's continuation.
  const [newer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id} <> ${run.id}`,
    or(eq(heartbeatRuns.nativeIssueId, issue.id), eq(heartbeatRuns.issueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    or(inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
      sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${run.createdAt.toISOString()}::timestamptz, ${run.id}::uuid)`))).limit(1);
  if (newer || typeof object(coordinator?.failureDetail).successorRunId === "string"
    || holds.some(hold => hold.evidence.executionReconciliation && ["pending", "delivered", "delegated"]
      .includes(String(hold.evidence.continuationDelivery)))) return { kind: "successor_exists" };

  // Exact recovery that is still under way keeps its chance. Each of these is
  // bounded by its own owner; the fallback is checked again afterwards.
  if (adapterExecutionControls.has(run.id)) return { kind: "exact_recovery_pending", reason: "execution_settling",
    retryAt: new Date(now.getTime() + EXACT_RECOVERY_RECHECK_MS) };
  if (coordinator?.leaseOwner || (coordinator?.resultId && coordinator.phase !== "committed")
    || (coordinator?.nextAttemptAt && coordinator.nextAttemptAt > now))
    return { kind: "exact_recovery_pending", reason: "native_finalizer_active",
      retryAt: coordinator?.nextAttemptAt && coordinator.nextAttemptAt > now ? coordinator.nextAttemptAt
        : new Date(now.getTime() + EXACT_RECOVERY_RECHECK_MS) };
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now)
    return { kind: "exact_recovery_pending", reason: "controller_lease_live", retryAt: run.controllerLeaseExpiresAt };
  // A preparation that never started provider work has its own bounded retry
  // lane (the ownership pass). It gets the first chance; the fallback follows.
  if (isInterruptedNativePreparationCandidate(run) && !holds.some(hold => hold.evidence[FRESH_CONTINUATION_CHECK_KEY]))
    return { kind: "exact_recovery_pending", reason: "interrupted_preparation_lane",
      retryAt: new Date(now.getTime() + EXACT_RECOVERY_RECHECK_MS) };
  for (const hold of holds) {
    const recovery = readSystemRecovery(hold.evidence);
    if (recovery && EXACT_RECOVERY_STATES.includes(recovery.state))
      return { kind: "exact_recovery_pending", reason: "saved_work_recovery_running",
        retryAt: new Date(Math.max(now.getTime() + EXACT_RECOVERY_RECHECK_MS, recovery.nextAttemptAt ?? 0)) };
    const retainedCheck = object(hold.evidence.retainedSourceFallbackCheck);
    if (recovery?.state === "exhausted" && typeof retainedCheck.nextCheckAt === "number" && retainedCheck.nextCheckAt > now.getTime())
      return { kind: "exact_recovery_pending", reason: "retained_source_fallback_pending", retryAt: new Date(retainedCheck.nextCheckAt) };
  }

  // (b) Causes that are the person's.
  if (isPersonOwnedFailureCode(run.errorCode)) return { kind: "person_owned", reason: run.errorCode! };
  // A Stop a person (or an agent acting on the task) asked for is never undone.
  const cancellation = readRunCancellation(run.resultJson);
  if (run.status === "cancelled" && (isAcknowledgedNativeStop(run) || isAcknowledgedNativeReassignmentStop(run)
    || object(run.resultJson).operatorInterrupted === true
    || (cancellation && ["user", "agent"].includes(cancellation.initiator.type))
    // A cancellation that recorded neither its cause nor a system initiator may
    // be a person's Stop saved by an older release; it is never undone.
    || (!cancellation && !run.errorCode)))
    return { kind: "person_owned", reason: "stopped_on_request" };
  // A task in review waits for its reviewer.
  if (issue.status === "in_review") return { kind: "person_owned", reason: "in_review" };
  if (holds.some(hold => hold.ownerUserId || hold.evidence.ownerGoneAttestation || hold.evidence.explicitUserContinuation))
    return { kind: "person_owned", reason: "operator_decision_recorded" };
  const taskWait = await personOwnedTaskWait(tx, { companyId, issue, run });
  if (taskWait) return { kind: "person_owned", reason: taskWait };
  let ownsBlock = false;
  if (issue.status === "blocked") {
    const receipts = holds.filter(hold => hold.evidence.nativeFailureBlock !== undefined || hold.evidence.legacyCancellationBlock !== undefined
      || hold.evidence.nativeBootstrapFailureBlock !== undefined);
    ownsBlock = (receipts.length ? receipts : holds).some(hold => holdOwnsBlockedStatus(hold, issue, run))
      || receipts.some(hold => [hold.evidence.legacyCancellationBlock, hold.evidence.nativeBootstrapFailureBlock]
        .some(block => object(block).runId === run.id && object(block).statusVersion === Number(issue.statusVersion)))
      // A run that left no hold: its terminal failure set the block and nothing changed it since.
      || (!holds.length && issue.lastStatusDecisionId === null && issue.blockedTransitionAt !== null
        && issue.blockedTransitionAt.getTime() >= run.finishedAt.getTime() - 1_000);
    if (!ownsBlock) return { kind: "person_owned", reason: "blocked_by_another_decision" };
    const readiness = await issueService(tx).listDependencyReadiness(companyId, [issue.id], tx);
    if (readiness.get(issue.id)?.isDependencyReady === false) return { kind: "dependency_wait" };
  }

  // (c) Bounded per task: the restart lane's hourly cap, then back off.
  const windowStart = new Date(now.getTime() - FRESH_CONTINUATION_WINDOW_MS).toISOString();
  const recent = await tx.select({ recordedAt: sql<string>`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}'` })
    .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, issue.id),
      sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`,
      sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}' > ${windowStart}`))
    .orderBy(asc(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}'`));
  if (recent.length >= FRESH_CONTINUATIONS_PER_HOUR) {
    const oldest = new Date(recent[0]!.recordedAt).getTime();
    return { kind: "backoff", retryAt: new Date(oldest + FRESH_CONTINUATION_WINDOW_MS) };
  }

  // Saved user input (a message or a Retry the person pressed) continues the
  // task through normal admission once nothing blocks it; a second, automatic
  // continuation would run after it.
  const [savedInput] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    eq(agentWakeupRequests.requestedByActorType, "user"), sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`)).limit(1);
  const delivery: "recorded" | "caller_owns" | "saved_input" = input.delivery === "caller_owns" ? "caller_owns"
    : savedInput ? "saved_input" : "recorded";

  // (d) Continue: fence the old workspace epoch, settle every hold of the run,
  // release the Blocked status this failure owns, and record one continuation.
  const fenced = await fenceSourceWorkspace(tx, run);
  const unverified = await unverifiedActions(tx, run);
  const note = freshContinuationNote({ runId: run.id, unverified, workspace: fenced ? "restored_last_save" : "kept" });
  const decision: ExecutionReconciliation = { runId: run.id, providerStopped: true, actionOutcome: "mixed", outcomeEvidence: note,
    workspaceRepairEvidence: fenced
      ? `Paperclip abandoned unverified workspace epoch ${fenced.abandonedEpoch} of run ${run.id}; the continuation restores `
        + `${fenced.snapshotId ? `committed snapshot ${fenced.snapshotId}` : "the workspace source"} into a new root.`
      : `The continuation of run ${run.id} starts from the task's last saved workspace; no unverified files are applied.` };
  const freshContinuation = { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: run.id, trigger: input.trigger,
    failureCode: run.errorCode ?? null, delivery, recordedAt: now.toISOString(),
    // The successor never shares this run's controller, session or workspace epoch.
    stopProof: fenced ? "workspace_epoch_abandoned" : "run_terminal", unverifiedActions: unverified,
    ...(fenced ? { workspace: fenced } : {}) };
  const reconciliation = { ...decision, actorId: FRESH_CONTINUATION_ACTOR, recordedAt: now.toISOString() };
  const ownerHold = holds.find(hold => issue.status === "blocked" && holdOwnsBlockedStatus(hold, issue, run)) ?? holds.at(-1);

  await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionReplacement);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
  await notifyStatusCardIssueChange(tx, companyId);
  await notifyRoutineExecutionStatus(tx, issue.id, companyId);
  if (delivery === "saved_input") await notifyDeferredWakesForIssue(tx, { companyId, issueId: issue.id });

  let primaryId: string;
  const continuationDelivery = delivery === "recorded" ? "pending" : "not_requested";
  if (ownerHold) {
    primaryId = ownerHold.id;
    for (const hold of holds) {
      const primary = hold.id === ownerHold.id;
      const { automaticRecovery: _automatic, [FRESH_CONTINUATION_CHECK_KEY]: _check, ...evidence } = hold.evidence;
      await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: hold.resolvedAt ?? now,
        updatedAt: now, ownerType: "system", ownerAgentId: null, ownerUserId: null, wakePolicy: null, monitorPolicy: null,
        returnOwnerAgentId: primary ? run.agentId : hold.returnOwnerAgentId, nextAction: USER_TEXT,
        resolutionNote: "continued_fresh_from_last_saved",
        evidence: { ...evidence, executionReconciliation: reconciliation,
          ...(primary ? { freshContinuation, continuationDelivery }
            : { continuationDelivery: "invalidated", coalescedIntoRecoveryActionId: ownerHold.id }) },
      }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, hold.id)));
    }
  } else {
    const [created] = await tx.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
      returnOwnerAgentId: run.agentId, cause: FRESH_CONTINUATION_CAUSE, fingerprint: `fresh-continuation:${run.id}`,
      nextAction: USER_TEXT, resolutionNote: "continued_fresh_from_last_saved", resolvedAt: now, attemptCount: 1,
      evidence: { runId: run.id, originalFailureCode: run.errorCode ?? null, executionReconciliation: reconciliation,
        freshContinuation, continuationDelivery } }).returning({ id: issueRecoveryActions.id });
    primaryId = created!.id;
  }
  // The source is never replayed or replaced exactly after this decision.
  if (coordinator) {
    await tx.update(nativeRunFinalizations).set({ failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb)
      || ${JSON.stringify({ replacementDenied: "fresh_continuation" })}::jsonb` }).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id)));
  }
  if (issue.status === "blocked") {
    await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
      blockedOwnerNotifiedAt: null, updatedAt: now }).where(and(eq(issues.companyId, companyId), eq(issues.id, issue.id)));
    await logActivity(tx, { companyId, actorType: "system", actorId: FRESH_CONTINUATION_ACTOR, action: "issue.updated",
      entityType: "issue", entityId: issue.id, agentId: run.agentId, runId: run.id,
      details: { status: "todo", previousStatus: "blocked", reason: "fresh_continuation", recoveryActionId: primaryId,
        _previous: { status: "blocked" } } });
  }
  await logActivity(tx, { companyId, actorType: "system", actorId: FRESH_CONTINUATION_ACTOR,
    action: "issue.continued_from_saved_work", entityType: "issue", entityId: issue.id, agentId: run.agentId, runId: run.id,
    details: { recoveryActionId: primaryId, sourceRunId: run.id, failureCode: run.errorCode ?? null, trigger: input.trigger,
      delivery, workspaceEpochAbandoned: Boolean(fenced), unverifiedActionCount: unverified.length } });
  logger.info({ runId: run.id, issueId: issue.id, failureCode: run.errorCode, trigger: input.trigger, delivery },
    "Unfinished run continues in a fresh run from saved work");
  return { kind: "continued", recoveryActionId: primaryId, delivery };
}

/** Records why a hold was not continued yet, and when to look again. */
export async function recordFreshContinuationCheck(db: Db, input: { companyId: string; actionId: string },
  result: FreshContinuationResult, now = new Date()) {
  if (result.kind === "continued" || result.kind === "already_continued") return;
  const nextCheckAt = result.kind === "backoff" || result.kind === "exact_recovery_pending" ? result.retryAt.getTime()
    : result.kind === "person_owned" || result.kind === "dependency_wait" ? now.getTime() + PERSON_RECHECK_MS : null;
  const marker = { kind: result.kind, reason: "reason" in result ? result.reason : null, checkedAt: now.getTime(), nextCheckAt };
  await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence}
    || jsonb_build_object(${FRESH_CONTINUATION_CHECK_KEY}::text, ${JSON.stringify(marker)}::jsonb)` }).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)));
}

/** Not yet checked, or due for another check. */
export function freshContinuationCheckDue(now: Date) {
  return sql`(${issueRecoveryActions.evidence}->${FRESH_CONTINUATION_CHECK_KEY} is null
    or coalesce((${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}')::bigint, 9223372036854775807) <= ${now.getTime()})`;
}

/**
 * Holds that today keep a task waiting with no automatic continuation, including
 * every shape older releases saved: settled-but-blocked no-replay holds, and
 * saved-work recoveries that finished or gave up. Exact recovery still under
 * way is excluded (it is checked again by its owner and here afterwards).
 */
export function heldExecutionsAwaitingFreshContinuation(db: Db, now: Date, limit: number) {
  return db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
    runId: sql<string>`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')` })
    .from(issueRecoveryActions).innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId),
      eq(issues.companyId, issueRecoveryActions.companyId)))
    .where(and(
      inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
      sql`${issueRecoveryActions.evidence}->'executionReconciliation' is null`,
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is null`,
      sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId') is not null`,
      or(
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('complete', 'exhausted')`),
      ),
      sql`coalesce(${issueRecoveryActions.evidence}#>>'{systemRecovery,state}', '') not in ('scheduled', 'running', 'awaiting_evidence')`,
      isNull(issueRecoveryActions.ownerUserId),
      sql`${issues.status} not in ('done', 'cancelled')`,
      sql`${issues.assigneeAgentId} is not null`,
      // Only the task's latest run, unfinished and still its assignee's: other
      // holds are history, and are never touched here.
      sql`exists (select 1 from ${heartbeatRuns} source where source.company_id = ${issueRecoveryActions.companyId}
        and source.id::text = coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')
        and source.status in ('failed', 'timed_out', 'interrupted', 'cancelled') and source.finished_at is not null
        and source.agent_id = ${issues.assigneeAgentId}
        and not exists (select 1 from ${heartbeatRuns} newer where newer.company_id = source.company_id and newer.id <> source.id
          and (newer.native_issue_id = ${issues.id} or newer.issue_id = ${issues.id} or newer.context_snapshot->>'issueId' = ${issues.id}::text)
          and (newer.status in ('queued', 'running', 'scheduled_retry') or (newer.created_at, newer.id) > (source.created_at, source.id))))`,
      freshContinuationCheckDue(now),
    ))
    .orderBy(asc(issueRecoveryActions.updatedAt), asc(issueRecoveryActions.id))
    .limit(limit);
}

/** The earliest time a deferred check becomes due again, if any. */
export async function nextFreshContinuationCheckAt(db: Db): Promise<number | null> {
  const [row] = await db.select({ at: sql<string | null>`min((${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}')::bigint)` })
    .from(issueRecoveryActions).where(and(
      sql`${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}' is not null`,
      sql`${issueRecoveryActions.evidence}->'executionReconciliation' is null`,
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is null`,
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`)));
  return row?.at ? Number(row.at) : null;
}

/**
 * Continues tasks held by recovery records, including records saved by older
 * releases, so tasks already waiting continue after deploy without a Retry.
 * Runs on the execution-disposition worker. Bounded per pass.
 */
export async function continueHeldExecutions(db: Db, now = new Date(), limit = 25) {
  const candidates = await heldExecutionsAwaitingFreshContinuation(db, now, limit);
  let continued = 0;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.runId || seen.has(candidate.runId)) continue;
    seen.add(candidate.runId);
    try {
      const result = await ensureFreshContinuation(db, { companyId: candidate.companyId, runId: candidate.runId,
        trigger: "held_recovery", now });
      if (result.kind === "continued") continued += 1;
      else await recordFreshContinuationCheck(db, { companyId: candidate.companyId, actionId: candidate.id }, result, now);
    } catch (error) {
      logger.warn({ err: error, recoveryActionId: candidate.id }, "Fresh continuation of a held task deferred");
      await recordFreshContinuationCheck(db, { companyId: candidate.companyId, actionId: candidate.id },
        { kind: "exact_recovery_pending", reason: "fallback_failed", retryAt: new Date(now.getTime() + EXACT_RECOVERY_RECHECK_MS) }, now)
        .catch(() => undefined);
    }
  }
  return { checked: seen.size, continued };
}

/** Newest-first list of fresh continuations of one task (diagnostics and tests). */
export async function listFreshContinuations(db: Db, input: { companyId: string; issueId: string }) {
  return db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId),
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`,
    gt(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}'`, "")))
    .orderBy(desc(issueRecoveryActions.updatedAt));
}
