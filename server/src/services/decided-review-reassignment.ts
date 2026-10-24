import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  approvals,
  environmentLeases,
  heartbeatRuns,
  issueApprovals,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { persistActivity } from "./activity-log.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { readChatControlRecoveryStop } from "./chat-control-recovery-stop.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { executionBlockerPredicate } from "./execution-blocker.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { isPreDispatchExecutionWaitVerified } from "./pre-dispatch-execution-wait.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

/**
 * A reviewer run that recorded a durable decision and was then stopped by the
 * expected reassignment of that same mutation has no unknown review outcome:
 * its outcome is the decision. After the author resubmits, the current review
 * participant needs a fresh turn on the new submission, not a replay of the
 * stopped run. Everything here runs under the issue row lock and proves the
 * exact provenance again; unproven, unknown or foreign cases keep their hold.
 */

type Run = typeof heartbeatRuns.$inferSelect;
type Task = typeof issues.$inferSelect;
type Hold = typeof issueRecoveryActions.$inferSelect;
type Decision = typeof issueExecutionDecisions.$inferSelect;

const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";
export const DECIDED_REVIEW_CONTINUATION_REPLAY = "decided_review_continuation_v1";
const REVIEW_REQUEST_REASON = "execution_review_requested";

/** A submission is the recorded decision plus the author's later resubmission. */
export type SubmissionIdentity = { decisionId: string; resubmissionActivityId: string };

export type DecidedReviewConsumption = {
  sourceRunId: string;
  decisionId: string;
  resubmissionActivityId: string;
  chainRunIds: string[];
  successorRunId: string;
  shape: "in_review" | "blocked_projection";
  recordedAt: string;
};

export type DecidedReviewSource = { source: Run; chain: Run[]; holds: Hold[]; decision: Decision };

export type DecidedReviewSelection =
  | ({ kind: "selected" } & DecidedReviewSource)
  | { kind: "none"; rule: string; runId?: string };

export type DecidedReviewProof =
  | {
      kind: "proved";
      task: Task;
      source: Run;
      chain: Run[];
      holds: Hold[];
      decisionId: string;
      resubmissionActivityId: string;
      shape: "in_review" | "blocked_projection";
    }
  | { kind: "hold"; reason: string };

function readState(task: Pick<Task, "executionState">) {
  return parseIssueExecutionState(task.executionState);
}

function runIssueId(run: Pick<Run, "nativeIssueId" | "contextSnapshot">) {
  return run.nativeIssueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
}

function processStopped(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function evidenceObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readDecision(db: Db, task: Pick<Task, "companyId" | "id">, decisionId: string | null | undefined) {
  if (!decisionId) return null;
  const [decision] = await db.select().from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.companyId, task.companyId), eq(issueExecutionDecisions.issueId, task.id),
    eq(issueExecutionDecisions.id, decisionId),
  )).limit(1);
  return decision ?? null;
}

async function readRun(db: Db, companyId: string, runId: string | null | undefined) {
  if (!runId) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  )).limit(1);
  return run ?? null;
}

/** The newest author resubmission into the current review stage after `decision`. */
async function latestResubmission(db: Db, task: Pick<Task, "companyId" | "id" | "executionState">, decision: Decision) {
  const state = readState(task);
  const author = state?.returnAssignee;
  if (!state?.currentStageId || !author || (author.type === "agent" ? !author.agentId : !author.userId)) return null;
  const [activity] = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, task.companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.updated"),
    eq(activityLog.actorType, author.type), eq(activityLog.actorId, (author.type === "agent" ? author.agentId : author.userId)!),
    gt(activityLog.createdAt, decision.createdAt),
    sql`${activityLog.details}->>'status' = 'in_review'`,
    sql`${activityLog.details}->'_previous'->>'status' = 'in_progress'`,
    sql`${activityLog.details}->'changes'->'executionState'->'to'->>'status' = 'pending'`,
    sql`${activityLog.details}->'changes'->'executionState'->'to'->>'currentStageId' = ${state.currentStageId}`,
    decision.createdByRunId
      ? or(isNull(activityLog.runId), ne(activityLog.runId, decision.createdByRunId))
      : undefined,
  )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
  return activity ?? null;
}

