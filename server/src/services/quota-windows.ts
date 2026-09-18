import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * How long a provider quota snapshot stays fresh for enforcement reads.
 * Provider usage endpoints are rate limited (the Anthropic OAuth usage endpoint
 * allows about one read per minute per account, shared with every other client
 * of that account), and the Claude CLI fallback runs a multi-second terminal
 * probe, so enforcement never fetches on every dispatch and the default
 * cadence stays well under that ceiling.
 */
export const QUOTA_SNAPSHOT_TTL_MS = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_TTL_MS", 120_000);

/**
 * How soon a throttled read (HTTP 429) is retried, and how many such retries
 * one refresh cycle may make before waiting out the full TTL. A 429 means the
 * endpoint is healthy and another client used this minute's read, so a short
 * wait usually clears it; the cap keeps a sustained throttle from turning into
 * the retry loops that public reports say can get a token flagged.
 */
export const QUOTA_SNAPSHOT_THROTTLE_RETRY_MS = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_THROTTLE_RETRY_MS", 20_000);
export const QUOTA_SNAPSHOT_THROTTLE_RETRIES = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_THROTTLE_RETRIES", 2);

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

/** One provider window observed outside the probe, e.g. from a live run's stream. */
export type QuotaWindowObservation = {
  provider: string;
  window: QuotaWindow;
  observedAt: Date;
  /** Where the observation came from, recorded as the row's source when it starts one. */
  source?: string | null;
};

export type QuotaSnapshotReader = ((input?: { now?: Date }) => Promise<QuotaSnapshot>) & {
  /**
   * Folds an observation into the snapshot immediately: the provider's last
   * good row gains or replaces that window, is stamped with the observation
   * time, and stands as a fresh (not stale) result until the next probe.
   */
  observe?: (observation: QuotaWindowObservation) => void;
};

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
export function isRateLimitedQuotaResult(result: ProviderQuotaResult): boolean {
  if (result.ok) return false;
  if (result.rateLimited === true) return true;
  return typeof result.error === "string" && /\b429\b/.test(result.error);
}

