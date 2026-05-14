import fs from "node:fs";
import path from "node:path";

/**
 * Cross-process advisory lock around shared-state file writes on the
 * shared `/paperclip/.ccrotate` PVC. The lock filename matches ccrotate's
 * own `withCcrotateLock` (lib/state-helpers.js) so this writer and
 * ccrotate's own writers serialize on the same lock.
 *
 * Contract is the file format + lock filename, not the code. If you change
 * the lock path, change it in ccrotate too. If you change the tier-cache
 * schema, update both writers.
 *
 * Async to avoid blocking the event loop while waiting for a contended
 * lock. The previous sync implementation used a 50ms busy-wait loop which,
 * under contention with the auth-bot's pool-sweep refresh, blocked the
 * paperclip server's /healthz long enough to fail the kubelet's 1s probe
 * (observed 2026-05-09 ~04:55Z).
 */
export async function withCcrotateLock<T>(
  profilesDir: string,
  fn: () => T | Promise<T>,
  opts: { timeout?: number; staleMs?: number } = {},
): Promise<T> {
  const lockPath = path.join(profilesDir, ".active-files.lock");
  const timeout = opts.timeout ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const sleepMs = 50;
  const start = Date.now();
  let fd: number | undefined;

  try {
    fs.mkdirSync(profilesDir, { recursive: true });
  } catch {
    // best-effort
  }

  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch {
        // metadata best-effort
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // race with concurrent reclaim
        }
        continue;
      }
    } catch {
      // file disappeared; retry
    }
    if (Date.now() - start > timeout) {
      throw new Error(`ccrotate: timed out waiting for ${lockPath} after ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  try {
    return await fn();
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

interface RateLimits {
  utilization5h?: number | null;
  utilization7d?: number | null;
  reset5h?: number | null;
  reset7d?: number | null;
  resetAt?: string | null;
  snapshotCapturedAt?: string | null;
  [key: string]: unknown;
}

export interface TierCacheEntry {
  email: string;
  status?: string;
  serviceTier?: string | null;
  response?: string | null;
  result?: string | null;
  rateLimits?: RateLimits | null;
}

export interface TierCache {
  updatedAt: string | null;
  accounts: TierCacheEntry[];
}

export type TierCacheTarget = "claude" | "codex";

function tierCacheFilename(target: TierCacheTarget): string {
  return target === "claude" ? "tier-cache.json" : "tier-cache.codex.json";
}

/**
 * Refresh window for trusting existing utilization data when deciding
 * whether a runtime quota burn looks like a real cap hit. If the cache
 * was probed within this window and shows both 5h and 7d well below
 * cap, the burn is likely non-cap (overage credits out, transient
 * concurrent limit, content filter) and we should NOT flip the account
 * out of rotation.
 */
const UTILIZATION_FRESHNESS_MS = 30 * 60 * 1000;

/**
 * Threshold below which an existing utilization% counts as "well below cap".
 * Matches the gate in ccrotate's account-table.js#isUsableNow.
 */
const NOT_AT_CAP_PCT = 95;

export interface MarkAccountExhaustedResult {
  skipped: boolean;
  reason?: string;
  email?: string;
  utilization5h?: number | null;
  utilization7d?: number | null;
  snapshotAgeMs?: number;
}

/**
 * Atomically mark an account as `serviceTier: 'exhausted'` in the shared
 * tier-cache for `target`. Captures runtime quota-failure events observed
 * by the orchestrator (paperclip-server) — the reset epoch comes from the
 * adapter's `retryNotBefore`, so subsequent `ccrotate next` invocations
 * skip this account in candidate scoring (next.js stale-and-tier filter).
 *
 * Without this writeback, runtime quota burns are invisible to the pool's
 * state machine: ccrotate's own probe (testAccountViaMessages) is throttled
 * by Anthropic's per-org Usage API rate limit, so tier-cache stays "unknown"
 * while the runtime is observing the same burns and dropping the data on
 * the floor. Pool spirals into a retry storm. Real incident 2026-05-08.
 *
 * Guard against false positives: if the cache entry has FRESH utilization
 * data showing both rolling windows below 95%, the burn is likely NOT from
 * a real cap (overage credits out, transient concurrent limit, content
 * filter). In that case we skip the write and return `{skipped: true}` so
 * the caller can log/instrument. Real incident 2026-05-13:
 * `ramadan@blockcast.net` (5h:6% 7d:1%) and `omar.ramadan93@blockcast.net`
 * (5h:87% 7d:53%) both flipped to 'exhausted' by this writeback path,
 * collapsing the pool to 1 viable account.
 */
export async function markAccountExhausted(
  profilesDir: string,
  email: string,
  fields: {
    target?: TierCacheTarget;
    reset5h?: number | null;
    reset7d?: number | null;
    response?: string | null;
  } = {},
): Promise<MarkAccountExhaustedResult> {
  const target = fields.target ?? "claude";
  const reset5h = fields.reset5h ?? null;
  const reset7d = fields.reset7d ?? null;
  const response = fields.response ?? null;

  return await withCcrotateLock(profilesDir, () => {
    const tierCachePath = path.join(profilesDir, tierCacheFilename(target));

    let cache: TierCache = { updatedAt: null, accounts: [] };
    try {
      const raw = fs.readFileSync(tierCachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TierCache>;
      cache = {
        updatedAt: parsed.updatedAt ?? null,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      };
    } catch {
      // fresh cache
    }

    const existing = cache.accounts.find((a) => a.email === email);

    // Guard: only mark exhausted when we DON'T have fresh evidence the
    // account is well below cap. Stale data or at-cap utilization both
    // fall through to the write path.
    const existingRl = existing?.rateLimits ?? {};
    const u5h = (existingRl as { utilization5h?: number | null }).utilization5h;
    const u7d = (existingRl as { utilization7d?: number | null }).utilization7d;
    const snapshotAtStr = (existingRl as { snapshotCapturedAt?: string | null }).snapshotCapturedAt;
    const snapshotAt = snapshotAtStr ? Date.parse(snapshotAtStr) : NaN;
    const dataAgeMs = Number.isFinite(snapshotAt) ? Date.now() - snapshotAt : Infinity;
    const utilizationIsFreshAndLow =
      dataAgeMs <= UTILIZATION_FRESHNESS_MS &&
      typeof u5h === "number" && u5h < NOT_AT_CAP_PCT &&
      typeof u7d === "number" && u7d < NOT_AT_CAP_PCT;
    if (utilizationIsFreshAndLow) {
      return {
        skipped: true,
        reason: "utilization below cap on fresh data",
        email,
        utilization5h: u5h,
        utilization7d: u7d,
        snapshotAgeMs: dataAgeMs,
      } satisfies MarkAccountExhaustedResult;
    }

    const others = cache.accounts.filter((a) => a.email !== email);
    const resetEpoch = reset5h ?? reset7d;
    const fallbackResp = resetEpoch
      ? `quota exhausted; resets at ${new Date(resetEpoch * 1000).toISOString()}`
      : "quota exhausted";

    const entry: TierCacheEntry = {
      email,
      status: "success",
      serviceTier: "exhausted",
      response: response ?? existing?.response ?? fallbackResp,
      rateLimits: {
        ...(existing?.rateLimits ?? {}),
        ...(reset5h != null ? { reset5h } : {}),
        ...(reset7d != null ? { reset7d } : {}),
        snapshotCapturedAt: new Date().toISOString(),
      },
    };

    const next: TierCache = {
      updatedAt: new Date().toISOString(),
      accounts: others.concat(entry),
    };

    const tmp = `${tierCachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, tierCachePath);
    return { skipped: false, email } satisfies MarkAccountExhaustedResult;
  });
}
