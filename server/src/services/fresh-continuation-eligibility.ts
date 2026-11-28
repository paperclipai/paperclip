import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, approvals, heartbeatRuns, issueApprovals, issueRecoveryActions, issueThreadInteractions, issues,
  type Db } from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { PERMANENT_SOURCE_RETRY_CLASSES, UNVERIFIABLE_SOURCE_CODES } from "./system-recovery-state.js";
import { RESTART_CLASS_FAILURE_CODES, SETUP_FAILURE_CODES, continuationCauseIsSystemOwnedSql, continuesAutomaticallySql,
  recoveryRunSql } from "./continuation-cause.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { holdOwnsBlockedStatus } from "./recovery-hold-blocked-status.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

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
export const BACKLOG_CONTINUATION_SOURCE_CODES = RESTART_CLASS_FAILURE_CODES;
type BlockFacts = { holds: Array<typeof issueRecoveryActions.$inferSelect>;
  issue: Pick<typeof issues.$inferSelect, "id" | "status" | "statusVersion" | "lastStatusDecisionId" | "blockedTransitionAt">;
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "finishedAt"> };

export function failureOwnsBlock(holds: BlockFacts["holds"], issue: BlockFacts["issue"], run: BlockFacts["run"]) {
  const receipts = holds.filter(hold => hold.evidence.nativeFailureBlock !== undefined || hold.evidence.legacyCancellationBlock !== undefined
    || hold.evidence.nativeBootstrapFailureBlock !== undefined);
  return (receipts.length ? receipts : holds).some(hold => holdOwnsBlockedStatus(hold, issue, run))
    || receipts.some(hold => [hold.evidence.legacyCancellationBlock, hold.evidence.nativeBootstrapFailureBlock]
      .some(block => object(block).runId === run.id && object(block).statusVersion === Number(issue.statusVersion)))
    || (!holds.length && issue.lastStatusDecisionId === null && issue.blockedTransitionAt !== null && run.finishedAt !== null
      && issue.blockedTransitionAt.getTime() >= run.finishedAt.getTime() - 1_000);
}

/** Holds the disposition pass (unresolvedExecutionDispositions) handles itself, whatever their age. */
export function liveDispositionHoldSql() {
  return and(inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.kind, "active_run_watchdog"))!;
}

const cancelledAtDispatch = (alias: "newer" | "held") => sql.raw(`coalesce(${alias}.status = 'cancelled' and ${alias}.started_at is null
  and ${alias}.error_code = 'execution_reconciliation_required', false)`);
// The issue id is a uuid (a column or a task's id), so each link is compared on
// its own indexed column; a cast of the column would scan every run's context.
const runOfTask = (alias: "newer" | "held", issueId: SQL) => sql`(${sql.raw(alias)}.native_issue_id = ${issueId}::uuid
  or ${sql.raw(alias)}.issue_id = ${issueId}::uuid or ${sql.raw(alias)}.context_snapshot->>'issueId' = ${issueId}::text)`;

const sqlList = (values: readonly string[]) => sql.join(values.map(value => sql`${value}`), sql`, `);

export function interruptionEligibility(input: { now: Date; companyId: SQL; issueId: SQL; sourceRunId: SQL }) {
  const since = sql`${new Date(input.now.getTime() - BACKLOG_CONTINUATION_MAX_AGE_MS).toISOString()}::timestamptz`;
  const source = (condition: SQL) => sql`exists (select 1 from ${heartbeatRuns} source where source.company_id = ${input.companyId}
    and source.id = ${sourceRunKey(input.sourceRunId)} and ${condition})`;
  const refusedLater = sql`held.company_id = source.company_id and held.id <> source.id and ${runOfTask("held", input.issueId)}
    and (held.created_at, held.id) > (source.created_at, source.id) and ${cancelledAtDispatch("held")}`;
  const personAsked = source(sql`(exists (select 1 from ${agentWakeupRequests} retry where retry.company_id = source.company_id
      and retry.status = 'deferred_issue_execution' and retry.reason = 'task_retry' and retry.requested_by_actor_type = 'user'
      and retry.run_id is null and retry.payload->>'issueId' = ${input.issueId}::text and retry.requested_at > source.finished_at)
    or exists (select 1 from ${heartbeatRuns} held where ${refusedLater}
      and held.context_snapshot->>'wakeReason' = 'task_retry' and held.finished_at > ${since}))`);
  const systemRetriedSource = sql`(${continuationCauseIsSystemOwnedSql("source")}
    and coalesce(source.context_snapshot->>'wakeReason', '') <> 'task_retry' and not coalesce(source.context_snapshot ? 'explicitUserContinuation', false)
    and exists (select 1 from ${heartbeatRuns} held where ${refusedLater} and ${recoveryRunSql("held")}))`;
  // Saved-work recovery proved the run's unsaved files are permanently gone
  // (`source_unavailable`, use another strategy). The only way on is a fresh
  // run in a new workspace, which is exactly what Retry would do: a person
  // adds nothing, so the system takes that step itself (needed-retry is 0%).
  // Uncast keys, so the (company, task, evidence runId) index serves the lookup.
  const savedFilesLost = sql`exists (select 1 from ${issueRecoveryActions} lost where lost.company_id = source.company_id
    and lost.source_issue_id = ${input.issueId}
    and (lost.evidence->>'runId' = source.id::text or (lost.evidence->>'runId' is null and lost.evidence->>'sourceRunId' = source.id::text))
    and lost.evidence#>>'{systemRecovery,state}' = 'exhausted'
    and lost.evidence#>>'{systemRecovery,failure,code}' in (${sqlList(UNVERIFIABLE_SOURCE_CODES)})
    and lost.evidence#>>'{systemRecovery,failure,retryClass}' in (${sqlList(PERMANENT_SOURCE_RETRY_CLASSES)}))`;
  const setupFailedAfterWork = sql`(coalesce(source.result_json#>>'{executionRecovery,providerWorkStarted}', '') <> 'false'
    and source.error_code in (${sqlList(SETUP_FAILURE_CODES)})
    and exists (select 1 from ${issueRecoveryActions} saved where saved.company_id = source.company_id
      and saved.source_issue_id = ${input.issueId}
      and (saved.evidence->>'runId' = source.id::text or (saved.evidence->>'runId' is null and saved.evidence->>'sourceRunId' = source.id::text))
      and saved.evidence ?| array['workspaceRestoreRecovery', 'workspaceRestoreFailure', 'systemRecovery']
      and coalesce(saved.evidence#>>'{systemRecovery,state}', '') <> 'exhausted'))`;
  const recent = source(sql`(${continuesAutomaticallySql("source")} or ${systemRetriedSource}
      or (${continuationCauseIsSystemOwnedSql("source")} and (${savedFilesLost} or ${setupFailedAfterWork})))
    and greatest(source.finished_at, (select max(held.finished_at) from ${heartbeatRuns} held where ${refusedLater})) > ${since}`);
  return { recent, personAsked };
}

