import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests, agents, approvals, companies, documentRevisions, documents, executionWorkspaces, heartbeatRuns, issueApprovals,
  issueComments, issueRecoveryActions, issueThreadInteractions, issues, nativeRunFinalizations, toolInvocations, type Db,
} from "@paperclipai/db";
import {
  EXECUTION_RECONCILIATION_CAUSES, readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type ExecutionReconciliation,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { taskHistoryReadsForRun } from "./queued-comment-delivery.js";
import { undeliveredLegacyUserCommentIds } from "./explicit-native-continuation.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { FRESH_CONTINUATION_SUPERSEDED_KEY } from "../agent-run-cancellation.js";
import { isAcknowledgedNativeReassignmentStop, isAcknowledgedNativeStop } from "./acknowledged-native-stop.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { isInterruptedNativePreparationCandidate } from "./cancelled-native-startup.js";
import { notifyDeferredWakesForIssue } from "./deferred-execution-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { issueService } from "./issues.js";
import { holdOwnsBlockedStatus } from "./recovery-hold-blocked-status.js";
import { proveRunProcessGone } from "./run-process-owner.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";
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
/** Consecutive pending checks (about 12 minutes) before the fallback stops waiting. */
/** Worst case from the first pending check to the fresh continuation. */
export const FRESH_CONTINUATION_PENDING_BOUND_MS = 10 * 60_000;
/** Longer cap while the exact-recovery owner shows progress (a new event or a renewed lease). */
export const FRESH_CONTINUATION_PROGRESS_BOUND_MS = 15 * 60_000;
/** Saved-work recovery that is running and advancing keeps its own budget. */
export const FRESH_CONTINUATION_SAVED_WORK_BOUND_MS = 30 * 60_000;
const EXACT_RECOVERY_RECHECK_MS = 60_000;

/**
 * Run failure codes that only a person can resolve (the test for each: did a
 * person fail to do something, or did the system fail to carry it forward? Only
 * the first belongs here; e.g. a lost carry-over of a Retry's authorization,
 * `continuation_user_authorization_missing`, is the system's): they stopped the work, a
 * credential or access they must share, a configuration choice they must make,
 * a budget stop, or a provider usage limit that is waiting as designed. Every
 * other code, including codes that do not exist yet, gets the fallback.
 */
export const PERSON_OWNED_FAILURE_CODES = [
  // A person stopped or paused the work.
  "cancelled", "operator_cancelled", "operator_interrupted", "issue_cancelled", "issue_paused", "agent_paused",
  // A credential, secret or access the person must share.
  "configuration_incomplete", "slack_configuration_incomplete", "signing_secret_unconfigured",
  "user_secret_missing", "user_secret_definition_missing", "user_secret_definition_inactive",
  "github_access_denied", "github_repo_not_accessible", "github_auth_required", "project_access_denied",
  "permission_denied", "responsible_user_unauthorized", "oauth_access_projection_disabled",
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

/**
 * How the continuation is kept apart from the old executor:
 * - `remote_epoch`: the old run's remote workspace epoch is fenced (abandoned, or
 *   already taken from it), so it can never publish; the next preparation
 *   restores the last committed save into a new root.
 * - `writer_ended`: the old local writer is proven gone (no process, no
 *   unsettled allocation), so the task workspace is safe to reuse.
 * - `fresh_isolated_workspace`: the old local writer is not proven gone, so the
 *   continuation gets a new isolated workspace and never writes the old
 *   directory. Nothing waits for that proof.
 */
export type FreshContinuationIsolation = "remote_epoch" | "writer_ended" | "fresh_isolated_workspace";

export type FreshContinuationTrigger = "recovery_refused" | "held_recovery" | "continuation_wake";

export type FreshContinuationResult =
  | { kind: "continued"; recoveryActionId: string; delivery: "recorded" | "caller_owns" | "saved_input"; isolation: FreshContinuationIsolation }
  | { kind: "already_continued"; recoveryActionId: string }
  | { kind: "successor_exists" }
  | { kind: "dependency_wait" }
  | { kind: "person_owned"; reason: string }
  | { kind: "backoff"; retryAt: Date }
  | { kind: "exact_recovery_pending"; reason: string; retryAt: Date; progressAt?: number; savedWorkSignature?: string }
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

export type FreshContinuationCreatedObjects = { subtasks: string[]; comments: string[]; documents: string[]; readFollowUps?: string[];
  editedFollowUps?: string[] };

async function taskHistoryReadsOfRun(tx: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">) {
  const reads = await taskHistoryReadsForRun(tx, { companyId: run.companyId, runId: run.id });
  return new Map(reads.map(read => [read.commentId, read]));
}

const quoted = (value: string, max = 80) => `"${value.replace(/\s+/g, " ").trim().slice(0, max)}${value.length > max ? "..." : ""}"`;

async function createdObjects(tx: Db, run: typeof heartbeatRuns.$inferSelect): Promise<FreshContinuationCreatedObjects> {
  const [children, comments, revisions] = await Promise.all([
    tx.select({ identifier: issues.identifier, title: issues.title }).from(issues).where(and(
      eq(issues.companyId, run.companyId), eq(issues.originRunId, run.id), isNull(issues.hiddenAt)))
      .orderBy(asc(issues.createdAt)).limit(20),
    tx.select({ body: issueComments.body }).from(issueComments).where(and(
      eq(issueComments.companyId, run.companyId), eq(issueComments.createdByRunId, run.id), isNull(issueComments.deletedAt)))
      .orderBy(asc(issueComments.createdAt)).limit(10),
    tx.selectDistinct({ title: documents.title }).from(documentRevisions)
      .innerJoin(documents, eq(documents.id, documentRevisions.documentId))
      .where(and(eq(documentRevisions.companyId, run.companyId), eq(documentRevisions.createdByRunId, run.id))).limit(10),
  ]);
  const reads = await taskHistoryReadsOfRun(tx, run);
  const readComments = reads.size ? await tx.select({ id: issueComments.id, body: issueComments.body, updatedAt: issueComments.updatedAt })
    .from(issueComments).where(and(
      eq(issueComments.companyId, run.companyId), inArray(issueComments.id, [...reads.keys()]),
      eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt))).limit(10) : [];
  const unchanged = (comment: (typeof readComments)[number]) => comment.updatedAt.getTime() <= reads.get(comment.id)!.revision.getTime();
  const edited = readComments.filter(comment => !unchanged(comment));
  return {
    readFollowUps: readComments.filter(unchanged)
      .map(comment => `${quoted(comment.body)} (read at ${reads.get(comment.id)!.readAt.toISOString().slice(11, 16)} UTC)`),
    ...(edited.length ? { editedFollowUps: edited.map(comment => quoted(comment.body)) } : {}),
    subtasks: children.map(child => `${child.identifier ?? "subtask"} ${quoted(child.title)}`),
    comments: comments.map(comment => quoted(comment.body)),
    documents: revisions.map(revision => quoted(revision.title ?? "untitled document")),
  };
}

/** The opening context of the continuation. It names no person who must act. */
export function freshContinuationNote(input: { runId: string; unverified: string[]; workspace: "restored_last_save" | "kept";
  created?: FreshContinuationCreatedObjects }) {
  const actions = input.unverified.length
    ? `These actions of that run have unverified outcomes: ${input.unverified.join(", ")}. For each one, first check whether it took effect.`
    : "No action of that run is recorded with an unknown outcome; check the task's recent history before repeating any side effect.";
  const files = input.workspace === "restored_last_save"
    ? "Its unsaved file changes could not be verified, so this run starts from the last saved version of the workspace; those changes were not applied."
    : "This run starts from the task's saved workspace.";
  // How to proceed. Nobody has to restore the previous attempt: the agent
  // checks, redoes what is missing, and asks only through the normal approval.
  const guidance = "Completed actions with recorded results are still not repeated; this applies only to the actions above, whose outcome is unknown. "
    + "If an action did not take effect, or repeating it is safe, do it again and continue the task. "
    + "If repeating it would be a governed or irreversible action, request it through the normal approval step. "
    + "Nothing about the previous attempt needs to be restored before you continue.";
  const created = input.created;
  const read = created?.readFollowUps?.length
    ? ` That run had already read these messages from a person: ${created.readFollowUps.join(", ")}. Answer each once; what it did after reading is below.`
    : "";
  const edited = created?.editedFollowUps?.length
    ? ` A person edited these messages after that run read them, so it never saw their current text; treat them as new: ${created.editedFollowUps.join(", ")}.`
    : "";
  const existing = created &&(created.subtasks.length || created.comments.length || created.documents.length)
    ? ` That run already did these, and they exist now: ${[
      created.subtasks.length ? `created subtasks ${created.subtasks.join(", ")}` : null,
      created.comments.length ? `posted comments ${created.comments.join(", ")}` : null,
      created.documents.length ? `saved documents ${created.documents.join(", ")}` : null,
    ].filter(Boolean).join("; ")}. Do not create or post them again; read them and continue from where they leave off.`
    : "";
  return `The previous attempt (run ${input.runId}) was cut off before it finished. ${files}${read}${edited}${existing} ${actions} ${guidance}`;
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

/**
 * The one distinction this module turns on: a real human gate versus system
 * uncertainty.
 *
 * A human gate is a decision a person actually made or still owes: a pending
 * approval or question (`personOwnedTaskWait`), a hold a user owns, or an
 * operator decision recorded on the hold (an owner-gone attestation, an
 * explicit continuation, a reconciliation). The fallback never retires or
 * bypasses one.
 *
 * Everything else is system uncertainty, however it is labelled: a
 * no-replay record (`automaticRecovery.replay: blocked`, "outcome unknown after
 * an interruption"), a hold whose owner type is `board` because nobody else was
 * assigned, or a controller whose process space cannot be verified. Owner type
 * alone never proves that a person must act. For these the fallback starts a
 * fresh run, never a replay: the interrupted turn is not re-sent, no tool call
 * or write is re-executed, and any governed action goes through its approval
 * gate again.
 */
export function isHumanGate(hold: Pick<typeof issueRecoveryActions.$inferSelect, "ownerUserId" | "evidence">): boolean {
  return Boolean(hold.ownerUserId || hold.evidence.ownerGoneAttestation || hold.evidence.explicitUserContinuation
    || hold.evidence.executionReconciliation);
}

const isRestoreHold = (hold: typeof issueRecoveryActions.$inferSelect) =>
  hold.evidence.workspaceRestoreFailure !== undefined || hold.evidence.workspaceRestoreRecovery !== undefined;
const blocksExecution = (hold: typeof issueRecoveryActions.$inferSelect) =>
  ["active", "escalated"].includes(hold.status) || object(hold.evidence.automaticRecovery).replay === "blocked";

/** A reconciliation hold that blocks the task and that this decision settles. */
function isOwnedReconciliationHold(hold: typeof issueRecoveryActions.$inferSelect) {
  if (!(EXECUTION_RECONCILIATION_CAUSES as readonly string[]).includes(hold.cause) || !blocksExecution(hold)) return false;
  if (isHumanGate(hold)) return false;
  // A restore hold is owned only once its saved-work recovery completed.
  return !isRestoreHold(hold) || readSystemRecovery(hold.evidence)?.state === "complete";
}

/**
 * The old local writer's state. `alive`: its process is running on this host,
 * so it is still executing and is settled by its own owner (stop, reaper)
 * first. `ended`: no process this host can see and no allocation or workspace
 * finalization left unsettled. `unproven`: anything else (another host, an
 * unsettled allocation); the continuation is isolated from it, never waits.
 */
async function localWriterState(tx: Db, run: typeof heartbeatRuns.$inferSelect): Promise<"alive" | "ended" | "unproven"> {
  // The shared owner proof compares the recorded process identity (host, PID
  // space, start time), so a recycled PID is never mistaken for the old writer.
  const proof = await proveRunProcessGone(run, "fresh_continuation");
  if (proof?.verdict === "alive") return "alive";
  if (proof?.verdict === "unprovable" || await hasPendingRunCleanup(tx, run.companyId, run.id)) return "unproven";
  return "ended";
}

/** The workspace selection a delivered continuation carries (read only when its context names it). */
export async function readFreshContinuationReadiness(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "contextSnapshot">, issueId: string) {
  const recordId = object(run.contextSnapshot).freshContinuationIsolation;
  if (typeof recordId !== "string" || !/^[0-9a-f-]{36}$/i.test(recordId)) return null;
  const [record] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    sql`${issueRecoveryActions.id}::text = ${recordId}`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,isolation}' = 'fresh_isolated_workspace'`)).limit(1);
  const sourceRunId = object(record?.evidence.freshContinuation).sourceRunId;
  if (typeof sourceRunId !== "string") return null;
  return { mode: "fresh_isolated_workspace" as const, retryIntentId: recordId, sourceRunId, retainedSourceIds: [] as string[] };
}

/**
 * True when a wake continues a cut-off run in a new isolated workspace. The
 * fallback cleared the task's workspace binding on purpose, and the run
 * prepares a new workspace itself, so admission must not refuse the wake for
 * lacking that binding (it would refuse it forever).
 */
export async function isFreshIsolatedContinuationWake(db: Db, input: { companyId: string; issueId: string;
  contextSnapshot: Record<string, unknown> | null | undefined }) {
  if (typeof object(input.contextSnapshot).freshContinuationIsolation !== "string") return false;
  return (await readFreshContinuationReadiness(db, { id: "", companyId: input.companyId,
    contextSnapshot: input.contextSnapshot ?? {} }, input.issueId)) !== null;
}

/**
 * True when the fallback replaced this run and its continuation reuses none of
 * the run's workspace: a new isolated workspace or an abandoned remote epoch.
 * Holds that only protect the old executor's resources then no longer stand
 * between the task and its next turn.
 */
export async function freshContinuationIsolatesRun(db: Db, input: { companyId: string; runId: string }): Promise<false | {
  /** The isolated continuation is recorded but not yet delivered as a run. */
  continuationPending: boolean;
}> {
  const [record] = await db.select({ isolation: sql<string>`${issueRecoveryActions.evidence}#>>'{freshContinuation,isolation}'`,
    delivery: sql<string | null>`${issueRecoveryActions.evidence}->>'continuationDelivery'` }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId),
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${input.runId}`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,isolation}' in ('fresh_isolated_workspace', 'remote_epoch')`)).limit(1);
  if (!record) return false;
  // Only the recorded continuation carries the isolation marker that prepares
  // the new workspace, so while it is pending it must be the task's next run.
  return { continuationPending: record.isolation === "fresh_isolated_workspace" && record.delivery === "pending" };
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
  if (prior) {
    await settleLateHolds(tx, { companyId, issue, run, prior, holds: holds.filter(isOwnedReconciliationHold), now });
    return { kind: "already_continued", recoveryActionId: prior.id };
  }
  // The holds this decision owns: reconciliation holds that still block the
  // task. Workspace restore/repair holds stay with workspace recovery, and
  // resolved history is never rewritten.
  const ownedHolds = holds.filter(isOwnedReconciliationHold);

  // Every wait is bounded in time: about 10 minutes from the first pending
  // check, or 15 while the exact-recovery owner shows progress (a new run
  // event, output or lease renewal since the last check). Then the fallback
  // stops waiting and continues in isolation (writes revoked, new root).
  const pendingMarker = holds.map(hold => object(hold.evidence[FRESH_CONTINUATION_CHECK_KEY]))
    .filter(check => check.kind === "exact_recovery_pending" && typeof check.firstPendingAt === "number")
    .sort((a, b) => Number(a.firstPendingAt) - Number(b.firstPendingAt))[0];
  // Saved-work recovery shows progress when its generation advances (revision
  // or attempt) or its hold is updated; the run and coordinator when they
  // emit output, renew a lease or update.
  const savedWork = holds.map(hold => readSystemRecovery(hold.evidence)).filter(recovery => recovery !== null);
  const progressAt = Math.max(run.updatedAt?.getTime() ?? 0, run.lastOutputAt?.getTime() ?? 0,
    coordinator?.updatedAt?.getTime() ?? 0, coordinator?.leaseExpiresAt?.getTime() ?? 0,
    ...holds.filter(hold => readSystemRecovery(hold.evidence)).map(hold => hold.updatedAt.getTime()));
  const savedWorkSignature = savedWork.map(recovery => `${recovery!.generationId}:${recovery!.revision}:${recovery!.attempts}:${recovery!.state}`)
    .sort().join("|");
  const waitedMs = pendingMarker ? now.getTime() - Number(pendingMarker.firstPendingAt) : 0;
  const progressing = Boolean(pendingMarker && ((typeof pendingMarker.progressAt === "number" && progressAt > pendingMarker.progressAt)
    || (typeof pendingMarker.savedWorkSignature === "string" && savedWorkSignature !== pendingMarker.savedWorkSignature)));
  // Saved-work recovery that is running and advancing keeps its own 30-minute
  // budget: it may still rescue unsaved files. Anything idle gets the normal bound.
  const savedWorkAdvancing = progressing && savedWork.some(recovery => recovery!.state === "running");
  const waitBounded = savedWorkAdvancing ? waitedMs >= FRESH_CONTINUATION_SAVED_WORK_BOUND_MS
    : waitedMs >= FRESH_CONTINUATION_PROGRESS_BOUND_MS || (waitedMs >= FRESH_CONTINUATION_PENDING_BOUND_MS && !progressing);
  // Rechecks back off 1, 2, 3, 4 minutes, so the bound is reached on time.
  const step = Math.min(4, (typeof pendingMarker?.checks === "number" ? pendingMarker.checks : 0) + 1) * EXACT_RECOVERY_RECHECK_MS;
  const pending = (reason: string, retryAt: Date): FreshContinuationResult | null => waitBounded ? null
    : { kind: "exact_recovery_pending", reason, progressAt, savedWorkSignature,
      retryAt: new Date(Math.min(retryAt.getTime(), now.getTime() + step)) };

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

  // Exact recovery that is still under way keeps its chance, for a bounded
  // number of checks; each owner below also bounds itself.
  const recheck = new Date(now.getTime() + EXACT_RECOVERY_RECHECK_MS);
  const waits: Array<FreshContinuationResult | null> = [];
  if (adapterExecutionControls.has(run.id)) waits.push(pending("execution_settling", recheck));
  if (coordinator?.leaseOwner || (coordinator?.resultId && coordinator.phase !== "committed")
    || (coordinator?.nextAttemptAt && coordinator.nextAttemptAt > now))
    waits.push(pending("native_finalizer_active",
      coordinator?.nextAttemptAt && coordinator.nextAttemptAt > now ? coordinator.nextAttemptAt : recheck));
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now)
    waits.push(pending("controller_lease_live", run.controllerLeaseExpiresAt));
  // A preparation that never started provider work has its own bounded retry
  // lane (the ownership pass). It gets the first chance; the fallback follows.
  if (isInterruptedNativePreparationCandidate(run) && !holds.some(hold => hold.evidence[FRESH_CONTINUATION_CHECK_KEY]))
    waits.push(pending("interrupted_preparation_lane", recheck));
  for (const hold of holds) {
    const recovery = readSystemRecovery(hold.evidence);
    if (recovery && EXACT_RECOVERY_STATES.includes(recovery.state))
      waits.push(pending("saved_work_recovery_running",
        new Date(Math.max(recheck.getTime(), recovery.nextAttemptAt ?? 0))));
    if (!isOwnedReconciliationHold(hold) && isRestoreHold(hold) && blocksExecution(hold) && recovery?.state !== "complete")
      waits.push(pending("workspace_recovery_owns_restore", recheck));
    const retainedCheck = object(hold.evidence.retainedSourceFallbackCheck);
    if (recovery?.state === "exhausted" && typeof retainedCheck.nextCheckAt === "number" && retainedCheck.nextCheckAt > now.getTime())
      waits.push(pending("retained_source_fallback_pending", new Date(retainedCheck.nextCheckAt)));
  }
  const firstWait = waits.find(wait => wait !== null);
  if (firstWait) return firstWait;
  // Past the bound, a hold that workspace recovery still owns is settled too:
  // the continuation never uses that workspace (isolation below).
  const owned = waitBounded ? holds.filter(hold => isOwnedReconciliationHold(hold)
    || (isRestoreHold(hold) && blocksExecution(hold) && !isHumanGate(hold))) : ownedHolds;

  // (b) Causes that are the person's.
  if (isPersonOwnedFailureCode(run.errorCode)) return { kind: "person_owned", reason: run.errorCode! };
  // A Stop a person (or an agent acting on the task) asked for is never undone.
  const cancellation = readRunCancellation(run.resultJson);
  if ((cancellation && ["user", "agent"].includes(cancellation.initiator.type))
    || object(run.resultJson).operatorInterrupted === true
    || (run.status === "cancelled" && (isAcknowledgedNativeStop(run) || isAcknowledgedNativeReassignmentStop(run)
    // A cancellation that recorded neither its cause nor a system initiator may
    // be a person's Stop saved by an older release; it is never undone.
    || (!cancellation && !run.errorCode))))
    return { kind: "person_owned", reason: "stopped_on_request" };
  // A task in review waits for its reviewer.
  if (issue.status === "in_review") return { kind: "person_owned", reason: "in_review" };
  // A recorded operator reconciliation that already delivered a continuation
  // was handled above (successor_exists); any other human gate stays.
  if (holds.some(hold => blocksExecution(hold) && isHumanGate(hold) && !hold.evidence.executionReconciliation)
    || holds.some(hold => hold.ownerUserId || hold.evidence.ownerGoneAttestation || hold.evidence.explicitUserContinuation))
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
  const savedWakes = await tx.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    eq(agentWakeupRequests.requestedByActorType, "user"), sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`)).limit(5);
  // Saved input continues the task only while it still holds something the
  // agent has not received: a message the cut-off run already took into its
  // turn is settled as delivered when promoted, and then nothing would run.
  let savedInput: { id: string } | undefined;
  for (const wake of savedWakes) {
    const commentIds = queuedCommentIdsFromWakePayload(wake.payload);
    if (!commentIds.length || (await undeliveredLegacyUserCommentIds(tx, companyId, issue.id, run.agentId, commentIds)).length) {
      savedInput = wake;
      break;
    }
  }
  let delivery: "recorded" | "caller_owns" | "saved_input" = input.delivery === "caller_owns" ? "caller_owns"
    : savedInput ? "saved_input" : "recorded";

  // (d) Continue: fence the old workspace epoch, settle every hold of the run,
  // release the Blocked status this failure owns, and record one continuation.
  const remoteSource = remoteWorkspaceRunReferenceSchema.safeParse(object(run.runnerProfileJson).remoteWorkspace).success;
  const writer = remoteSource ? null : await localWriterState(tx, run);
  // A local process still running on this host is executing: its own owner
  // (the reaper or a Stop) settles it first, then the fallback continues.
  const aliveWait = writer === "alive" ? pending("previous_process_running", new Date(now.getTime() + step)) : null;
  if (aliveWait) return aliveWait;
  const fenced = await fenceSourceWorkspace(tx, run);
  // Never claim a stop that was not proven: record what isolates the successor.
  const isolation: FreshContinuationIsolation = fenced || remoteSource ? "remote_epoch"
    : writer === "ended" && !waitBounded ? "writer_ended" : "fresh_isolated_workspace";
  // Only a run that carries the isolation in its context prepares the new
  // workspace (create_new). Saved input carries no such marker: on a task with
  // no project it would be refused at admission once the binding is cleared,
  // and otherwise could resolve the old directory. So the recorded
  // continuation runs first, binds the new workspace, and saved input follows.
  if (isolation === "fresh_isolated_workspace" && delivery === "saved_input") delivery = "recorded";
  const unverified = await unverifiedActions(tx, run);
  const created = await createdObjects(tx, run);
  const note = freshContinuationNote({ runId: run.id, unverified, created,
    workspace: isolation === "writer_ended" ? "kept" : "restored_last_save" });
  const decision: ExecutionReconciliation & { providerStopProof: "writer_ended" | "isolated" } = { runId: run.id, providerStopped: true,
    // Only a proven end is a stop. `isolated` means exactly: the old run's agent
    // token is refused for writes, and the continuation runs in a new workspace
    // root (a fenced remote epoch or a new local workspace). Nothing more.
    providerStopProof: isolation === "writer_ended" ? "writer_ended" : "isolated",
    actionOutcome: "mixed", outcomeEvidence: note,
    workspaceRepairEvidence: fenced
      ? `Paperclip abandoned unverified workspace epoch ${fenced.abandonedEpoch} of run ${run.id}; the continuation restores `
        + `${fenced.snapshotId ? `committed snapshot ${fenced.snapshotId}` : "the workspace source"} into a new root.`
      : isolation === "fresh_isolated_workspace"
        ? `The previous writer of run ${run.id} is not proven stopped, so the continuation starts in a new isolated workspace; no unverified files are applied.`
        : `The continuation of run ${run.id} starts from the task's last saved workspace; no unverified files are applied.` };
  const freshContinuation = { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: run.id, trigger: input.trigger,
    failureCode: run.errorCode ?? null, delivery, recordedAt: now.toISOString(), isolation,
    stopProof: isolation === "writer_ended" ? "writer_ended" : fenced ? "unproven_epoch_abandoned" : "unproven_isolated",
    unverifiedActions: unverified, createdObjects: created, ...(fenced ? { workspace: fenced } : {}) };
  const reconciliation = { ...decision, actorId: FRESH_CONTINUATION_ACTOR, recordedAt: now.toISOString() };
  // Who, what, why and when. A fresh run is not a replay: the interrupted turn
  // is not re-sent, no tool call or write is re-executed, and any governed
  // action the new run wants goes through its approval gate again.
  const settlement = { schema: FRESH_CONTINUATION_SCHEMA, actorType: "system", actorId: FRESH_CONTINUATION_ACTOR,
    decision: "continue_in_fresh_run", replay: "none", sourceRunId: run.id, failureCode: run.errorCode ?? null,
    reason: "exact_resumption_unavailable", isolation, unverifiedActions: unverified, recordedAt: now.toISOString() };
  const ownerHold = owned.find(hold => issue.status === "blocked" && holdOwnsBlockedStatus(hold, issue, run)) ?? owned.at(-1);

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
    for (const hold of owned) {
      const primary = hold.id === ownerHold.id;
      // The earlier no-replay decision stays on the hold as history, and the
      // fallback is recorded beside it as its own attributed system decision.
      const { automaticRecovery, [FRESH_CONTINUATION_CHECK_KEY]: _check, ...evidence } = hold.evidence;
      await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: hold.resolvedAt ?? now,
        updatedAt: now, ownerType: "system", ownerAgentId: null, ownerUserId: null, wakePolicy: null, monitorPolicy: null,
        returnOwnerAgentId: primary ? run.agentId : hold.returnOwnerAgentId, nextAction: USER_TEXT,
        resolutionNote: "continued_fresh_from_last_saved",
        evidence: { ...evidence, executionReconciliation: reconciliation, freshContinuationSettlement: settlement,
          ...(automaticRecovery !== undefined ? { automaticRecoveryHistory: automaticRecovery } : {}),
          ...(primary ? { freshContinuation, continuationDelivery }
            : { continuationDelivery: "coalesced", coalescedIntoRecoveryActionId: ownerHold.id }) },
      }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, hold.id)));
    }
  } else {
    const [created] = await tx.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
      returnOwnerAgentId: run.agentId, cause: FRESH_CONTINUATION_CAUSE, fingerprint: `fresh-continuation:${run.id}`,
      nextAction: USER_TEXT, resolutionNote: "continued_fresh_from_last_saved", resolvedAt: now, attemptCount: 1,
      evidence: { runId: run.id, originalFailureCode: run.errorCode ?? null, executionReconciliation: reconciliation,
        freshContinuationSettlement: settlement, freshContinuation, continuationDelivery } }).returning({ id: issueRecoveryActions.id });
    primaryId = created!.id;
  }
  // The replaced run loses its write authority: its agent may still be alive
  // in an unreachable sandbox, and only the continuation may act on the task.
  await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
    || ${JSON.stringify({ [FRESH_CONTINUATION_SUPERSEDED_KEY]: now.toISOString() })}::jsonb` }).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, run.id)));
  // The source is never replayed or replaced exactly after this decision.
  if (coordinator) {
    await tx.update(nativeRunFinalizations).set({ failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb)
      || ${JSON.stringify({ replacementDenied: "fresh_continuation" })}::jsonb` }).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id)));
  }
  // The isolation is a property of the task's next run, whatever path starts
  // it (a system continuation, saved input, a person's Retry, a sweep wake):
  // the task no longer points at the directory the old writer may still use,
  // so every next run prepares a new workspace. The old one is left in place.
  if (isolation === "fresh_isolated_workspace" && issue.executionWorkspaceId) {
    await tx.update(issues).set({ executionWorkspaceId: null, workspaceBindingRevision: sql`${issues.workspaceBindingRevision} + 1`,
      updatedAt: now }).where(and(eq(issues.companyId, companyId), eq(issues.id, issue.id)));
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
  return { kind: "continued", recoveryActionId: primaryId, delivery, isolation };
}

