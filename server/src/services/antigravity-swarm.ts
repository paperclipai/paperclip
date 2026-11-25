import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { antigravitySwarmWorkModeAllows, SWARM_REQUEST_MAX_CHARS } from "@paperclipai/shared";
import { activityLog, agentWakeupRequests, agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { PaperclipRunnerProviderProfileError } from "./native-runtime/provider-profile.js";
import { recordedSwarmRequestSql } from "./queued-comment-delivery.js";
import { saveUndeliveredUserComments } from "./work-intent-outbox.js";
import { queuedCommentIdsFromRunContext, queuedCommentIdsFromWakePayload } from "../lib/queued-comment-context.js";

/**
 * Google Antigravity's native `/swarm`, started only by a signed-in user.
 *
 * Source of trust: the task composer applies `parseLeadingUserCommand` (the
 * one rule, packages/shared) to what the user typed and submits a structured
 * `nativeCommand: "swarm"`. The server accepts it only from a signed-in board
 * user, records the request in the activity log (server-written only) and
 * marks the assignee's wake with the comment id. A run is a swarm only when
 * that record exists. Comment text is never read as a command here, so
 * pasted, quoted, agent or API text stays text.
 *
 * A requested swarm that cannot run is refused with a plain message; it is
 * never run as an ordinary request.
 */
export const ANTIGRAVITY_SWARM_COMMAND = "swarm" as const;
export { ANTIGRAVITY_SWARM_REQUESTED_ACTION, ANTIGRAVITY_SWARM_UNAVAILABLE, isAntigravityAgent } from "./antigravity-swarm-refusal.js";
import { ANTIGRAVITY_CLI_QUOTA_SCOPE, ANTIGRAVITY_SWARM_REQUESTED_ACTION, ANTIGRAVITY_SWARM_UNAVAILABLE, isAntigravityAgent } from "./antigravity-swarm-refusal.js";
import { PROVIDER_QUOTA_SCOPE_CONTEXT_KEY } from "./native-runtime/native-startup-retry.js";
/** Automatic wakes (recovery, sweeps) attempt one swarm request at most this often; the user can always ask again. */
export const ANTIGRAVITY_SWARM_AUTOMATIC_ATTEMPTS = 3;

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};


export function antigravitySwarmRefusal(input: {
  enabled: boolean;
  agent: { adapterType: string; adapterConfig: unknown } | null;
  remote?: boolean;
  planning?: boolean;
  /** The task's work mode. Helpers change files, so only a standard task runs a swarm (an allow-list). */
  workMode?: string | null;
}): string | null {
  if (!input.enabled) {
    return "Swarm is not turned on for this Paperclip. An instance admin can turn on \"Google Antigravity swarm\" in Settings, Experimental.";
  }
  if (!isAntigravityAgent(input.agent)) return "Swarm works only for tasks assigned to a Google Antigravity agent.";
  if (input.planning || input.workMode === "planning") return "Swarm is not available while the task is in Plan mode: helpers change files. Approve the plan first, then send /swarm.";
  if (input.workMode !== undefined && !antigravitySwarmWorkModeAllows(input.workMode)) {
    return "Swarm works only in a standard task: helpers change files, and this task's mode does not allow changes. Switch the task to Standard, then send /swarm.";
  }
  if (input.remote) return "Swarm is not available for this agent: it runs only on this computer, not in a cloud or remote environment.";
  return null;
}

