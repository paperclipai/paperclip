import { and, asc, desc, eq, gt, inArray, isNull, like, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { readProviderFailure } from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { isProvenTurnSettlement, TURN_SETTLED_EVENTS, TURN_STARTED_EVENTS } from "../heartbeat/restart-interrupted-turn.js";
import { parseProviderQuotaClockReset } from "../provider-quota-reset.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { requestTaskRetry } from "../task-retry.js";

/** The chat service's Retry callback, which a connected conversation's Retry needs. */
export type PrepareChatRetry = NonNullable<Parameters<typeof requestTaskRetry>[0]["prepareChatRetry"]>;

/**
 * A native run whose provider ended its turn because the account's usage limit
 * ran out. When the provider reported when the limit resets, Paperclip asks for
 * the task's Retry itself at that time, as the accountable user would. Retry
 * admission keeps every gate (stop proof, saved work, action reconciliation),
 * so this never starts work a user's own Retry could not.
 */
export const NATIVE_PROVIDER_USAGE_LIMIT = "native_provider_usage_limit";
/** Longer than a weekly limit's reset, so the reset is the only wait. */
export const PROVIDER_LIMIT_RESUME_MAX_WAIT_MS = 8 * 24 * 60 * 60_000;
/** A reset older than this belongs to an incident nobody is waiting on. */
const STALE_RESET_MS = 24 * 60 * 60_000;
/** Automatic Retries in a row without a successful run between them. */
const MAX_AUTOMATIC_RESUMES = 3;
export const PROVIDER_LIMIT_RESUME_KEY_PREFIX = "provider-limit-reset:";
const LIMIT_CATEGORIES = ["rate_limit", "quota_exhausted"];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The provider-reported failure on a settled turn event, raw or PRP-wrapped. */
function providerFailureOf(payload: unknown) {
  const direct = asRecord(asRecord(payload).error).providerFailure;
  const wrapped = asRecord(asRecord(asRecord(asRecord(payload).prpEvent).payload).error).providerFailure;
  return readProviderFailure(direct) ?? readProviderFailure(wrapped);
}

export type ProviderLimitReset = {
  resetAt: Date; observedAt: Date;
  /** False for a reset further out than Paperclip waits by itself (a monthly limit). */
  withinAutomaticWait: boolean;
};

/**
 * When the provider said the usage limit resets, from the run's own durable
 * events. Null unless the last turn event is a provider-observed settlement
 * reporting an exhausted allowance with a reset after it.
 */
export async function readNativeUsageLimitReset(
  db: Pick<Db, "select">,
  run: { id: string; companyId: string },
): Promise<ProviderLimitReset | null> {
  const [lastTurn] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload,
    createdAt: heartbeatRunEvents.createdAt })
    .from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      inArray(heartbeatRunEvents.eventType, [...TURN_STARTED_EVENTS, ...TURN_SETTLED_EVENTS]),
    )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  // An unsettled or unobserved turn may still be working: its outcome is unknown.
  if (!lastTurn || lastTurn.eventType !== "turn.failed" || !isProvenTurnSettlement(lastTurn)) return null;
  const failure = providerFailureOf(lastTurn.payload);
  if (!failure || !LIMIT_CATEGORIES.includes(failure.category)) return null;
  const observedAt = lastTurn.createdAt;
  const typed = failure.retryAt ? new Date(failure.retryAt) : null;
  const resetAt = typed && Number.isFinite(typed.getTime()) ? typed : parseProviderQuotaClockReset(failure.message, observedAt);
  if (!resetAt || resetAt.getTime() <= observedAt.getTime()) return null;
  return { resetAt, observedAt,
    withinAutomaticWait: resetAt.getTime() - observedAt.getTime() <= PROVIDER_LIMIT_RESUME_MAX_WAIT_MS };
}