async function settleLateHolds(tx: Db, input: { companyId: string; issue: typeof issues.$inferSelect; run: typeof heartbeatRuns.$inferSelect;
  prior: typeof issueRecoveryActions.$inferSelect; holds: Array<typeof issueRecoveryActions.$inferSelect>; now: Date }) {
  const { companyId, issue, run, prior, holds, now } = input;
  if (!holds.length) return;
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
  await notifyStatusCardIssueChange(tx, companyId);
  await notifyRoutineExecutionStatus(tx, issue.id, companyId);
  const ownsBlock = issue.status === "blocked" && holds.some(hold => holdOwnsBlockedStatus(hold, issue, run));
  const delivery = String(prior.evidence.continuationDelivery);
  const followed = ["delivered", "invalidated"].includes(delivery) ? delivery : "coalesced";
  for (const hold of holds) {
    const { automaticRecovery, [FRESH_CONTINUATION_CHECK_KEY]: _check, ...evidence } = hold.evidence;
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
      ownerType: "system", ownerAgentId: null, ownerUserId: null, wakePolicy: null, monitorPolicy: null, nextAction: USER_TEXT,
      resolutionNote: "continued_fresh_from_last_saved",
      evidence: { ...evidence, ...(automaticRecovery !== undefined ? { automaticRecoveryHistory: automaticRecovery } : {}),
        continuationDelivery: followed, coalescedIntoRecoveryActionId: prior.id,
        ...(typeof prior.evidence.continuationRunId === "string" ? { continuationRunId: prior.evidence.continuationRunId } : {}) },
    }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, hold.id)));
  }
  if (ownsBlock) {
    await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
      blockedOwnerNotifiedAt: null, updatedAt: now }).where(and(eq(issues.companyId, companyId), eq(issues.id, issue.id)));
    await logActivity(tx, { companyId, actorType: "system", actorId: FRESH_CONTINUATION_ACTOR, action: "issue.updated",
      entityType: "issue", entityId: issue.id, agentId: run.agentId, runId: run.id,
      details: { status: "todo", previousStatus: "blocked", reason: "fresh_continuation", recoveryActionId: prior.id,
        _previous: { status: "blocked" } } });
  }
}