/** The comment id a wake carries when the user asked for a swarm. Verified against the activity log before use. */
export function requestedAntigravitySwarmCommentId(context: unknown): string | null {
  const value = record(context).antigravitySwarmCommentId;
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

/**
 * The swarm's instruction from a recorded request comment: its text, verbatim.
 * With `nativeCommand: "swarm"` the comment body IS the request; the composer
 * removes the one leading `/swarm` the user typed, and nothing strips another
 * (`/swarm /swarm explain this` asks the swarm about `/swarm explain this`).
 */
export function antigravitySwarmRequestFromComment(body: string): string {
  return body.trim();
}

/** A request the swarm cannot run: nothing to do, or longer than the swarm accepts. */
export function antigravitySwarmRequestRefusal(request: string): string | null {
  if (!request) return "This swarm has no request to run. Send /swarm followed by what the swarm should do.";
  if (request.length > SWARM_REQUEST_MAX_CHARS) {
    return `This swarm request is too long. Keep what follows /swarm under ${SWARM_REQUEST_MAX_CHARS.toLocaleString("en-US")} characters.`;
  }
  return null;
}

async function swarmEnabled(db: Db): Promise<boolean> {
  return (await instanceSettingsService(db).getExperimentalReadOnly()).enableAntigravitySwarm === true;
}

/** Comment-time check, so an unavailable swarm is refused before anything is posted. */
export async function antigravitySwarmCommentRefusal(db: Db, issue: { companyId: string; assigneeAgentId: string | null; workMode?: string | null }): Promise<string | null> {
  const [agent] = issue.assigneeAgentId
    ? await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig }).from(agents)
      .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
    : [];
  return antigravitySwarmRefusal({ enabled: await swarmEnabled(db), agent: agent ?? null, workMode: issue.workMode ?? null });
}

/**
 * Run-time decision for the run a comment woke. Returns true when this run is
 * the user's swarm. Throws a plain-language failure when the swarm was asked
 * for but cannot run here, so the run is not silently an ordinary request.
 */
/**
 * Every run that re-creates a swarm request is that swarm, never ordinary work:
 * - a retry or automatic recovery inherits it through its retry link (the run
 *   column, or the context copy), following a bounded chain on the same task;
 * - any other wake on the task (blocker-stalled and stranded-work sweeps,
 *   continuations, restart recovery) runs it while the user's latest message is
 *   a swarm request that no successful swarm run has fulfilled.
 * The record check in resolveAntigravitySwarmRun still applies to the result.
 */
