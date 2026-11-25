import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import type { AttentionItem, AttentionProviderLimit, AttentionRunHistoryEntry } from "@paperclipai/shared";
import { alias } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { attentionIssueCondition } from "./issue-visibility.js";

const taskId = sql<string>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
  ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`;
const account = sql<string | null>`coalesce(nullif(${heartbeatRuns.contextSnapshot}#>>'{aiConnection,subscriptionId}', ''),
  nullif(${heartbeatRuns.contextSnapshot}#>>'{aiConnection,connectionId}', ''))`;

/** A reset or queued retry does not establish recovery. Keep this probe aligned with the attention resumed index. */
export const providerWorkResumed = sql<boolean>`exists(select 1 from heartbeat_runs later where later.company_id = ${heartbeatRuns.companyId}
  and later.created_at > ${heartbeatRuns.createdAt} and later.status in ('running','succeeded')
  and coalesce(later.issue_id::text,later.native_issue_id::text,later.context_snapshot->>'issueId',later.context_snapshot->>'taskId') = ${taskId})`;

export const usageLimitFailure = sql`(${heartbeatRuns.errorCode} in ('provider_limit_wait','native_provider_usage_limit')
  or ${heartbeatRuns.resultJson}#>>'{providerFailure,category}' in ('rate_limit','quota_exhausted'))`;

export async function scheduledProviderWaits(db: Db, companyId: string) {
  const retry = alias(heartbeatRuns, "scheduled_provider_retry");
  const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: agents.id, agentName: agents.name,
    status: heartbeatRuns.status, error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode, account, taskId,
    createdAt: heartbeatRuns.createdAt, updatedAt: heartbeatRuns.updatedAt, finishedAt: heartbeatRuns.finishedAt,
    resetAt: sql<string | null>`coalesce(${heartbeatRuns.resultJson}#>>'{providerLimitWait,resetAt}', ${heartbeatRuns.resultJson}#>>'{providerFailure,retryAt}')`,
    reported: sql<boolean>`case when ${heartbeatRuns.errorCode} = 'provider_limit_wait' then
      ${heartbeatRuns.resultJson}#>>'{providerLimitWait,resetReported}' = 'true' else true end`,
    retryStatus: retry.status, due: retry.scheduledRetryAt }).from(retry)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, retry.retryOfRunId), eq(heartbeatRuns.companyId, companyId)))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
    .where(and(eq(retry.companyId, companyId), inArray(retry.status, ["scheduled_retry", "queued"]), usageLimitFailure,
      sql`coalesce(${retry.issueId}::text, ${retry.nativeIssueId}::text, ${retry.contextSnapshot}->>'issueId',
        ${retry.contextSnapshot}->>'taskId', ${taskId}) = ${taskId}`,
      sql`not ${providerWorkResumed}`));
  return rows.filter(row => row.taskId).map(row => {
    const limit = providerLimitForHold({ ...row, runId: row.id },
      { providerLimitResetAt: row.resetAt, providerLimitAutomatic: true, providerLimitEstimated: !row.reported }, "");
    limit.retryAt = row.due?.toISOString() ?? null;
    if (row.retryStatus === "queued") limit.state = "retry_requested";
    return { ...row, boundTaskId: row.taskId, contextSnapshot: { issueId: row.taskId }, exhaustionMessage: null, limit };
  });
}

/** Some native limit failures never emit a bounded-retry exhaustion receipt. */
export async function recoveredProviderRuns(db: Db, companyId: string, runIds: string[], readCondition: SQL) {
  if (!runIds.length) return [];
  return db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.companyId, companyId), sql`${issues.id}::text = ${taskId}`))
    .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds),
      eq(heartbeatRuns.errorCode, "native_provider_usage_limit"), readCondition,
      or(inArray(issues.status, ["done", "cancelled"]), providerWorkResumed, sql`exists(
        select 1 from ${issueRecoveryActions} hold where hold.company_id = ${heartbeatRuns.companyId}
          and hold.source_issue_id = ${issues.id} and hold.evidence->>'runId' = ${heartbeatRuns.id}::text
          and hold.cause = 'native_provider_usage_limit' and hold.status in ('resolved','cancelled'))`)));
}