/** Records why a hold was not continued yet, and when to look again. */
export async function recordFreshContinuationCheck(db: Db, input: { companyId: string; actionId: string },
  result: FreshContinuationResult, now = new Date()) {
  if (result.kind === "continued" || result.kind === "already_continued") return;
  const nextCheckAt = result.kind === "backoff" || result.kind === "exact_recovery_pending" ? result.retryAt.getTime()
    : result.kind === "person_owned" || result.kind === "dependency_wait" ? now.getTime() + PERSON_RECHECK_MS : null;
  const [row] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)));
  const prior = object(row?.evidence[FRESH_CONTINUATION_CHECK_KEY]);
  const same = prior.kind === result.kind;
  const checks = same && typeof prior.checks === "number" ? prior.checks + 1 : 1;
  const firstPendingAt = result.kind === "exact_recovery_pending"
    ? (same && typeof prior.firstPendingAt === "number" ? prior.firstPendingAt : now.getTime()) : null;
  const marker = { kind: result.kind, reason: "reason" in result ? result.reason : null, checks, checkedAt: now.getTime(), nextCheckAt,
    ...(firstPendingAt !== null ? { firstPendingAt,
      progressAt: result.kind === "exact_recovery_pending" ? result.progressAt ?? null : null,
      savedWorkSignature: result.kind === "exact_recovery_pending" ? result.savedWorkSignature ?? null : null } : {}) };
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
    .where(and(heldExecutionWhere(), freshContinuationCheckDue(now), recentInterruptionSourceSql(now)))
    // Newest interruption first: the most recent work is the work someone is waiting for.
    .orderBy(desc(sql`(select source.finished_at from ${heartbeatRuns} source where source.company_id = ${issueRecoveryActions.companyId}
      and source.id::text = coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId'))`),
      asc(issueRecoveryActions.id))
    .limit(limit);
}