async function inheritedSwarmCommentId(db: Db, companyId: string, issueId: string, runId: string, context: unknown): Promise<string | null> {
  const [current] = await db.select({ retryOfRunId: heartbeatRuns.retryOfRunId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  let retryOf: unknown = current?.retryOfRunId ?? record(context).retryOfRunId;
  for (let hop = 0; hop < 8 && typeof retryOf === "string" && /^[0-9a-f-]{36}$/i.test(retryOf); hop++) {
    const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot, retryOfRunId: heartbeatRuns.retryOfRunId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, retryOf), eq(heartbeatRuns.companyId, companyId),
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`));
    if (!source) return null;
    const inherited = requestedAntigravitySwarmCommentId(source.contextSnapshot);
    if (inherited) return inherited;
    retryOf = source.retryOfRunId ?? record(source.contextSnapshot).retryOfRunId;
  }
  return null;
}

async function pendingSwarmCommentId(db: Db, companyId: string, issueId: string): Promise<string | null> {
  // A deleted latest message withdraws whatever it asked for; it never falls back to an older request.
  const [latest] = await db.select({ id: issueComments.id, deletedAt: issueComments.deletedAt }).from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  return latest && !latest.deletedAt ? latest.id : null;
}

/**
 * Read-only `nativeCommand: "swarm"` on the comments that are recorded /swarm
 * requests: the server's own activity record for that user and comment, never
 * the comment's client-writable metadata or its text.
 */
export async function withAntigravitySwarmMarkers<T extends { id: string; authorUserId: string | null; authorAgentId: string | null }>(
  db: Db, companyId: string, issueId: string, comments: readonly T[],
): Promise<Array<T & { nativeCommand?: typeof ANTIGRAVITY_SWARM_COMMAND }>> {
  const candidates = comments.filter(comment => comment.authorUserId && !comment.authorAgentId).map(comment => comment.id);
  if (candidates.length === 0) return [...comments];
  // The one definition of a recorded request (recordedSwarmRequestSql), read from the stored rows.
  const requests = new Set(await recordedSwarmRequestIds(db, companyId, issueId, candidates));
  return comments.map(comment => requests.has(comment.id) ? { ...comment, nativeCommand: ANTIGRAVITY_SWARM_COMMAND } : comment);
}

export async function recordAntigravitySwarmRequest(db: Db, input: { companyId: string; issueId: string; commentId: string; userId: string }): Promise<void> {
  await logActivity(db, {
    companyId: input.companyId, actorType: "user", actorId: input.userId, issueId: input.issueId,
    action: ANTIGRAVITY_SWARM_REQUESTED_ACTION, entityType: "issue", entityId: input.issueId,
    details: { commentId: input.commentId, summary: "Asked the Google Antigravity agent to run a swarm." },
  });
}

/**
 * Run-time decision for the run a comment woke. Returns true when this run is
 * the user's swarm. Throws a plain-language failure when the swarm was asked
 * for but cannot run here, so the run is not silently an ordinary request.
 */
export async function resolveAntigravitySwarmRun(db: Db, input: {
  companyId: string;
  issueId: string;
  runId: string;
  agent: { id: string; adapterType: string; adapterConfig: unknown };
  context: unknown;
  remote: boolean;
  planning: boolean;
  /** The task's work mode at dispatch; only a standard task runs a swarm. */
  workMode?: string | null;
}): Promise<AntigravitySwarmSelection | null> {
  // Most runs carry no swarm request: a cheap look without the task lock lets
  // them through. A request's record commits with its comment, so a run that
  // sees none here was not woken by one.
  if (!await recordedRequest(db, input)) return null;
  // Every fact the decision depends on (which request is newest, whether it is
  // fulfilled, running or stopped, its attempts, the user's Retry) is read again
  // under the task lock, in the transaction that records the selection. Saving
  // a user comment and its /swarm record takes the same lock (issues.addComment),
  // so a newer request either committed before these reads or saves after the
  // selection is recorded.
  const decision = await db.transaction(async (tx) => {
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
    return decideSwarm(tx as unknown as Db, input);
  });
  if (decision && "refusal" in decision) throw new PaperclipRunnerProviderProfileError(ANTIGRAVITY_SWARM_UNAVAILABLE, decision.refusal);
  return decision;
}

type SwarmDecision = AntigravitySwarmSelection | { refusal: string } | null;

/**
 * Read-only, before dispatch (the usage-limit hold runs before selection, which
 * needs the prepared workspace): the quota this run would draw on. A run that
 * would serve an unfulfilled recorded /swarm request draws on the CLI's quota.
 * Selection still decides; a wrong guess here only lets one run reach the
 * provider, which then reports its own limit.
 */
export async function antigravitySwarmQuotaScope(db: Db, input: {
  companyId: string; issueId: string; runId: string; agent: { id: string; adapterType: string; adapterConfig: unknown }; context: unknown;
}): Promise<string | null> {
  if (!isAntigravityAgent(input.agent)) return null;
  const requested = await recordedRequest(db, { ...input, remote: false, planning: false });
  if (!requested) return null;
  return await requestFulfilled(db, input.companyId, requested.commentId) ? null : ANTIGRAVITY_CLI_QUOTA_SCOPE;
}

async function requestFulfilled(db: Db, companyId: string, commentId: string): Promise<boolean> {
  const [fulfilled] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "succeeded"),
      sql`${heartbeatRuns.contextSnapshot}->>'antigravitySwarmCommentId' = ${commentId}`)).limit(1);
  return Boolean(fulfilled);
}

/** The recorded user /swarm request this run serves, if any (before any replacement). */
async function recordedRequest(db: Db, input: Parameters<typeof resolveAntigravitySwarmRun>[1]): Promise<{ commentId: string; body: string } | null> {
  const marked = requestedAntigravitySwarmCommentId(input.context);
  const explicit = marked ?? await inheritedSwarmCommentId(db, input.companyId, input.issueId, input.runId, input.context);
  // Only an explicit request (a fresh /swarm or its retry chain) is refused for
  // a non-Antigravity assignee; a task reassigned since then runs ordinary work.
  const commentId = explicit ?? (isAntigravityAgent(input.agent) ? await pendingSwarmCommentId(db, input.companyId, input.issueId) : null);
  if (!commentId) return null;
  const [requested] = await db.select({ id: activityLog.id, body: issueComments.body }).from(activityLog)
    // A deleted request is withdrawn: no swarm and no failure, so the run is ordinary work.
    // The prompt therefore never comes from text the user has since deleted.
    .innerJoin(issueComments, and(eq(issueComments.id, commentId), eq(issueComments.issueId, input.issueId), eq(issueComments.companyId, input.companyId),
      isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt)))
    .where(and(eq(activityLog.companyId, input.companyId), eq(activityLog.action, ANTIGRAVITY_SWARM_REQUESTED_ACTION),
      eq(activityLog.entityId, input.issueId), eq(activityLog.actorType, "user"), eq(activityLog.actorId, issueComments.authorUserId),
      sql`${activityLog.details}->>'commentId' = ${commentId}`))
    .limit(1);
  return requested ? { commentId, body: requested.body } : null;
}

/** Runs under the task lock. Writes made before a refusal (re-queued comments) commit with it. */
async function decideSwarm(tx: Db, input: Parameters<typeof resolveAntigravitySwarmRun>[1]): Promise<SwarmDecision> {
  const requested = await recordedRequest(tx, input);
  if (!requested) return null;
  const { commentId } = requested;
  // A later user /swarm replaces an earlier one (queued-comment-delivery.ts
  // counts the earlier one handled). When the newest request rode into this
  // wake, this run is that swarm; otherwise this request was replaced and
  // never runs, neither as a swarm nor as ordinary work.
  const wakeIds = await wakeCommentIds(tx, input);
  const recordedInWake = await recordedSwarmRequestIds(tx, input.companyId, input.issueId, wakeIds);
  const newest = await newestSwarmRequest(tx, input.companyId, input.issueId);
  let selected = { commentId, body: requested.body };
  if (newest && newest.id !== commentId) {
    if (!wakeIds.includes(newest.id)) {
      await queueCommentsTheSwarmDoesNotSend(tx, { ...input, commentId });
      return { refusal: "A newer /swarm request on this task replaced this one, so this one did not run." };
    }
    selected = { commentId: newest.id, body: newest.body };
  }
  // A fulfilled request never fails a later wake, whatever its text says now.
  if (await requestFulfilled(tx, input.companyId, selected.commentId)) return null;
  const replacedCommentIds = recordedInWake.filter(id => id !== selected.commentId);
  // The swarm's only instruction is this recorded comment's own text.
  const request = antigravitySwarmRequestFromComment(selected.body);
  // A requested swarm with nothing (or too much) to run is refused, never run as ordinary work.
  const requestRefusal = antigravitySwarmRequestRefusal(request);
  if (requestRefusal) return { refusal: requestRefusal };
  return selectSwarm(tx, { ...input, commentId: selected.commentId, request, replacedCommentIds });
}

async function selectSwarm(tx: Db, input: Parameters<typeof resolveAntigravitySwarmRun>[1] & {
  commentId: string; request: string; replacedCommentIds: string[];
}): Promise<SwarmDecision> {
  const { commentId, request } = input;
  const attempts = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, createdAt: heartbeatRuns.createdAt,
    finishedAt: heartbeatRuns.finishedAt, updatedAt: heartbeatRuns.updatedAt }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, input.runId),
      sql`${heartbeatRuns.contextSnapshot}->>'antigravitySwarmCommentId' = ${commentId}`,
      // A wake held for a usage limit never started; its scheduled retry is this request's next attempt, not a Stop.
      sql`${heartbeatRuns.errorCode} is distinct from 'provider_limit_wait'`));
  if (attempts.some(run => run.status === "succeeded")) return null;
  if (attempts.some(run => ["queued", "running"].includes(run.status))) return { refusal: "A swarm for this request is already running." };
  // The user asked for this attempt: it is the request's first run (the
  // fresh /swarm comment), or this run is the one the user's Retry started,
  // clicked after the last attempt began and after any Stop. Run context and
  // wake reasons are not proof (recoveries copy context, and an agent can
  // name any wake reason), so Retry is read from the user's own retry
  // request. A click that joined an attempt already running belongs to that
  // attempt. Everything else (recovery, sweeps, continuations, automatic
  // retries) is automatic and bounded below.
  const latestOf = (dates: Date[]) => dates.reduce<Date | null>((latest, at) => !latest || at > latest ? at : latest, null);
  const lastAttemptAt = latestOf(attempts.map(run => run.createdAt));
  const stoppedAt = latestOf(attempts.filter(run => run.status === "cancelled").map(run => run.finishedAt ?? run.updatedAt));
  const manual = lastAttemptAt === null || await userRetryStartedRun(tx, {
    companyId: input.companyId, agentId: input.agent.id, issueId: input.issueId, runId: input.runId,
    since: stoppedAt && stoppedAt > lastAttemptAt ? stoppedAt : lastAttemptAt });
  if (!manual && attempts.some(run => run.status === "cancelled")) {
    return { refusal: "The swarm for this request was stopped. Send /swarm again, or use Retry, to start it again." };
  }
  // A swarm the route itself failed (no result, helpers timed out, a blocked
  // action) waits for the person: only interruptions are attempted again automatically.
  if (!manual && attempts.some(run => run.status === "failed" && run.errorCode === ANTIGRAVITY_SWARM_UNAVAILABLE)) {
    return { refusal: "The swarm for this request did not finish. Send /swarm again, or use Retry, to start it again." };
  }
  if (!manual && attempts.filter(run => ["failed", "timed_out"].includes(run.status)).length >= ANTIGRAVITY_SWARM_AUTOMATIC_ATTEMPTS) {
    return { refusal: "The swarm did not finish after three attempts, so Paperclip stopped retrying it. Send /swarm again to start a new one." };
  }
  const refusal = antigravitySwarmRefusal({ enabled: await swarmEnabled(tx), agent: input.agent, remote: input.remote, planning: input.planning,
    ...(input.workMode !== undefined ? { workMode: input.workMode } : {}) });
  if (refusal) return { refusal };
  await queueCommentsTheSwarmDoesNotSend(tx, { ...input, commentId });
  // The one stored fact every later decision reads: this run serves this request.
  await tx.update(heartbeatRuns)
    // The swarm draws on the CLI's own quota, so its limits are recorded (and held) apart from ordinary work.
    .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ antigravitySwarmCommentId: commentId, [PROVIDER_QUOTA_SCOPE_CONTEXT_KEY]: ANTIGRAVITY_CLI_QUOTA_SCOPE })}::jsonb` })
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  await logActivity(tx, {
    companyId: input.companyId, actorType: "system", actorId: "paperclip", agentId: input.agent.id, runId: input.runId,
    issueId: input.issueId, action: "issue.antigravity_swarm_started", entityType: "issue", entityId: input.issueId,
    details: {
      commentId,
      ...(input.replacedCommentIds.length ? { replacedCommentIds: input.replacedCommentIds } : {}),
      summary: (input.replacedCommentIds.length ? "Your latest /swarm request replaced the earlier one, which did not run. " : "") +
        "Started a Google Antigravity swarm with helpers. Helper actions are approved automatically by Antigravity's auto mode. Paperclip does not sandbox the helpers on this computer and cannot see their shell commands, which can write outside the task folder (for example in temp directories). Usage is one total for the coordinator and its helpers.",
    },
  });
  return { commentId, request };
}

