import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * How long a provider quota snapshot stays fresh for enforcement reads.
 * Provider usage endpoints are rate limited, and the Claude CLI fallback runs a
 * multi-second terminal probe, so enforcement never fetches on every dispatch.
 */
export const QUOTA_SNAPSHOT_TTL_MS = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_TTL_MS", 60_000);

/**
 * How long the last successful read of a provider keeps standing in for a
 * failed refresh. The Anthropic usage endpoint is rate limited and the Claude
 * CLI fallback scrapes a terminal, so single reads fail now and then; without
 * this bound each blip would report the provider as unknown for one TTL and
 * flip budget summaries between a measured percent and "unavailable". A
 * provider that stays unreadable past this bound is reported as unavailable.
 * The dispatch gate never clears a run on a stale result (it may only defer
 * on one), so the reuse serves the summaries; unreadable and stale-below-limit
 * usage both hold runs under a limit for a re-check.
 */
export const QUOTA_SNAPSHOT_MAX_STALE_MS = readPositiveIntEnv(
  "PAPERCLIP_QUOTA_SNAPSHOT_MAX_STALE_MS",
  10 * 60_000,
);

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

export type QuotaSnapshot = {
  results: ProviderQuotaResult[];
  fetchedAt: Date;
};

export type QuotaSnapshotReader = (input?: { now?: Date }) => Promise<QuotaSnapshot>;

function parseObservedAt(result: ProviderQuotaResult): number | null {
  if (!result.observedAt) return null;
  const parsed = new Date(result.observedAt).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Builds a memoized reader over `fetchAllQuotaWindows`. One fetch is shared by
 * all concurrent callers, and the result is reused until `ttlMs` has elapsed.
 * The reader never throws: a failed fetch yields per-provider `ok: false` rows,
 * which the gate treats as unknown usage (runs under a limit wait for a
 * re-check; scopes without a limit proceed).
 *
 * A provider whose refresh fails keeps its last successful result, marked
 * `stale` and carrying the new error, until that result is older than
 * `maxStaleMs`. Every ok row is stamped with `observedAt` so consumers can say
 * how old the usage is.
 */
export function createQuotaSnapshotReader(options: {
  fetch?: () => Promise<ProviderQuotaResult[]>;
  ttlMs?: number;
  maxStaleMs?: number;
} = {}): QuotaSnapshotReader {
  const fetch = options.fetch ?? fetchAllQuotaWindows;
  const ttlMs = options.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? QUOTA_SNAPSHOT_MAX_STALE_MS;
  let cached: QuotaSnapshot | null = null;
  let inFlight: Promise<QuotaSnapshot> | null = null;
  /** Last ok result per provider, reused while that provider's refresh fails. */
  const lastGood = new Map<string, ProviderQuotaResult>();

  function reconcile(results: ProviderQuotaResult[], fetchedAt: Date): ProviderQuotaResult[] {
    const observedAt = fetchedAt.toISOString();
    return results.map((result) => {
      if (result.ok) {
        const fresh: ProviderQuotaResult = { ...result, observedAt };
        lastGood.set(result.provider, fresh);
        return fresh;
      }
      const previous = lastGood.get(result.provider);
      const previousObservedAt = previous ? parseObservedAt(previous) : null;
      if (
        !previous
        || previousObservedAt == null
        || fetchedAt.getTime() - previousObservedAt >= maxStaleMs
      ) {
        lastGood.delete(result.provider);
        return result;
      }
      return {
        ...previous,
        stale: true,
        error: result.error,
        errorFamily: result.errorFamily ?? null,
      };
    });
  }

  return async (input = {}) => {
    const now = input.now ?? new Date();
    if (cached && now.getTime() - cached.fetchedAt.getTime() < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = fetch()
      .then(
        (results) => results,
        (error: unknown): ProviderQuotaResult[] => {
          // The whole fetch threw, so no provider reported anything. Report the
          // failure against every provider we have seen so their last good
          // read can stand in; with no history there is nothing to attribute.
          const failure = { ok: false as const, error: String(error), windows: [] };
          const known = [...lastGood.keys()];
          return known.length > 0
            ? known.map((provider) => ({ provider, ...failure }))
            : [{ provider: "unknown", ...failure }];
        },
      )
      .then((results) => {
        const fetchedAt = new Date();
        const snapshot: QuotaSnapshot = { results: reconcile(results, fetchedAt), fetchedAt };
        cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

let sharedQuotaSnapshotReader: QuotaSnapshotReader | null = null;

/** Process-wide memoized quota reader used by budget enforcement and summaries. */
export function readQuotaSnapshot(input?: { now?: Date }): Promise<QuotaSnapshot> {
  sharedQuotaSnapshotReader ??= createQuotaSnapshotReader();
  return sharedQuotaSnapshotReader(input);
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
