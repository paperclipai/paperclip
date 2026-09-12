import { and, asc, desc, eq, gte, lte, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { ISSUE_STATUSES, type IssueStatus } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Auto-retry scheduler for heartbeat runs that died before doing any
 * observable work. Refines the pre-existing
 * `enqueueProcessLossRetry` path so that any transient infrastructure
 * failure (Process lost, gateway 1012, missing-adapter, etc.) with an
 * empty `stdout_excerpt` is a candidate for automatic revival, up to
 * `MAX_AUTO_RETRIES` attempts with exponential backoff.
 *
 * After exhausting the retry budget the issue transitions to
 * `needs_retry` so the board sees a distinct revival target on the
 * Kanban rather than a silent `failed` row. The board can then drag
 * the card back to `todo` to make the runnable again, or use
 * `POST /api/issues/:id/force-release-checkout` to clear the orphan
 * checkout from a dead run.
 */

export const HEARTBEAT_AUTO_RETRY_REASONS = new Set<string>([
  "process_lost",
  "gateway_closed",
  "adapter_missing",
  "context_overflow_recoverable",
]);

export const HEARTBEAT_AUTO_RETRY_NO_OUTPUT_REASONS = new Set<string>([
  "process_lost",
  "gateway_closed",
  "adapter_missing",
]);

const DEFAULT_MAX_AUTO_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 1_000;

export interface AutoRetryEligibility {
  eligible: boolean;
  reason: string;
  retryAttempt: number;
  nextRetryAt: Date | null;
}

export interface AutoRetryContext {
  db: Db;
  now?: Date;
  maxAutoRetries?: number;
  backoffBaseMs?: number;
}

function classifyTransientFailure(run: typeof heartbeatRuns.$inferSelect): string | null {
  const errorText = (run.error ?? "").toLowerCase();
  const code = (run.errorCode ?? "").toLowerCase();
  if (errorText.includes("process lost") || errorText.includes("server may have restarted")) {
    return "process_lost";
  }
  if (code === "gateway_closed" || errorText.includes("gateway closed") || errorText.includes("(1012)")) {
    return "gateway_closed";
  }
  if (
    code === "adapter_missing" ||
    errorText.includes("adapter not found") ||
    errorText.includes("no command")
  ) {
    return "adapter_missing";
  }
  if (
    code === "context_overflow" ||
    errorText.includes("context length") ||
    errorText.includes("maximum context")
  ) {
    return "context_overflow_recoverable";
  }
  return null;
}

function hasObservableWork(run: typeof heartbeatRuns.$inferSelect): boolean {
  const stdoutExcerpt = (run.stdoutExcerpt ?? "").trim();
  if (stdoutExcerpt.length > 0) return true;
  const resultJson = run.resultJson as Record<string, unknown> | null;
  if (resultJson && typeof resultJson === "object") {
    if (Object.keys(resultJson).length > 0) return true;
  }
  return false;
}

export function evaluateAutoRetryEligibility(
  run: typeof heartbeatRuns.$inferSelect,
  now: Date = new Date(),
  maxAutoRetries: number = DEFAULT_MAX_AUTO_RETRIES,
): AutoRetryEligibility {
  const reason = classifyTransientFailure(run);
  if (!reason || !HEARTBEAT_AUTO_RETRY_REASONS.has(reason)) {
    return { eligible: false, reason: "not_transient", retryAttempt: 0, nextRetryAt: null };
  }
  if (hasObservableWork(run)) {
    return { eligible: false, reason: "has_output", retryAttempt: 0, nextRetryAt: null };
  }
  if (run.autoRetryCount >= maxAutoRetries) {
    return { eligible: false, reason: "max_retries_reached", retryAttempt: run.autoRetryCount, nextRetryAt: null };
  }
  const backoffMs = DEFAULT_BACKOFF_BASE_MS * Math.pow(2, run.autoRetryCount);
  const nextRetryAt = new Date(now.getTime() + backoffMs);
  return {
    eligible: true,
    reason,
    retryAttempt: run.autoRetryCount + 1,
    nextRetryAt,
  };
}

export interface AutoRetryEnqueueResult {
  outcome: "enqueued" | "skipped" | "exhausted";
  retryRunId: string | null;
  retryAttempt: number;
  reason: string;
  issueTransitioned: boolean;
}

export async function maybeEnqueueAutoRetry(
  ctx: AutoRetryContext & { run: typeof heartbeatRuns.$inferSelect },
): Promise<AutoRetryEnqueueResult> {
  const db = ctx.db;
  const now = ctx.now ?? new Date();
  const eligibility = evaluateAutoRetryEligibility(
    ctx.run,
    now,
    ctx.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES,
  );

  if (!eligibility.eligible) {
    return {
      outcome: "skipped",
      retryRunId: null,
      retryAttempt: ctx.run.autoRetryCount,
      reason: eligibility.reason,
      issueTransitioned: false,
    };
  }

  const existingRetry = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, ctx.run.companyId),
        eq(heartbeatRuns.retryOfRunId, ctx.run.id),
        eq(heartbeatRuns.invocationSource, "auto_retry"),
      ),
    )
    .orderBy(asc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existingRetry) {
    logger.info(
      {
        event: "auto_retry.duplicate",
        originalRunId: ctx.run.id,
        retryRunId: existingRetry.id,
        retryRunStatus: existingRetry.status,
        reason: eligibility.reason,
      },
      "auto-retry already enqueued; skipping duplicate",
    );
    return {
      outcome: "skipped",
      retryRunId: existingRetry.id,
      retryAttempt: ctx.run.autoRetryCount,
      reason: "duplicate_retry",
      issueTransitioned: false,
    };
  }

  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, ctx.run.agentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!agent) {
    logger.warn(
      { event: "auto_retry.no_agent", originalRunId: ctx.run.id },
      "auto-retry skipped because agent row disappeared",
    );
    return {
      outcome: "skipped",
      retryRunId: null,
      retryAttempt: ctx.run.autoRetryCount,
      reason: "agent_missing",
      issueTransitioned: false,
    };
  }

  if (agent.status === "terminated" || agent.status === "pending_approval") {
    return {
      outcome: "skipped",
      retryRunId: null,
      retryAttempt: ctx.run.autoRetryCount,
      reason: "agent_not_runnable",
      issueTransitioned: false,
    };
  }

  let issueTransitioned = false;
  let retryRunId: string | null = null;

  try {
    const result = await db.transaction(async (tx) => {
      const wakeup = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: ctx.run.companyId,
          agentId: ctx.run.agentId,
          source: "automation",
          triggerDetail: "auto_retry",
          reason: "auto_retry",
          payload: {
            retryOfRunId: ctx.run.id,
            reason: eligibility.reason,
            attempt: eligibility.retryAttempt,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const retryRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: ctx.run.companyId,
          agentId: ctx.run.agentId,
          invocationSource: "auto_retry",
          triggerDetail: `auto_retry:${eligibility.reason}`,
          status: "queued",
          responsibleUserId: ctx.run.responsibleUserId,
          retryOfRunId: ctx.run.id,
          autoRetryCount: eligibility.retryAttempt,
          autoRetryReason: eligibility.reason,
          nextAutoRetryAt: eligibility.nextRetryAt,
          contextSnapshot: {
            ...(parseObject(ctx.run.contextSnapshot) as Record<string, unknown>),
            retryOfRunId: ctx.run.id,
            wakeReason: "auto_retry",
            autoRetryReason: eligibility.reason,
            autoRetryAttempt: eligibility.retryAttempt,
          } as Record<string, unknown>,
        })
        .returning()
        .then((rows) => rows[0]);

      const sourceContext = parseObject(ctx.run.contextSnapshot) as Record<string, unknown>;
      const issueId = readNonEmptyString(sourceContext.issueId);
      if (issueId) {
        await tx
          .update(heartbeatRuns)
          .set({ autoRetryCount: eligibility.retryAttempt })
          .where(eq(heartbeatRuns.id, ctx.run.id));
        await tx
          .update(agentWakeupRequests)
          .set({ payload: sql`${agentWakeupRequests.payload} || ${sql`${JSON.stringify({ retryRunId: retryRun.id })}`}::jsonb` })
          .where(eq(agentWakeupRequests.id, wakeup.id));
      }

      void issueId;
      void retryRun;
      return retryRun.id;
    });
    retryRunId = result;
  } catch (err) {
    logger.error(
      { event: "auto_retry.db_error", originalRunId: ctx.run.id, err: (err as Error).message },
      "auto-retry database transaction failed",
    );
    return {
      outcome: "skipped",
      retryRunId: null,
      retryAttempt: ctx.run.autoRetryCount,
      reason: "db_error",
      issueTransitioned: false,
    };
  }

  if (eligibility.retryAttempt >= (ctx.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES)) {
    issueTransitioned = await transitionIssueToNeedsRetry(ctx);
    return {
      outcome: "exhausted",
      retryRunId,
      retryAttempt: eligibility.retryAttempt,
      reason: eligibility.reason,
      issueTransitioned,
    };
  }

  return {
    outcome: "enqueued",
    retryRunId,
    retryAttempt: eligibility.retryAttempt,
    reason: eligibility.reason,
    issueTransitioned: false,
  };
}

