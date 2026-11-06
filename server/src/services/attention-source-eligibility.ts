import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";

export const HUMAN_RECOVERY_OWNER_TYPES = ["user", "board"] as const;
const OPEN_RECOVERY_ATTENTION_STATUSES = ["active", "escalated"] as const;

export function recoveryActionAttentionCondition() {
  return and(inArray(issueRecoveryActions.status, [...OPEN_RECOVERY_ATTENTION_STATUSES]),
    inArray(issueRecoveryActions.ownerType, [...HUMAN_RECOVERY_OWNER_TYPES]))!;
}
export const ATTENTION_BUDGET_WARNING_PERCENT = 85;
export const ATTENTION_AGENT_ERROR_STATUS = "error";

export function collapsePendingConfirmationsToNewest<T extends {
  id: string;
  issueId: string;
  kind: string;
  createdAt: Date;
  payload: unknown;
}>(rows: T[]) {
  const independent = (row: T) => Boolean(row.payload && typeof row.payload === "object" && "qualityReview" in row.payload && row.payload.qualityReview);
  const newestByGroup = new Map<string, T>();
  for (const row of rows) {
    if (row.kind !== "request_confirmation" || independent(row)) continue;
    const groupKey = `${row.issueId}:${row.kind}`;
    const newest = newestByGroup.get(groupKey);
    if (
      !newest
      || row.createdAt.getTime() > newest.createdAt.getTime()
      || (row.createdAt.getTime() === newest.createdAt.getTime() && row.id > newest.id)
    ) {
      newestByGroup.set(groupKey, row);
    }
  }

  return rows.filter((row) => (
    row.kind !== "request_confirmation"
    || independent(row)
    || newestByGroup.get(`${row.issueId}:${row.kind}`)?.id === row.id
  ));
}

export function readRunIssueId(contextSnapshot: Record<string, unknown> | null) {
  const issueId = contextSnapshot?.issueId ?? contextSnapshot?.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

type FailedRunProbe = { id: string; agentId: string; issueId: string | null; createdAt: Date };

const FAILED_RUN_PROBE_BATCH_SIZE = 1000;

export async function listFailedRunsWithNewerRun(db: Db, companyId: string, failedRuns: FailedRunProbe[]) {
  const withNewerRun = new Set<string>();
  const keyed = failedRuns.filter(run => run.issueId !== null);
  for (let start = 0; start < keyed.length; start += FAILED_RUN_PROBE_BATCH_SIZE) {
    const batch = keyed.slice(start, start + FAILED_RUN_PROBE_BATCH_SIZE);
    for (const id of await listFailedRunBatchWithNewerRun(db, companyId, batch)) withNewerRun.add(id);
  }
  const unkeyed = failedRuns.filter(run => run.issueId === null);
  if (unkeyed.length === 0) return withNewerRun;
  const agentIds = [...new Set(unkeyed.map(run => run.agentId))];
  const oldestCreatedAt = unkeyed.reduce((oldest, run) => run.createdAt < oldest ? run.createdAt : oldest,
    unkeyed[0]!.createdAt);
  const latestByAgent = new Map<string, Date>();
  for (let start = 0; start < agentIds.length; start += FAILED_RUN_PROBE_BATCH_SIZE) {
    const rows = await db.select({
      agentId: heartbeatRuns.agentId,
      createdAt: sql<Date>`max(${heartbeatRuns.createdAt})`.mapWith(heartbeatRuns.createdAt),
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.agentId, agentIds.slice(start, start + FAILED_RUN_PROBE_BATCH_SIZE)),
      gt(heartbeatRuns.createdAt, oldestCreatedAt),
      sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId', '') = ''`,
    )).groupBy(heartbeatRuns.agentId);
    for (const row of rows) latestByAgent.set(row.agentId, row.createdAt);
  }
  for (const run of unkeyed) {
    if ((latestByAgent.get(run.agentId)?.getTime() ?? 0) > run.createdAt.getTime()) withNewerRun.add(run.id);
  }
  return withNewerRun;
}

async function listFailedRunBatchWithNewerRun(db: Db, companyId: string, failedRuns: FailedRunProbe[]) {
  if (failedRuns.length === 0) return [];
  const failed = sql.join(
    failedRuns.map((run) => sql`(${run.id}::uuid, ${run.agentId}::uuid, ${run.issueId}::text, ${new Date(run.createdAt.getTime() + 1).toISOString()}::timestamptz)`),
    sql`, `,
  );
  const runIssueId = sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId')`;
  const runTaskId = sql`(${heartbeatRuns.contextSnapshot} ->> 'taskId')`;
  const newerRunExists = (match: SQL) => sql`exists (
    select 1 from ${heartbeatRuns}
    where ${heartbeatRuns.companyId} = ${companyId}
      and ${heartbeatRuns.agentId} = failed.agent_id
      and ${heartbeatRuns.createdAt} >= failed.newer_from
      and ${match}
  )`;
  const rows = await db.execute(sql`
    select failed.id
    from (values ${failed}) as failed (id, agent_id, issue_id, newer_from)
    where ${newerRunExists(sql`${runIssueId} = failed.issue_id`)}
      or ${newerRunExists(sql`${runTaskId} = failed.issue_id and ${runIssueId} is null`)}
  `) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}


export function requiresReviewAttention(input: {
  hasHumanParticipant: boolean; hasUserAssignee: boolean; hasPendingApproval: boolean; stalled: boolean;
}) {
  return input.hasHumanParticipant || input.hasUserAssignee || input.hasPendingApproval || input.stalled;
}

export function terminalBlockerRequiresAttention<T extends { state?: string; blockingTreeLive?: boolean }>(
  attention: T | null | undefined,
): attention is T & { state: "stalled" | "needs_attention" } {
  return Boolean(attention && !attention.blockingTreeLive && ["stalled", "needs_attention"].includes(attention.state ?? ""));
}
