import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvals,
  caseHandoffs,
  companies,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import type { IssueRecoveryActionOutcome } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { unadmittedChatWakeupCondition } from "../durable-chat-wakeup.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueService } from "../issues.js";
import { legacyControllerOwnerStamp } from "../legacy-controller-lease.js";
import { currentProcessProbe, proveOwnerGone, type OwnerProof, type LocalOwnerStamp } from "../owner-proof.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { taskInterruptionPresentations } from "../task-interruption-presentation.js";
import { CHAT_CONTROL_RECOVERY_STOP_CODE, CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE } from "../chat-control-recovery-stop.js";
import { onboardingFirstTaskAwaitingUserSql } from "./onboarding-first-task-wait.js";
import {
  continuationActivityMessage,
  continuationAllowance,
  evaluateAssignedWork,
  CONTINUATION_HISTORY_MS,
  STALE_BLOCK_MS,
  type AssignedWorkFacts,
  type AssignedWorkVerdict,
  type RunOwnerVerdict,
  type ViolationReason,
} from "./assigned-work-invariant.js";

/** Activity action recorded for every automatic continuation. It is also the
 * durable claim two servers serialize on, and the per-task rate-limit ledger. */
export const ASSIGNED_WORK_CONTINUED_ACTION = "issue.continued_automatically";
export const ASSIGNED_WORK_CONTINUATION_SOURCE = "issue.assigned_work_invariant";
/** Repairs per process per minute, so a deploy with many violations does not
 * start hundreds of runs at once. The rest are deferred, newest first. */
export const ASSIGNED_WORK_REPAIRS_PER_MINUTE = 10;
/** Upper bound on tasks one report reads. */
export const ASSIGNED_WORK_REPORT_LIMIT = 2_000;

const OPEN_STATUSES = ["todo", "in_progress", "blocked"] as const;
const PENDING_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const NON_TERMINAL_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const NATIVE_PENDING_RECOVERY_STATES = ["awaiting_evidence", "awaiting_runner_reattach", "resuming_session", "bootstrap_incomplete"];
const PROVIDER_LIMIT_CAUSES = ["provider_quota", "native_provider_usage_limit"];
const BLOCK_ATTRIBUTION_WINDOW_MS = 10_000;

type IssueRow = Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "assigneeAgentId" | "assigneeUserId" | "hiddenAt"
  | "blockedTransitionAt" | "updatedAt" | "unblockDescriptor" | "monitorNextCheckAt" | "conversationAgentId" | "originKind"
  | "projectId" | "statusVersion" | "executionState" | "identifier">;

type RunRow = Pick<typeof heartbeatRuns.$inferSelect, "id" | "status" | "agentId" | "runtimeMode" | "errorCode" | "finishedAt"
  | "scheduledRetryAt" | "controllerBootId" | "controllerLeaseExpiresAt" | "controllerProcess" | "resultJson"> & { issueId: string };

export type AssignedWorkDeps = {
  enqueueWakeup: (agentId: string, opts: {
    source: "automation"; triggerDetail: "system"; reason: string;
    payload: Record<string, unknown>; requestedByActorType: "system"; requestedByActorId: null;
    contextSnapshot: Record<string, unknown>;
  }) => Promise<{ id: string } | null>;
  /** Runs this process executes now. */
  liveRunExecutions?: Readonly<{ has(id: string): boolean }>;
  /** Heartbeat's lost-process settle path for a running run whose owner is gone. */
  settleLostRunProcess?: (scope: { companyId: string; runId: string; onDeferredDeadline?: (at: number) => void }) => Promise<unknown>;
  /** Shared owner proof, injectable for tests. */
  proveOwner?: (stamp: LocalOwnerStamp) => Promise<OwnerProof>;
  now?: () => Date;
};

export type AssignedWorkCheck = {
  verdict: AssignedWorkVerdict;
  outcome: "ok" | "settling" | "repaired" | "settled_lost_run" | "deferred_rate_limit" | "deferred_cap" | "stale_reported" | "changed" | "enqueue_refused";
  retryAt: Date | null;
};

