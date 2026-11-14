import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issueThreadInteractions, type Db } from "@paperclipai/db";

export const HUMAN_RECOVERY_OWNER_TYPES = ["user", "board"] as const;
const OPEN_RECOVERY_ATTENTION_STATUSES = ["active", "escalated"] as const;

export function recoveryActionAttentionCondition() {
  return and(inArray(issueRecoveryActions.status, [...OPEN_RECOVERY_ATTENTION_STATUSES]),
    inArray(issueRecoveryActions.ownerType, [...HUMAN_RECOVERY_OWNER_TYPES]))!;
}
export const ATTENTION_BUDGET_WARNING_PERCENT = 85;
export const ATTENTION_AGENT_ERROR_STATUS = "error";

function confirmationAudienceKey(row: { issueId: string; addresseeUserId?: string | null; addresseeAgentId?: string | null }) {
  return `${row.issueId}:${row.addresseeUserId ?? ""}:${row.addresseeAgentId ?? ""}`;
}

function payloadFlag(payload: unknown, key: string) {
  return Boolean(payload && typeof payload === "object" && key in payload && (payload as Record<string, unknown>)[key]);
}

/** Payload keys that bind a confirmation to one specific action (tool call, secret, app connection). */
const GOVERNED_CONFIRMATION_PAYLOAD_KEYS = ["toolAction", "secretProposal", "connectionAuthorization"] as const;

/** Governed confirmations gate one action; answering one never answers an ordinary ask, and vice versa. */
function governedAction(payload: unknown) {
  // Truthy, not key presence: the summary read projects absent keys as JSON null.
  return GOVERNED_CONFIRMATION_PAYLOAD_KEYS.some((key) => payloadFlag(payload, key));
}

/**
 * A pending confirmation is superseded once the same issue has a newer
 * ordinary confirmation — pending, or already answered/expired. Without the
 * settled case, answering the newest card (from chat or anywhere else)
 * resurfaces the older ask it replaced. Quality approvals stay
 * independent; tool-action, secret-proposal and app-connection approvals gate
 * one specific action, so they neither hide nor are hidden by a settled
 * confirmation.
 * Only an ask to the same recipient settles it, so one person's answer never
 * hides a request addressed to someone else.
 */
export function collapsePendingConfirmationsToNewest<T extends {
  id: string;
  issueId: string;
  kind: string;
  createdAt: Date;
  payload: unknown;
  addresseeUserId?: string | null;
  addresseeAgentId?: string | null;
}>(rows: T[], newestSettledConfirmationAt: ReadonlyMap<string, Date> = new Map()) {
  const independent = (row: T) => payloadFlag(row.payload, "qualityReview") || governedAction(row.payload);
  const newestByGroup = new Map<string, T>();
  for (const row of rows) {
    if (row.kind !== "request_confirmation" || independent(row)) continue;
    const groupKey = confirmationAudienceKey(row);
    const newest = newestByGroup.get(groupKey);
    if (
      !newest
      || row.createdAt.getTime() > newest.createdAt.getTime()
      || (row.createdAt.getTime() === newest.createdAt.getTime() && row.id > newest.id)
    ) {
      newestByGroup.set(groupKey, row);
    }
  }

  return rows.filter((row) => {
    if (row.kind !== "request_confirmation" || independent(row)) return true;
    if (newestByGroup.get(confirmationAudienceKey(row))?.id !== row.id) return false;
    const settledAt = newestSettledConfirmationAt.get(confirmationAudienceKey(row));
    return !settledAt || settledAt.getTime() <= row.createdAt.getTime();
  });
}

// Cancelled/failed replacements do not settle the ask, so an older card returns.
const SETTLED_CONFIRMATION_STATUSES = ["accepted", "rejected", "answered", "expired"] as const;

/** Newest answered/expired ordinary confirmation per issue and recipient (see the collapse above). */
export async function loadNewestSettledConfirmationAt(db: Db, companyId: string, issueIds: string[]) {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) return new Map<string, Date>();
  const rows = await db.select({
    issueId: issueThreadInteractions.issueId,
    addresseeUserId: issueThreadInteractions.addresseeUserId,
    addresseeAgentId: issueThreadInteractions.addresseeAgentId,
    createdAt: sql<string>`max(${issueThreadInteractions.createdAt})::text`,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId),
    inArray(issueThreadInteractions.issueId, ids),
    eq(issueThreadInteractions.kind, "request_confirmation"),
    inArray(issueThreadInteractions.status, [...SETTLED_CONFIRMATION_STATUSES]),
    sql`jsonb_typeof(${issueThreadInteractions.payload}->'qualityReview') is distinct from 'object'`,
    sql`not (${issueThreadInteractions.payload} ?| array['toolAction', 'secretProposal', 'connectionAuthorization'])`,
  )).groupBy(issueThreadInteractions.issueId, issueThreadInteractions.addresseeUserId, issueThreadInteractions.addresseeAgentId);
  return new Map(rows.map((row) => [confirmationAudienceKey(row), new Date(row.createdAt)]));
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
