/**
 * Wake the issues waiting on a stalled one (`issue_blocker_stalled`).
 *
 * A parent hears about a child only when the child completes
 * (`issue_children_completed`), and a dependent hears about a blocker only when
 * every blocker is done (`issue_blockers_resolved`). When a child or blocker
 * instead stalls on a recovery action that needs the board (for example a run
 * whose retries are exhausted), nothing told the waiting agent: restart chaos
 * w-20261108T181313-s9701 t05 left a parent silently blocked for 50+ minutes.
 *
 * A stall is the issue's latest recovery action needing the board, on an
 * issue that is not done or cancelled:
 * - open (`active` or `escalated`) and board-owned or escalated; or
 * - board-owned and resolved with outcome `blocked` while the issue is still
 *   `blocked`. Recovery resolves its action this way when it gives the issue
 *   to the board (t05: created and resolved within six seconds), so an open
 *   action alone misses the common case.
 * Each open, agent-assigned waiter (the parent, and every issue the stalled
 * one `blocks`) is woken once per stall. The idempotency key names the
 * recovery action, so a repeated sweep never wakes twice, and a later stall
 * (a new action after a Retry or another failure) wakes again.
 *
 * A wake that did not reach the agent is retried, boundedly. A refusal
 * (wake-on-demand off, agent paused) is retried after ten minutes. A stall whose
 * runs failed (the keyed wake's run or a resource-wait retry carrying it) is
 * retried with a doubling wait and given up after MAX_FAILED_STALL_DELIVERIES
 * failed runs; the stall stays listed on the waiter's page. A waiter whose last
 * run failed setup on its bound remote workspace's hold is not woken again while
 * reservation would still refuse that hold (remoteWorkspaceHoldRefusesStart):
 * its run could only fail the same way. It is woken once the hold settles.
 */
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issueRelations, issues, type Db } from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON, readRemoteWorkspaceAuthority, type IssueBlockerStalledWakeContext,
  type IssueBlockerStallRelation } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { parseHeartbeatPolicy } from "../heartbeat/timer-policy.js";
import { authorizationService } from "../authorization.js";
import { readRemoteWorkspaceWriterHold, REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE,
  remoteWorkspaceHoldRefusesStart } from "../remote-workspace-writer-hold.js";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];
/** Waiters that may be woken: not finished, and not parked in the backlog by the board. */
const WAKEABLE_WAITER_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
const MAX_STALLS_PER_PASS = 200;
/** A wake row with one of these statuses was delivered or is still pending. */
const DELIVERED_OR_PENDING_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed", "coalesced", "completed"];
/** Waiters of one stall read per page, and scanned per pass before a cursor resumes the rest. */
const MAX_WAITERS_PER_STALL = 100;
const MAX_WAITERS_SCANNED_PER_STALL = 500;
const waiterCursors = new Map<string, string>();
/** Runs that still hold, or already delivered, a stall prompt. A failed setup never did. */
const DELIVERING_RUN_STATUSES = ["queued", "scheduled_retry", "running", "succeeded"];
/** A refused wake (skipped, failed, cancelled) is retried, but not more often than this. */
const REFUSED_WAKE_RETRY_MS = 10 * 60_000;
/** Failed runs of one stall's wake before it is no longer retried; each retry waits twice as long. */
const MAX_FAILED_STALL_DELIVERIES = 3;
/** Re-check for a waiter whose workspace hold refuses a run; settling the hold is what lets it run. */
const HELD_WORKSPACE_RECHECK_MS = 60 * 60_000;
const NON_INVOKABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];
/** Company-wide passes resume after the last stall a capped pass reached, so every stall is visited. */
const companyCursors = new Map<string, string>();

export type BlockerStallWakeup = (agentId: string, input: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
  allowRunCoalescing: false;
  issueStateGuard: { statuses: string[]; assigneeAgentId: string };
}) => Promise<unknown>;