const json = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Per-pass accounting, logged once per burst of checks (no timer while idle). */
function createPassLog() {
  let pass: { startedAt: number; checked: number; ok: Record<string, number>; violations: Record<string, number>;
    repaired: number; deferred: number; stale: number } | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (!pass) return;
    const summary = pass; pass = null;
    logger.info({ event: "assigned_work_invariant.pass", checked: summary.checked, ok: summary.ok,
      violations: summary.violations, repaired: summary.repaired, deferredByRateLimit: summary.deferred,
      staleBlockedReported: summary.stale, durationMs: Date.now() - summary.startedAt }, "assigned-work invariant pass");
  };
  return {
    record(check: AssignedWorkCheck) {
      pass ??= { startedAt: Date.now(), checked: 0, ok: {}, violations: {}, repaired: 0, deferred: 0, stale: 0 };
      pass.checked += 1;
      const verdict = check.verdict;
      if (verdict.kind === "ok") {
        const key = verdict.clause === "live_run" ? "live_run" : verdict.clause === "pending_intent" ? `pending:${verdict.intent}` : `waiting:${verdict.reason}`;
        pass.ok[key] = (pass.ok[key] ?? 0) + 1;
      } else if (verdict.kind === "violation") {
        pass.violations[verdict.reason] = (pass.violations[verdict.reason] ?? 0) + 1;
      }
      if (check.outcome === "repaired" || check.outcome === "settled_lost_run") pass.repaired += 1;
      if (check.outcome === "deferred_rate_limit" || check.outcome === "deferred_cap") pass.deferred += 1;
      if (check.outcome === "stale_reported") pass.stale += 1;
      if (!timer) { timer = setTimeout(flush, 5_000); timer.unref?.(); }
    },
    flush,
  };
}