/**
 * The backlog pass continues a held record only when it is a recent
 * interruption: its source run ended within BACKLOG_CONTINUATION_MAX_AGE_MS
 * and ended with a restart, deploy, lease, process-loss or recovery-refusal
 * code. A configuration or provider failure, or anything older, stays exactly
 * as it is for a person's Retry: re-running last week's failures is not
 * "an interruption is invisible". Fresh interruptions reach the fallback
 * through restart recovery and the disposition pass, not through this list.
 */
export const BACKLOG_CONTINUATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const BACKLOG_CONTINUATION_SOURCE_CODES = [
  "native_restart_recovery_blocked", "native_continuation_requires_reconciliation", "native_session_interrupted",
  "native_runner_process_exited", "server_shutdown_interrupted", "process_lost", "controller_lease_lost",
  "execution_finalization_deadline_exceeded", "local_runtime_api_listener_unavailable",
  "runner_remote_process_identity_unavailable", "continuation_user_authorization_missing",
] as const;
/** At most this many backlog continuations per server per rolling minute, and per pass. */
export const BACKLOG_CONTINUATIONS_PER_MINUTE = 10;
const BACKLOG_CONTINUATIONS_PER_PASS = 5;

/** Holds the disposition pass (unresolvedExecutionDispositions) handles itself, whatever their age. */
function liveDispositionHoldSql() {
  return and(inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.kind, "active_run_watchdog"))!;
}