/** The user whose authority Retry uses: the requester, else the run's accountable user. */
async function accountableUser(db: Pick<Db, "select">, run: typeof heartbeatRuns.$inferSelect) {
  const [wake] = run.wakeupRequestId ? await db.select({ type: agentWakeupRequests.requestedByActorType,
    id: agentWakeupRequests.requestedByActorId }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId))) : [];
  if (wake?.type === "user" && wake.id) return wake.id;
  return run.responsibleUserId ?? null;
}

export type ProviderLimitResumePlan =
  | { automatic: true; resetAt: Date; actorId: string }
  | { automatic: false; resetAt: Date | null };

/** Whether this failed run's task continues by itself once the limit resets. */
export async function planProviderLimitResume(db: Pick<Db, "select">, runId: string): Promise<ProviderLimitResumePlan> {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!run) return { automatic: false, resetAt: null };
  const reset = await readNativeUsageLimitReset(db, run);
  if (!reset) return { automatic: false, resetAt: null };
  // A reset beyond the bounded wait is still reported; only the automatic Retry is bounded.
  const actorId = reset.withinAutomaticWait ? await accountableUser(db, run) : null;
  return actorId ? { automatic: true, resetAt: reset.resetAt, actorId } : { automatic: false, resetAt: reset.resetAt };
}

export function providerLimitNextAction(plan: ProviderLimitResumePlan) {
  if (plan.automatic) {
    return `The provider usage limit resets at ${plan.resetAt.toISOString()}. Paperclip will retry this task then; Retry starts it sooner if usage capacity is already restored.`;
  }
  return plan.resetAt
    ? `The provider usage limit resets at ${plan.resetAt.toISOString()}. Retry the task after that time, or sooner if usage capacity is restored.`
    : "Restore model provider usage capacity, then retry the task. The provider did not report when its usage limit resets.";
}

type Outcome =
  | { requested: true; requestId: string }
  | { requested: false; waitUntil: Date }
  | { requested: false; reason: string };

async function settle(db: Db, actionId: string, state: Record<string, unknown>, nextAction?: string) {
  await db.update(issueRecoveryActions).set({
    evidence: sql`coalesce(${issueRecoveryActions.evidence}, '{}'::jsonb) || jsonb_build_object('providerLimitResume', ${JSON.stringify(state)}::jsonb)`,
    ...(nextAction ? { nextAction } : {}),
    updatedAt: new Date(),
  }).where(and(eq(issueRecoveryActions.id, actionId), sql`${issueRecoveryActions.evidence}->'providerLimitResume' is null`));
}

/** Why Paperclip did not retry after a reset it announced; the Retry stays.
 * Every give-up reason is listed, so no give-up leaves the promise standing. */
const NOT_RETRIED = {
  source_run_mismatch: "the failed run no longer matches this hold",
  reset_unknown: "the provider's reset could no longer be read",
  task_changed: "the task changed",
  no_accountable_user: "no user is accountable for the run",
  automatic_retry_budget_used: "three automatic Retries in a row did not restore usage",
  retry_stale: "a newer run exists",
  retry_refused: "Retry was not allowed for the accountable user",
  reset_stale: "the reset passed more than a day ago",
} as const;
type NotRetriedReason = keyof typeof NOT_RETRIED;

/**
 * Requests the task's Retry for one usage-limit hold once its reset has
 * passed. Idempotent per run: the Retry key and the recorded outcome both
 * prevent a second request.
 */
