import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { aiConnectionTaskPins, aiConnectionQuotaCooldowns, connectionGrants, heartbeatRuns, type Db } from "@paperclipai/db";
import { readProviderFailure, type ProviderFailure } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { infrastructureRetryDelayMs, PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS } from "../system-recovery-state.js";
import { isProviderQuotaActionRequired, parseProviderQuotaClockReset } from "../provider-quota-reset.js";
import { quotaIdentityFromSessionSnapshot } from "../ai-connection-router.js";
import { ANTIGRAVITY_CLI_QUOTA_SCOPE } from "../antigravity-swarm-refusal.js";

/** Categories that report an exhausted account or request allowance. */
const PROVIDER_LIMIT_CATEGORIES = ["rate_limit", "quota_exhausted"];
/** Run errors that record an exhausted allowance without a typed provider failure. */
const PROVIDER_LIMIT_ERROR_CODES = ["native_provider_usage_limit", "provider_quota"];
/** Limit evidence older than this is ignored, and no limit holds a retry longer. */
const NATIVE_PROVIDER_LIMIT_WINDOW_MS = 24 * 60 * 60_000;
const LIMIT_EVIDENCE_ROWS = 20;

type ProviderLimitEvidence = { resetAt: number; resetReported: boolean; category: string; sourceRunId: string | null; grantId?: string | null };

function limitEvidence(failure: ProviderFailure | null, observedAt: Date, sourceRunId: string | null): ProviderLimitEvidence | null {
  if (!failure || !PROVIDER_LIMIT_CATEGORIES.includes(failure.category)) return null;
  if (isProviderQuotaActionRequired({ resultJson: { providerFailure: failure } }, observedAt)) return null;
  const retryAt = failure.retryAt ? Date.parse(failure.retryAt) : Number.NaN;
  if (Number.isFinite(retryAt)) return { resetAt: retryAt, resetReported: true, category: failure.category, sourceRunId };
  // ACP harnesses report the reset only in the provider's own wording.
  const clockReset = parseProviderQuotaClockReset(failure.message, observedAt);
  return clockReset
    ? { resetAt: clockReset.getTime(), resetReported: true, category: failure.category, sourceRunId }
    : { resetAt: observedAt.getTime() + PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS, resetReported: false, category: failure.category, sourceRunId };
}

/**
 * The AI credential a provider limit is checked against. A limit belongs to
 * the credential it was reported on, so evidence from another credential, or
 * from one that was revoked or removed, does not hold work.
 */