/** The backlog pass's eligibility: the one predicate its listing and its deadline query share. */
function recentInterruptionSourceSql(now: Date) {
  return sql`exists (select 1 from ${heartbeatRuns} source where source.company_id = ${issueRecoveryActions.companyId}
    and source.id::text = coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')
    and source.finished_at > ${new Date(now.getTime() - BACKLOG_CONTINUATION_MAX_AGE_MS).toISOString()}::timestamptz
    and source.error_code in (${sql.join(BACKLOG_CONTINUATION_SOURCE_CODES.map(code => sql`${code}`), sql`, `)}))`;
}

/** Held records the backlog pass leaves for a person (older, or not an interruption). */
async function countHeldExecutionsLeftAlone(db: Db, now: Date): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(issueRecoveryActions)
    .innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId), eq(issues.companyId, issueRecoveryActions.companyId)))
    .where(and(heldExecutionWhere(), sql`not ${recentInterruptionSourceSql(now)}`));
  return Number(row?.count ?? 0);
}

/** Per database client: one per server process in production, one per test database in tests. */
const backlogContinuationTimes = new WeakMap<object, number[]>();
export function resetBacklogContinuationPacingForTests(db?: Db) {
  if (db) backlogContinuationTimes.delete(db);
  lastLeftAloneLogAt = 0;
}
let lastLeftAloneLogAt = 0;
const LEFT_ALONE_LOG_INTERVAL_MS = 10 * 60_000;