export function issueBlockerStalledWakeKey(input: { waiterIssueId: string; stalledIssueId: string; recoveryActionId: string }) {
  return [ISSUE_BLOCKER_STALLED_WAKE_REASON, input.waiterIssueId, input.stalledIssueId, input.recoveryActionId].join(":");
}

/**
 * Recovery-action rows that keep a company in the recovery-action sweep: open
 * actions, and a board action resolved as "blocked" on an issue that is still
 * blocked (a stall with no open action left). Without the second case, an
 * unassigned stalled blocker with a todo waiter is visited by no sweep.
 */
export function recoveryActionSweepCondition() {
  return or(
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"),
      eq(issueRecoveryActions.ownerType, "board"),
      sql`exists (select 1 from ${issues} stalled where stalled.id = ${issueRecoveryActions.sourceIssueId}
        and stalled.company_id = ${issueRecoveryActions.companyId} and stalled.status = 'blocked')`),
    // A legacy subtask moved to its own workspace whose wake is still owed.
    // The pass returns its retry time, which schedules the company again.
    and(eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}#>>'{legacyWorkspaceRehome,wake}' = 'pending'`),
  )!;
}

type StallFilter = { companyId?: string | null; issueId?: string | null; issueIds?: readonly string[]; afterActionId?: string | null };

/** The stalled issues matching `filter` and the recovery action each one waits on. */
async function readStalls(db: Db, filter: StallFilter, limit = MAX_STALLS_PER_PASS) {
  if (filter.issueIds && filter.issueIds.length === 0) return [];
  return db.select({
    actionId: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
    kind: issueRecoveryActions.kind, cause: issueRecoveryActions.cause, status: issueRecoveryActions.status,
    ownerType: issueRecoveryActions.ownerType, nextAction: issueRecoveryActions.nextAction,
    issueId: issues.id, identifier: issues.identifier, title: issues.title, issueStatus: issues.status, parentId: issues.parentId,
    projectId: issues.projectId, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
  }).from(issueRecoveryActions)
    .innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId), eq(issues.companyId, issueRecoveryActions.companyId)))
    .where(and(
      filter.companyId ? eq(issueRecoveryActions.companyId, filter.companyId) : undefined,
      filter.issueId ? eq(issueRecoveryActions.sourceIssueId, filter.issueId) : undefined,
      filter.issueIds ? inArray(issueRecoveryActions.sourceIssueId, [...filter.issueIds]) : undefined,
      filter.afterActionId ? gt(issueRecoveryActions.id, filter.afterActionId) : undefined,
      notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
      or(
        and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          or(eq(issueRecoveryActions.ownerType, "board"), eq(issueRecoveryActions.status, "escalated"))),
        and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"),
          eq(issueRecoveryActions.ownerType, "board"), eq(issues.status, "blocked")),
      ),
      // Only the issue's latest action describes its current state.
      sql`not exists (select 1 from ${issueRecoveryActions} newer
        where newer.company_id = ${issueRecoveryActions.companyId}
          and newer.source_issue_id = ${issueRecoveryActions.sourceIssueId}
          and newer.created_at > ${issueRecoveryActions.createdAt})`,
    ))
    .orderBy(issueRecoveryActions.id)
    .limit(limit);
}

type StallRow = Awaited<ReturnType<typeof readStalls>>[number];

/**
 * Whether a run of the waiter's assignee could only fail setup on its bound
 * remote workspace's hold. The evidence is the assignee's own latest run on the
 * task: it failed setup on that hold, so this agent uses the workspace and
 * reservation already tried, and refused, to release the writer. The hold must
 * still be one reservation refuses outright (an ended writer past the holder
 * cutoff with its save unsettled, or a writer that cannot be named). Another
 * assignee, a later run, or a settled hold lets the wake through.
 */
