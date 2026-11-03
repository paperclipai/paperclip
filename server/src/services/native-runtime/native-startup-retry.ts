import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { readProviderFailure, type ProviderFailure } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { infrastructureRetryDelayMs, PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS } from "../system-recovery-state.js";

/** Categories that report an exhausted account or request allowance. */
const PROVIDER_LIMIT_CATEGORIES = ["rate_limit", "quota_exhausted"];
/** Run errors that record an exhausted allowance without a typed provider failure. */
const PROVIDER_LIMIT_ERROR_CODES = ["native_provider_usage_limit", "provider_quota"];
/** Limit evidence older than this is ignored, and no limit holds a retry longer. */
const NATIVE_PROVIDER_LIMIT_WINDOW_MS = 24 * 60 * 60_000;
const LIMIT_EVIDENCE_ROWS = 20;

function limitCooldownAt(failure: ProviderFailure | null, observedAt: Date): number | null {
  if (!failure || !PROVIDER_LIMIT_CATEGORIES.includes(failure.category)) return null;
  const retryAt = failure.retryAt ? Date.parse(failure.retryAt) : Number.NaN;
  return Number.isFinite(retryAt) ? retryAt : observedAt.getTime() + PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS;
}

/**
 * The latest known provider limit for this agent, from the current failure or
 * from the agent's recent runs. A later successful run clears older evidence.
 */
async function nativeProviderCooldownAt(input: {
  db: Db;
  binding: { companyId: string; agentId: string; runId: string };
  failure: ProviderFailure | null;
  now: Date;
}): Promise<Date | null> {
  const now = input.now.getTime();
  let cooldownAt = limitCooldownAt(input.failure, input.now) ?? 0;
  const rows = await input.db
    .select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      observedAt: sql<Date>`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`.mapWith(heartbeatRuns.updatedAt),
      providerFailure: sql<unknown>`${heartbeatRuns.resultJson} -> 'providerFailure'`,
      retryNotBefore: sql<string | null>`${heartbeatRuns.resultJson} ->> 'retryNotBefore'`,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.binding.companyId),
      eq(heartbeatRuns.agentId, input.binding.agentId),
      gte(heartbeatRuns.startedAt, new Date(now - NATIVE_PROVIDER_LIMIT_WINDOW_MS)),
      ne(heartbeatRuns.id, input.binding.runId),
      or(
        eq(heartbeatRuns.status, "succeeded"),
        inArray(heartbeatRuns.errorCode, PROVIDER_LIMIT_ERROR_CODES),
        inArray(sql<string>`${heartbeatRuns.resultJson} #>> '{providerFailure,category}'`, PROVIDER_LIMIT_CATEGORIES),
      ),
    ))
    .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`))
    .limit(LIMIT_EVIDENCE_ROWS);
  for (const row of rows) {
    // The provider accepted work after this point, so its allowance was restored.
    if (row.status === "succeeded") break;
    const failure = readProviderFailure(row.providerFailure);
    let recorded = limitCooldownAt(failure, row.observedAt);
    if (recorded === null && PROVIDER_LIMIT_ERROR_CODES.includes(row.errorCode ?? "")) {
      const reset = row.retryNotBefore ? Date.parse(row.retryNotBefore) : Number.NaN;
      recorded = Number.isFinite(reset) ? reset : row.observedAt.getTime() + PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS;
    }
    if (recorded !== null) cooldownAt = Math.max(cooldownAt, recorded);
  }
  return cooldownAt > now ? new Date(Math.min(cooldownAt, now + NATIVE_PROVIDER_LIMIT_WINDOW_MS)) : null;
}

/**
 * Schedules a same-run bootstrap retry after a failure that provably came
 * before provider work. The attempt budget stays with the coordinator; this
 * adds exponential backoff and waits out a known provider limit.
 */
export async function planNativeStartupRetry(input: {
  db: Db;
  binding: { companyId: string; agentId: string; runId: string };
  attempt: number;
  retryable: boolean;
  failure: ProviderFailure | null;
  now: Date;
}): Promise<{ nextAttemptAt: Date | null; providerCooldownAt: Date | null }> {
  // Limit evidence only refines the schedule. A failed read must not stop the
  // failure from settling, so the retry falls back to plain backoff.
  const providerCooldownAt = await nativeProviderCooldownAt(input).catch((error: unknown) => {
    logger.warn({ err: error, runId: input.binding.runId }, "native provider limit evidence unavailable");
    return null;
  });
  if (!input.retryable) return { nextAttemptAt: null, providerCooldownAt };
  // Persisted with the failure, so a restart keeps the same jitter.
  const sample = createHash("sha256").update(`${input.binding.runId}:${input.attempt}`)
    .digest().readUInt32BE(0) / 0xffffffff;
  const from = Math.max(input.now.getTime(), providerCooldownAt?.getTime() ?? 0);
  return {
    nextAttemptAt: new Date(from + infrastructureRetryDelayMs(input.attempt, sample)),
    providerCooldownAt,
  };
}

export function nativeStartupRetryExhaustedAction(attempts: number, providerCooldownAt: Date | null) {
  return `Provider startup failed on ${attempts} attempts before any provider work began. Automatic retries are stopped.${
    providerCooldownAt ? ` The provider usage limit for this agent is expected to reset at ${providerCooldownAt.toISOString()}.` : ""
  } Check the agent's AI connection and provider usage, then retry the task.`;
}

export function nativeStartupRetryWait(providerCooldownAt: Date | null) {
  return providerCooldownAt ? ` after the provider usage limit resets at ${providerCooldownAt.toISOString()}` : "";
}