/** Held reconciliation records of a task's latest unfinished run (joined to its task). */
function heldExecutionWhere(options: { includeActive?: boolean } = {}) {
  return and(
      inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
      sql`${issueRecoveryActions.evidence}->'executionReconciliation' is null`,
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is null`,
      sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId') is not null`,
      or(
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('complete', 'exhausted')`),
        options.includeActive ? and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          eq(issueRecoveryActions.kind, "active_run_watchdog")) : undefined,
        // Saved-work recovery still under way: checked so its bound is reached
        // (exact recovery keeps its first chance inside the fallback).
        sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('scheduled', 'running', 'awaiting_evidence')`,
      ),
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
  )!;
}

/** The earliest time a deferred check becomes due again, if any. */
export async function nextFreshContinuationCheckAt(db: Db, now = new Date()): Promise<number | null> {
  // The same records the held-run query and the disposition pass would select;
  // a deadline on a record nothing would act on never schedules a scan.
  // That includes active holds that backed off: the disposition pass rechecks
  // them when due, and nothing else would wake it then.
  const [held] = await db.select({ at: sql<string | null>`min((${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}')::bigint)` })
    .from(issueRecoveryActions).innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId),
      eq(issues.companyId, issueRecoveryActions.companyId)))
    .where(and(heldExecutionWhere({ includeActive: true }),
      sql`${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}' is not null`,
      // A record the backlog pass leaves alone schedules nothing; active holds
      // stay with the disposition pass, which rechecks them when due.
      or(liveDispositionHoldSql(), recentInterruptionSourceSql(now))));
  return held?.at ? Number(held.at) : null;
}

