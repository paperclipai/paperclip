// ROCAA-25: Tier observability — bridge between heartbeat / adapter results
// and the SQLite observability store.
//
// ROCAA-180 extends this with a result-side reader: `extractTierSignal`
// prefers the top-level `AdapterExecutionResult.{tierUsed,tierTransitions,
// classifierVersion}` (added by ROCAA-28) and `AdapterInvocationMeta.
// failoverEvent`. The legacy `extractTierFromMeta` is kept as a fallback
// for adapters / call sites that haven't been migrated.

import type {
  AdapterFailoverEvent,
  AdapterInvocationMeta,
  AdapterTierTransition,
  AdapterTierUsed,
} from "@paperclipai/adapter-utils";
import { logger } from "../middleware/logger.js";
import type {
  AgentInvocationRecord,
  ObservabilityStore,
} from "./observability-store.js";

// The published `@paperclipai/adapter-utils` dist `.d.ts` does not yet carry
// the ROCAA-19 auth fields (`authSource`, `authDriftDetected`,
// `authDriftReasons`) — only the in-tree source does. Until the package is
// rebuilt, we widen the meta shape locally for those fields. The ROCAA-28
// tier-failover fields (`failoverEvent`, `tierUsed`, `tierTransitions`,
// `classifierVersion`) ARE in dist; we import them directly.
type TierMeta = AdapterInvocationMeta & {
  authSource?: "subscription" | "api" | "metered_api";
  authDriftDetected?: boolean;
  authDriftReasons?: string[];
};

/** Minimal slice of `AdapterExecutionResult` we read for tier signals. */
export interface TierAwareResult {
  tierUsed?: AdapterTierUsed;
  tierTransitions?: AdapterTierTransition[];
  classifierVersion?: string;
}

// Re-export for downstream consumers (heartbeat, tests) that previously used
// the *Like aliases — keeps a single import path for the tier-failover types
// even though they originate from `@paperclipai/adapter-utils`.
export type { AdapterFailoverEvent, AdapterTierTransition, AdapterTierUsed };

export interface TierTransition {
  tier: number;
  errorReason?: string | null;
}

export interface TierMetaExtract {
  tierUsed: number;
  tierTransitions: TierTransition[];
  classifierVersion?: string | null;
}

/** Map the v1 tier-id strings to the legacy numeric tier used in storage. */
function tierIdToNumber(tierId: string | null | undefined): number | null {
  if (tierId === "tier_0_claude_cli") return 0;
  if (tierId === "tier_1_anthropic_sdk") return 1;
  return null;
}

function normalizeReason(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, 500);
}

/**
 * Pull tier metadata off `AdapterInvocationMeta.context`. ROCAA-22/24 will
 * stuff `tier` (number 0..4) and `tierTransitions` (array of `{tier,
 * errorReason}`) into `meta.context` on each adapter spawn. Until then,
 * everything defaults to Tier 0 with no transitions.
 */
export function extractTierFromMeta(
  meta: Pick<AdapterInvocationMeta, "context">,
): TierMetaExtract {
  const ctx = (meta.context ?? {}) as Record<string, unknown>;
  let tierUsed = 0;
  const rawTier = ctx["tier"] ?? ctx["tierUsed"];
  if (typeof rawTier === "number" && Number.isFinite(rawTier)) {
    tierUsed = Math.max(0, Math.min(4, Math.trunc(rawTier)));
  } else if (typeof rawTier === "string" && /^[0-4]$/.test(rawTier.trim())) {
    tierUsed = Number(rawTier.trim());
  }

  const transitions: TierTransition[] = [];
  const rawTransitions = ctx["tierTransitions"] ?? ctx["tier_transitions"];
  if (Array.isArray(rawTransitions)) {
    for (const entry of rawTransitions) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const tierVal = e["tier"];
      const tier =
        typeof tierVal === "number" && Number.isFinite(tierVal)
          ? Math.max(0, Math.min(4, Math.trunc(tierVal)))
          : null;
      if (tier === null) continue;
      const reason = e["errorReason"] ?? e["error_reason"] ?? null;
      transitions.push({
        tier,
        errorReason:
          typeof reason === "string" && reason.length > 0 ? reason.slice(0, 500) : null,
      });
    }
  }

  return { tierUsed, tierTransitions: transitions };
}

/**
 * ROCAA-180: Preferred tier-signal extractor.
 *
 * Reads the top-level `result.tierUsed` / `result.tierTransitions` /
 * `result.classifierVersion` shipped by ROCAA-28's adapter boundary. Also
 * pulls `meta.failoverEvent` so a Tier 0→Tier 1 transition that occurred
 * inside the adapter wiring shows up as a transition row even if the result
 * happens to claim Tier 0 (it shouldn't, but be defensive).
 *
 * When the result-side fields are absent — e.g. legacy adapters or mocks —
 * falls back to the meta-side `extractTierFromMeta` for back-compat.
 */
