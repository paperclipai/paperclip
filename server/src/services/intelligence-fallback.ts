/**
 * Intelligence fallback chain: when a run fails because the current intelligence
 * source is exhausted by a provider quota / rate limit, the executor retries the
 * run against the next configured source (a second Claude subscription — just a
 * different auth `env` — or a different provider such as Codex — a different
 * `adapterType`). Selection is a pure function of the agent's configured chain
 * and how many sources have already been attempted for this piece of work.
 *
 * Strict shape validation lives in `agentRuntimeConfigSchema`
 * (packages/shared/src/validators/agent.ts) and runs when the agent is written;
 * this module only reads the already-validated config structurally, so it stays
 * free of the shared validator barrel (and its runtime import cost).
 */

/** Maximum fallback sources honoured, mirroring the write-time schema cap. */
export const MAX_FALLBACK_SOURCES = 4;

/** A resolved source the executor should run a single attempt against. */
export interface FallbackSourceOverride {
  /** 1-based position in the chain (source 0 is the agent's default). */
  index: number;
  adapterType: string;
  model?: string;
  effort?: string;
  env?: Record<string, unknown>;
  label?: string;
}

/** One configured source in an agent's fallback chain. */
export interface FallbackSourceSpec {
  adapterType: string;
  model?: string;
  effort?: string;
  env?: Record<string, unknown>;
  label?: string;
}

/** Marker persisted on a retry run's context so the executor applies the source. */
export const FALLBACK_SOURCE_CONTEXT_KEY = "intelligenceFallbackSource" as const;

/**
 * Error codes that mean "this intelligence source is exhausted, try the next
 * one". Deliberately narrow: only provider quota / rate-limit exhaustion, never
 * budget exhaustion (a deliberate spend cap, not a source problem) and never a
 * real adapter/code failure — those must surface, not silently switch sources.
 */
export function isSourceExhaustionFailure(input: {
  errorCode: string | null | undefined;
  errorFamily: string | null | undefined;
}): boolean {
  return input.errorCode === "provider_quota" || input.errorFamily === "provider_quota";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read an agent's configured fallback chain from its (already write-validated)
 * runtimeConfig, tolerating loose/absent input. Structural read only — entries
 * missing an adapterType are dropped and the chain is capped.
 */
export function readFallbackChain(runtimeConfig: unknown): FallbackSourceSpec[] {
  const config = readOptionalObject(runtimeConfig);
  const raw = config?.fallbackChain;
  if (!Array.isArray(raw)) return [];
  const chain: FallbackSourceSpec[] = [];
  for (const entry of raw) {
    const record = readOptionalObject(entry);
    const adapterType = record ? readOptionalString(record.adapterType) : undefined;
    if (!adapterType) continue;
    chain.push({
      adapterType,
      model: readOptionalString(record?.model),
      effort: readOptionalString(record?.effort),
      env: readOptionalObject(record?.env),
      label: readOptionalString(record?.label),
    });
    if (chain.length >= MAX_FALLBACK_SOURCES) break;
  }
  return chain;
}

/**
 * Pick the next source to try. `attemptedSourceIndex` is the 0-based index of the
 * source that just ran (0 = the agent's default, 1 = first fallback, …). Returns
 * the next source with its 1-based chain position, or null when the chain is
 * exhausted. The chain is bounded (max 4), so this always terminates.
 *
 * Only same-provider sources (matching `currentAdapterType`) can be executed today
 * — a cross-provider switch reworks session handling and is a deferred follow-up.
 * So a cross-provider entry is SKIPPED, not stalled on: selection walks past it to
 * the next same-provider source and returns that source's real chain position. This
 * keeps a later supported subscription reachable even when a deferred cross-provider
 * entry sits ahead of it in the chain.
 */
export function selectNextFallbackSource(
  chain: FallbackSourceSpec[],
  attemptedSourceIndex: number,
  currentAdapterType: string,
): FallbackSourceOverride | null {
  // chain[0] is the FIRST fallback, i.e. it serves attemptedSourceIndex 0 (the
  // default). So the next source after attempt N lives at chain[N] onward.
  for (let pos = Math.max(0, attemptedSourceIndex); pos < chain.length; pos++) {
    const next = chain[pos];
    // Skip a deferred cross-provider source and keep looking for a runnable one,
    // so its 1-based index advances past the skipped entry on the next round too.
    if (next.adapterType !== currentAdapterType) continue;
    return { index: pos + 1, ...next };
  }
  return null;
}

/**
 * Overlay a same-provider fallback source's model/effort/env onto an adapter
 * config for a retry. Returns the config unchanged when there is no override or
 * the override targets a different adapter (cross-provider fallback is executed
 * elsewhere, not by a config overlay). The override's env wins key-by-key, so a
 * fallback source can swap the auth token (e.g. CLAUDE_CODE_OAUTH_TOKEN) while
 * inheriting the rest of the agent's env.
 */
export function applyFallbackSourceToConfig(
  config: Record<string, unknown>,
  override: FallbackSourceOverride | null,
  currentAdapterType: string,
): Record<string, unknown> {
  if (!override || override.adapterType !== currentAdapterType) return config;
  const baseEnv = readOptionalObject(config.env) ?? {};
  const next: Record<string, unknown> = { ...config };
  if (override.model !== undefined) next.model = override.model;
  if (override.effort !== undefined) next.effort = override.effort;
  if (override.env && Object.keys(override.env).length > 0) {
    next.env = { ...baseEnv, ...override.env };
  }
  return next;
}

/** Parse a persisted source override off a run's context snapshot, if present. */
export function readFallbackSourceOverride(contextSnapshot: unknown): FallbackSourceOverride | null {
  const snapshot = readOptionalObject(contextSnapshot);
  const value = snapshot ? readOptionalObject(snapshot[FALLBACK_SOURCE_CONTEXT_KEY]) : undefined;
  if (!value) return null;
  const adapterType = readOptionalString(value.adapterType);
  const index = typeof value.index === "number" && Number.isInteger(value.index) ? value.index : null;
  if (!adapterType || index === null || index < 1) return null;
  return {
    index,
    adapterType,
    model: readOptionalString(value.model),
    effort: readOptionalString(value.effort),
    env: readOptionalObject(value.env),
    label: readOptionalString(value.label),
  };
}