/**
 * Identify the submission this wake would serve, from durable task history
 * only. It deliberately ignores runs, holds and process state: those decide
 * whether a new continuation may be admitted, not whether one already was.
 */
export async function currentSubmissionIdentity(
  db: Db, task: Pick<Task, "companyId" | "id" | "status" | "executionState">, agentId: string,
): Promise<SubmissionIdentity | null> {
  if (task.status !== "in_review") return null;
  const state = readState(task);
  if (state?.currentStageType !== "review" || !state.currentStageId ||
      state.currentParticipant?.type !== "agent" || state.currentParticipant.agentId !== agentId) return null;
  const decision = await readDecision(db, task, state.lastDecisionId);
  if (!decision || decision.stageId !== state.currentStageId) return null;
  const decidingRun = await readRun(db, task.companyId, decision.createdByRunId);
  if (!decidingRun || decidingRun.agentId !== agentId) return null;
  const resubmission = await latestResubmission(db, task, decision);
  return resubmission ? { decisionId: decision.id, resubmissionActivityId: resubmission.id } : null;
}

/** The durable admission record for one submission, kept on its settled holds. */
export async function findConsumption(
  db: Db, task: Pick<Task, "companyId" | "id">, identity: SubmissionIdentity,
): Promise<DecidedReviewConsumption | null> {
  const [row] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->>'decisionId' = ${identity.decisionId}`,
    sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->>'resubmissionActivityId' = ${identity.resubmissionActivityId}`,
  )).orderBy(asc(issueRecoveryActions.createdAt)).limit(1);
  return (evidenceObject(row?.evidence.decidedReviewContinuation) as DecidedReviewConsumption | null) ?? null;
}

function isBlockingHold(hold: Hold) {
  return ["active", "escalated"].includes(hold.status) ||
    evidenceObject(hold.evidence.automaticRecovery)?.replay === "blocked";
}

/**
 * Choose the recovery source from decision provenance, never from "latest run".
 * Every newer run of the reviewer must be a verified unused attempt that the
 * stale gate parked behind this incident's own hold; anything else ends the
 * selection and leaves today's handling in force.
 */
