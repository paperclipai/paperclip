import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { agents, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import type { AttentionItem, AttentionProviderLimit, AttentionRunHistoryEntry } from "@paperclipai/shared";
import { alias } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { attentionIssueCondition } from "./issue-visibility.js";

const taskId = sql<string>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
  ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`;
const account = sql<string | null>`coalesce(nullif(${heartbeatRuns.contextSnapshot}#>>'{aiConnection,subscriptionId}', ''),
  nullif(${heartbeatRuns.contextSnapshot}#>>'{aiConnection,connectionId}', ''))`;

/** A reset passing or a retry being queued is not proof that work resumed. */
const resumed = sql<boolean>`exists(select 1 from heartbeat_runs later where later.company_id = ${heartbeatRuns.companyId}
  and later.created_at > ${heartbeatRuns.createdAt} and later.status in ('running','succeeded')
  and coalesce(later.issue_id::text,later.native_issue_id::text,later.context_snapshot->>'issueId',later.context_snapshot->>'taskId') = ${taskId})`;

export async function scheduledProviderWaits(db: Db, companyId: string) {
  const retry = alias(heartbeatRuns, "scheduled_provider_retry");
  const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: agents.id, agentName: agents.name,
    status: heartbeatRuns.status, error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode, account, taskId,
    createdAt: heartbeatRuns.createdAt, updatedAt: heartbeatRuns.updatedAt, finishedAt: heartbeatRuns.finishedAt,
    resetAt: sql<string | null>`${heartbeatRuns.resultJson}#>>'{providerLimitWait,resetAt}'`,
    reported: sql<boolean>`${heartbeatRuns.resultJson}#>>'{providerLimitWait,resetReported}' = 'true'`,
    origin: sql<string | null>`${heartbeatRuns.resultJson}#>>'{providerLimitWait,sourceRunId}'`,
    due: retry.scheduledRetryAt }).from(retry)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, retry.retryOfRunId), eq(heartbeatRuns.companyId, companyId)))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
    .where(and(eq(retry.companyId, companyId), eq(retry.status, "scheduled_retry"), eq(heartbeatRuns.errorCode, "provider_limit_wait"),
      sql`not ${resumed}`));
  return rows.filter(row => row.taskId && row.due).map(row => {
    const limit = providerLimitForHold({ ...row, runId: row.id },
      { providerLimitResetAt: row.resetAt, providerLimitAutomatic: true, providerLimitEstimated: !row.reported }, "");
    if (!row.account && row.origin) limit.episode = createHash("sha256").update(row.origin).digest("hex");
    limit.resetAt = row.due!.toISOString();
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
      or(inArray(issues.status, ["done", "cancelled"]), resumed, sql`exists(
        select 1 from ${issueRecoveryActions} hold where hold.company_id = ${heartbeatRuns.companyId}
          and hold.source_issue_id = ${issues.id} and hold.evidence->>'runId' = ${heartbeatRuns.id}::text
          and hold.cause = 'native_provider_usage_limit' and hold.status in ('resolved','cancelled'))`)));
}

export async function providerHoldRuns(db: Db, companyId: string, runIds: string[]) {
  if (!runIds.length) return new Map<string, ProviderRun>();
  const rows = await db.select({ runId: heartbeatRuns.id, agentId: agents.id, agentName: agents.name,
    taskId, account, resumed }).from(heartbeatRuns)
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
    : !resume && resetAt && automatic === true ? "scheduled" : "needs_retry";
  const sharedWindow = run.account && resetAt && !evidence.providerLimitEstimated && !nextAction.includes("did not report");
  const episode = createHash("sha256").update(sharedWindow ? JSON.stringify([run.account, resetAt]) : run.runId).digest("hex");
  return { episode, resetAt, state, runId: run.runId, agentId: run.agentId, agentName: run.agentName };
}

/** Group only after task access and personal routing, keeping the dismissal stable as membership changes. */
export function groupProviderLimits(items: AttentionItem[]) {
  const groups = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (!item.providerLimit) continue;
    const key = `provider-limit:${item.providerLimit.episode}:${item.audience.kind}:${item.audience.userId ?? ""}`;
    const members = groups.get(key) ?? [];
    members.push(item);
    groups.set(key, members);
  }
  for (const [key, members] of groups) {
    const lead = members.find(item => item.providerLimit?.state === "needs_retry") ?? members[0]!;
    for (const member of members) {
      member.dismissalKey = `attention:${key}`;
      member.obligationKey = key;
      member.obligationLeadId = lead.id;
    }
  }
}

/** Only load diagnostic history when opened. Every run must join a task the board actor may read. */
export async function attentionRunHistory(db: Db, companyId: string, readCondition: SQL,
  before?: { at: string; id: string }): Promise<AttentionRunHistoryEntry[]> {
  const rows = await db.select({ runId: heartbeatRuns.id, agentId: agents.id, agentName: agents.name,
    taskId: issues.id, taskTitle: issues.title, identifier: issues.identifier, status: issues.status,
    holdStatus: issueRecoveryActions.status, recordedAt: sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, code: heartbeatRuns.errorCode,
    resumed })
    .from(heartbeatRuns).innerJoin(issues, and(eq(issues.companyId,companyId), sql`${issues.id}::text = ${taskId}`))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
    .leftJoin(issueRecoveryActions, and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issues.id),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${heartbeatRuns.id}::text`, eq(issueRecoveryActions.cause, "native_provider_usage_limit")))
    .where(and(eq(heartbeatRuns.companyId,companyId), or(inArray(heartbeatRuns.status, ["failed","timed_out"]),
      eq(heartbeatRuns.errorCode,"provider_limit_wait")), attentionIssueCondition(), readCondition,
      before ? sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) < (${before.at}::timestamptz, ${before.id}::uuid)` : undefined))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(100);
  return rows.map(({ status, holdStatus, recordedAt, code, resumed, ...row }) => ({ ...row, recordedAt,
    reason: ["native_provider_usage_limit", "provider_limit_wait"].includes(code ?? "") ? "Provider usage limit" : "Failed run",
    outcome: status === "done" ? "Task completed" : status === "cancelled" ? "Task cancelled" : resumed ? "Work resumed"
      : holdStatus === "resolved" ? "Recovery resolved" : "Run recorded" }));
}