/**
 * A Retry the signed-in user asked for on this task and agent after `since`
 * that started this run: its request is this run's wake, or is linked to this
 * run (automatic retries excluded). Promotion renames a deferred Retry's wake
 * reason, so a Retry is also known by its own retry intent.
 */
async function userRetryStartedRun(db: Db, input: { companyId: string; agentId: string; issueId: string; runId: string; since: Date }): Promise<boolean> {
  const [retry] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
    or(inArray(agentWakeupRequests.reason, ["task_retry", "retry_failed_run"]),
      sql`${agentWakeupRequests.payload}->'taskRetry'->>'schema' = 'paperclip.task-retry.v1'`),
    eq(agentWakeupRequests.requestedByActorType, "user"), isNotNull(agentWakeupRequests.requestedByActorId),
    gt(agentWakeupRequests.requestedAt, input.since),
    sql`coalesce(${agentWakeupRequests.payload}->>'issueId', ${agentWakeupRequests.payload}->>'taskId') = ${input.issueId}`,
    sql`${agentWakeupRequests.payload}->'taskRetry'->>'initiatedBy' is null`,
    or(eq(agentWakeupRequests.runId, input.runId), sql`exists (select 1 from ${heartbeatRuns} started
      where started.company_id = ${input.companyId} and started.id = ${input.runId}
        and started.wakeup_request_id = ${agentWakeupRequests.id})`),
  )).limit(1);
  return Boolean(retry);
}