export async function selectDecidedReviewSource(
  db: Db, task: Task, identity?: SubmissionIdentity | null,
): Promise<DecidedReviewSelection> {
  const state = readState(task);
  if (state?.currentParticipant?.type !== "agent" || !state.currentParticipant.agentId) return { kind: "none", rule: "participant_not_agent" };
  const agentId = state.currentParticipant.agentId;
  const decision = await readDecision(db, task, state.lastDecisionId);
  if (!decision || decision.outcome !== "changes_requested") return { kind: "none", rule: "decision_not_changes_requested" };
  const source = await readRun(db, task.companyId, decision.createdByRunId);
  if (!source || source.agentId !== agentId || runIssueId(source) !== task.id) return { kind: "none", rule: "decision_run_not_participant" };
  const submission = identity === undefined ? await currentSubmissionIdentity(db, task, agentId) : identity;
  if (submission && await findConsumption(db, task, submission)) return { kind: "none", rule: "consumed" };
  const newer = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId), eq(heartbeatRuns.agentId, agentId),
    or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
    sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (select created_at, id from heartbeat_runs where company_id = ${task.companyId} and id = ${source.id})`,
  )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  const fingerprints = (ids: string[]) => ids.map(id => `legacy-execution:${id}`);
  const chain: Run[] = [];
  for (const run of newer) {
    const wait = evidenceObject(run.resultJson?.executionWait);
    const accepted = [source.id, ...chain.map(q => q.id)];
    const [parent] = typeof wait?.recoveryActionId === "string" ? await db.select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
        sql`${issueRecoveryActions.id}::text = ${wait.recoveryActionId}`,
        inArray(sql`${issueRecoveryActions.evidence}->>'runId'`, accepted),
      )).limit(1) : [];
    if (!(await isPreDispatchExecutionWaitVerified(db, run)) || !parent || !source.finishedAt ||
        run.createdAt < source.finishedAt) {
      return { kind: "none", rule: "newer_run_not_verified_pre_dispatch_wait", runId: run.id };
    }
    chain.push(run);
  }
  const holds = (await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    inArray(issueRecoveryActions.fingerprint, fingerprints([source.id, ...chain.map(q => q.id)])),
  )).orderBy(asc(issueRecoveryActions.createdAt))).filter(isBlockingHold);
  return { kind: "selected", source, chain, holds, decision };
}

async function provesStopSettled(db: Db, run: Run) {
  if (run.processPid && !processStopped(run.processPid)) return "P2_process_running";
  if (run.processGroupId && !processStopped(-run.processGroupId)) return "P2_process_running";
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease))) return "P2_lease_unreleased";
  return null;
}

/** P1: the run ended by the expected stop of the mutation that reassigned it. */
async function provesExpectedReassignmentStop(db: Db, run: Run) {
  const result = run.resultJson ?? {};
  const cancellation = evidenceObject(result.cancellation);
  const initiator = evidenceObject(cancellation?.initiator);
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || run.errorCode !== "issue_reassigned" ||
      result.reassignmentStopConfirmed !== true || typeof result.issueMutationStopId !== "string" ||
      cancellation?.source !== "control_plane" || cancellation.expected !== true ||
      ["user", "board"].includes(String(initiator?.type)) || !run.finishedAt ||
      hasWorkspaceRestoreFailure(result)) return "P1_not_expected_reassignment_stop";
  const [native] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  return native ? "P1_native_finalization" : null;
}

/** P3: the run's own decision, recorded by the same mutation that stopped it. */
async function provesDecisionProvenance(db: Db, task: Task, run: Run, decision: Decision) {
  const state = readState(task);
  if (decision.createdByRunId !== run.id || decision.actorAgentId !== run.agentId ||
      decision.outcome !== "changes_requested" || decision.stageType !== "review" ||
      decision.stageId !== state?.currentStageId || !run.finishedAt ||
      decision.createdAt < run.finishedAt) return "P3_decision_provenance";
  const [later] = await db.select({ id: issueExecutionDecisions.id }).from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.companyId, task.companyId), eq(issueExecutionDecisions.issueId, task.id),
    eq(issueExecutionDecisions.stageId, decision.stageId), ne(issueExecutionDecisions.id, decision.id),
    sql`${issueExecutionDecisions.createdAt} >= ${decision.createdAt.toISOString()}::timestamptz`,
  )).limit(1);
  return later ? "P3_later_decision" : null;
}

/** P1-P3 for a selected source: the incident's outcome is the recorded decision. */
export async function provesDecidedReviewProvenance(db: Db, task: Task, selected: DecidedReviewSource) {
  return await provesExpectedReassignmentStop(db, selected.source) ??
    await provesDecisionProvenance(db, task, selected.source, selected.decision);
}

/**
 * Prove, under the issue lock, that the current review participant may get a
 * fresh turn on the author's resubmission. Returns the failing clause name
 * otherwise and writes nothing.
 */
export async function proveDecidedReviewContinuation(db: Db, input: { task: Task }): Promise<DecidedReviewProof> {
  const { task } = input;
  const state = readState(task);
  if (["done", "cancelled"].includes(task.status)) return { kind: "hold", reason: "P4_task_closed" };
  if (state?.status !== "pending" || state.currentStageType !== "review" ||
      state.currentParticipant?.type !== "agent" || !state.currentParticipant.agentId) return { kind: "hold", reason: "P4_not_pending_review" };
  const selected = await selectDecidedReviewSource(db, task);
  if (selected.kind === "none") return { kind: "hold", reason: `selector_${selected.rule}` };
  const { source, chain, holds, decision } = selected;
  const provenance = await provesDecidedReviewProvenance(db, task, selected);
  if (provenance) return { kind: "hold", reason: provenance };
  const stop = await provesStopSettled(db, source);
  if (stop) return { kind: "hold", reason: stop };

  // P4: the review participant is the stopped reviewer, in one of two shapes.
  if (task.assigneeAgentId !== source.agentId || isSupersededConversationRun(task, source)) return { kind: "hold", reason: "P4_assignee" };
  let shape: "in_review" | "blocked_projection";
  if (task.status === "in_review") shape = "in_review";
  else if (task.status === "blocked") {
    const chainIds = new Set([source.id, ...chain.map(q => q.id)]);
    const receipt = holds.map(hold => evidenceObject(hold.evidence.reviewHoldBlock)).find(block =>
      typeof block?.runId === "string" && chainIds.has(block.runId) && block.statusVersion === task.statusVersion &&
      block.previousStatus === "in_review" && block.stageId === state.currentStageId && block.lastDecisionId === decision.id);
    if (!receipt) {
      return { kind: "hold", reason: holds.some(hold => hold.evidence.reviewHoldBlock) ? "P4b_receipt_stale" : "P4b_no_receipt" };
    }
    if (task.executionRunId || task.checkoutRunId) return { kind: "hold", reason: "P4b_execution_owned" };
    shape = "blocked_projection";
  } else return { kind: "hold", reason: "P4_status" };

  // P5: a separate author resubmission after the decision.
  const resubmission = await latestResubmission(db, task, decision);
  if (!resubmission) return { kind: "hold", reason: "P5_no_resubmission" };

  // P6: no other gate owns this task.
  if (!holds.length) return { kind: "hold", reason: "P6_no_hold" };
  const readiness = (await issueService(db).listDependencyReadiness(task.companyId, [task.id], db)).get(task.id);
  if (readiness && !readiness.isDependencyReady) return { kind: "hold", reason: "P6_dependency" };
  const [interaction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, task.companyId), eq(issueThreadInteractions.issueId, task.id),
    eq(issueThreadInteractions.status, "pending"),
  )).limit(1);
  const [approval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, task.companyId),
  )).where(and(eq(issueApprovals.companyId, task.companyId), eq(issueApprovals.issueId, task.id),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (interaction || approval) return { kind: "hold", reason: "P6_decision_pending" };
  if ((await readChatControlRecoveryStop(db, {
    companyId: task.companyId, issueId: task.id, agentId: source.agentId, sourceRunId: source.id,
  })).kind !== "clear") return { kind: "hold", reason: "P6_chat_control_stop" };
  if (await getConversationOwnershipBlocker(db, task.companyId, task.id)) return { kind: "hold", reason: "P6_conversation_owner" };
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId),
    or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
  )).limit(1);
  if (active) return { kind: "hold", reason: "P6_execution_active" };
  const settledIds = new Set(holds.map(hold => hold.id));
  const blockers = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    executionBlockerPredicate(),
  ));
  if (blockers.some(blocker => !settledIds.has(blocker.id))) return { kind: "hold", reason: "P6_foreign_hold" };

  // P7: this incident has not been admitted or handed to another owner.
  if (holds.some(hold => ["decidedReviewContinuation", "executionReconciliation", "explicitUserContinuation",
    "workspaceRestoreFailure"].some(key => key in hold.evidence))) return { kind: "hold", reason: "P7_already_owned" };

  return {
    kind: "proved", task, source, chain, holds, decisionId: decision.id,
    resubmissionActivityId: resubmission.id, shape,
  };
}

/**
 * Settle the proved holds for one successor, in the transaction that inserts
 * that successor. Returns parked wakes of these holds for the caller to fold
 * into the successor once its run row exists.
 */
export async function admitDecidedReviewContinuation(
  db: Db, proof: Extract<DecidedReviewProof, { kind: "proved" }>, input: { successorRunId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const record: DecidedReviewConsumption = {
    sourceRunId: proof.source.id,
    decisionId: proof.decisionId,
    resubmissionActivityId: proof.resubmissionActivityId,
    chainRunIds: proof.chain.map(run => run.id),
    successorRunId: input.successorRunId,
    shape: proof.shape,
    recordedAt: now.toISOString(),
  };
  for (const hold of proof.holds) {
    const runId = hold.evidence.runId;
    await db.update(issueRecoveryActions).set({
      status: "resolved", outcome: "cancelled", resolvedAt: now, updatedAt: now,
      nextAction: "The reviewer recorded its decision before the expected reassignment stop. A fresh review of the resubmission was started.",
      resolutionNote: "The stopped reviewer's outcome is its recorded decision. No prior action was replayed.",
      wakePolicy: null, monitorPolicy: null,
      evidence: {
        ...hold.evidence,
        automaticRecovery: {
          policy: "preserve_without_replay_v1",
          runId,
          ...evidenceObject(hold.evidence.automaticRecovery),
          replay: DECIDED_REVIEW_CONTINUATION_REPLAY,
          actionOutcome: runId === proof.source.id ? "decision_recorded" : "not_performed",
        },
        decidedReviewContinuation: record,
      },
    }).where(and(eq(issueRecoveryActions.companyId, proof.task.companyId), eq(issueRecoveryActions.id, hold.id)));
  }
  const holdIds = proof.holds.map(hold => hold.id);
  const parked = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, proof.task.companyId), eq(agentWakeupRequests.agentId, proof.source.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${proof.task.id}`,
    inArray(sql`${agentWakeupRequests.payload}->'executionWait'->>'recoveryActionId'`, holdIds),
  ));
  await persistActivity(db, {
    companyId: proof.task.companyId, actorType: "system", actorId: "execution-recovery",
    action: "issue.execution_recovery_settled", entityType: "issue", entityId: proof.task.id,
    agentId: proof.source.agentId, runId: proof.source.id,
    details: { continuation: "decided_review_reassignment", recoveryActionIds: holdIds, ...record },
  });
  return {
    record,
    foldedWakeIds: parked.map(wake => wake.id),
  };
}