async function transitionIssueToNeedsRetry(
  ctx: AutoRetryContext & { run: typeof heartbeatRuns.$inferSelect },
): Promise<boolean> {
  const sourceContext = parseObject(ctx.run.contextSnapshot) as Record<string, unknown>;
  const issueId = readNonEmptyString(sourceContext.issueId);
  if (!issueId) return false;
  const updated = await ctx.db
    .update(issues)
    .set({
      status: "needs_retry" satisfies IssueStatus,
      updatedAt: ctx.now ?? new Date(),
    })
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.companyId, ctx.run.companyId),
        // only flip if the issue is still in a recoverable state
        gte(issues.status, "backlog"),
        lte(issues.status, "in_review"),
      ),
    )
    .returning({ id: issues.id })
    .then((rows) => rows[0] ?? null);
  if (updated) {
    logger.warn(
      {
        event: "auto_retry.exhausted_to_needs_retry",
        runId: ctx.run.id,
        issueId,
        companyId: ctx.run.companyId,
        retryCount: ctx.run.autoRetryCount,
      },
      "auto-retry budget exhausted; issue moved to needs_retry",
    );
    return true;
  }
  return false;
}

export async function listAutoRetryableRuns(
  ctx: AutoRetryContext,
  limit: number = 25,
): Promise<Array<{ run: typeof heartbeatRuns.$inferSelect; agent: typeof agents.$inferSelect | null }>> {
  const candidate = await ctx.db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, "failed"),
        gte(heartbeatRuns.autoRetryCount, 0),
        sql`${heartbeatRuns.stdoutExcerpt} IS NULL OR ${heartbeatRuns.stdoutExcerpt} = ''`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(limit);
  const agentIds = Array.from(new Set(candidate.map((r) => r.agentId)));
  if (agentIds.length === 0) return candidate.map((run) => ({ run, agent: null }));
  const agentRows = await ctx.db
    .select()
    .from(agents)
    .where(
      sql`${agents.id} = ANY(${sql`${JSON.stringify(agentIds)}`}::jsonb)`,
    );
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  return candidate.map((run) => ({ run, agent: byId.get(run.agentId) ?? null }));
}

export function isNeedsRetryIssue(status: string | null): boolean {
  if (!status) return false;
  return (ISSUE_STATUSES as readonly string[]).includes(status) && status === "needs_retry";
}

export const AUTO_RETRY_TUNING = {
  DEFAULT_MAX_AUTO_RETRIES,
  DEFAULT_BACKOFF_BASE_MS,
} as const;
