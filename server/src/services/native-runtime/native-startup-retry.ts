import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { aiConnectionTaskPins, aiConnectionQuotaCooldowns, heartbeatRuns, type Db } from "@paperclipai/db";
import { readProviderFailure, type ProviderFailure } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { infrastructureRetryDelayMs, PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS } from "../system-recovery-state.js";
import { parseProviderQuotaClockReset } from "../provider-quota-reset.js";
import { quotaIdentityFromSessionSnapshot } from "../ai-connection-router.js";

/** Categories that report an exhausted account or request allowance. */
const PROVIDER_LIMIT_CATEGORIES = ["rate_limit", "quota_exhausted"];
/** Run errors that record an exhausted allowance without a typed provider failure. */
const PROVIDER_LIMIT_ERROR_CODES = ["native_provider_usage_limit", "provider_quota"];
/** Limit evidence older than this is ignored, and no limit holds a retry longer. */
const NATIVE_PROVIDER_LIMIT_WINDOW_MS = 24 * 60 * 60_000;
const LIMIT_EVIDENCE_ROWS = 20;

type ProviderLimitEvidence = { resetAt: number; resetReported: boolean; category: string; sourceRunId: string | null };

function limitEvidence(failure: ProviderFailure | null, observedAt: Date, sourceRunId: string | null): ProviderLimitEvidence | null {
  if (!failure || !PROVIDER_LIMIT_CATEGORIES.includes(failure.category)) return null;
  const retryAt = failure.retryAt ? Date.parse(failure.retryAt) : Number.NaN;
  if (Number.isFinite(retryAt)) return { resetAt: retryAt, resetReported: true, category: failure.category, sourceRunId };
  // ACP harnesses report the reset only in the provider's own wording.
  const clockReset = parseProviderQuotaClockReset(failure.message, observedAt);
  return clockReset
    ? { resetAt: clockReset.getTime(), resetReported: true, category: failure.category, sourceRunId }
    : { resetAt: observedAt.getTime() + PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS, resetReported: false, category: failure.category, sourceRunId };
}

export type AgentProviderLimitCooldown = {
  /** When the agent's provider allowance is expected to return. */
  resetAt: Date;
  /** False when no reset was reported and the default cooldown applies. */
  resetReported: boolean;
  category: string;
  /** The run whose failure recorded the latest reset. */
  sourceRunId: string | null;
};

/**
 * The latest known provider limit for this agent, from the current failure or
 * from the agent's recent runs. A later successful run clears older evidence.
 */
export async function agentProviderLimitCooldown(db: Db, input: {
  companyId: string;
  agentId: string;
  /** Excluded from the evidence; the caller supplies its own failure. */
  runId?: string;
  failure?: ProviderFailure | null;
  now: Date;
}): Promise<AgentProviderLimitCooldown | null> {
  const now = input.now.getTime();
  let latest = limitEvidence(input.failure ?? null, input.now, input.runId ?? null);
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      observedAt: sql<Date>`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`.mapWith(heartbeatRuns.updatedAt),
      providerFailure: sql<unknown>`${heartbeatRuns.resultJson} -> 'providerFailure'`,
      retryNotBefore: sql<string | null>`${heartbeatRuns.resultJson} ->> 'retryNotBefore'`,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      gte(heartbeatRuns.startedAt, new Date(now - NATIVE_PROVIDER_LIMIT_WINDOW_MS)),
      ...(input.runId ? [ne(heartbeatRuns.id, input.runId)] : []),
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
    let recorded = limitEvidence(readProviderFailure(row.providerFailure), row.observedAt, row.id);
    if (recorded === null && PROVIDER_LIMIT_ERROR_CODES.includes(row.errorCode ?? "")) {
      const reset = row.retryNotBefore ? Date.parse(row.retryNotBefore) : Number.NaN;
      recorded = Number.isFinite(reset)
        ? { resetAt: reset, resetReported: true, category: "quota_exhausted", sourceRunId: row.id }
        : { resetAt: row.observedAt.getTime() + PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS, resetReported: false, category: "quota_exhausted", sourceRunId: row.id };
    }
    if (recorded && (!latest || recorded.resetAt > latest.resetAt)) latest = recorded;
  }
  if (!latest || latest.resetAt <= now) return null;
  return {
    resetAt: new Date(Math.min(latest.resetAt, now + NATIVE_PROVIDER_LIMIT_WINDOW_MS)),
    resetReported: latest.resetReported,
    category: latest.category,
    sourceRunId: latest.sourceRunId,
  };
}

