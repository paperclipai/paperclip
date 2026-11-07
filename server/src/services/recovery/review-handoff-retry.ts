import { and, desc, eq, inArray, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { isUniqueViolation } from "../../db-errors.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
import { withRecoveryContext } from "./status-only-context.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { notifyIssueRecovery } from "../issue-recovery-notifications.js";

export const DEFAULT_MAX_REVIEW_HANDOFF_ATTEMPTS = 3;
const REVIEW_HANDOFF_RETRY_IDEMPOTENCY_PREFIX = "review-handoff:";
export const EXECUTION_REVIEW_REQUESTED_REASON = "execution_review_requested";
export const EXECUTION_APPROVAL_REQUESTED_REASON = "execution_approval_requested";
const REVIEW_HANDOFF_RETRY_IDEMPOTENCY_INDEX =
  "agent_wakeup_requests_review_handoff_retry_idempotency_uq";
const REVIEW_HANDOFF_EXHAUSTED_CAUSE = "execution_recovery_budget_exhausted";
export const REVIEW_HANDOFF_REFUSED_RETRY_DELAY_MS = 30_000;

function buildReviewHandoffRetryFingerprint(input: {
  issueId: string;
  stageId: string;
}): string {
  return `${REVIEW_HANDOFF_RETRY_IDEMPOTENCY_PREFIX}${input.issueId}:${input.stageId}`;
}

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;

type PendingReviewStageTarget = {
  stageId: string;
  stageType: "review" | "approval";
  reviewerAgentId: string;
  executionState: ParsedExecutionState;
};

type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  reviewRequest: ParsedExecutionState["reviewRequest"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};

export function buildReviewHandoffRetryIdempotencyKeyPrefix(input: {
  issueId: string;
  stageId: string;
}): string {
  return `${REVIEW_HANDOFF_RETRY_IDEMPOTENCY_PREFIX}${input.issueId}:${input.stageId}:`;
}

export function buildReviewHandoffRetryIdempotencyKey(input: {
  issueId: string;
  stageId: string;
  attempt: number;
}): string {
  return `${buildReviewHandoffRetryIdempotencyKeyPrefix(input)}${input.attempt}`;
}

export function isReviewHandoffRetryIdempotencyConflict(error: unknown): boolean {
  return isUniqueViolation(error, REVIEW_HANDOFF_RETRY_IDEMPOTENCY_INDEX);
}

export function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

export function getPendingReviewStageTarget(issue: {
  status: string;
  executionState: unknown;
}): PendingReviewStageTarget | null {
  if (issue.status !== "in_review") return null;
  const executionState = parseIssueExecutionState(issue.executionState);
  if (!executionState || executionState.status !== "pending") return null;
  if (!executionState.currentStageId) return null;
  if (
    executionState.currentParticipant?.type !== "agent" ||
    !executionState.currentParticipant.agentId
  ) {
    return null;
  }
  const stageType =
    executionState.currentStageType === "approval" ? "approval" : "review";
  return {
    stageId: executionState.currentStageId,
    stageType,
    reviewerAgentId: executionState.currentParticipant.agentId,
    executionState,
  };
}

async function hasValidReviewBlocker(
  db: Db,
  issue: {
    id: string;
    companyId: string;
  },
  treeControlSvc?: Parameters<typeof isAutomaticRecoverySuppressedByPauseHold>[3],
): Promise<{ hasBlocker: boolean; reason: string | null }> {
  const [unresolvedBlocker] = await db
    .select({ id: issues.id, status: issues.status })
    .from(issueRelations)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueRelations.companyId),
        eq(issues.id, issueRelations.issueId),
      ),
    )
    .where(
      and(
        eq(issueRelations.companyId, issue.companyId),
        eq(issueRelations.relatedIssueId, issue.id),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, ["done", "cancelled"]),
        sql`${issues.hiddenAt} is null`,
      ),
    )
    .limit(1);
  if (unresolvedBlocker) {
    return {
      hasBlocker: true,
      reason: `unresolved_dependency:${unresolvedBlocker.id}`,
    };
  }

  const executionBlocker = await getExecutionBlocker(
    db,
    issue.companyId,
    issue.id,
  );
  if (executionBlocker) {
    return {
      hasBlocker: true,
      reason: `execution_blocker:${executionBlocker.cause}`,
    };
  }

  if (
    await isAutomaticRecoverySuppressedByPauseHold(
      db,
      issue.companyId,
      issue.id,
      treeControlSvc,
    )
  ) {
    return { hasBlocker: true, reason: "pause_hold_active" };
  }

  return { hasBlocker: false, reason: null };
}