export async function requestProviderLimitResumeRetry(db: Db, input: {
  companyId: string; actionId: string; prepareChatRetry?: PrepareChatRetry;
}, now = new Date()): Promise<Outcome> {
  const [action] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)));
  if (!action || action.status !== "active" || action.kind !== "active_run_watchdog" || action.cause !== NATIVE_PROVIDER_USAGE_LIMIT
    || action.evidence?.providerLimitResume) return { requested: false, reason: "not_waiting" };
  const runId = typeof action.evidence?.runId === "string" ? action.evidence.runId : null;
  const [run] = runId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, action.companyId), sql`${heartbeatRuns.id}::text = ${runId}`)) : [];
  const done = async (reason: NotRetriedReason, extra: Record<string, unknown> = {}) => {
    // Replace a promise to retry with what the user can do now.
    const nextAction = action.evidence?.providerLimitResetAt
      ? `Paperclip did not retry this task after the provider usage limit reset because ${NOT_RETRIED[reason]}. Retry the task when usage capacity is available.`
      : undefined;
    await settle(db, action.id, { state: "not_requested", reason, decidedAt: now.toISOString(), ...extra }, nextAction);
    return { requested: false as const, reason };
  };
  // The failure that created the hold may still be settling its run.
  if (run && ["queued", "running"].includes(run.status)) return { requested: false, waitUntil: new Date(now.getTime() + 60_000) };
  if (!run || run.runtimeMode !== "native" || run.status !== "failed" || run.errorCode !== NATIVE_PROVIDER_USAGE_LIMIT)
    return done("source_run_mismatch");
  const reset = await readNativeUsageLimitReset(db, run);
  if (!reset) return done("reset_unknown");
  if (!reset.withinAutomaticWait) {
    // Too far out to wait by itself: the hold names the reset and leaves the
    // Retry to the user; it never promised an automatic one.
    await db.update(issueRecoveryActions).set({
      nextAction: providerLimitNextAction({ automatic: false, resetAt: reset.resetAt }),
      evidence: sql`coalesce(${issueRecoveryActions.evidence}, '{}'::jsonb) || jsonb_build_object('providerLimitResetAt', ${reset.resetAt.toISOString()}::text)`,
      updatedAt: now,
    }).where(and(eq(issueRecoveryActions.id, action.id), eq(issueRecoveryActions.status, "active")));
    await settle(db, action.id, { state: "not_requested", reason: "reset_beyond_wait", resetAt: reset.resetAt.toISOString(),
      decidedAt: now.toISOString() });
    return { requested: false, reason: "reset_beyond_wait" };
  }
  if (reset.resetAt.getTime() > now.getTime()) {
    // A hold saved by an earlier release names no reset; tell its reader when work resumes.
    if (!action.evidence?.providerLimitResetAt) {
      const actorId = await accountableUser(db, run);
      await db.update(issueRecoveryActions).set({
        nextAction: providerLimitNextAction(actorId
          ? { automatic: true, resetAt: reset.resetAt, actorId } : { automatic: false, resetAt: reset.resetAt }),
        evidence: sql`coalesce(${issueRecoveryActions.evidence}, '{}'::jsonb) || jsonb_build_object('providerLimitResetAt', ${reset.resetAt.toISOString()}::text)`,
        updatedAt: now,
      }).where(and(eq(issueRecoveryActions.id, action.id), eq(issueRecoveryActions.status, "active")));
    }
    return { requested: false, waitUntil: reset.resetAt };
  }
  if (now.getTime() - reset.resetAt.getTime() > STALE_RESET_MS) return done("reset_stale", { resetAt: reset.resetAt.toISOString() });
  const issueId = action.sourceIssueId;
  const [issue] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues)
    .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
  if (!issue || issue.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(issue.status)) return done("task_changed");
  const actorId = await accountableUser(db, run);
  if (!actorId) return done("no_accountable_user");
  // Bound a provider that keeps reporting resets that do not restore capacity.
  const [lastSuccess] = await db.select({ finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "succeeded"),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
  )).orderBy(desc(heartbeatRuns.finishedAt)).limit(1);
  const earlier = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    like(agentWakeupRequests.idempotencyKey, `task-retry:${PROVIDER_LIMIT_RESUME_KEY_PREFIX}%`),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    lastSuccess?.finishedAt ? gt(agentWakeupRequests.requestedAt, lastSuccess.finishedAt) : undefined,
  )).limit(MAX_AUTOMATIC_RESUMES);
  if (earlier.length >= MAX_AUTOMATIC_RESUMES) return done("automatic_retry_budget_used");
  try {
    const receipt = await requestTaskRetry({ db, companyId: run.companyId, issueId, actorId,
      actorSource: actorId === "local-board" ? "local_implicit" : "session",
      idempotencyKey: `${PROVIDER_LIMIT_RESUME_KEY_PREFIX}${run.id}`, observedRunId: run.id,
      initiatedBy: "provider_limit_reset", prepareChatRetry: input.prepareChatRetry });
    if (!receipt.accepted || !receipt.requestId) return done("retry_stale");
    await settle(db, action.id, { state: "requested", requestId: receipt.requestId, resetAt: reset.resetAt.toISOString(),
      requestedAt: now.toISOString() });
    return { requested: true, requestId: receipt.requestId };
  } catch (error) {
    // Authority or conversation checks refused it; the visible Retry remains.
    if (!(error instanceof HttpError)) throw error;
    logger.info({ runId: run.id, status: error.status }, "provider limit reset left for an explicit Retry");
    return done("retry_refused", { status: error.status });
  }
}