export type DecidedReviewWake = {
  agentId: string;
  reason: string | null;
  source: string;
  requestedByActorType: string | null | undefined;
  payload: Record<string, unknown> | null;
  /** True when the wake carries a comment, saved input, interaction or chat
   * context, or a failed-run retry. Those are new information, never W2. */
  carriesInput: boolean;
};

export type DecidedReviewAdmissionOutcome =
  | { kind: "continue" }
  | { kind: "skip"; reason: string; detail: Record<string, unknown> }
  | { kind: "coalesce"; runId: string }
  | { kind: "admit"; identity: SubmissionIdentity };

export type DecidedReviewAdmissionReads = {
  identity(): Promise<SubmissionIdentity | null>;
  consumption(identity: SubmissionIdentity): Promise<DecidedReviewConsumption | null>;
  /** True when the recorded successor still owns the issue execution. */
  successorActive(runId: string): Promise<boolean>;
  select(identity: SubmissionIdentity): Promise<{ kind: "selected" } | { kind: "none"; rule: string; runId?: string }>;
  hasBlocker(): Promise<boolean>;
  prove(): Promise<{ kind: "proved" } | { kind: "hold"; reason: string }>;
};

function carriedIdentity(payload: Record<string, unknown> | null) {
  const carried = evidenceObject(payload?.decidedReviewContinuation);
  return carried && typeof carried.decisionId === "string" && typeof carried.resubmissionActivityId === "string"
    ? { sourceRunId: carried.sourceRunId, decisionId: carried.decisionId, resubmissionActivityId: carried.resubmissionActivityId }
    : null;
}

