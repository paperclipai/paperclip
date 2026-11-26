import { issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { and, eq, inArray, or, sql } from "drizzle-orm";

export const ISSUE_MONITOR_DEFERRAL_BASE_DELAY_MS = 30_000;
export const ISSUE_MONITOR_DEFERRAL_MAX_DELAY_MS = 60 * 60_000;
export const ISSUE_MONITOR_DIAGNOSTIC_MIN_QUIET_MS = 5 * 60_000;

export interface IssueMonitorDeferralState {
  nextCheckAt: string;
  deferredCount: number;
  retryAt: string | null;
  recoveryActionId: string | null;
  recoveryActionUpdatedAt: string | null;
  reason: string;
}

const BLANK_EXECUTION_STATE = {
  status: "idle",
  currentStageId: null,
  currentStageIndex: null,
  currentStageType: null,
  currentParticipant: null,
  returnAssignee: null,
  reviewRequest: null,
  completedStageIds: [],
  lastDecisionId: null,
  lastDecisionOutcome: null,
  monitor: null,
};

export function issueMonitorDeferralDelayMs(deferredCount: number): number {
  const exponent = Math.max(0, Math.min(deferredCount - 1, 30));
  return Math.min(
    ISSUE_MONITOR_DEFERRAL_BASE_DELAY_MS * 2 ** exponent,
    ISSUE_MONITOR_DEFERRAL_MAX_DELAY_MS,
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asIsoString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

export function readIssueMonitorDeferral(
  executionState: Record<string, unknown> | null | undefined,
  scheduledAtIso: string,
): IssueMonitorDeferralState | null {
  const raw = asObject(asObject(executionState)?.monitorDeferral);
  if (!raw) return null;
  const nextCheckAt = asIsoString(raw.nextCheckAt);
  if (!nextCheckAt) return null;
  const expectedTime = Date.parse(scheduledAtIso);
  if (Number.isNaN(expectedTime) || Date.parse(nextCheckAt) !== expectedTime) {
    return null;
  }
  const deferredCount =
    typeof raw.deferredCount === "number" &&
    Number.isInteger(raw.deferredCount) &&
    raw.deferredCount >= 0
      ? raw.deferredCount
      : 0;
  const retryAt = asIsoString(raw.retryAt);
  const recoveryActionId =
    typeof raw.recoveryActionId === "string" && raw.recoveryActionId.trim().length > 0
      ? raw.recoveryActionId
      : null;
  const recoveryActionUpdatedAt = asIsoString(raw.recoveryActionUpdatedAt);
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  return {
    nextCheckAt,
    deferredCount,
    retryAt,
    recoveryActionId,
    recoveryActionUpdatedAt,
    reason,
  };
}

export function buildIssueMonitorDeferralState(input: {
  existing: IssueMonitorDeferralState | null;
  scheduledAtIso: string;
  now: Date;
  timeoutAt: Date | null;
  reason: string;
  recoveryHold: { id: string; updatedAtIso: string } | null;
}): { state: IssueMonitorDeferralState; quietWindowMs: number } {
  const deferredCount = (input.existing?.deferredCount ?? 0) + 1;
  if (input.recoveryHold) {
    return {
      state: {
        nextCheckAt: input.scheduledAtIso,
        deferredCount,
        retryAt: null,
        recoveryActionId: input.recoveryHold.id,
        recoveryActionUpdatedAt: input.recoveryHold.updatedAtIso,
        reason: input.reason,
      },
      quietWindowMs: ISSUE_MONITOR_DIAGNOSTIC_MIN_QUIET_MS,
    };
  }

  const delayMs = issueMonitorDeferralDelayMs(deferredCount);
  let retryAtMs = input.now.getTime() + delayMs;
  if (
    input.timeoutAt &&
    input.timeoutAt.getTime() > input.now.getTime() &&
    input.timeoutAt.getTime() < retryAtMs
  ) {
    retryAtMs = input.timeoutAt.getTime();
  }
  return {
    state: {
      nextCheckAt: input.scheduledAtIso,
      deferredCount,
      retryAt: new Date(retryAtMs).toISOString(),
      recoveryActionId: null,
      recoveryActionUpdatedAt: null,
      reason: input.reason,
    },
    quietWindowMs: Math.max(ISSUE_MONITOR_DIAGNOSTIC_MIN_QUIET_MS, delayMs),
  };
}

export function monitorDeferralExecutionStateSql(deferral: IssueMonitorDeferralState) {
  return sql`jsonb_set(
    case when ${issues.executionState} is not null and ${issues.executionState} ? 'status'
      then ${issues.executionState}
      else ${JSON.stringify(BLANK_EXECUTION_STATE)}::jsonb end,
    '{monitorDeferral}',
    ${JSON.stringify(deferral)}::jsonb
  )`;
}

const UUID_REGEX = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const ISO_TS_REGEX = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$";

function deferralMatchesMonitorSql() {
  return sql`coalesce((jsonb_typeof(${issues.executionState}->'monitorDeferral') = 'object'
    and (case
      when (${issues.executionState}->'monitorDeferral'->>'nextCheckAt') ~ ${ISO_TS_REGEX}
      then (${issues.executionState}->'monitorDeferral'->>'nextCheckAt')::timestamptz
      else null
    end) = ${issues.monitorNextCheckAt}), false)`;
}

/**
 * Single-row predicate matching recovery actions that remain effective holds:
 * open (`active`/`escalated`) rows as well as resolved rows that still block
 * execution (`automaticRecovery.replay = 'blocked'` or unreconciled native
 * workspace exports). Admission (`getExecutionBlocker`) already validated this
 * action before parking, so checking the row directly uses the primary-key
 * index without nested `heartbeat_runs` subqueries.
 */
export function parkableRecoveryHoldCondition() {
  return or(
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    and(
      eq(issueRecoveryActions.status, "resolved"),
      eq(issueRecoveryActions.resolutionNote, "new_source_execution_path"),
      sql`${issueRecoveryActions.evidence}->'executionReconciliation'->'workspaceReconstruction' is null`,
    ),
    and(
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->'executionReconciliation'->'workspaceReconstruction'->>'schema' = 'paperclip.workspace-reconstruction.v1'`,
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
    ),
  )!;
}

function parkedOnUnchangedRecoveryHoldSql() {
  return sql`coalesce((${deferralMatchesMonitorSql()}
    and exists (select 1 from ${issueRecoveryActions}
      where ${issueRecoveryActions.id} = (case
          when (${issues.executionState}->'monitorDeferral'->>'recoveryActionId') ~ ${UUID_REGEX}
          then (${issues.executionState}->'monitorDeferral'->>'recoveryActionId')::uuid
          else null
        end)
        and ${issueRecoveryActions.companyId} = ${issues.companyId}
        and ${issueRecoveryActions.sourceIssueId} = ${issues.id}
        and (${parkableRecoveryHoldCondition()})
        and ${issueRecoveryActions.updatedAt} <= (case
          when (${issues.executionState}->'monitorDeferral'->>'recoveryActionUpdatedAt') ~ ${ISO_TS_REGEX}
          then (${issues.executionState}->'monitorDeferral'->>'recoveryActionUpdatedAt')::timestamptz
          else null
        end))), false)`;
}

function nonWakeOwnerTimeoutAtSql() {
  return sql`(case
    when coalesce(${issues.executionPolicy}->'monitor'->>'recoveryPolicy', 'wake_owner') in ('escalate_to_board', 'create_recovery_issue')
      and (${issues.executionPolicy}->'monitor'->>'timeoutAt') ~ ${ISO_TS_REGEX}
    then (${issues.executionPolicy}->'monitor'->>'timeoutAt')::timestamptz
    else null
  end)`;
}

function matchingDeferredRetryAtSql() {
  return sql`(case
    when ${deferralMatchesMonitorSql()}
      and (${issues.executionState}->'monitorDeferral'->>'retryAt') ~ ${ISO_TS_REGEX}
    then (${issues.executionState}->'monitorDeferral'->>'retryAt')::timestamptz
    else null
  end)`;
}

/**
 * Excludes scheduled monitors that are either parked on an unchanged active
 * execution-reconciliation hold (unless a non-wake_owner timeoutAt is now due)
 * or waiting out their exponential deferral backoff window.
 */
export function eligibleDeferredMonitorCondition(now: Date) {
  const nowIso = now.toISOString();
  const parked = parkedOnUnchangedRecoveryHoldSql();
  const nonWakeTimeout = nonWakeOwnerTimeoutAtSql();
  const retryAt = matchingDeferredRetryAtSql();
  return sql`((not ${parked} and (${retryAt} is null or ${retryAt} <= ${nowIso}::timestamptz))
    or (${parked} and ${nonWakeTimeout} is not null and ${nonWakeTimeout} <= ${nowIso}::timestamptz))`;
}

export function nextIssueMonitorWhereCondition() {
  return sql`(not ${parkedOnUnchangedRecoveryHoldSql()} or ${nonWakeOwnerTimeoutAtSql()} is not null)`;
}

export async function resolveScheduledMonitorDeferralUpdate(
  tx: Pick<Db, "select">,
  input: {
    companyId: string;
    issueId: string;
    executionState: Record<string, unknown> | null;
    scheduledAtIso: string;
    now: Date;
    activitySource: "manual" | "scheduled";
    reason: string;
    blockerRecoveryActionId?: string | null;
    timeoutAt?: Date | null;
  },
): Promise<{ patch: Record<string, unknown>; quietWindowMs: number }> {
  if (input.activitySource !== "scheduled") {
    return {
      patch: { monitorWakeRequestedAt: null },
      quietWindowMs: ISSUE_MONITOR_DIAGNOSTIC_MIN_QUIET_MS,
    };
  }
  let recoveryHold: { id: string; updatedAtIso: string } | null = null;
  if (input.blockerRecoveryActionId && isUuidLike(input.blockerRecoveryActionId)) {
    const [hold] = await tx.select({
      id: issueRecoveryActions.id,
      updatedAtIso: sql<string>`to_char(${issueRecoveryActions.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.id, input.blockerRecoveryActionId),
      parkableRecoveryHoldCondition(),
    )).limit(1);
    if (hold) recoveryHold = hold;
  }
  const { state, quietWindowMs } = buildIssueMonitorDeferralState({
    existing: readIssueMonitorDeferral(input.executionState, input.scheduledAtIso),
    scheduledAtIso: input.scheduledAtIso,
    now: input.now,
    timeoutAt: input.timeoutAt ?? null,
    reason: input.reason,
    recoveryHold,
  });
  return {
    patch: {
      monitorWakeRequestedAt: null,
      executionState: monitorDeferralExecutionStateSql(state),
    },
    quietWindowMs,
  };
}

export function nextIssueMonitorAtSelectSql() {
  const parked = parkedOnUnchangedRecoveryHoldSql();
  const nonWakeTimeout = nonWakeOwnerTimeoutAtSql();
  const retryAt = matchingDeferredRetryAtSql();
  return sql<string | null>`min(case
    when ${parked}
    then greatest(${nonWakeTimeout}, ${issues.monitorWakeRequestedAt} + interval '5 minutes' + interval '1 millisecond')
    else greatest(${issues.monitorNextCheckAt}, ${retryAt}, ${issues.monitorWakeRequestedAt} + interval '5 minutes' + interval '1 millisecond')
  end)`;
}
