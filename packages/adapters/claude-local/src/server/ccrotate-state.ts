import fs from "node:fs";
import path from "node:path";

/**
 * Cross-process advisory lock around shared-state file writes on the
 * shared `/paperclip/.ccrotate` PVC. The lock filename is intentionally
 * identical to the one ccrotate uses (`ccrotate/lib/state-helpers.js`
 * `withCcrotateLock`), so this writer and ccrotate's own writers
 * serialize on the SAME POSIX advisory lock.
 *
 * The contract here is the file format + lock filename, not the code.
 * If you change the lock path, change it in ccrotate too. If you change
 * the tier-cache schema, update both writers.
 *
 * Implementation matches ccrotate exactly: O_CREAT | O_EXCL with
 * busy-retry, stale-lock reclaim after `staleMs`, synchronous spin
 * (this runs in a short-lived adapter call path; busy-wait blocks only
 * the heartbeat run that already failed).
 */
export function withCcrotateLock<T>(
  profilesDir: string,
  fn: () => T,
  opts: { timeout?: number; staleMs?: number } = {},
): T {
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
    const sleepUntil = Date.now() + sleepMs;
    while (Date.now() < sleepUntil) {
      // synchronous spin
    }
  }

  try {
    return fn();
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

interface TierCacheEntry {
  email: string;
  status?: string;
  serviceTier?: string | null;
  response?: string | null;
  result?: string | null;
  rateLimits?: RateLimits | null;
}

interface TierCache {
  updatedAt: string | null;
  accounts: TierCacheEntry[];
}

/**
 * Atomically mark an account as `serviceTier: 'exhausted'` in the
 * shared tier-cache.json. Captures runtime quota-failure events
 * observed by claude-local — the reset epoch came from
 * `extractClaudeRetryNotBefore` parsing claude's
 * "out of extra usage · resets 4pm" text — so subsequent
 * `ccrotate next` invocations skip this account in candidate scoring
 * (next.js:92-108 already filters `serviceTier === 'exhausted'`).
 *
 * Without this writeback, runtime quota burns are invisible to the
 * pool's state machine: ccrotate's own probe (testAccountViaMessages)
 * is throttled by Anthropic's per-org Usage API rate limit, so
 * tier-cache stays "unknown" while the runtime is observing the same
 * burns and dropping the data on the floor. Pool spirals into a retry
 * storm, rotating between exhausted accounts that all look "no per-
 * account data" to next.js.
 *
 * Real incident 2026-05-08: pool depleted; runtime quota burns not
 * captured; agents storm.
 */
export function markAccountExhausted(
  profilesDir: string,
  email: string,
  fields: { reset5h?: number | null; reset7d?: number | null; response?: string | null } = {},
): void {
  const reset5h = fields.reset5h ?? null;
  const reset7d = fields.reset7d ?? null;
  const response = fields.response ?? null;

  withCcrotateLock(profilesDir, () => {
    const tierCachePath = path.join(profilesDir, "tier-cache.json");

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
  });
}