/** W1: the periodic pass's continuation wake. W2: the same-submission review
 * request (the author's own wake or its delayed copy). W3: everything else. */
export function classifyDecidedReviewWake(wake: DecidedReviewWake, currentParticipantAgentId: string | null) {
  if (wake.source === "automation" && wake.requestedByActorType === "system" &&
      wake.reason === REVIEW_REQUEST_REASON && carriedIdentity(wake.payload)) return "W1" as const;
  if (wake.reason === REVIEW_REQUEST_REASON && wake.agentId === currentParticipantAgentId &&
      wake.requestedByActorType !== "user" && !wake.carriesInput && !carriedIdentity(wake.payload)) return "W2" as const;
  return "W3" as const;
}

/**
 * Admission order for one wake. Consumption is checked before source
 * selection, so a served submission stays served whatever later happened to
 * its successor or to the selector's answer.
 */
export async function decideDecidedReviewAdmission(
  wakeClass: "W1" | "W2" | "W3", wake: Pick<DecidedReviewWake, "payload">, reads: DecidedReviewAdmissionReads,
): Promise<DecidedReviewAdmissionOutcome> {
  if (wakeClass === "W3") return { kind: "continue" };
  const recovery = wakeClass === "W1";
  const identity = await reads.identity();
  if (!identity) {
    return recovery ? { kind: "skip", reason: "decided_review_continuation_stale", detail: { detail: "identity_unavailable" } } : { kind: "continue" };
  }
  const carried = carriedIdentity(wake.payload);
  if (recovery && (carried?.decisionId !== identity.decisionId || carried.resubmissionActivityId !== identity.resubmissionActivityId)) {
    return { kind: "skip", reason: "decided_review_continuation_stale", detail: { detail: "identity_changed", ...identity } };
  }
  const consumed = await reads.consumption(identity);
  if (consumed) {
    return await reads.successorActive(consumed.successorRunId)
      ? { kind: "coalesce", runId: consumed.successorRunId }
      : { kind: "skip", reason: "decided_review_continuation_consumed", detail: { successorRunId: consumed.successorRunId, ...identity } };
  }
  const selected = await reads.select(identity);
  if (selected.kind === "none") {
    return recovery
      ? { kind: "skip", reason: "decided_review_continuation_not_eligible", detail: { rule: selected.rule, runId: selected.runId ?? null, ...identity } }
      : { kind: "continue" };
  }
  if (!(await reads.hasBlocker())) {
    return recovery ? { kind: "skip", reason: "decided_review_continuation_not_held", detail: { ...identity } } : { kind: "continue" };
  }
  const proof = await reads.prove();
  if (proof.kind === "hold") {
    return recovery ? { kind: "skip", reason: "decided_review_continuation_unproven", detail: { predicate: proof.reason, ...identity } } : { kind: "continue" };
  }
  return { kind: "admit", identity };
}