export async function providerHoldRuns(db: Db, companyId: string, runIds: string[]) {
  if (!runIds.length) return new Map<string, ProviderRun>();
  const rows = await db.select({ runId: heartbeatRuns.id, agentId: agents.id, agentName: agents.name,
    taskId, account, resumed: providerWorkResumed }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
    .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)));
  return new Map(rows.map(row => [row.runId, row]));
}

type ProviderRun = { runId: string; agentId: string; agentName: string; account: string | null; taskId: string; resumed?: boolean };

export function providerLimitForHold(run: ProviderRun, evidence: Record<string, unknown>, nextAction: string): AttentionProviderLimit {
  const reset = evidence.providerLimitResetAt;
  const resetAt = typeof reset === "string" && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null;
  const resume = evidence.providerLimitResume as { state?: string } | undefined;
  // Older holds persisted the scheduler's promise only in its canonical next action.
  const automatic = evidence.providerLimitAutomatic ?? nextAction.includes("Paperclip will retry this task");
  const state = resume?.state === "requested" ? "retry_requested"
    : !resume && automatic === true ? "scheduled" : "needs_retry";
  const reportedReset = evidence.providerLimitEstimated || nextAction.includes("did not report") ? null : resetAt;
  const sharedWindow = run.account && reportedReset;
  const episode = sharedWindow ? createHash("sha256").update(JSON.stringify([run.account, resetAt])).digest("hex") : episodeForRun(run.runId);
  return { episode, grouping: sharedWindow ? "account_window" : "retry_chain", attempts: 1,
    resetAt: reportedReset, retryAt: state === "scheduled" ? resetAt : null, state, runId: run.runId, agentId: run.agentId, agentName: run.agentName };
}

function episodeForRun(id: string) {
  return createHash("sha256").update(id).digest("hex");
}

function obligationKey(episode: string, audience: AttentionItem["audience"]) {
  return `provider-limit:${episode}:${audience.kind}:${audience.userId ?? ""}`;
}

/** A retry has to link to the same task. A cooldown's source run can belong to a different task. */
export async function attachProviderRetryChains(db: Db, companyId: string, items: AttentionItem[],
  dismissals: ReadonlyMap<string, unknown>) {
  const members = items.filter(item => item.providerLimit?.grouping === "retry_chain");
  const legacyDismissals = new Map<string, string>();
  if (!members.length) return legacyDismissals;
  const ids = [...new Set(members.map(item => item.providerLimit!.runId))];
  // A native retry may bind a durable task retry request without setting retry_of_run_id.
  const rows = await db.execute<{ run_id: string; attempts: string[] }>(sql`
    with recursive chain(run_id, task_id, id, agent_id, parent_id, retry_request_id, path, limited) as (
      select id, ${taskId}, id, agent_id, retry_of_run_id, context_snapshot->>'taskRetryRequestId', array[id], true
      from ${heartbeatRuns}
      where company_id = ${companyId} and ${inArray(heartbeatRuns.id, ids)}
      union all
      select c.run_id, c.task_id, r.id, r.agent_id, r.retry_of_run_id, r.context_snapshot->>'taskRetryRequestId',
        c.path || r.id,
        r.error_code in ('provider_limit_wait','native_provider_usage_limit')
          or r.result_json#>>'{providerFailure,category}' in ('rate_limit','quota_exhausted')
      from chain c
      left join ${agentWakeupRequests} wake on c.parent_id is null
        and wake.company_id = ${companyId} and wake.run_id = c.id and wake.agent_id = c.agent_id
        and wake.id::text = c.retry_request_id and wake.reason = 'task_retry'
        and wake.payload->>'issueId' = c.task_id
        and wake.payload#>>'{taskRetry,schema}' = 'paperclip.task-retry.v1'
        and wake.payload#>>'{taskRetry,generationId}' = c.retry_request_id
      join ${heartbeatRuns} r on r.company_id = ${companyId} and r.id = coalesce(c.parent_id,
        case when wake.payload#>>'{taskRetry,sourceRunId}' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          then (wake.payload#>>'{taskRetry,sourceRunId}')::uuid end)
      where coalesce(r.issue_id::text, r.native_issue_id::text, r.context_snapshot->>'issueId', r.context_snapshot->>'taskId') = c.task_id
        and r.status in ('failed','timed_out','cancelled')
        and not r.id = any(c.path)
    )
    select run_id, array_agg(id order by cardinality(path) desc) as attempts
    from chain where limited group by run_id
  `);
  const byRun = new Map(rows.map(row => [row.run_id, row.attempts]));
  for (const item of members) {
    const limit = item.providerLimit!;
    const attempts = byRun.get(limit.runId);
    if (!attempts?.length) continue;
    limit.episode = episodeForRun(attempts[0]!);
    limit.attempts = attempts.length;

    // Honor a personal archive written for an individual attempt before chain grouping.
    if (!dismissals.size) continue;
    const key = obligationKey(limit.episode, item.audience);
    for (const runId of attempts) {
      const oldKey = `attention:${obligationKey(episodeForRun(runId), item.audience)}`;
      if (dismissals.has(oldKey)) {
        legacyDismissals.set(key, oldKey);
        break;
      }
    }
  }
  return legacyDismissals;
}