export function assignedWorkSweep(db: Db, deps: AssignedWorkDeps) {
  const now = () => deps.now?.() ?? new Date();
  const proveOwner = deps.proveOwner ?? ((stamp: LocalOwnerStamp) => proveOwnerGone(stamp, { ...currentProcessProbe(), readOnly: true }));
  const passLog = createPassLog();
  const repairTimes: number[] = [];
  const treeControl = issueTreeControlService(db);

  async function runOwner(run: RunRow, at: Date): Promise<RunOwnerVerdict> {
    if (run.status !== "running") return "alive";
    if (deps.liveRunExecutions?.has(run.id)) return "alive";
    // Native runs are owned through the native coordinator's fenced claims,
    // which the native settle watch judges. Never declare them gone here.
    if (run.runtimeMode !== "legacy") return "unprovable";
    // A held lease is a live owner, including another server during a deploy overlap.
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > at.getTime()) return "alive";
    const stamp = legacyControllerOwnerStamp(run);
    if (!stamp) return "unprovable";
    const proof = await proveOwner(stamp);
    return proof.verdict;
  }

  async function loadFacts(companyId: string, issueRows: IssueRow[]): Promise<Map<string, AssignedWorkFacts>> {
    const result = new Map<string, AssignedWorkFacts>();
    if (!issueRows.length) return result;
    const at = now();
    const ids = issueRows.map(issue => issue.id);
    const idParam = sql`${sql.param(ids)}::text[]`;
    const runIssue = sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`;
    const runColumns = {
      issueId: runIssue, id: heartbeatRuns.id, status: heartbeatRuns.status, agentId: heartbeatRuns.agentId,
      runtimeMode: heartbeatRuns.runtimeMode, errorCode: heartbeatRuns.errorCode, finishedAt: heartbeatRuns.finishedAt,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt, controllerBootId: heartbeatRuns.controllerBootId,
      controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt, controllerProcess: heartbeatRuns.controllerProcess,
      resultJson: sql<Record<string, unknown> | null>`jsonb_build_object('cancelledByActorType', ${heartbeatRuns.resultJson}->'cancelledByActorType')`,
    };
    const agentIds = [...new Set(issueRows.flatMap(issue => issue.assigneeAgentId ? [issue.assigneeAgentId] : []))];
    const blockedRows = issueRows.filter(issue => issue.status === "blocked");

    const [activeRuns, latestRuns, wakes, chatWakes, nativePending, handoffs, goals, interactions, approvalRows,
      blockerRows, childRows, actionMap, agentRows, companyRows, onboardingRows, blockActivity, interruptions] = await Promise.all([
      db.select(runColumns).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, NON_TERMINAL_RUN_STATUSES), sql`${runIssue} = any(${idParam})`)),
      // The newest run per task, read through the (company, issueId, created) index.
      db.execute<RunRow & { issue_id: string }>(sql`select requested.id as "issueId", latest.*
        from unnest(${idParam}) as requested(id)
        cross join lateral (
          select r.id, r.status, r.agent_id as "agentId", r.runtime_mode as "runtimeMode", r.error_code as "errorCode",
            r.finished_at as "finishedAt", r.scheduled_retry_at as "scheduledRetryAt",
            r.controller_boot_id as "controllerBootId", r.controller_lease_expires_at as "controllerLeaseExpiresAt",
            r.controller_process as "controllerProcess",
            jsonb_build_object('cancelledByActorType', r.result_json->'cancelledByActorType') as "resultJson"
          from heartbeat_runs r
          where r.company_id = ${companyId} and (r.context_snapshot->>'issueId') = requested.id
          order by r.created_at desc limit 1
        ) latest`),
      db.select({ issueId: sql<string>`${agentWakeupRequests.payload}->>'issueId'`, count: sql<number>`count(*)::int` })
        .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, PENDING_WAKE_STATUSES),
          sql`${agentWakeupRequests.payload}->>'issueId' = any(${idParam})`))
        .groupBy(sql`${agentWakeupRequests.payload}->>'issueId'`),
      db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids),
        unadmittedChatWakeupCondition(issues.id, issues.companyId))),
      db.selectDistinct({ issueId: nativeRunFinalizations.issueId }).from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, companyId), inArray(nativeRunFinalizations.issueId, ids),
        isNull(nativeRunFinalizations.resultId), inArray(nativeRunFinalizations.recoveryState, NATIVE_PENDING_RECOVERY_STATES))),
      db.selectDistinct({ issueId: caseHandoffs.issueId }).from(caseHandoffs).where(and(eq(caseHandoffs.companyId, companyId),
        inArray(caseHandoffs.issueId, ids), eq(caseHandoffs.destinationKind, "agent"),
        inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch"]))),
      db.select({ taskKey: agentTaskSessions.taskKey, agentId: agentTaskSessions.agentId, goalStatus: agentTaskSessions.goalStatus })
        .from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId), inArray(agentTaskSessions.taskKey, ids),
          sql`${agentTaskSessions.goalStatus} is not null`, sql`${agentTaskSessions.goalStatus} <> 'complete'`)),
      db.select({ issueId: issueThreadInteractions.issueId, count: sql<number>`count(*)::int` }).from(issueThreadInteractions)
        .where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.issueId, ids),
          eq(issueThreadInteractions.status, "pending"))).groupBy(issueThreadInteractions.issueId),
      db.select({ issueId: issueApprovals.issueId, count: sql<number>`count(*)::int` }).from(issueApprovals)
        .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
        .where(and(eq(issueApprovals.companyId, companyId), inArray(issueApprovals.issueId, ids), eq(approvals.status, "pending")))
        .groupBy(issueApprovals.issueId),
      db.select({ issueId: issueRelations.relatedIssueId, count: sql<number>`count(*)::int` }).from(issueRelations)
        .innerJoin(issues, and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, issueRelations.companyId)))
        .where(and(eq(issueRelations.companyId, companyId), inArray(issueRelations.relatedIssueId, ids),
          eq(issueRelations.type, "blocks"), sql`${issues.status} not in ('done', 'cancelled')`))
        .groupBy(issueRelations.relatedIssueId),
      db.select({ parentId: issues.parentId, count: sql<number>`count(*)::int` }).from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, ids), sql`${issues.status} not in ('done', 'cancelled')`,
          isNull(issues.hiddenAt))).groupBy(issues.parentId),
      issueRecoveryActionService(db).listActiveForIssues(companyId, ids),
      agentIds.length ? db.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))) : [],
      db.select({ status: companies.status, pauseReason: companies.pauseReason }).from(companies).where(eq(companies.id, companyId)),
      db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids),
        onboardingFirstTaskAwaitingUserSql(issues.companyId, issues.id, issues.originKind))),
      blockedRows.length ? db.execute<{ issueId: string; actorType: string; actorId: string; agentId: string | null; details: unknown }>(sql`
        select requested.id as "issueId", latest.actor_type as "actorType", latest.actor_id as "actorId",
          latest.agent_id as "agentId", latest.details
        from jsonb_to_recordset(${JSON.stringify(blockedRows.map(issue => ({ id: issue.id,
          blocked_at: (issue.blockedTransitionAt ?? issue.updatedAt).toISOString() })))}::jsonb) as requested(id text, blocked_at timestamptz)
        cross join lateral (
          select a.actor_type, a.actor_id, a.agent_id, a.details from activity_log a
          where a.company_id = ${companyId} and a.entity_type = 'issue' and a.entity_id = requested.id
            and a.created_at between requested.blocked_at - make_interval(secs => ${BLOCK_ATTRIBUTION_WINDOW_MS / 1000})
              and requested.blocked_at + make_interval(secs => ${BLOCK_ATTRIBUTION_WINDOW_MS / 1000})
            and (a.details->>'status' = 'blocked' or a.details->>'toStatus' = 'blocked'
              or a.details->'changes'->'status'->>'to' = 'blocked')
          order by a.created_at desc limit 1
        ) latest`) : [],
      taskInterruptionPresentations(db, companyId, issueRows.map(issue => ({ id: issue.id, companyId: issue.companyId,
        status: issue.status, assigneeAgentId: issue.assigneeAgentId, projectId: issue.projectId }))),
    ]);

    const rowsOf = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : ((value as { rows?: T[] })?.rows ?? []);
    const agentsById = new Map<string, typeof agents.$inferSelect & { invokable: boolean }>();
    for (const agent of agentRows as Array<typeof agents.$inferSelect>) {
      agentsById.set(agent.id, { ...agent, invokable: (await evaluateAgentInvokabilityFromDb(db, agent)).invokable });
    }
    const company = companyRows[0];
    const companyBudget = company?.pauseReason === "budget" || company?.pauseReason === "budget_exceeded";
    const counts = (rows: Array<{ issueId: string | null; count: number }>) =>
      new Map(rows.filter(row => row.issueId).map(row => [row.issueId!, Number(row.count)]));
    const wakeCounts = counts(wakes);
    const chatWakeIds = new Set(chatWakes.map(row => row.id));
    const nativeIds = new Set(nativePending.map(row => row.issueId));
    const handoffIds = new Set(handoffs.map(row => row.issueId));
    const interactionCounts = counts(interactions);
    const approvalCounts = counts(approvalRows);
    const blockerCounts = counts(blockerRows);
    const childCounts = counts(childRows.map(row => ({ issueId: row.parentId, count: row.count })));
    const onboardingIds = new Set(onboardingRows.map(row => row.id));
    const latestByIssue = new Map(rowsOf<RunRow>(latestRuns).map(row => [row.issueId, row]));
    const blockActivityByIssue = new Map(rowsOf<{ issueId: string; actorType: string; actorId: string; agentId: string | null; details: unknown }>(blockActivity)
      .map(row => [row.issueId, row]));

    for (const issue of issueRows) {
      const agent = issue.assigneeAgentId ? agentsById.get(issue.assigneeAgentId) ?? null : null;
      const runs = activeRuns.filter(run => run.issueId === issue.id) as RunRow[];
      const ownedRuns = [];
      for (const run of runs) {
        ownedRuns.push({ id: run.id, status: run.status, scheduledRetryAt: run.scheduledRetryAt, owner: await runOwner(run, at) });
      }
      const latest = latestByIssue.get(issue.id) ?? null;
      const latestFinishedAt = latest?.finishedAt ? new Date(latest.finishedAt) : null;
      const leaseUntil = latest?.controllerLeaseExpiresAt ? new Date(latest.controllerLeaseExpiresAt) : null;
      const goal = goals.find(row => row.taskKey === issue.id && row.agentId === issue.assigneeAgentId);
      const action = actionMap.get(issue.id) ?? null;
      const interruption = interruptions.get(issue.id) ?? null;
      const executionState = json(issue.executionState);
      const blockedEntry = blockActivityByIssue.get(issue.id);
      // The tree pause gate walks ancestors; read it only when nothing else
      // already gives the task a path.
      const needsPauseCheck = !ownedRuns.some(run => run.owner !== "gone") && !(wakeCounts.get(issue.id) ?? 0);
      const pauseHold = needsPauseCheck && Boolean(await treeControl.getActivePauseHoldGate(companyId, issue.id));
      result.set(issue.id, {
        issue: {
          status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
          hidden: Boolean(issue.hiddenAt), blockedTransitionAt: issue.blockedTransitionAt, updatedAt: issue.updatedAt,
          unblockOwner: (issue.unblockDescriptor?.owner ?? null) as AssignedWorkFacts["issue"]["unblockOwner"],
          monitorNextCheckAt: issue.monitorNextCheckAt,
          isConversation: Boolean(issue.conversationAgentId) || issue.originKind === "chat_channel",
          awaitingFirstMessage: onboardingIds.has(issue.id),
        },
        activeRuns: ownedRuns,
        latestRun: latest ? {
          id: latest.id, status: latest.status, errorCode: latest.errorCode, finishedAt: latestFinishedAt,
          settlingUntil: latest.runtimeMode === "legacy" && latest.controllerBootId && leaseUntil
            && !NON_TERMINAL_RUN_STATUSES.includes(latest.status) ? leaseUntil : null,
          operatorStopped: latest.agentId === issue.assigneeAgentId && (
            [CHAT_CONTROL_RECOVERY_STOP_CODE, CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE, "operator_interrupted"].includes(latest.errorCode ?? "")
            || (latest.status === "cancelled" && ["user", "board"].includes(String(json(latest.resultJson).cancelledByActorType)))),
        } : null,
        pendingWakes: (wakeCounts.get(issue.id) ?? 0) + (chatWakeIds.has(issue.id) ? 1 : 0),
        nativeRecoveryPending: nativeIds.has(issue.id),
        pendingHandoff: handoffIds.has(issue.id),
        sessionGoal: goal ? (goal.goalStatus === "paused" ? "paused" : "active") : null,
        interruption: interruption ? { responsibility: interruption.responsibility, state: interruption.state,
          userAction: interruption.userAction, nextRetryAt: interruption.nextRetryAt, canRetry: interruption.canRetry } : null,
        pendingInteractions: interactionCounts.get(issue.id) ?? 0,
        pendingApprovals: approvalCounts.get(issue.id) ?? 0,
        openBlockers: blockerCounts.get(issue.id) ?? 0,
        openChildren: childCounts.get(issue.id) ?? 0,
        reviewPending: executionState.status === "pending" || Boolean(executionState.reviewRequest),
        activeRecoveryAction: action ? { cause: action.cause, ownerType: action.ownerType,
          resumeAt: PROVIDER_LIMIT_CAUSES.includes(action.cause) && interruption?.nextRetryAt ? new Date(interruption.nextRetryAt) : null } : null,
        agent: agent ? { status: agent.status, invokable: agent.invokable } : null,
        companyPaused: company?.status === "paused",
        pauseHold,
        budgetStop: companyBudget || agent?.pauseReason === "budget" || agent?.pauseReason === "budget_exceeded",
        blockedBy: issue.status !== "blocked" ? null : attributeBlock(blockedEntry, issue.assigneeAgentId),
      });
    }
    return result;
  }

  const issueColumns = {
    id: issues.id, companyId: issues.companyId, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId, hiddenAt: issues.hiddenAt, blockedTransitionAt: issues.blockedTransitionAt,
    updatedAt: issues.updatedAt, unblockDescriptor: issues.unblockDescriptor, monitorNextCheckAt: issues.monitorNextCheckAt,
    conversationAgentId: issues.conversationAgentId, originKind: issues.originKind, projectId: issues.projectId,
    statusVersion: issues.statusVersion, executionState: issues.executionState, identifier: issues.identifier,
  };

  async function loadIssues(companyId: string, issueId?: string, limit = ASSIGNED_WORK_REPORT_LIMIT): Promise<IssueRow[]> {
    return db.select(issueColumns).from(issues).where(and(
      eq(issues.companyId, companyId),
      issueId ? eq(issues.id, issueId) : undefined,
      inArray(issues.status, [...OPEN_STATUSES]),
      sql`${issues.assigneeAgentId} is not null`,
      isNull(issues.assigneeUserId),
      isNull(issues.hiddenAt),
    )).orderBy(desc(issues.updatedAt)).limit(limit);
  }

  /**
   * The cheap, indexed pre-filter the sweep reconstructs from: open assigned
   * tasks with no run that is plainly live, no pending wake and no pending
   * question. Everything it lets through is judged by the full predicate.
   * Chat conversations and blocks older than the stale window are left out:
   * the first wait on a person's message, the second is only reported.
   */
  async function listSuspects(scope: { companyId?: string; issueId?: string; createdAfter?: Date | null }, cursor: string | null, limit: number) {
    const at = now();
    return db.select({ id: issues.id, companyId: issues.companyId, updatedAt: issues.updatedAt }).from(issues).where(and(
      scope.companyId ? eq(issues.companyId, scope.companyId) : undefined,
      scope.issueId ? eq(issues.id, scope.issueId) : undefined,
      cursor ? sql`${issues.id} > ${cursor}` : undefined,
      scope.createdAfter ? gte(issues.createdAt, scope.createdAfter) : undefined,
      inArray(issues.status, [...OPEN_STATUSES]),
      sql`${issues.assigneeAgentId} is not null`,
      isNull(issues.assigneeUserId),
      isNull(issues.hiddenAt),
      isNull(issues.conversationAgentId),
      sql`coalesce(${issues.originKind}, '') <> 'chat_channel'`,
      sql`(${issues.status} <> 'blocked' or coalesce(${issues.blockedTransitionAt}, ${issues.updatedAt}) > ${new Date(at.getTime() - STALE_BLOCK_MS).toISOString()}::timestamptz)`,
      sql`(${issues.monitorNextCheckAt} is null or ${issues.monitorNextCheckAt} <= ${at.toISOString()}::timestamptz)`,
      // A legacy run whose controller lease lapsed may have lost its owner;
      // the predicate judges it with the owner proof. Other active runs are live.
      sql`not exists (select 1 from heartbeat_runs r where r.company_id = ${issues.companyId}
        and (r.context_snapshot->>'issueId') = ${issues.id}::text
        and r.status in ('queued', 'running', 'scheduled_retry')
        and not (r.status = 'running' and r.runtime_mode = 'legacy' and r.controller_lease_expires_at is not null
          and r.controller_lease_expires_at < ${at.toISOString()}::timestamptz))`,
      sql`not exists (select 1 from agent_wakeup_requests w where w.company_id = ${issues.companyId}
        and (w.payload->>'issueId') = ${issues.id}::text
        and w.status in ('queued', 'deferred_issue_execution', 'claimed'))`,
      sql`not exists (select 1 from issue_thread_interactions t where t.company_id = ${issues.companyId}
        and t.issue_id = ${issues.id} and t.status = 'pending')`,
      // Plain waits on someone else, decided without the full read. The
      // predicate re-checks every task this lets through.
      sql`not exists (select 1 from issue_relations rel inner join issues blocker
        on blocker.id = rel.issue_id and blocker.company_id = rel.company_id
        where rel.company_id = ${issues.companyId} and rel.related_issue_id = ${issues.id}
          and rel.type = 'blocks' and blocker.status not in ('done', 'cancelled'))`,
      sql`not exists (select 1 from issue_approvals ia inner join approvals ap on ap.id = ia.approval_id
        where ia.company_id = ${issues.companyId} and ia.issue_id = ${issues.id} and ap.status = 'pending')`,
      sql`not exists (select 1 from issue_recovery_actions ra where ra.company_id = ${issues.companyId}
        and ra.source_issue_id = ${issues.id} and ra.status in ('active', 'escalated')
        and ra.cause in ('configuration_incomplete', 'ownership_owner_unprovable'))`,
      sql`(${issues.status} <> 'blocked' or ${issues.unblockDescriptor} is null
        or (${issues.unblockDescriptor}->'owner'->>'agentId') = ${issues.assigneeAgentId}::text)`,
    )).orderBy(issues.id).limit(limit);
  }

  /** Evaluate one task, and repair it when it violates the invariant. */
  async function checkIssue(scope: { companyId: string; issueId: string; onDeferredDeadline?: (at: number) => void }): Promise<AssignedWorkCheck | null> {
    const [issue] = await loadIssues(scope.companyId, scope.issueId, 1);
    if (!issue) return null;
    const facts = (await loadFacts(scope.companyId, [issue])).get(issue.id)!;
    const at = now();
    const verdict = evaluateAssignedWork(facts, at);
    const check = await act(issue, facts, verdict, at);
    if (check.retryAt) scope.onDeferredDeadline?.(check.retryAt.getTime());
    passLog.record(check);
    return check;
  }

  async function act(issue: IssueRow, facts: AssignedWorkFacts, verdict: AssignedWorkVerdict, at: Date): Promise<AssignedWorkCheck> {
    if (verdict.kind === "not_applicable" || verdict.kind === "ok") return { verdict, outcome: "ok", retryAt: null };
    if (verdict.kind === "settling") return { verdict, outcome: "settling", retryAt: verdict.recheckAt };
    if (verdict.stale) return { verdict, outcome: "stale_reported", retryAt: null };
    if (verdict.reason === "run_owner_gone") {
      // Hand the run to heartbeat's lost-process settle path; its own failure
      // policy schedules the continuation. Re-check after the grace.
      await deps.settleLostRunProcess?.({ companyId: issue.companyId, runId: verdict.runId! });
      return { verdict, outcome: "settled_lost_run", retryAt: new Date(at.getTime() + 90_000) };
    }
    // A small process-wide budget keeps a post-deploy backlog from starting
    // hundreds of runs at once. Deferred tasks come back on their deadline.
    const minuteAgo = at.getTime() - 60_000;
    while (repairTimes.length && repairTimes[0] <= minuteAgo) repairTimes.shift();
    if (repairTimes.length >= ASSIGNED_WORK_REPAIRS_PER_MINUTE) {
      return { verdict, outcome: "deferred_rate_limit", retryAt: new Date(repairTimes[0] + 60_000 + Math.floor(Math.random() * 5_000)) };
    }
    const claimed = await claimContinuation(issue, verdict.reason, at);
    if (claimed.kind !== "claimed") return { verdict, outcome: claimed.kind === "capped" ? "deferred_cap" : claimed.kind === "changed" ? "changed" : "deferred_rate_limit",
      retryAt: claimed.kind === "changed" ? null : claimed.retryAt };
    repairTimes.push(at.getTime());
    const run = await deps.enqueueWakeup(issue.assigneeAgentId!, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      payload: { issueId: issue.id, mutation: "assigned_work_invariant" },
      requestedByActorType: "system", requestedByActorId: null,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_continuation_needed",
        source: ASSIGNED_WORK_CONTINUATION_SOURCE, assignedWorkViolation: verdict.reason,
        ...(facts.latestRun ? { previousRunId: facts.latestRun.id } : {}) },
    }).catch(error => {
      logger.warn({ err: error, companyId: issue.companyId, issueId: issue.id }, "assigned-work continuation was not admitted");
      return null;
    });
    // A refused continuation stays a violation; the claim spaces the next try.
    return { verdict, outcome: run ? "repaired" : "enqueue_refused", retryAt: claimed.nextCheckAt };
  }

  /**
   * The durable, serialized claim: under the task's row lock, re-check that the
   * task is unchanged and still has nothing pending, apply the per-task cap and
   * spacing, restore a recovery-owned block, and record the activity entry. A
   * second server sweeping at the same time waits on the lock and then sees the
   * claim, so one violation produces one continuation.
   */
  async function claimContinuation(issue: IssueRow, reason: ViolationReason, at: Date):
    Promise<{ kind: "claimed"; nextCheckAt: Date } | { kind: "capped" | "spaced"; retryAt: Date } | { kind: "changed" }> {
    const publications: ActivityPublication[] = [];
    const outcome = await db.transaction(async tx => {
      const [current] = await tx.select(issueColumns).from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id))).for("update");
      if (!current || current.status !== issue.status || current.statusVersion !== issue.statusVersion
        || current.assigneeAgentId !== issue.assigneeAgentId || current.assigneeUserId || current.hiddenAt) return { kind: "changed" as const };
      const [pendingWake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, issue.companyId), inArray(agentWakeupRequests.status, PENDING_WAKE_STATUSES),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`)).limit(1);
      const [activeRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, issue.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`)).limit(1);
      if (pendingWake || activeRun) return { kind: "changed" as const };
      const recent = await tx.select({ createdAt: activityLog.createdAt }).from(activityLog).where(and(
        eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id),
        eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION),
        gte(activityLog.createdAt, new Date(at.getTime() - CONTINUATION_HISTORY_MS)))).orderBy(desc(activityLog.createdAt)).limit(64);
      const allowance = continuationAllowance(recent.map(row => row.createdAt), at);
      if (!allowance.allowed) return { kind: allowance.capped ? "capped" as const : "spaced" as const, retryAt: allowance.retryAt };
      let previousStatus: string | null = null;
      if (current.status === "blocked") {
        // The block was a recovery outcome, not a person's: resolve the
        // recovery hold that caused it and put the task back where it was.
        const actions = issueRecoveryActionService(tx as unknown as Db);
        const active = await actions.getActiveForIssue(issue.companyId, issue.id, tx as unknown as Db);
        const evidence = json(active?.evidence);
        previousStatus = typeof evidence.previousStatus === "string" && ["todo", "in_progress"].includes(evidence.previousStatus)
          ? evidence.previousStatus : "todo";
        if (active) {
          await actions.resolveActiveForIssue({ companyId: issue.companyId, sourceIssueId: issue.id, actionId: active.id,
            status: "resolved", outcome: "restored" satisfies IssueRecoveryActionOutcome,
            resolutionNote: "Continued automatically: nothing needed a person, so the task was picked back up." }, tx as unknown as Db);
        }
        await issueService(tx as unknown as Db).update(issue.id, { status: previousStatus }, tx);
      }
      await logActivity(tx as unknown as Db, {
        companyId: issue.companyId, actorType: "system", actorId: "system", agentId: issue.assigneeAgentId, runId: null,
        action: ASSIGNED_WORK_CONTINUED_ACTION, entityType: "issue", entityId: issue.id,
        details: { identifier: issue.identifier, message: continuationActivityMessage(reason), violation: reason,
          ...(previousStatus ? { status: previousStatus, previousStatus: "blocked" } : {}),
          attempt: recent.length + 1 },
      }, publications);
      const next = continuationAllowance([at, ...recent.map(row => row.createdAt)], at);
      return { kind: "claimed" as const, nextCheckAt: next.allowed ? new Date(at.getTime() + 90_000) : next.retryAt };
    });
    for (const publication of publications) publishActivity(publication);
    return outcome;
  }

  /** Read-only: classify every open assigned task of a company. */
  async function report(companyId: string) {
    const rows = await loadIssues(companyId);
    const at = now();
    const summary = { checked: rows.length, truncated: rows.length >= ASSIGNED_WORK_REPORT_LIMIT, ok: {} as Record<string, number>,
      violations: {} as Record<string, number>, violationCount: 0, staleBlocked: 0, settling: 0,
      sample: [] as Array<{ identifier: string | null; status: string; reason: string }> };
    for (let index = 0; index < rows.length; index += 200) {
      const batch = rows.slice(index, index + 200);
      const facts = await loadFacts(companyId, batch);
      for (const issue of batch) {
        const verdict = evaluateAssignedWork(facts.get(issue.id)!, at);
        if (verdict.kind === "ok") {
          const key = verdict.clause === "live_run" ? "live_run" : verdict.clause === "pending_intent" ? `pending:${verdict.intent}` : `waiting:${verdict.reason}`;
          summary.ok[key] = (summary.ok[key] ?? 0) + 1;
        } else if (verdict.kind === "settling") summary.settling += 1;
        else if (verdict.kind === "violation") {
          if (verdict.stale) { summary.staleBlocked += 1; continue; }
          summary.violationCount += 1;
          summary.violations[verdict.reason] = (summary.violations[verdict.reason] ?? 0) + 1;
          if (summary.sample.length < 20) summary.sample.push({ identifier: issue.identifier, status: issue.status, reason: verdict.reason });
        }
      }
    }
    return summary;
  }

  return { checkIssue, listSuspects, report, loadFacts, flushPassLog: passLog.flush };
}

/** Who moved a task to `blocked`, from the activity entry written with it. */
export function attributeBlock(entry: { actorType: string; actorId: string; agentId: string | null; details: unknown } | undefined,
  assigneeAgentId: string | null): "user" | "assignee" | "system" | "unknown" {
  if (!entry) return "unknown";
  const details = json(entry.details);
  if (entry.actorType === "user") return "user";
  if (entry.actorType === "agent") return entry.agentId && entry.agentId === assigneeAgentId ? "assignee" : "system";
  // The agent's own turn decided to block (committed by the native status
  // decision), except when the decision only bound a dependency.
  if (entry.actorId === "native-status-committer" && details.source === "native_status_decision"
    && details.reasonCode !== "durable_dependency_blocker_bound") return "assignee";
  return "system";
}