/** Wire the admission order to the database. The caller holds the issue lock. */
export async function decidedReviewAdmission(db: Db, input: {
  companyId: string; issueId: string; wake: DecidedReviewWake;
}): Promise<DecidedReviewAdmissionOutcome> {
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!task) return { kind: "continue" };
  const state = readState(task);
  const participant = state?.currentParticipant?.type === "agent" ? state.currentParticipant.agentId ?? null : null;
  const wakeClass = classifyDecidedReviewWake(input.wake, participant);
  return decideDecidedReviewAdmission(wakeClass, input.wake, {
    identity: () => currentSubmissionIdentity(db, task, input.wake.agentId),
    consumption: identity => findConsumption(db, task, identity),
    successorActive: async runId => {
      const run = await readRun(db, task.companyId, runId);
      return Boolean(run && ["queued", "running"].includes(run.status) && task.executionRunId === run.id);
    },
    select: identity => selectDecidedReviewSource(db, task, identity),
    hasBlocker: async () => (await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
      executionBlockerPredicate(),
    )).limit(1)).length > 0,
    prove: () => proveDecidedReviewContinuation(db, { task }),
  });
}

/**
 * Release-drain guard for a parked review request (W2). On an issue whose
 * review was continued here, a request made before the current submission
 * belongs to an earlier one. When the current submission's own request is
 * already recorded, promoting the older copy would start a second review turn.
 */