/** Group only after task access and personal routing, keeping the dismissal stable as membership changes. */
export function groupProviderLimits(items: AttentionItem[], legacyDismissals?: ReadonlyMap<string, string>) {
  const groups = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (!item.providerLimit) continue;
    const key = obligationKey(item.providerLimit.episode, item.audience);
    const members = groups.get(key) ?? [];
    members.push(item);
    groups.set(key, members);
  }
  for (const [key, members] of groups) {
    let lead = members.find(item => item.providerLimit?.state === "needs_retry") ?? members[0]!;
    if (lead.providerLimit!.grouping === "retry_chain") {
      // Old hold receipts can still be active when the next attempt records its own state.
      for (const item of members) {
        const difference = item.providerLimit!.attempts - lead.providerLimit!.attempts;
        if (difference > 0 || (difference === 0 && item.activityAt > lead.activityAt)) lead = item;
      }
    }
    for (const member of members) {
      member.dismissalKey = legacyDismissals?.get(key) ?? `attention:${key}`;
      member.obligationKey = key;
      member.obligationLeadId = lead.id;
    }
  }
}

/** Only load diagnostic history when opened. Every run must join a task the board actor may read. */
export function attentionRunHistoryQuery(db: Db, companyId: string, readCondition: SQL, before?: { at: string; id: string }) {
  return db.select({ runId: heartbeatRuns.id, agentId: agents.id, agentName: agents.name,
    taskId: issues.id, taskTitle: issues.title, identifier: issues.identifier, status: issues.status,
    holdStatus: issueRecoveryActions.status, recordedAt: sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, code: heartbeatRuns.errorCode,
    resumed: providerWorkResumed })
    .from(heartbeatRuns).innerJoin(issues, and(eq(issues.companyId,companyId), sql`${issues.id}::text = ${taskId}`))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
    .leftJoin(issueRecoveryActions, and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issues.id),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${heartbeatRuns.id}::text`, eq(issueRecoveryActions.cause, "native_provider_usage_limit")))
    .where(and(eq(heartbeatRuns.companyId,companyId),
      sql`(${heartbeatRuns.status} in ('failed', 'timed_out') or ${heartbeatRuns.errorCode} = 'provider_limit_wait')`,
      attentionIssueCondition(), readCondition,
      before ? sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) < (${before.at}::timestamptz, ${before.id}::uuid)` : undefined))
    .orderBy(sql`${heartbeatRuns.createdAt} desc nulls last`, sql`${heartbeatRuns.id} desc nulls last`).limit(100);
}

export async function attentionRunHistory(db: Db, companyId: string, readCondition: SQL,
  before?: { at: string; id: string }): Promise<AttentionRunHistoryEntry[]> {
  const rows = await attentionRunHistoryQuery(db, companyId, readCondition, before);
  return rows.map(({ status, holdStatus, recordedAt, code, resumed, ...row }) => ({ ...row, recordedAt,
    reason: ["native_provider_usage_limit", "provider_limit_wait"].includes(code ?? "") ? "Provider usage limit" : "Failed run",
    outcome: status === "done" ? "Task completed" : status === "cancelled" ? "Task cancelled" : resumed ? "Work resumed"
      : holdStatus === "resolved" ? "Recovery resolved" : "Run recorded" }));
}