async function hasActiveReviewRun(
  db: Db,
  companyId: string,
  issueId: string,
  agentId: string,
): Promise<boolean> {
  const [activeRun] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      ),
    )
    .limit(1);
  return Boolean(activeRun);
}

async function hasQueuedReviewWake(
  db: Db,
  companyId: string,
  issueId: string,
  stageId: string,
  reviewerAgentId: string,
): Promise<boolean> {
  const keyPrefix = buildReviewHandoffRetryIdempotencyKeyPrefix({ issueId, stageId });
  const [queuedWake] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        or(
          sql`${agentWakeupRequests.idempotencyKey} LIKE ${`${keyPrefix}%`}`,
          and(
            eq(agentWakeupRequests.agentId, reviewerAgentId),
            sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
            sql`${agentWakeupRequests.payload}->'executionStage'->>'stageId' = ${stageId}`,
          ),
        ),
        inArray(agentWakeupRequests.status, [
          "queued",
          "deferred_issue_execution",
        ]),
      ),
    )
    .limit(1);
  return Boolean(queuedWake);
}

async function getReviewHandoffAttemptLedger(
  db: Db,
  companyId: string,
  issueId: string,
  stageId: string,
): Promise<{ lastAttempt: number; used: number; lastRefusedAt: Date | null }> {
  const keyPrefix = buildReviewHandoffRetryIdempotencyKeyPrefix({ issueId, stageId });
  const [[closedEscalation], rows] = await Promise.all([
    db
      .select({ resolvedAt: issueRecoveryActions.resolvedAt })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
          eq(issueRecoveryActions.cause, REVIEW_HANDOFF_EXHAUSTED_CAUSE),
          eq(issueRecoveryActions.fingerprint, buildReviewHandoffRetryFingerprint({ issueId, stageId })),
          isNotNull(issueRecoveryActions.resolvedAt),
        ),
      )
      .orderBy(desc(issueRecoveryActions.resolvedAt))
      .limit(1),
    db
      .select({
        payload: agentWakeupRequests.payload,
        status: agentWakeupRequests.status,
        createdAt: agentWakeupRequests.createdAt,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.idempotencyKey} LIKE ${`${keyPrefix}%`}`,
        ),
      ),
  ]);

  const budgetStartedAt = closedEscalation?.resolvedAt ?? null;
  let lastAttempt = 0;
  let attemptsBeforeBudget = 0;
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown> | null;
    const attempt = Number(payload?.reviewHandoffAttempt ?? 0);
    if (!Number.isFinite(attempt)) continue;
    if (attempt > lastAttempt) lastAttempt = attempt;
    if (budgetStartedAt && row.createdAt <= budgetStartedAt && attempt > attemptsBeforeBudget) {
      attemptsBeforeBudget = attempt;
    }
  }
  let lastRefusedAt: Date | null = null;
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown> | null;
    if (row.status !== SKIPPED_WAKE_STATUS) continue;
    if (Number(payload?.reviewHandoffAttempt ?? 0) !== lastAttempt) continue;
    if (!lastRefusedAt || row.createdAt > lastRefusedAt) lastRefusedAt = row.createdAt;
  }
  return { lastAttempt, used: lastAttempt - attemptsBeforeBudget, lastRefusedAt };
}

async function recordRefusedReviewHandoffAttempt(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    idempotencyKey: string;
    reason: string;
    payload: Record<string, unknown>;
  },
): Promise<Date> {
  return db.transaction(async (tx) => {
    const [recorded] = await tx.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      status: SKIPPED_WAKE_STATUS,
      payload: input.payload,
      requestedByActorType: "system",
      idempotencyKey: input.idempotencyKey,
      finishedAt: new Date(),
    }).returning({ createdAt: agentWakeupRequests.createdAt });
    // The refused attempt leaves an obligation: recovery must register its retry deadline.
    await notifyIssueRecovery(tx, { companyId: input.companyId, issueId: input.issueId });
    return recorded.createdAt;
  });
}

async function getReviewHandoffWakeReceipts(
  db: Db,
  companyId: string,
  idempotencyKey: string,
): Promise<Array<{ status: string; createdAt: Date }>> {
  return db
    .select({ status: agentWakeupRequests.status, createdAt: agentWakeupRequests.createdAt })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ),
    );
}

type ReviewHandoffRetryDecision =
  | {
      kind: "skip";
      reason: string;
    }
  | {
      kind: "exhausted";
      reason: string;
      stageId: string;
      stageType: "review" | "approval";
      reviewerAgentId: string;
      attemptsUsed: number;
      maxAttempts: number;
    }
  | {
      kind: "enqueue";
      targetAgentId: string;
      idempotencyKey: string;
      reason: string;
      attempt: number;
      maxAttempts: number;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    };

type DecideReviewHandoffRetryParams = {
  target: PendingReviewStageTarget | null;
  issue: {
    id: string;
    companyId: string;
    identifier?: string | null;
    assigneeAgentId?: string | null;
  };
  hasBlocker: boolean;
  blockerReason: string | null;
  hasActiveRun: boolean;
  hasQueuedWake: boolean;
  attemptCount: number;
  lastAttempt?: number;
  maxAttempts?: number;
};

export function decideReviewHandoffRetry(input: DecideReviewHandoffRetryParams): ReviewHandoffRetryDecision {
  const { target, issue, hasBlocker, blockerReason, hasActiveRun, hasQueuedWake } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_REVIEW_HANDOFF_ATTEMPTS;

  if (!target) {
    return {
      kind: "skip",
      reason: "issue is not in_review with a pending agent review stage",
    };
  }

  if (hasActiveRun) {
    return { kind: "skip", reason: "active review run already exists" };
  }

  if (hasQueuedWake) {
    return { kind: "skip", reason: "durable review retry already queued" };
  }

  if (hasBlocker) {
    return {
      kind: "skip",
      reason: `issue has valid blocker: ${blockerReason ?? "unresolved"}`,
    };
  }

  if (input.attemptCount >= maxAttempts) {
    return {
      kind: "exhausted",
      reason: `review handoff retries exhausted (${input.attemptCount}/${maxAttempts})`,
      stageId: target.stageId,
      stageType: target.stageType,
      reviewerAgentId: target.reviewerAgentId,
      attemptsUsed: input.attemptCount,
      maxAttempts,
    };
  }

  const nextAttempt = (input.lastAttempt ?? input.attemptCount) + 1;
  const idempotencyKey = buildReviewHandoffRetryIdempotencyKey({
    issueId: issue.id,
    stageId: target.stageId,
    attempt: nextAttempt,
  });
  const reason =
    target.stageType === "approval"
      ? EXECUTION_APPROVAL_REQUESTED_REASON
      : EXECUTION_REVIEW_REQUESTED_REASON;

  const executionStage = buildExecutionStageWakeContext({
    state: target.executionState,
    wakeRole: target.stageType === "approval" ? "approver" : "reviewer",
    allowedActions: ["approve", "request_changes"],
  });

  const payload = withRecoveryContext(
    {
      issueId: issue.id,
      mutation: "update",
      executionStage,
      reviewHandoffAttempt: nextAttempt,
      maxReviewHandoffAttempts: maxAttempts,
    },
    "normal_model",
  );

  const contextSnapshot = withRecoveryContext(
    {
      issueId: issue.id,
      taskId: issue.id,
      wakeReason: reason,
      source: "issue.review_handoff_retry",
      currentStageId: target.stageId,
      executionStage,
      reviewHandoffAttempt: nextAttempt,
      maxReviewHandoffAttempts: maxAttempts,
    },
    "normal_model",
  );

  return {
    kind: "enqueue",
    targetAgentId: target.reviewerAgentId,
    idempotencyKey,
    reason,
    attempt: nextAttempt,
    maxAttempts,
    payload,
    contextSnapshot,
  };
}

async function escalateReviewHandoffExhaustion(
  db: Db,
  input: {
    companyId: string;
    issue: {
      id: string;
      identifier?: string | null;
      assigneeAgentId?: string | null;
    };
    stageId: string;
    stageType: "review" | "approval";
    reviewerAgentId: string;
    attemptsUsed: number;
    maxAttempts: number;
  },
) {
  const nextAction = `Automatic review handoff retries exhausted (${input.attemptsUsed}/${input.maxAttempts}) for this ${input.stageType} stage. Verify reviewer availability and explicitly reassign or trigger the review.`;

  return issueRecoveryActionService(db).upsertSourceScoped({
    companyId: input.companyId,
    sourceIssueId: input.issue.id,
    kind: "stranded_assigned_issue",
    ownerType: "board",
    returnOwnerAgentId: input.reviewerAgentId ?? input.issue.assigneeAgentId ?? null,
    cause: REVIEW_HANDOFF_EXHAUSTED_CAUSE,
    fingerprint: buildReviewHandoffRetryFingerprint({
      issueId: input.issue.id,
      stageId: input.stageId,
    }),
    evidence: {
      issueId: input.issue.id,
      stageId: input.stageId,
      stageType: input.stageType,
      reviewerAgentId: input.reviewerAgentId,
      attemptsUsed: input.attemptsUsed,
      maxAttempts: input.maxAttempts,
    },
    nextAction,
    attemptCount: input.attemptsUsed,
    maxAttempts: input.maxAttempts,
    supersedeOnIdentityChange: true,
  });
}

type ReviewHandoffWake = { id: string } | null;

type ReviewHandoffEnqueueWakeup = (
  agentId: string,
  request: {
    source: "assignment" | "automation" | "timer" | "on_demand";
    triggerDetail?: "system";
    reason: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string | null;
    requestedByActorType?: "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<ReviewHandoffWake>;

type ReviewHandoffReconciliationResult = {
  action: "enqueued" | "exhausted" | "skipped";
  reason?: string;
  wake?: ReviewHandoffWake;
  recoveryActionId?: string;
  retryAt?: number;
};

export const REVIEW_HANDOFF_COALESCED_REASON =
  "durable review retry already queued for this attempt";
export const REVIEW_HANDOFF_REFUSED_REASON =
  "wake refused; this attempt is recorded and counts toward the retry budget";
export const REVIEW_HANDOFF_NO_RECEIPT_REASON =
  "wake persisted no receipt for this attempt";
export const REVIEW_HANDOFF_REFUSED_RETRY_PENDING_REASON =
  "previous attempt was refused; the next attempt waits for its retry deadline";
const SKIPPED_WAKE_STATUS = "skipped";

export async function reconcileReviewHandoffAfterBlockerClear(
  db: Db,
  input: {
    issueId: string;
    companyId: string;
    enqueueWakeup: ReviewHandoffEnqueueWakeup;
    treeControlSvc?: Parameters<typeof isAutomaticRecoverySuppressedByPauseHold>[3];
    deferRefusedRetry?: boolean;
  },
): Promise<ReviewHandoffReconciliationResult> {
  const [issue] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(
      and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.companyId),
        sql`${issues.hiddenAt} is null`,
      ),
    );

  if (!issue || issue.status !== "in_review") {
    return { action: "skipped", reason: "issue not in_review" };
  }

  const target = getPendingReviewStageTarget(issue);
  if (!target) {
    return { action: "skipped", reason: "no pending review stage target" };
  }

  const [blockerCheck, hasActive, hasQueued, ledger] = await Promise.all([
    hasValidReviewBlocker(db, issue, input.treeControlSvc),
    hasActiveReviewRun(db, issue.companyId, issue.id, target.reviewerAgentId),
    hasQueuedReviewWake(db, issue.companyId, issue.id, target.stageId, target.reviewerAgentId),
    getReviewHandoffAttemptLedger(db, issue.companyId, issue.id, target.stageId),
  ]);

  const decision = decideReviewHandoffRetry({
    target,
    issue,
    hasBlocker: blockerCheck.hasBlocker,
    blockerReason: blockerCheck.reason,
    hasActiveRun: hasActive,
    hasQueuedWake: hasQueued,
    attemptCount: ledger.used,
    lastAttempt: ledger.lastAttempt,
    maxAttempts: DEFAULT_MAX_REVIEW_HANDOFF_ATTEMPTS,
  });

  if (decision.kind === "exhausted") {
    const action = await escalateReviewHandoffExhaustion(db, {
      companyId: issue.companyId,
      issue,
      stageId: decision.stageId,
      stageType: decision.stageType,
      reviewerAgentId: decision.reviewerAgentId,
      attemptsUsed: decision.attemptsUsed,
      maxAttempts: decision.maxAttempts,
    });
    return {
      action: "exhausted",
      reason: decision.reason,
      recoveryActionId: action.id,
    };
  }

  if (decision.kind === "skip") {
    return { action: "skipped", reason: decision.reason };
  }

  if (input.deferRefusedRetry && ledger.lastRefusedAt) {
    const retryAt = ledger.lastRefusedAt.getTime() + REVIEW_HANDOFF_REFUSED_RETRY_DELAY_MS;
    if (Date.now() < retryAt) {
      return { action: "skipped", reason: REVIEW_HANDOFF_REFUSED_RETRY_PENDING_REASON, retryAt };
    }
  }

  let wake: ReviewHandoffWake = null;
  try {
    wake = await input.enqueueWakeup(decision.targetAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: decision.reason,
      payload: decision.payload,
      idempotencyKey: decision.idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: decision.contextSnapshot,
    });
  } catch (error) {
    if (isReviewHandoffRetryIdempotencyConflict(error)) {
      return { action: "skipped", reason: REVIEW_HANDOFF_COALESCED_REASON };
    }
    await recordRefusedReviewHandoffAttempt(db, {
      companyId: issue.companyId,
      issueId: issue.id,
      agentId: decision.targetAgentId,
      idempotencyKey: decision.idempotencyKey,
      reason: decision.reason,
      payload: decision.payload,
    }).catch(() => undefined);
    throw error;
  }

  const receipts = await getReviewHandoffWakeReceipts(
    db,
    issue.companyId,
    decision.idempotencyKey,
  );
  if (receipts.some((receipt) => receipt.status !== SKIPPED_WAKE_STATUS)) {
    return { action: "enqueued", wake };
  }
  if (receipts.length > 0) {
    await db.transaction((tx) =>
      notifyIssueRecovery(tx, { companyId: issue.companyId, issueId: issue.id }),
    );
    const refusedAt = Math.max(...receipts.map((receipt) => receipt.createdAt.getTime()));
    return {
      action: "skipped",
      reason: REVIEW_HANDOFF_REFUSED_REASON,
      retryAt: refusedAt + REVIEW_HANDOFF_REFUSED_RETRY_DELAY_MS,
    };
  }
  const refusedAt = await recordRefusedReviewHandoffAttempt(db, {
    companyId: issue.companyId,
    issueId: issue.id,
    agentId: decision.targetAgentId,
    idempotencyKey: decision.idempotencyKey,
    reason: decision.reason,
    payload: decision.payload,
  });
  return {
    action: "skipped",
    reason: REVIEW_HANDOFF_NO_RECEIPT_REASON,
    retryAt: refusedAt.getTime() + REVIEW_HANDOFF_REFUSED_RETRY_DELAY_MS,
  };
}