export function extractTierSignal(
  result: TierAwareResult | null | undefined,
  meta: Pick<AdapterInvocationMeta, "context" | "failoverEvent"> = {},
): TierMetaExtract {
  const resultTier = tierIdToNumber(result?.tierUsed ?? null);
  const failover = meta.failoverEvent;

  const hasResultSignal =
    resultTier !== null ||
    (Array.isArray(result?.tierTransitions) && result!.tierTransitions!.length > 0) ||
    failover != null;

  if (!hasResultSignal) {
    return extractTierFromMeta(meta);
  }

  const transitions: TierTransition[] = [];
  if (Array.isArray(result?.tierTransitions)) {
    for (const t of result!.tierTransitions!) {
      const toTier = tierIdToNumber(t?.to ?? null);
      if (toTier === null) continue;
      transitions.push({
        tier: toTier,
        errorReason: normalizeReason(t?.reason),
      });
    }
  }
  // If the result didn't include a transitions array but the meta carries a
  // failoverEvent, synthesize one entry. (Defensive — adapter wiring is
  // expected to populate both.)
  if (transitions.length === 0 && failover) {
    const toTier = tierIdToNumber(failover.to);
    if (toTier !== null) {
      transitions.push({
        tier: toTier,
        errorReason: normalizeReason(failover.reason),
      });
    }
  }

  // Prefer the result's claim; if absent, infer from failoverEvent.to; else
  // fall through to meta.context.
  let tierUsed = resultTier;
  if (tierUsed === null && failover) {
    tierUsed = tierIdToNumber(failover.to);
  }
  if (tierUsed === null) {
    tierUsed = extractTierFromMeta(meta).tierUsed;
  }

  const classifierVersion =
    typeof result?.classifierVersion === "string" && result.classifierVersion.length > 0
      ? result.classifierVersion.slice(0, 64)
      : null;

  return {
    tierUsed: Math.max(0, Math.min(4, tierUsed)),
    tierTransitions: transitions,
    classifierVersion,
  };
}

export interface RecordInvocationParams {
  store: ObservabilityStore;
  meta: TierMeta;
  /** ROCAA-180: top-level adapter result; preferred source of tier signal. */
  result?: TierAwareResult | null;
  agent: { id: string; companyId: string; name?: string | null };
  runId: string;
  issueId?: string | null;
  startedAt: Date;
  endedAt: Date;
  /** From `adapterResult.usage.inputTokens + outputTokens` (cached counted toward in). */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Adapter-reported cost in USD; falls back to 0. */
  costEstimateUsd?: number | null;
  /** Optional override; otherwise derived via `extractTierSignal(result, meta)`. */
  tierOverride?: TierMetaExtract;
  /** Optional metadata to keep alongside the row for forensics. Heavy fields
   *  like `prompt`/`env` are stripped here. */
  rawMetaExtras?: Record<string, unknown>;
}

function sanitizeRawMeta(meta: TierMeta): Record<string, unknown> {
  const ctx = (meta.context ?? {}) as Record<string, unknown>;
  // Keep only safe-to-store keys. Drop `env`, `prompt`, `commandArgs` which
  // can carry secrets or oversized payloads.
  return {
    adapterType: meta.adapterType,
    command: meta.command,
    cwd: meta.cwd ?? null,
    authSource: meta.authSource ?? null,
    authDriftDetected: meta.authDriftDetected ?? false,
    authDriftReasons: meta.authDriftReasons ?? [],
    commandNotes: meta.commandNotes ?? [],
    promptMetrics: meta.promptMetrics ?? null,
    failoverEvent: meta.failoverEvent ?? null,
    context: {
      tier: ctx["tier"] ?? null,
      tierTransitions: ctx["tierTransitions"] ?? ctx["tier_transitions"] ?? null,
      model: ctx["model"] ?? null,
    },
  };
}

/**
 * Build the row that would be inserted, without performing the write.
 * Useful for unit tests + dry-run callers.
 */
export function buildInvocationRecord(params: RecordInvocationParams): AgentInvocationRecord {
  const { meta, result, agent, runId, issueId, startedAt, endedAt } = params;
  const tier = params.tierOverride ?? extractTierSignal(result ?? null, meta);
  const latencyMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
  const tokensIn = params.tokensIn ?? null;
  const tokensOut = params.tokensOut ?? null;
  const tokensUsed =
    tokensIn !== null || tokensOut !== null ? (tokensIn ?? 0) + (tokensOut ?? 0) : null;

  const raw = sanitizeRawMeta(meta);
  if (tier.classifierVersion) {
    raw["classifierVersion"] = tier.classifierVersion;
  }
  if (params.rawMetaExtras) Object.assign(raw, params.rawMetaExtras);

  return {
    recordedAt: endedAt.toISOString(),
    companyId: agent.companyId,
    agentId: agent.id,
    agentName: agent.name ?? null,
    issueId: issueId ?? null,
    runId,
    adapterType: meta.adapterType,
    tierUsed: tier.tierUsed,
    tierTransitions: tier.tierTransitions,
    costEstimateUsd: Math.max(0, params.costEstimateUsd ?? 0),
    latencyMs,
    tokensUsed,
    tokensIn,
    tokensOut,
    authSource: meta.authSource ?? null,
    rawMeta: raw,
  };
}

/**
 * Best-effort record. Never throws; logs and swallows. Returns true on a
 * successful insert attempt (which itself is silent), false on no-op.
 */
export function recordInvocation(params: RecordInvocationParams): boolean {
  if (!params.store.enabled) return false;
  try {
    const record = buildInvocationRecord(params);
    params.store.recordInvocation(record);
    return true;
  } catch (err) {
    logger.warn(
      {
        error: err instanceof Error ? err.message : String(err),
        agentId: params.agent.id,
        runId: params.runId,
      },
      "tier observability record failed",
    );
    return false;
  }
}