async function routedAccountCooldown(input: {
  db: Db;
  binding: { companyId: string; agentId: string; runId: string };
  failure: ProviderFailure | null;
  now: Date;
  managedAiAccountIdentity?: string;
}): Promise<{ matched: boolean; cooldown: Date | null }> {
  if (!input.managedAiAccountIdentity) return { matched: false, cooldown: null };
  const [routed] = await input.db
    .select({ grantId: sql<string>`${aiConnectionTaskPins.selection}->'binding'->>'grantId'` })
    .from(heartbeatRuns)
    .innerJoin(aiConnectionTaskPins, and(eq(aiConnectionTaskPins.companyId, heartbeatRuns.companyId),
      eq(aiConnectionTaskPins.agentId, heartbeatRuns.agentId),
      sql`${aiConnectionTaskPins.poolId}::text = ${heartbeatRuns.contextSnapshot}->'aiRouterSelection'->>'poolId'`,
      sql`${aiConnectionTaskPins.taskKey} = ${heartbeatRuns.contextSnapshot}->>'aiRouterTaskKey'`,
      sql`${aiConnectionTaskPins.selection} = ${heartbeatRuns.contextSnapshot}->'aiRouterSelection'`,
      sql`${aiConnectionTaskPins.member}->'binding' = ${aiConnectionTaskPins.selection}->'binding'`,
      sql`${aiConnectionTaskPins.member}->>'id' = ${aiConnectionTaskPins.selection}->>'memberId'`))
    .where(and(eq(heartbeatRuns.id, input.binding.runId), eq(heartbeatRuns.companyId, input.binding.companyId),
      eq(heartbeatRuns.agentId, input.binding.agentId),
      sql`${input.managedAiAccountIdentity} LIKE (${aiConnectionTaskPins.selection}->'binding'->>'grantId') || ':%'`,
      sql`((${heartbeatRuns.scopeKind} = 'issue' and (${heartbeatRuns.issueId}::text = ${aiConnectionTaskPins.taskKey}
          or exists (select 1 from issues where issues.id = ${heartbeatRuns.issueId} and issues.company_id = ${heartbeatRuns.companyId} and issues.identifier = ${aiConnectionTaskPins.taskKey})))
        or (${heartbeatRuns.scopeKind} <> 'issue' and (${heartbeatRuns.id}::text = ${aiConnectionTaskPins.taskKey}
          or (${aiConnectionTaskPins.taskKey} = '__heartbeat__' and ${heartbeatRuns.invocationSource} = 'timer' and ${heartbeatRuns.contextSnapshot}->>'wakeSource' = 'timer'))))`)).limit(1);
  const identity = routed ? quotaIdentityFromSessionSnapshot(routed.grantId, input.managedAiAccountIdentity) : null;
  if (!identity) return { matched: false, cooldown: null };
  const [account] = await input.db.select({ retryAt: aiConnectionQuotaCooldowns.retryAt }).from(aiConnectionQuotaCooldowns)
    .where(and(eq(aiConnectionQuotaCooldowns.companyId, input.binding.companyId),
      eq(aiConnectionQuotaCooldowns.credentialIdentity, identity))).limit(1);
  const current = limitEvidence(input.failure, input.now, input.binding.runId)?.resetAt ?? 0;
  const resetAt = Math.max(current, account?.retryAt.getTime() ?? 0);
  return { matched: true, cooldown: resetAt > input.now.getTime() ? new Date(resetAt) : null };
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
  managedAiAccountIdentity?: string;
}): Promise<{ nextAttemptAt: Date | null; providerCooldownAt: Date | null }> {
  // Limit evidence only refines the schedule. A failed read must not stop the
  // failure from settling, so the retry falls back to plain backoff.
  const providerCooldownAt = await (async () => {
    const account = await routedAccountCooldown(input);
    if (account.matched) return account.cooldown;
    const cooldown = await agentProviderLimitCooldown(input.db, {
      companyId: input.binding.companyId,
      agentId: input.binding.agentId,
      runId: input.binding.runId,
      failure: input.failure,
      now: input.now,
    });
    return cooldown?.resetAt ?? null;
  })().catch((error: unknown) => {
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