export type ProviderLimitCredential =
  /** No managed AI connection: the harness signs in with the host's own account. */
  | { kind: "host" }
  /** The managed connection grants the next run may use. */
  | { kind: "grants"; grantIds: readonly string[] }
  /** A managed connection whose account is chosen only when the run starts. */
  | { kind: "unresolved" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The run-context key naming the provider quota a run draws on when one
 * credential reaches more than one quota (for example Google's Antigravity CLI,
 * which bills a different pool than the same account's ordinary route). A limit
 * holds only runs on the same credential AND the same quota scope. Absent (all
 * rows saved before scopes existed, and every ordinary run) is the credential's
 * default quota.
 */
export const PROVIDER_QUOTA_SCOPE_CONTEXT_KEY = "providerQuotaScope";
const QUOTA_SCOPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The quota scope a run drew on; null is the credential's default quota. A run
 * that executed the Antigravity swarm route draws on the CLI's own pool even
 * when its context lacks the field (runs started before scopes existed, and
 * their retries), so the executed provider mode in its runner profile decides.
 */
export function runProviderQuotaScope(contextSnapshot: unknown, runnerProfileJson?: unknown): string | null {
  const value = contextSnapshot && typeof contextSnapshot === "object"
    ? (contextSnapshot as Record<string, unknown>)[PROVIDER_QUOTA_SCOPE_CONTEXT_KEY] : undefined;
  if (typeof value === "string" && QUOTA_SCOPE_PATTERN.test(value)) return value;
  const profile = runnerProfileJson && typeof runnerProfileJson === "object" ? runnerProfileJson as Record<string, unknown> : {};
  const input = profile.nativeExecutionInput && typeof profile.nativeExecutionInput === "object" ? profile.nativeExecutionInput as Record<string, unknown> : {};
  const provider = input.provider && typeof input.provider === "object" ? input.provider as Record<string, unknown> : {};
  return provider.kind === "acpx" && provider.agent === "antigravity" && provider.mode === "swarm" ? ANTIGRAVITY_CLI_QUOTA_SCOPE : null;
}

function quotaScopeEvidenceFilter(scope: string | null) {
  // The same derivation as runProviderQuotaScope, in SQL, so old swarm evidence holds only swarms.
  const executed = sql`${heartbeatRuns.runnerProfileJson} -> 'nativeExecutionInput' -> 'provider'`;
  const recorded = sql`coalesce(${heartbeatRuns.contextSnapshot} ->> ${PROVIDER_QUOTA_SCOPE_CONTEXT_KEY},
    case when ${executed} ->> 'kind' = 'acpx' and ${executed} ->> 'agent' = 'antigravity' and ${executed} ->> 'mode' = 'swarm'
      then ${ANTIGRAVITY_CLI_QUOTA_SCOPE} end)`;
  return scope === null ? sql`${recorded} is null` : sql`${recorded} = ${scope}`;
}

/** The credential a run used, from the account it recorded when it started. */
export function runProviderLimitCredential(contextSnapshot: unknown): ProviderLimitCredential {
  const grantId = recordedGrantId(contextSnapshot);
  return grantId ? { kind: "grants", grantIds: [grantId] } : { kind: "host" };
}

function recordedGrantId(contextSnapshot: unknown): string | null {
  const snapshot = contextSnapshot && typeof contextSnapshot === "object" ? contextSnapshot as Record<string, unknown> : {};
  const connection = snapshot.aiConnection && typeof snapshot.aiConnection === "object"
    ? snapshot.aiConnection as Record<string, unknown> : {};
  return typeof connection.grantId === "string" && UUID_PATTERN.test(connection.grantId) ? connection.grantId : null;
}

/**
 * Whether evidence recorded on `evidenceGrantId` (null: the host's account)
 * still describes the credential the agent would use now.
 */
function evidenceApplies(evidenceGrantId: string | null, credential: ProviderLimitCredential, activeGrantIds: ReadonlySet<string>) {
  if (evidenceGrantId === null) return credential.kind === "host";
  if (!activeGrantIds.has(evidenceGrantId)) return false;
  if (credential.kind === "grants") return credential.grantIds.includes(evidenceGrantId);
  return credential.kind === "unresolved";
}

/** Narrows the evidence read to the checked credential, so other accounts never crowd it out. */
function credentialEvidenceFilter(credential: ProviderLimitCredential) {
  const recorded = sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'grantId'`;
  if (credential.kind === "host") return [sql`${recorded} is null`];
  if (credential.kind === "grants") return [inArray(recorded, [...credential.grantIds])];
  return [];
}

/**
 * Whether any recent run of the agent recorded a provider limit, on any
 * account. Without one no account can be held, so callers skip resolving the
 * account the next run would use. Never decides that a limit applies.
 */
export async function agentHasProviderLimitEvidence(db: Db, input: {
  companyId: string; agentId: string; runId?: string; now: Date;
}): Promise<boolean> {
  const [row] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    gte(heartbeatRuns.startedAt, new Date(input.now.getTime() - NATIVE_PROVIDER_LIMIT_WINDOW_MS)),
    ...(input.runId ? [ne(heartbeatRuns.id, input.runId)] : []),
    or(
      inArray(heartbeatRuns.errorCode, PROVIDER_LIMIT_ERROR_CODES),
      inArray(sql<string>`${heartbeatRuns.resultJson} #>> '{providerFailure,category}'`, PROVIDER_LIMIT_CATEGORIES),
    ),
  )).limit(1);
  return Boolean(row);
}

export type AgentProviderLimitCooldown = {
  /** When the agent's provider allowance is expected to return. */
  resetAt: Date;
  /** False when no reset was reported and the default cooldown applies. */
  resetReported: boolean;
  category: string;
  /** The run whose failure recorded the latest reset. */
  sourceRunId: string | null;
  /** The connection grant the limit was reported on; null for the host's own account. */
  grantId: string | null;
};

/**
 * The latest known provider limit for this agent's credential, from the
 * current failure or from the agent's recent runs on that same credential. A
 * later successful run on the credential clears older evidence. Evidence from
 * another credential, or from a revoked or removed one, never applies.
 */