export function createQuotaSnapshotReader(options: {
  fetch?: () => Promise<ProviderQuotaResult[]>;
  ttlMs?: number;
  maxStaleMs?: number;
  throttleRetryMs?: number;
  maxThrottleRetries?: number;
} = {}): QuotaSnapshotReader {
  const fetch = options.fetch ?? fetchAllQuotaWindows;
  const ttlMs = options.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? QUOTA_SNAPSHOT_MAX_STALE_MS;
  const throttleRetryMs = options.throttleRetryMs ?? QUOTA_SNAPSHOT_THROTTLE_RETRY_MS;
  const maxThrottleRetries = options.maxThrottleRetries ?? QUOTA_SNAPSHOT_THROTTLE_RETRIES;
  let cached: QuotaSnapshot | null = null;
  /** When the cached snapshot may be refreshed: the TTL, or sooner after a throttle. */
  let refreshAt = 0;
  let throttleRetries = 0;
  let inFlight: Promise<QuotaSnapshot> | null = null;
  /** Last ok result per provider, reused while that provider's refresh fails. */
  const lastGood = new Map<string, ProviderQuotaResult>();
  /**
   * Windows observed from live runs, per provider and window key, with the
   * time each was observed. A probe's data is as old as the moment the probe
   * started, so a window observed after that moment outranks the probe's copy
   * of it; older observations are dropped once a probe supersedes them.
   */
  const harvested = new Map<string, Map<string, { window: QuotaWindow; observedAt: number }>>();

  function mergeNewerObservations(result: ProviderQuotaResult, probeStartedAt: Date): QuotaWindow[] {
    const newer = harvested.get(result.provider);
    if (!newer) return result.windows;
    let windows = result.windows;
    for (const [key, entry] of newer) {
      if (entry.observedAt <= probeStartedAt.getTime()) {
        newer.delete(key);
        continue;
      }
      windows = windows.filter((window) => window.key !== key);
      windows.push(entry.window);
    }
    return windows;
  }

  function reconcile(results: ProviderQuotaResult[], fetchedAt: Date, probeStartedAt: Date): ProviderQuotaResult[] {
    const observedAt = fetchedAt.toISOString();
    return results.map((result) => {
      if (result.ok) {
        const fresh: ProviderQuotaResult = {
          ...result,
          windows: mergeNewerObservations(result, probeStartedAt),
          observedAt,
        };
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
        rateLimited: result.rateLimited === true,
      };
    });
  }

  function observe(observation: QuotaWindowObservation) {
    const observedAt = observation.observedAt.toISOString();
    const key = observation.window.key ?? "";
    const perProvider = harvested.get(observation.provider) ?? new Map();
    perProvider.set(key, { window: observation.window, observedAt: observation.observedAt.getTime() });
    harvested.set(observation.provider, perProvider);
    const previous = lastGood.get(observation.provider);
    const windows = (previous?.windows ?? []).filter((window) => window.key !== observation.window.key);
    windows.push(observation.window);
    const fresh: ProviderQuotaResult = {
      provider: observation.provider,
      ok: true,
      source: previous?.source ?? observation.source ?? null,
      windows,
      observedAt,
    };
    lastGood.set(observation.provider, fresh);
    // Readers see it at once. The probe schedule is untouched: a run's stream
    // reports one window at a time, so the probe still fills in the rest.
    const results = (cached?.results ?? []).filter((row) => row.provider !== observation.provider);
    results.push(fresh);
    cached = { results, fetchedAt: cached?.fetchedAt ?? observation.observedAt };
  }

  const read: QuotaSnapshotReader = async (input = {}) => {
    const now = input.now ?? new Date();
    if (cached && now.getTime() < refreshAt) return cached;
    if (inFlight) return inFlight;
    const probeStartedAt = new Date();
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
        const throttled = results.some(isRateLimitedQuotaResult);
        if (throttled && throttleRetries < maxThrottleRetries) {
          throttleRetries += 1;
          refreshAt = fetchedAt.getTime() + throttleRetryMs;
        } else {
          throttleRetries = 0;
          refreshAt = fetchedAt.getTime() + ttlMs;
        }
        const snapshot: QuotaSnapshot = { results: reconcile(results, fetchedAt, probeStartedAt), fetchedAt };
        cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  read.observe = observe;
  return read;
}

let sharedQuotaSnapshotReader: QuotaSnapshotReader | null = null;

/** Process-wide memoized quota reader used by budget enforcement and summaries. */
export function readQuotaSnapshot(input?: { now?: Date }): Promise<QuotaSnapshot> {
  sharedQuotaSnapshotReader ??= createQuotaSnapshotReader();
  return sharedQuotaSnapshotReader(input);
}

/** Folds an observation into the process-wide snapshot (see QuotaSnapshotReader.observe). */
export function observeQuotaWindow(observation: QuotaWindowObservation): void {
  sharedQuotaSnapshotReader ??= createQuotaSnapshotReader();
  sharedQuotaSnapshotReader.observe?.(observation);
}

/** Claude Code `rate_limit_event` window types that map onto known quota windows. */
const CLAUDE_RATE_LIMIT_WINDOWS: Record<string, { key: string; label: string }> = {
  five_hour: { key: "five_hour", label: "Current session" },
  seven_day: { key: "seven_day", label: "Current week (all models)" },
  seven_day_sonnet: { key: "seven_day_sonnet", label: "Current week (Sonnet only)" },
  seven_day_opus: { key: "seven_day_opus", label: "Current week (Opus only)" },
};

function rateLimitPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  // The SDK reports utilization as the API's ratio, so at most 1 means a
  // fraction; larger values are already percents (a defensive reading).
  const percent = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.round(percent));
}

function rateLimitResetsAt(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Epoch seconds unless it already looks like milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Normalizes Claude Code's `rate_limit_info` (from the SDK's `rate_limit_event`,
 * forwarded by the Claude ACP bridge as usage-update meta) into a quota
 * window. Overage and unknown window types yield null.
 */
export function claudeRateLimitInfoToWindow(info: Record<string, unknown>): QuotaWindow | null {
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  const known = type ? CLAUDE_RATE_LIMIT_WINDOWS[type] : undefined;
  if (!known) return null;
  return {
    key: known.key,
    label: known.label,
    usedPercent: rateLimitPercent(info.utilization),
    resetsAt: rateLimitResetsAt(info.resetsAt),
    valueLabel: null,
    detail: null,
  };
}

const CLAUDE_RUN_STREAM_SOURCE = "claude-run-stream";
const harvestedProviderWindows = new Set<string>();

/**
 * Records a Claude rate-limit observation from a live run against `provider`.
 * Returns the window it became, and whether this process has seen that
 * provider window before, so the caller can log the first one for operators
 * to confirm the payload's scale.
 */
export function observeClaudeRateLimitInfo(
  provider: string,
  info: Record<string, unknown>,
  observedAt: Date,
): { window: QuotaWindow; first: boolean } | null {
  const window = claudeRateLimitInfoToWindow(info);
  if (!window || window.usedPercent == null) return null;
  observeQuotaWindow({ provider, window, observedAt, source: CLAUDE_RUN_STREAM_SOURCE });
  const seenKey = `${provider}:${window.key}`;
  const first = !harvestedProviderWindows.has(seenKey);
  harvestedProviderWindows.add(seenKey);
  return { window, first };
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