export async function isSupersededReviewRequest(db: Db, input: { companyId: string; issueId: string; wakeId: string }) {
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.wakeId),
  )).limit(1);
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!wake || !task) return false;
  const payload = evidenceObject(wake.payload);
  const state = readState(task);
  const participant = state?.currentParticipant?.type === "agent" ? state.currentParticipant.agentId ?? null : null;
  // A parked row keeps its original reason in the deferred wake context.
  const deferredContext = evidenceObject(payload?._paperclipWakeContext);
  const reason = typeof deferredContext?.wakeReason === "string" ? deferredContext.wakeReason : wake.reason;
  // Same notion of new input as the admission gate: any of it makes this W3.
  const carriesInput = wake.idempotencyKey?.startsWith("chat-inbound:") ||
    ["commentId", "wakeCommentId", "failedRunId", "taskRetryRequestId", "nativeStatusWakeIntentId",
      "interactionId", "interactionKind", "interactionStatus", "continuationPolicy"]
      .some(key => Boolean(payload?.[key] || deferredContext?.[key])) ||
    [payload?.queuedCommentIds, deferredContext?.queuedCommentIds].some(ids => Array.isArray(ids) && ids.length > 0);
  if (classifyDecidedReviewWake({ agentId: wake.agentId, reason, source: wake.source,
    requestedByActorType: wake.requestedByActorType, payload, carriesInput }, participant) !== "W2") return false;
  const [continued] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
  )).limit(1);
  if (!continued) return false;
  const identity = await currentSubmissionIdentity(db, task, wake.agentId);
  if (!identity) return false;
  const [resubmission] = await db.select({ createdAt: activityLog.createdAt }).from(activityLog).where(and(
    eq(activityLog.companyId, task.companyId), eq(activityLog.id, identity.resubmissionActivityId),
  )).limit(1);
  if (!resubmission || wake.requestedAt >= resubmission.createdAt) return false;
  const [own] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, task.companyId), eq(agentWakeupRequests.agentId, wake.agentId),
    ne(agentWakeupRequests.id, wake.id),
    sql`coalesce(${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'wakeReason', ${agentWakeupRequests.reason}) = ${REVIEW_REQUEST_REASON}`,
    sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
    gte(agentWakeupRequests.requestedAt, resubmission.createdAt),
    notInArray(agentWakeupRequests.status, ["skipped", "cancelled", "failed"]),
  )).limit(1);
  return Boolean(own);
}

/** The pass's wake. Exported so tests can send the exact production shape. */
export function buildDecidedReviewContinuationWakeup(input: {
  issueId: string; sourceRunId: string; decisionId: string; resubmissionActivityId: string;
}) {
  return {
    source: "automation" as const,
    triggerDetail: "system" as const,
    reason: REVIEW_REQUEST_REASON,
    payload: {
      issueId: input.issueId,
      decidedReviewContinuation: {
        sourceRunId: input.sourceRunId, decisionId: input.decisionId, resubmissionActivityId: input.resubmissionActivityId,
      },
    },
    requestedByActorType: "system" as const,
    requestedByActorId: "execution-recovery",
    idempotencyKey: `decided-review-continuation:${input.sourceRunId}:${input.decisionId}`,
    contextSnapshot: {
      issueId: input.issueId, taskId: input.issueId, wakeReason: REVIEW_REQUEST_REASON,
      source: "execution.decided_review_continuation",
    },
  };
}

class RestoreNotProved extends Error {}

type Wakeup = (agentId: string, options: ReturnType<typeof buildDecidedReviewContinuationWakeup>) => Promise<unknown>;

/**
 * Periodic pass. Restores an unchanged system projection to in_review, then
 * sends one continuation wake per proved submission. Admission itself happens
 * in the wake gate, which proves everything again under the issue lock.
 */