/** The backlog pass's eligibility: the one predicate its listing and its deadline query share. */
export function recentInterruptionSourceSql(now: Date) {
  const { recent, personAsked } = interruptionEligibility({ now, companyId: sql`${issueRecoveryActions.companyId}`,
    issueId: sql`${issueRecoveryActions.sourceIssueId}`,
    sourceRunId: heldRunIdSql() });
  return sql`(${recent} or ${personAsked})`;
}

export async function runsAwaitingSystemContinuation(db: Db, companyId: string, issueIds: string[], runIds: string[],
  now = new Date()): Promise<Set<string>> {
  if (!issueIds.length || !runIds.length) return new Set();
  const rows = await db.select({ issueId: issueRecoveryActions.sourceIssueId, runId: sql<string>`${heldRunIdSql()}` })
    .from(issueRecoveryActions).innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId),
      eq(issues.companyId, issueRecoveryActions.companyId)))
    .where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, issueIds),
      inArray(heldRunIdSql(), runIds), heldExecutionWhere(), interruptionEligibility({ now,
        companyId: sql`${issueRecoveryActions.companyId}`, issueId: sql`${issueRecoveryActions.sourceIssueId}`,
        sourceRunId: heldRunIdSql() }).recent,
      sql`coalesce(${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,kind}', 'exact_recovery_pending') = 'exact_recovery_pending'`,
      sql`not exists (select 1 from ${issueThreadInteractions} question where question.company_id = ${issueRecoveryActions.companyId}
        and question.issue_id = ${issueRecoveryActions.sourceIssueId} and question.status = 'pending')`,
      sql`not exists (select 1 from ${issueApprovals} link join ${approvals} approval on approval.id = link.approval_id
        and approval.company_id = link.company_id where link.company_id = ${issueRecoveryActions.companyId}
        and link.issue_id = ${issueRecoveryActions.sourceIssueId} and approval.status in ('pending', 'revision_requested'))`));
  if (!rows.length) return new Set();
  const candidateIssueIds = [...new Set(rows.map(row => row.issueId))];
  const candidateRunIds = [...new Set(rows.map(row => row.runId))];
  const runKeys = candidateRunIds.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
  if (!runKeys.length) return new Set();
  const [issueRows, runRows, holdRows] = await Promise.all([
    db.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, candidateIssueIds))),
    db.select({ id: heartbeatRuns.id, finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runKeys))),
    db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      inArray(issueRecoveryActions.sourceIssueId, candidateIssueIds), inArray(heldRunIdSql(), candidateRunIds))),
  ]);
  return new Set(rows.filter(row => {
    const issue = issueRows.find(candidate => candidate.id === row.issueId);
    const run = runRows.find(candidate => candidate.id === row.runId);
    if (!issue || !run) return false;
    if (issue.status !== "blocked") return true;
    const holds = holdRows.filter(hold => hold.sourceIssueId === row.issueId
      && (hold.evidence.runId === row.runId || hold.evidence.sourceRunId === row.runId));
    return failureOwnsBlock(holds, issue, run);
  }).map(row => `${row.issueId}:${row.runId}`));
}

/** Held reconciliation records of a task's latest unfinished run (joined to its task). */
export function heldExecutionWhere(options: { includeActive?: boolean } = {}) {
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
      sql`exists (select 1 from ${heartbeatRuns} source where source.company_id = ${issueRecoveryActions.companyId}
        and source.id = ${sourceRunKey(heldRunIdSql())}
        and source.status in ('failed', 'timed_out', 'interrupted', 'cancelled') and source.finished_at is not null
        and source.agent_id = ${issues.assigneeAgentId}
        and not exists (select 1 from ${heartbeatRuns} newer where newer.company_id = source.company_id and newer.id <> source.id
          and (newer.native_issue_id = ${issues.id} or newer.issue_id = ${issues.id} or newer.context_snapshot->>'issueId' = ${issues.id}::text)
          and not ${cancelledAtDispatch("newer")}
          and (newer.status in ('queued', 'running', 'scheduled_retry') or (newer.created_at, newer.id) > (source.created_at, source.id))))`,
  )!;
}

export const heldRunIdSql = () => sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`;
/** The recorded run id as the run's key: the same match as `id::text = text`, but an index lookup. */
export const sourceRunKey = (runId: SQL) => canonicalExecutionUuid(sql`(${runId})::text`);