type Scope = { companyId: string };
const LOAD_PAGE_SIZE = 500;
type Entry = { id: string; companyId: string; dueAt: number };

/**
 * Deadline owner for usage-limit holds: one entry per hold, due at its
 * provider-reported reset. Holds are the durable truth; a new hold notifies
 * this queue, and startup reconstructs every waiting hold.
 */
export function registerProviderLimitResumeWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: { resume(companyId: string, requestId: string): Promise<unknown>; schedulingSuppressed(): Promise<boolean>;
    /** Read when a Retry is requested: the chat service registers it after startup. */
    prepareChatRetry?: () => PrepareChatRetry | undefined },
  canRun: () => boolean,
) {
  const cursors = new Map<string, string>();
  return registerScopedDeadlineWork<Entry, Scope>(coordinator, {
    queue: DELIVERY_QUEUES.providerLimitResume,
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as Scope,
    matches: (entry, scope) => !scope || entry.companyId === scope.companyId,
    load: async scope => {
      // One bounded page per pass, resumed from a stable cursor until every
      // waiting hold is loaded: a hold left out would never retry.
      const key = scope ? JSON.stringify(scope) : "*";
      const cursor = cursors.get(key);
      const rows = await db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId })
        .from(issueRecoveryActions).where(and(
          scope ? eq(issueRecoveryActions.companyId, scope.companyId) : undefined,
          eq(issueRecoveryActions.status, "active"), eq(issueRecoveryActions.kind, "active_run_watchdog"),
          eq(issueRecoveryActions.cause, NATIVE_PROVIDER_USAGE_LIMIT),
          sql`${issueRecoveryActions.evidence}->'providerLimitResume' is null`,
          isNull(issueRecoveryActions.resolvedAt),
          cursor ? gt(issueRecoveryActions.id, cursor) : undefined,
        )).orderBy(asc(issueRecoveryActions.id)).limit(LOAD_PAGE_SIZE);
      const complete = rows.length < LOAD_PAGE_SIZE;
      if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
      // check() reads each hold's reset and returns its real deadline.
      return { rows: rows.map(row => ({ ...row, dueAt: 0 })), complete };
    },
    check: async entry => {
      if (await owner.schedulingSuppressed()) return { ...entry, dueAt: Date.now() + 5 * 60_000 };
      const outcome = await requestProviderLimitResumeRetry(db, { companyId: entry.companyId, actionId: entry.id,
        prepareChatRetry: owner.prepareChatRetry?.() });
      if ("waitUntil" in outcome) return { ...entry, dueAt: outcome.waitUntil.getTime() };
      if (outcome.requested) await owner.resume(entry.companyId, outcome.requestId).catch((error: unknown) =>
        logger.warn({ err: error, actionId: entry.id }, "provider limit Retry remains queued"));
      return null;
    },
  }, canRun);
}