async function waiterWorkspaceRefusesStart(db: Db, companyId: string,
  waiter: { id: string; assigneeAgentId: string | null; executionWorkspaceId: string | null }) {
  if (!waiter.executionWorkspaceId || !waiter.assigneeAgentId) return false;
  const [latest] = await db.select({ status: heartbeatRuns.status, error: heartbeatRuns.error }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, waiter.assigneeAgentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${waiter.id}`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  if (latest?.status !== "failed" || latest.error !== REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE) return false;
  const [workspace] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, waiter.executionWorkspaceId)));
  const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
  if (!authority?.writerRunId) return false;
  return remoteWorkspaceHoldRefusesStart(await readRemoteWorkspaceWriterHold(db, { companyId, authority }));
}

/** What a waiter's agent may see of a stalled issue it cannot read: that it is stalled, nothing more. */
function redactedStallContext(stall: StallRow, relation: IssueBlockerStallRelation): IssueBlockerStalledWakeContext {
  return {
    stalledIssueId: stall.issueId, stalledIssueIdentifier: null, stalledIssueTitle: "A task you cannot read",
    stalledIssueStatus: stall.issueStatus, relation,
    recoveryAction: { id: stall.actionId, kind: "", cause: "", status: stall.status, ownerType: stall.ownerType,
      nextAction: "Ask the board to act on it; its details are not available to you." },
  };
}

function stallContext(stall: StallRow, relation: IssueBlockerStallRelation): IssueBlockerStalledWakeContext {
  return {
    stalledIssueId: stall.issueId,
    stalledIssueIdentifier: stall.identifier,
    stalledIssueTitle: stall.title,
    stalledIssueStatus: stall.issueStatus,
    relation,
    recoveryAction: { id: stall.actionId, kind: stall.kind, cause: stall.cause, status: stall.status,
      ownerType: stall.ownerType, nextAction: stall.nextAction },
  };
}

/**
 * The children and blockers of `issueId` that are stalled on the board, for
 * the waiting issue's own page: the board sees them without opening each one.
 */
export async function listStalledDependencies(db: Db, input: { companyId: string; issueId: string }): Promise<IssueBlockerStalledWakeContext[]> {
  const children = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.parentId, input.issueId), isNull(issues.hiddenAt)));
  const blockers = await db.select({ id: issueRelations.issueId }).from(issueRelations)
    .where(and(eq(issueRelations.companyId, input.companyId), eq(issueRelations.type, "blocks"),
      eq(issueRelations.relatedIssueId, input.issueId)));
  const childIds = new Set(children.map(row => row.id));
  const stalls = await readStalls(db, { companyId: input.companyId, issueIds: [...new Set([...childIds, ...blockers.map(row => row.id)])] }, 50);
  return stalls.map(stall => stallContext(stall, childIds.has(stall.issueId) ? "child" : "blocker"));
}

export async function wakeWaitersOfStalledIssues(db: Db, enqueueWakeup: BlockerStallWakeup,
  opts: { companyId?: string | null; issueId?: string | null; maxStalls?: number } = {}) {
  const result = { stalls: 0, woken: 0, alreadyWoken: 0, deferred: 0, failed: 0, retryAt: null as number | null };
  const retryAt = (at: number) => { result.retryAt = result.retryAt === null ? at : Math.min(result.retryAt, at); };
  const maxStalls = opts.maxStalls ?? MAX_STALLS_PER_PASS;
  let stalled: StallRow[];
  if (opts.issueId) {
    // The per-issue sweep checks the issue itself and its own children and
    // blockers, so a stalled dependency that this sweep never visits (for
    // example an unassigned blocker) still reaches the waiting issue.
    const scope = opts.companyId ? [eq(issues.companyId, opts.companyId)] : [];
    const children = await db.select({ id: issues.id }).from(issues).where(and(...scope, eq(issues.parentId, opts.issueId)));
    const blockers = await db.select({ id: issueRelations.issueId }).from(issueRelations)
      .where(and(eq(issueRelations.type, "blocks"), eq(issueRelations.relatedIssueId, opts.issueId),
        opts.companyId ? eq(issueRelations.companyId, opts.companyId) : undefined));
    stalled = await readStalls(db, { companyId: opts.companyId,
      issueIds: [...new Set([opts.issueId, ...children.map(row => row.id), ...blockers.map(row => row.id)])] }, maxStalls);
  } else {
    const cursorKey = opts.companyId ?? "*";
    stalled = await readStalls(db, { companyId: opts.companyId, afterActionId: companyCursors.get(cursorKey) ?? null }, maxStalls);
    if (stalled.length >= maxStalls) companyCursors.set(cursorKey, stalled.at(-1)!.actionId);
    else companyCursors.delete(cursorKey);
  }
  const access = authorizationService(db);
  const agentCanRead = async (agentId: string, onBehalfOfUserId: string | null, stall: StallRow) => (await access.decide({
    actor: { type: "agent", agentId, companyId: stall.companyId, onBehalfOfUserId },
    action: "issue:read",
    resource: { type: "issue", companyId: stall.companyId, issueId: stall.issueId, projectId: stall.projectId,
      parentIssueId: stall.parentId, assigneeAgentId: stall.assigneeAgentId, assigneeUserId: stall.assigneeUserId,
      status: stall.issueStatus },
  })).allowed;
  const agentAcceptsWakes = new Map<string, boolean>();
  const acceptsWakes = async (agentId: string) => {
    if (!agentAcceptsWakes.has(agentId)) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      agentAcceptsWakes.set(agentId, Boolean(agent) && !NON_INVOKABLE_AGENT_STATUSES.includes(agent!.status)
        && parseHeartbeatPolicy(agent!).wakeOnDemand);
    }
    return agentAcceptsWakes.get(agentId)!;
  };

  for (const stall of stalled) {
    result.stalls += 1;
    const cursorKey = `${stall.actionId}:${opts.issueId ?? "*"}`;
    let after = waiterCursors.get(cursorKey) ?? null;
    let scanned = 0;
    for (;;) {
      const waiters = await db.select({ id: issues.id, identifier: issues.identifier, assigneeAgentId: issues.assigneeAgentId,
        status: issues.status, responsibleUserId: issues.responsibleUserId, executionWorkspaceId: issues.executionWorkspaceId,
        relation: sql<"child" | "blocker">`case when ${issues.id} = ${stall.parentId ?? null} then 'child' else 'blocker' end` })
        .from(issues)
        .where(and(
          eq(issues.companyId, stall.companyId),
          ne(issues.id, stall.issueId),
          inArray(issues.status, WAKEABLE_WAITER_STATUSES),
          isNull(issues.hiddenAt),
          sql`${issues.assigneeAgentId} is not null`,
          // A waiter's own sweep wakes only that waiter for its children and
          // blockers; the stalled issue's own pass covers all of its waiters.
          opts.issueId && stall.issueId !== opts.issueId ? eq(issues.id, opts.issueId) : undefined,
          after ? gt(issues.id, after) : undefined,
          sql`not exists (select 1 from ${agentWakeupRequests} w where w.company_id = ${stall.companyId}
            and w.idempotency_key = 'issue_blocker_stalled:' || ${issues.id}::text || ${`:${stall.issueId}:${stall.actionId}`}
            and w.status in (${sql.join(DELIVERED_OR_PENDING_WAKE_STATUSES.map(status => sql`${status}`), sql`, `)}))`,
          or(
            stall.parentId ? eq(issues.id, stall.parentId) : sql`false`,
            sql`exists (select 1 from ${issueRelations} r where r.company_id = ${stall.companyId}
              and r.type = 'blocks' and r.issue_id = ${stall.issueId} and r.related_issue_id = ${issues.id})`,
          ),
        )).orderBy(issues.id).limit(MAX_WAITERS_PER_STALL);
      for (const waiter of waiters) {
        const idempotencyKey = issueBlockerStalledWakeKey({ waiterIssueId: waiter.id, stalledIssueId: stall.issueId, recoveryActionId: stall.actionId });
        // (company_id, payload->>'issueId') is indexed; the key narrows to this stall.
        // A delivered or pending wake ends it. A refused one (wake-on-demand off,
        // agent paused) is retried once the refusal is old, so re-enabling wakes
        // still delivers the stall. Failed runs carrying this stall (the keyed
        // wake's run, or a resource-wait retry that keeps its context) are
        // retried after a doubling wait, and not after MAX_FAILED_STALL_DELIVERIES.
        const [prior] = await db.select({
          delivered: sql<boolean>`coalesce(bool_or(${inArray(agentWakeupRequests.status, DELIVERED_OR_PENDING_WAKE_STATUSES)}), false)`,
          lastRequestedAt: sql<string | null>`max(${agentWakeupRequests.requestedAt})`,
        }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, stall.companyId),
            sql`${agentWakeupRequests.payload}->>'issueId' = ${waiter.id}`,
            eq(agentWakeupRequests.idempotencyKey, idempotencyKey)));
        if (prior?.delivered) { result.alreadyWoken += 1; continue; }
        const [failed] = await db.select({
          runs: sql<number>`count(*)::int`,
          lastAt: sql<string | null>`max(coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}))`,
        }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, stall.companyId), eq(heartbeatRuns.status, "failed"),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${waiter.id}`,
            sql`${heartbeatRuns.contextSnapshot}#>>'{blockerStall,stalledIssueId}' = ${stall.issueId}`,
            sql`${heartbeatRuns.contextSnapshot}#>>'{blockerStall,recoveryAction,id}' = ${stall.actionId}`));
        const failedRuns = Number(failed?.runs ?? 0);
        if (failedRuns >= MAX_FAILED_STALL_DELIVERIES) { result.alreadyWoken += 1; continue; }
        const lastAttemptAt = Math.max(prior?.lastRequestedAt ? new Date(prior.lastRequestedAt).getTime() : 0,
          failed?.lastAt ? new Date(failed.lastAt).getTime() : 0);
        if (lastAttemptAt > 0) {
          const dueAt = lastAttemptAt + REFUSED_WAKE_RETRY_MS * 2 ** Math.max(0, failedRuns - 1);
          if (dueAt > Date.now()) {
            result.alreadyWoken += 1;
            retryAt(dueAt);
            continue;
          }
        }
        // A resource wait cancels the stall wake's run and schedules a retry
        // with no idempotency key; the retry keeps the stall in its context.
        const [carried] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, stall.companyId), eq(heartbeatRuns.agentId, waiter.assigneeAgentId!),
            inArray(heartbeatRuns.status, DELIVERING_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${waiter.id}`,
            sql`${heartbeatRuns.contextSnapshot}#>>'{blockerStall,stalledIssueId}' = ${stall.issueId}`,
            sql`${heartbeatRuns.contextSnapshot}#>>'{blockerStall,recoveryAction,id}' = ${stall.actionId}`)).limit(1);
        if (carried) { result.alreadyWoken += 1; continue; }
        if (await waiterWorkspaceRefusesStart(db, stall.companyId, waiter)) {
          result.deferred += 1;
          retryAt(Date.now() + HELD_WORKSPACE_RECHECK_MS);
          continue;
        }
        if (!(await acceptsWakes(waiter.assigneeAgentId!))) {
          result.deferred += 1;
          retryAt(Date.now() + REFUSED_WAKE_RETRY_MS);
          continue;
        }
        // A private stalled issue's details never reach an agent that cannot read it.
        const readable = await agentCanRead(waiter.assigneeAgentId!, waiter.responsibleUserId, stall);
        const context = readable ? stallContext(stall, waiter.relation) : redactedStallContext(stall, waiter.relation);
        try {
          const wake = await enqueueWakeup(waiter.assigneeAgentId!, {
            source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
            payload: { issueId: waiter.id, ...context }, idempotencyKey,
            requestedByActorType: "system", requestedByActorId: "issue-blocker-stall",
            contextSnapshot: { issueId: waiter.id, taskId: waiter.id, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
              source: "issue.blocker_stalled", blockerStall: context },
            // One stall per run: coalescing would keep only the last blockerStall
            // context while marking every merged stall as delivered.
            allowRunCoalescing: false,
            issueStateGuard: { statuses: WAKEABLE_WAITER_STATUSES, assigneeAgentId: waiter.assigneeAgentId! },
          });
          // Null is a normal deferral (for example wake-on-demand disabled): no
          // wake row exists yet, so a later sweep tries again.
          if (!wake) { result.deferred += 1; continue; }
          await logActivity(db, {
            companyId: stall.companyId, actorType: "system", actorId: "issue-blocker-stall",
            action: "issue.blocker_stalled_wake", entityType: "issue", entityId: waiter.id,
            agentId: waiter.assigneeAgentId, issueId: waiter.id,
            details: { stalledIssueId: stall.issueId, stalledIssueIdentifier: readable ? stall.identifier : null,
              relation: waiter.relation, recoveryActionId: stall.actionId,
              recoveryActionKind: readable ? stall.kind : null, recoveryActionStatus: stall.status, detailsWithheld: !readable },
          });
          result.woken += 1;
        } catch {
          // The next sweep retries: no wake row with this key exists yet.
          result.failed += 1;
        }
      }
      scanned += waiters.length;
      if (waiters.length < MAX_WAITERS_PER_STALL) { waiterCursors.delete(cursorKey); break; }
      after = waiters.at(-1)!.id;
      // Skipped waiters (agents taking no wakes) never pin later ones: the next pass resumes here.
      if (scanned >= MAX_WAITERS_SCANNED_PER_STALL) { waiterCursors.set(cursorKey, after); retryAt(Date.now()); break; }
    }
  }
  return result;
}