export async function agentProviderLimitCooldown(db: Db, input: {
  companyId: string;
  agentId: string;
  /** Excluded from the evidence; the caller supplies its own failure. */
  runId?: string;
  failure?: ProviderFailure | null;
  /** The credential being checked. The caller's failure was reported on it. */
  credential: ProviderLimitCredential;
  /** The quota scope being checked (see PROVIDER_QUOTA_SCOPE_CONTEXT_KEY); null or absent is the default quota. */
  quotaScope?: string | null;
  now: Date;
}): Promise<AgentProviderLimitCooldown | null> {
  if (isProviderQuotaActionRequired({ resultJson: { providerFailure: input.failure } }, input.now)) return null;
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
      contextSnapshot: sql<unknown>`jsonb_build_object('aiConnection', ${heartbeatRuns.contextSnapshot} -> 'aiConnection')`,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      gte(heartbeatRuns.startedAt, new Date(now - NATIVE_PROVIDER_LIMIT_WINDOW_MS)),
      ...(input.runId ? [ne(heartbeatRuns.id, input.runId)] : []),
      ...credentialEvidenceFilter(input.credential),
      // Another quota's limits, and its successes, say nothing about this one.
      quotaScopeEvidenceFilter(input.quotaScope ?? null),
      or(
        eq(heartbeatRuns.status, "succeeded"),
        inArray(heartbeatRuns.errorCode, PROVIDER_LIMIT_ERROR_CODES),
        inArray(sql<string>`${heartbeatRuns.resultJson} #>> '{providerFailure,category}'`, PROVIDER_LIMIT_CATEGORIES),
      ),
    ))
    .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`))
    .limit(LIMIT_EVIDENCE_ROWS);
  const recordedGrantIds = [...new Set(rows.flatMap(row => recordedGrantId(row.contextSnapshot) ?? []))];
  const activeGrantIds = new Set(recordedGrantIds.length === 0 ? [] : (await db
    .select({ id: connectionGrants.id }).from(connectionGrants).where(and(
      eq(connectionGrants.companyId, input.companyId),
      inArray(connectionGrants.id, recordedGrantIds),
      eq(connectionGrants.status, "active"),
    ))).map(row => row.id));
  for (const row of rows) {
    // Another credential's outcome says nothing about this one.
    if (!evidenceApplies(recordedGrantId(row.contextSnapshot), input.credential, activeGrantIds)) continue;
    // The provider accepted work after this point, so its allowance was restored.
    if (row.status === "succeeded") break;
    const failure = readProviderFailure(row.providerFailure);
    // A newer billing refusal supersedes an older estimate or reported reset.
    if (isProviderQuotaActionRequired({ resultJson: { providerFailure: failure } }, row.observedAt)) break;
    let recorded = limitEvidence(failure, row.observedAt, row.id);
    if (recorded === null && PROVIDER_LIMIT_ERROR_CODES.includes(row.errorCode ?? "")) {
      const reset = row.retryNotBefore ? Date.parse(row.retryNotBefore) : Number.NaN;
      recorded = Number.isFinite(reset)
        ? { resetAt: reset, resetReported: true, category: "quota_exhausted", sourceRunId: row.id }
        : { resetAt: row.observedAt.getTime() + PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS, resetReported: false, category: "quota_exhausted", sourceRunId: row.id };
    }
    if (recorded) recorded.grantId = recordedGrantId(row.contextSnapshot);
    if (recorded && (!latest || recorded.resetAt > latest.resetAt)) latest = recorded;
  }
  if (!latest || latest.resetAt <= now) return null;
  return {
    resetAt: new Date(Math.min(latest.resetAt, now + NATIVE_PROVIDER_LIMIT_WINDOW_MS)),
    resetReported: latest.resetReported,
    category: latest.category,
    sourceRunId: latest.sourceRunId,
    grantId: latest.grantId !== undefined ? latest.grantId
      : input.credential.kind === "grants" && input.credential.grantIds.length === 1 ? input.credential.grantIds[0] : null,
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
      sql`(${aiConnectionTaskPins.selection} - 'runtimeConfig' - 'notes' - 'adapterType' - 'runnerScope') =
        ((${heartbeatRuns.contextSnapshot}->'aiRouterSelection') - 'runtimeConfig' - 'notes' - 'adapterType' - 'runnerScope')`,
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
  if (isProviderQuotaActionRequired({ resultJson: { providerFailure: input.failure } }, input.now))
    return { nextAttemptAt: null, providerCooldownAt: null };
  // Limit evidence only refines the schedule. A failed read must not stop the
  // failure from settling, so the retry falls back to plain backoff.
  const providerCooldownAt = await (async () => {
    const account = await routedAccountCooldown(input);
    if (account.matched) return account.cooldown;
    const [run] = await input.db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot, runnerProfileJson: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.binding.companyId), eq(heartbeatRuns.id, input.binding.runId)));
    const cooldown = await agentProviderLimitCooldown(input.db, {
      companyId: input.binding.companyId,
      agentId: input.binding.agentId,
      runId: input.binding.runId,
      failure: input.failure,
      // The failure was reported on the account this run started with.
      credential: runProviderLimitCredential(run?.contextSnapshot),
      quotaScope: runProviderQuotaScope(run?.contextSnapshot, run?.runnerProfileJson),
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