/**
 * The swarm sends the provider only its request comment. Other user comments
 * merged into this run's wake (queued-comment-delivery.ts does not count them
 * delivered by a swarm run) are saved as their own receipt, so a following
 * ordinary run delivers them. A comment another receipt already carries is not
 * saved twice (a retry of the swarm copies the merged context).
 */
async function queueCommentsTheSwarmDoesNotSend(db: Db, input: {
  companyId: string; issueId: string; runId: string; agent: { id: string }; context: unknown; commentId: string;
}): Promise<void> {
  const others = (await wakeCommentIds(db, input)).filter(id => id !== input.commentId);
  if (others.length === 0) return;
  const receipts = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agent.id),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`));
  const waiting = new Set(receipts.flatMap(receipt => queuedCommentIdsFromWakePayload(receipt.payload)));
  const owed = others.filter(id => !waiting.has(id));
  if (owed.length === 0) return;
  await saveUndeliveredUserComments(db, { companyId: input.companyId, issueId: input.issueId, agentId: input.agent.id,
    commentIds: owed, allowedStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"] });
}

/** The user comment ids this run's wake carries (its stored context and the wake's own), in order. */
async function wakeCommentIds(db: Db, input: { companyId: string; runId: string; context: unknown }): Promise<string[]> {
  const [run] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  const merged = [run?.contextSnapshot, input.context].flatMap(value => [...queuedCommentIdsFromRunContext(value),
    record(value).wakeCommentId, record(value).commentId]);
  return [...new Set(merged.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))];
}

async function recordedSwarmRequestIds(db: Db, companyId: string, issueId: string, commentIds: string[]): Promise<string[]> {
  if (commentIds.length === 0) return [];
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.companyId, companyId),
    eq(issueComments.issueId, issueId), inArray(issueComments.id, commentIds), recordedSwarmRequestSql(companyId, sql`${issueComments}`)));
  return commentIds.filter(id => rows.some(row => row.id === id));
}

/** The task's newest live recorded /swarm request: the one a later request has not replaced. */
async function newestSwarmRequest(db: Db, companyId: string, issueId: string): Promise<{ id: string; body: string } | null> {
  const [newest] = await db.select({ id: issueComments.id, body: issueComments.body }).from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt),
      recordedSwarmRequestSql(companyId, sql`${issueComments}`)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  return newest ?? null;
}

export interface AntigravitySwarmSelection {
  commentId: string;
  /** The recorded request comment's own text: the swarm's only instruction. */
  request: string;
}

/** A native execution that runs the trusted swarm (Antigravity CLI route). */
export function isAntigravitySwarmExecution(execution: { provider: unknown }): boolean {
  const provider = record(execution.provider);
  return provider.kind === "acpx" && provider.agent === "antigravity" && provider.mode === "swarm";
}
