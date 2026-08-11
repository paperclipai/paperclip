import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, interruptedRunHandoffs } from "@paperclipai/db";
import type {
  HeartbeatRunStatus,
  InterruptedRunRecovery,
  InterruptedRunRecoveryReceiptOutcome,
  IssueRecoveryAction,
} from "@paperclipai/shared";

const PROCESS_LOSS_MAX_ATTEMPTS = 1;
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const FAILED_SUCCESSOR_STATUSES = ["failed", "interrupted", "cancelled", "timed_out"] as const;
const INTERRUPTION_ERROR_CODES = ["process_lost", "server_shutdown_interrupted"] as const;

const heartbeatRunIssueId = sql<string>`coalesce(
  ${heartbeatRuns.contextSnapshot} ->> 'issueId',
  ${heartbeatRuns.contextSnapshot} ->> 'taskId'
)`;

type RecoveryRun = {
  id: string;
  status: string;
  finishedAt: Date | null;
  errorCode: string | null;
  retryOfRunId: string | null;
  processLossRetryCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type RecoveryReceipt = typeof interruptedRunHandoffs.$inferSelect;

export type InterruptedRunRecoveryIssueInput = {
  id: string;
  status: string;
  activeRecoveryAction?: IssueRecoveryAction | null;
};

function bounded(value: string | null | undefined, max = 120) {
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function receiptOutcome(receipt: RecoveryReceipt): InterruptedRunRecoveryReceiptOutcome {
  if (receipt.reason === "existing_successor_adopted") return "already_exists";
  return receipt.status as InterruptedRunRecoveryReceiptOutcome;
}

function recoveryOwner(
  receipt: RecoveryReceipt | null,
  activeRecoveryAction: IssueRecoveryAction | null,
): InterruptedRunRecovery["owner"] {
  if (activeRecoveryAction) {
    return {
      type: activeRecoveryAction.ownerType,
      agentId: activeRecoveryAction.ownerAgentId,
      userId: activeRecoveryAction.ownerUserId,
    };
  }
  if (!receipt?.ownerAgentId) return null;
  return { type: "agent", agentId: receipt.ownerAgentId, userId: null };
}

function evidenceRedacted(state: InterruptedRunRecovery["state"]): InterruptedRunRecovery {
  return {
    state,
    interruptedRunId: null,
    interruptedAt: null,
    errorCode: null,
    successorRunId: null,
    successorStatus: null,
    receiptId: null,
    receiptOutcome: null,
    suppressionReason: null,
    escalationReason: null,
    attempt: null,
    maxAttempts: null,
    recoveryActionId: null,
    owner: null,
    nextAction: null,
  };
}

export function deriveInterruptedRunRecovery(input: {
  issueStatus: string;
  receipt: RecoveryReceipt | null;
  interruptedRun: RecoveryRun | null;
  successorRun: RecoveryRun | null;
  liveRunId: string | null;
  activeRecoveryAction: IssueRecoveryAction | null;
  evidenceAllowed?: boolean;
}): InterruptedRunRecovery | null {
  if (input.issueStatus === "done" || input.issueStatus === "cancelled") return null;

  const hasActiveRecoveryAction = Boolean(
    input.activeRecoveryAction && ["active", "escalated"].includes(input.activeRecoveryAction.status),
  );
  const successorStatus = input.successorRun?.status as HeartbeatRunStatus | undefined;
  const successorIsLive = Boolean(
    input.successorRun && LIVE_RUN_STATUSES.includes(input.successorRun.status as typeof LIVE_RUN_STATUSES[number]),
  );
  const otherLiveContinuation = Boolean(
    input.liveRunId && input.liveRunId !== input.successorRun?.id,
  );

  let state: InterruptedRunRecovery["state"] | null = null;
  if (hasActiveRecoveryAction) {
    state = "recovery_owner_required";
  } else if (successorIsLive && successorStatus !== "scheduled_retry") {
    state = "recovered";
  } else if (otherLiveContinuation) {
    return null;
  } else if (successorStatus === "scheduled_retry") {
    state = "retry_queued";
  } else if (
    input.successorRun
    && FAILED_SUCCESSOR_STATUSES.includes(input.successorRun.status as typeof FAILED_SUCCESSOR_STATUSES[number])
  ) {
    state = "retry_exhausted";
  } else if (input.receipt?.status === "queued") {
    state = "retry_queued";
  } else if (input.receipt?.status === "running") {
    state = "recovered";
  } else if (input.receipt?.status === "suppressed") {
    state = "suppressed";
  } else if (input.receipt?.status === "escalated") {
    state = "retry_exhausted";
  } else if (input.receipt) {
    return null;
  } else if (input.interruptedRun) {
    state = "pathless";
  }

  if (!state) return null;
  if (input.evidenceAllowed === false) return evidenceRedacted(state);

  const receipt = input.receipt;
  const interruptedRun = input.interruptedRun;
  const successorRun = input.successorRun;
  const attempt = successorRun?.processLossRetryCount ?? interruptedRun?.processLossRetryCount ?? null;
  return {
    state,
    interruptedRunId: interruptedRun?.id ?? null,
    interruptedAt: interruptedRun?.finishedAt ?? interruptedRun?.updatedAt ?? null,
    errorCode: bounded(interruptedRun?.errorCode),
    successorRunId: successorRun?.id ?? receipt?.successorRunId ?? null,
    successorStatus: successorStatus ?? null,
    receiptId: receipt?.id ?? null,
    receiptOutcome: receipt ? receiptOutcome(receipt) : null,
    suppressionReason: receipt?.status === "suppressed" ? bounded(receipt.reason) : null,
    escalationReason:
      receipt?.status === "escalated"
        ? bounded(receipt.reason)
        : successorRun && FAILED_SUCCESSOR_STATUSES.includes(successorRun.status as typeof FAILED_SUCCESSOR_STATUSES[number])
          ? bounded(`successor_${successorRun.status}`)
          : null,
    attempt,
    maxAttempts: receipt || interruptedRun ? PROCESS_LOSS_MAX_ATTEMPTS : null,
    recoveryActionId: input.activeRecoveryAction?.id ?? receipt?.recoveryActionId ?? null,
    owner: recoveryOwner(receipt, input.activeRecoveryAction),
    nextAction: input.activeRecoveryAction?.nextAction ?? null,
  };
}

function firstRunPerIssue(rows: Array<RecoveryRun & { issueId: string | null }>) {
  const result = new Map<string, RecoveryRun>();
  for (const row of rows) {
    if (row.issueId && !result.has(row.issueId)) result.set(row.issueId, row);
  }
  return result;
}

export async function listInterruptedRunRecoveries(
  db: Db,
  companyId: string,
  issues: InterruptedRunRecoveryIssueInput[],
  options?: { evidenceAllowed?: boolean },
): Promise<Map<string, InterruptedRunRecovery>> {
  if (issues.length === 0) return new Map();
  const issueIds = [...new Set(issues.map((issue) => issue.id))];

  const [receiptRows, latestRuns, activeRuns] = await Promise.all([
    db
      .select()
      .from(interruptedRunHandoffs)
      .where(and(
        eq(interruptedRunHandoffs.companyId, companyId),
        inArray(interruptedRunHandoffs.issueId, issueIds),
      ))
      .orderBy(
        interruptedRunHandoffs.issueId,
        desc(interruptedRunHandoffs.updatedAt),
        desc(interruptedRunHandoffs.createdAt),
        desc(interruptedRunHandoffs.id),
      ),
    db
      .selectDistinctOn([heartbeatRunIssueId], {
        issueId: heartbeatRunIssueId,
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        processLossRetryCount: heartbeatRuns.processLossRetryCount,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRunIssueId, issueIds),
      ))
      .orderBy(heartbeatRunIssueId, desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)),
    db
      .selectDistinctOn([heartbeatRunIssueId], {
        issueId: heartbeatRunIssueId,
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        processLossRetryCount: heartbeatRuns.processLossRetryCount,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
        inArray(heartbeatRunIssueId, issueIds),
      ))
      .orderBy(heartbeatRunIssueId, desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)),
  ]);

  const receiptByIssueId = new Map<string, RecoveryReceipt>();
  for (const receipt of receiptRows) {
    if (!receiptByIssueId.has(receipt.issueId)) receiptByIssueId.set(receipt.issueId, receipt);
  }

  const linkedRunIds = [...new Set(receiptRows.flatMap((receipt) => [
    receipt.interruptedRunId,
    receipt.successorRunId,
  ]).filter((id): id is string => Boolean(id)))];
  const linkedRuns = linkedRunIds.length > 0
    ? await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        processLossRetryCount: heartbeatRuns.processLossRetryCount,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.id, linkedRunIds),
      ))
    : [];
  const runById = new Map(linkedRuns.map((run) => [run.id, run]));
  const latestRunByIssueId = firstRunPerIssue(latestRuns);
  const activeRunByIssueId = firstRunPerIssue(activeRuns);
  const output = new Map<string, InterruptedRunRecovery>();

  for (const issue of issues) {
    const receipt = receiptByIssueId.get(issue.id) ?? null;
    const latestRun = latestRunByIssueId.get(issue.id) ?? null;
    const interruptedRun = receipt
      ? runById.get(receipt.interruptedRunId) ?? null
      : latestRun
        && INTERRUPTION_ERROR_CODES.includes(latestRun.errorCode as typeof INTERRUPTION_ERROR_CODES[number])
        && FAILED_SUCCESSOR_STATUSES.includes(latestRun.status as typeof FAILED_SUCCESSOR_STATUSES[number])
          ? latestRun
          : null;
    const successorRun = receipt?.successorRunId
      ? runById.get(receipt.successorRunId) ?? null
      : null;
    const recovery = deriveInterruptedRunRecovery({
      issueStatus: issue.status,
      receipt,
      interruptedRun,
      successorRun,
      liveRunId: activeRunByIssueId.get(issue.id)?.id ?? null,
      activeRecoveryAction: issue.activeRecoveryAction ?? null,
      evidenceAllowed: options?.evidenceAllowed,
    });
    if (recovery) output.set(issue.id, recovery);
  }

  return output;
}
