import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";
import type { ServerAdapterModule } from "../adapters/types.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * How long a successful quota result is reused. The Costs page route and the
 * pacing controller both read quota through fetchAllQuotaWindows(), so each
 * provider gets about one request per minute at most, however many callers
 * there are. Provider usage endpoints rate limit fast polling
 * (https://github.com/paperclipai/paperclip/issues/14096).
 */
export const QUOTA_WINDOWS_CACHE_TTL_MS = 60_000;

/**
 * How long a failed quota result is reused. A failure is often transient (a
 * timeout or a 429), so it is kept only long enough to absorb a burst of
 * callers. A full TTL would pin the failure and keep fresh data from pacing
 * for a minute after the provider recovers.
 */
export const QUOTA_WINDOWS_ERROR_CACHE_TTL_MS = 10_000;

interface CachedQuotaResult {
  result: ProviderQuotaResult;
  fetchedAtMs: number;
}

// Keyed by adapter type. Module scope, so every route and the pacing
// controller in this process share one cache and one in-flight request.
const cachedResults = new Map<string, CachedQuotaResult>();
const inFlightFetches = new Map<string, Promise<CachedQuotaResult>>();

/** Provider slug that quota results use for an adapter type. */
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
 * Returns the quota windows of each registered adapter that implements
 * getQuotaWindows(); other adapters are skipped. This is the only path to
 * live provider quota data. Concurrent callers share one in-flight request
 * per adapter, and a result fetched less than QUOTA_WINDOWS_CACHE_TTL_MS ago
 * (QUOTA_WINDOWS_ERROR_CACHE_TTL_MS for a failure) is served from the cache.
 * Each result carries `fetchedAt`, the time its provider answered.
 * A failing or slow adapter yields an error result rather than blocking the
 * other providers.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((adapter) => adapter.getQuotaWindows != null);
  const entries = await Promise.all(adapters.map((adapter) => sharedAdapterQuota(adapter)));
  return entries.map((entry) => entry.result);
}

/** Clears the shared quota cache. Tests only. */
export function resetQuotaWindowsCacheForTests(): void {
  cachedResults.clear();
  inFlightFetches.clear();
}

function isFresh(entry: CachedQuotaResult, nowMs: number): boolean {
  const ttlMs = entry.result.ok ? QUOTA_WINDOWS_CACHE_TTL_MS : QUOTA_WINDOWS_ERROR_CACHE_TTL_MS;
  return nowMs - entry.fetchedAtMs < ttlMs;
}

function sharedAdapterQuota(adapter: ServerAdapterModule): Promise<CachedQuotaResult> {
  const cached = cachedResults.get(adapter.type);
  if (cached && isFresh(cached, Date.now())) return Promise.resolve(cached);
  const pending = inFlightFetches.get(adapter.type);
  if (pending) return pending;

  const request = fetchAdapterQuota(adapter)
    .then((result): CachedQuotaResult => {
      const fetchedAtMs = Date.now();
      const entry = { result: { ...result, fetchedAt: new Date(fetchedAtMs).toISOString() }, fetchedAtMs };
      cachedResults.set(adapter.type, entry);
      return entry;
    })
    .finally(() => {
      inFlightFetches.delete(adapter.type);
    });
  inFlightFetches.set(adapter.type, request);
  return request;
}

/** One adapter's quota result. Never rejects: a failure becomes an error result. */
async function fetchAdapterQuota(adapter: ServerAdapterModule): Promise<ProviderQuotaResult> {
  try {
    return await withQuotaTimeout(adapter.type, adapter.getQuotaWindows!());
  } catch (err) {
    return {
      provider: providerSlugForAdapterType(adapter.type),
      ok: false,
      error: String(err),
      windows: [],
    };
  }
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