function decidedReviewCandidate() {
  return and(
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      and(eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`)),
    sql`not (${issueRecoveryActions.evidence} ? 'decidedReviewContinuation')`,
    inArray(issues.status, ["in_review", "blocked"]),
    // Only a pending review an agent already decided can ever prove, so other
    // legacy holds never keep the pass scheduled.
    sql`${issues.executionState}->>'status' = 'pending'`,
    sql`${issues.executionState}->>'currentStageType' = 'review'`,
    sql`${issues.executionState}->'currentParticipant'->>'type' = 'agent'`,
    sql`${issues.executionState}->>'lastDecisionId' is not null`,
  );
}

const SCAN_PAGE = 25;
export type DecidedReviewScan = { after: { companyId: string; issueId: string } | null };
const defaultScan: DecidedReviewScan = { after: null };

/** Whether a later pass may still have a hold to prove. */
export async function decidedReviewContinuationPending(db: Db) {
  const [row] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).innerJoin(issues, and(
    eq(issues.companyId, issueRecoveryActions.companyId), eq(issues.id, issueRecoveryActions.sourceIssueId),
  )).where(decidedReviewCandidate()).limit(1);
  return Boolean(row);
}

export async function continueDecidedReviewReassignments(db: Db, wakeup: Wakeup, scan: DecidedReviewScan = defaultScan) {
  // Pages rotate through every candidate in key order, so holds that never
  // prove cannot keep any other issue out of the pass.
  const after = scan.after;
  const candidates = await db.selectDistinct({
    companyId: issueRecoveryActions.companyId, issueId: issueRecoveryActions.sourceIssueId,
  })
    .from(issueRecoveryActions).innerJoin(issues, and(
      eq(issues.companyId, issueRecoveryActions.companyId), eq(issues.id, issueRecoveryActions.sourceIssueId),
    )).where(and(
      decidedReviewCandidate(),
      after ? sql`(${issueRecoveryActions.companyId}, ${issueRecoveryActions.sourceIssueId}) > (${after.companyId}, ${after.issueId})` : undefined,
    )).orderBy(asc(issueRecoveryActions.companyId), asc(issueRecoveryActions.sourceIssueId)).limit(SCAN_PAGE);
  const last = candidates[candidates.length - 1];
  scan.after = candidates.length === SCAN_PAGE && last ? { companyId: last.companyId, issueId: last.issueId } : null;
  let woken = 0;
  for (const candidate of candidates) {
    const proved = await db.transaction(async tx => {
      const [task] = await tx.select().from(issues).where(and(
        eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.issueId),
      )).for("update");
      if (!task) return null;
      let proof = await proveDecidedReviewContinuation(tx as unknown as Db, { task });
      if (proof.kind !== "proved") return null;
      if (proof.shape === "blocked_projection") {
        // Restore only the unchanged projection this incident's sweep made.
        // The issue service still enforces assignee and dependency readiness.
        await issueService(tx as unknown as Db).update(task.id, { status: "in_review" }, tx);
        await persistActivity(tx as unknown as Db, {
          companyId: task.companyId, actorType: "system", actorId: "execution-recovery",
          action: "issue.updated", entityType: "issue", entityId: task.id,
          agentId: proof.source.agentId, runId: proof.source.id,
          details: { status: "in_review", _previous: { status: task.status }, source: "decided_review_continuation",
            decisionId: proof.decisionId, resubmissionActivityId: proof.resubmissionActivityId },
        });
        const [restored] = await tx.select().from(issues).where(and(
          eq(issues.companyId, task.companyId), eq(issues.id, task.id),
        ));
        proof = await proveDecidedReviewContinuation(tx as unknown as Db, { task: restored! });
        // Never keep a restore the proof no longer justifies.
        if (proof.kind !== "proved" || proof.shape !== "in_review") throw new RestoreNotProved();
      }
      return proof;
    }).catch(error => {
      if (error instanceof RestoreNotProved) return null;
      throw error;
    });
    if (!proved) continue;
    await wakeup(proved.source.agentId, buildDecidedReviewContinuationWakeup({
      issueId: proved.task.id, sourceRunId: proved.source.id,
      decisionId: proved.decisionId, resubmissionActivityId: proved.resubmissionActivityId,
    }));
    woken += 1;
  }
  return { scanned: candidates.length, woken };
}

/**
 * Terminalizer guard. A hold adds no safety for this incident when it was
 * already admitted, when it would only hide the decided reviewer behind one of
 * its own unused attempts, or when the reviewer is proved and merely awaiting
 * admission. Every other run keeps today's conservative hold.
 */
export async function decidedReviewHoldIsRedundant(db: Db, task: Task, run: Pick<Run, "id" | "agentId">) {
  const [admitted] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    or(
      sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->>'sourceRunId' = ${run.id}`,
      sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->'chainRunIds' @> ${JSON.stringify([run.id])}::jsonb`,
    ),
  )).limit(1);
  if (admitted) return true;
  const state = readState(task);
  if (!["in_review", "blocked"].includes(task.status) || state?.status !== "pending" ||
      state.currentStageType !== "review" || state.currentParticipant?.type !== "agent" ||
      state.currentParticipant.agentId !== run.agentId || !state.lastDecisionId) return false;
  const selected = await selectDecidedReviewSource(db, task);
  if (selected.kind === "none") return false;
  if (selected.chain.some(attempt => attempt.id === run.id)) {
    return selected.holds.some(hold => hold.evidence.runId === selected.source.id) &&
      !(await provesDecidedReviewProvenance(db, task, selected));
  }
  return selected.source.id === run.id && (await proveDecidedReviewContinuation(db, { task })).kind === "proved";
}