/**
 * Whether a wake's `issue_blocker_stalled` context is real, so it may run past
 * the waiter's unresolved blockers. The reason string alone is not trusted:
 * the wake must come from the system, name a recovery action that is the
 * stalled issue's current stall, and that issue must be a child or blocker of
 * the waking issue. Anything else falls back to the ordinary dependency gate.
 */
export async function verifyBlockerStallWake(db: Db, input: {
  companyId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown> | null | undefined;
  requestedByActorType: string | null | undefined;
}): Promise<boolean> {
  const context = input.contextSnapshot;
  // A resource wait (AI connection busy, workspace busy) replaces the run with
  // a server-created retry that keeps the context but not the wake reason or
  // request. It carries the stall that admitted the original run.
  const serverRetry = typeof context?.retryOfRunId === "string" && context.retryOfRunId.length > 0;
  if (!context || (context.wakeReason !== ISSUE_BLOCKER_STALLED_WAKE_REASON && !serverRetry)) return false;
  if (!serverRetry && input.requestedByActorType !== "system") return false;
  const stall = context.blockerStall as Partial<IssueBlockerStalledWakeContext> | undefined;
  const stalledIssueId = typeof stall?.stalledIssueId === "string" ? stall.stalledIssueId : null;
  const actionId = typeof stall?.recoveryAction?.id === "string" ? stall.recoveryAction.id : null;
  if (!stalledIssueId || !actionId || stalledIssueId === input.issueId) return false;
  const [current] = await readStalls(db, { companyId: input.companyId, issueIds: [stalledIssueId] }, 1);
  if (!current || current.actionId !== actionId) return false;
  if (current.parentId === input.issueId) return true;
  const [edge] = await db.select({ id: issueRelations.id }).from(issueRelations)
    .where(and(eq(issueRelations.companyId, input.companyId), eq(issueRelations.type, "blocks"),
      eq(issueRelations.issueId, stalledIssueId), eq(issueRelations.relatedIssueId, input.issueId))).limit(1);
  return Boolean(edge);
}