/**
 * Continues tasks held by recovery records, including records saved by older
 * releases, so tasks already waiting continue after deploy without a Retry.
 * Runs on the execution-disposition worker. Bounded per pass.
 */
export async function continueHeldExecutions(db: Db, now = new Date(), limit = BACKLOG_CONTINUATIONS_PER_PASS) {
  if (now.getTime() - lastLeftAloneLogAt >= LEFT_ALONE_LOG_INTERVAL_MS) {
    lastLeftAloneLogAt = now.getTime();
    const leftAlone = await countHeldExecutionsLeftAlone(db, now).catch(() => null);
    if (leftAlone) logger.info({ leftAlone, maxAgeHours: BACKLOG_CONTINUATION_MAX_AGE_MS / 3_600_000 },
      "Held tasks left for a person: older than the backlog window or not an interruption");
  }
  // Per-server pacing: a backlog saved by older releases must not start a herd of runs.
  let times = backlogContinuationTimes.get(db);
  if (!times) backlogContinuationTimes.set(db, times = []);
  while (times.length && times[0]! <= now.getTime() - 60_000) times.shift();
  const room = Math.min(limit, BACKLOG_CONTINUATIONS_PER_MINUTE - times.length);
  if (room <= 0) return { checked: 0, continued: 0 };
  const candidates = await heldExecutionsAwaitingFreshContinuation(db, now, room);
  let continued = 0;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.runId || seen.has(candidate.runId)) continue;
    seen.add(candidate.runId);
    times.push(now.getTime());
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

/** Holds settled together with a primary record follow its final delivery
 * state, so no coalesced hold outlives the record it points at. */
export async function settleCoalescedFreshContinuationHolds(db: Db, input: { companyId: string; primaryId: string;
  delivery: "delivered" | "invalidated"; continuationRunId?: string | null }) {
  await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
    continuationDelivery: input.delivery, ...(input.continuationRunId ? { continuationRunId: input.continuationRunId } : {}) })}::jsonb` })
    .where(and(eq(issueRecoveryActions.companyId, input.companyId),
      sql`${issueRecoveryActions.evidence}->>'coalescedIntoRecoveryActionId' = ${input.primaryId}`,
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'coalesced'`));
}

export async function hasPendingFreshContinuation(db: Db, companyId: string, issueId: string) {
  const [row] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`)).limit(1);
  if (!row) return false;
  await notifyDeliveryWork(db, DELIVERY_QUEUES.executionContinuation);
  return true;
}

/** Newest-first list of fresh continuations of one task (diagnostics and tests). */
export async function listFreshContinuations(db: Db, input: { companyId: string; issueId: string }) {
  return db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId),
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`,
    gt(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}'`, "")))
    .orderBy(desc(issueRecoveryActions.updatedAt));
}
