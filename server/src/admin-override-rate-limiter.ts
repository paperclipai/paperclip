const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
  hourlyRemaining: number;
  dailyRemaining: number;
}

export interface RateLimitConfig {
  hourlyLimit: number;
  dailyLimit: number;
  nowMs?: () => number;
}

/**
 * Per-principal rate limiter for admin-override mints.
 *
 * AC-8-B ([AKS-1597](/AKS/issues/AKS-1597)): <=5 mints/hour/user AND <=10 mints/day/user.
 * In-memory ring-buffer of timestamps per principal; acceptable stale state on restart
 * because AC-8-B only guards spammy minting, not the override JWT itself (replay guard
 * is the database UNIQUE(override_jwt_jti) constraint).
 */
export class AdminOverrideRateLimiter {
  private readonly timestamps = new Map<string, number[]>();
  private readonly config: Required<RateLimitConfig>;

  constructor(config: RateLimitConfig) {
    this.config = {
      hourlyLimit: config.hourlyLimit,
      dailyLimit: config.dailyLimit,
      nowMs: config.nowMs ?? (() => Date.now()),
    };
  }

  /** Reports whether a fresh mint would be allowed without mutating state. */
  inspect(principalId: string): RateLimitDecision {
    const now = this.config.nowMs();
    const kept = this.prune(principalId, now);
    return this.decide(kept, now);
  }

  /**
   * Attempts to record a mint. Returns allowed=true iff the mint is within
   * both the hourly and daily limits; the timestamp is recorded only on allow.
   */
  record(principalId: string): RateLimitDecision {
    const now = this.config.nowMs();
    const kept = this.prune(principalId, now);
    const decision = this.decide(kept, now);
    if (!decision.allowed) return decision;
    kept.push(now);
    this.timestamps.set(principalId, kept);
    return {
      allowed: true,
      hourlyRemaining: Math.max(0, decision.hourlyRemaining - 1),
      dailyRemaining: Math.max(0, decision.dailyRemaining - 1),
    };
  }

  /** Clears all state. Intended for tests. */
  reset(): void {
    this.timestamps.clear();
  }

  private prune(principalId: string, nowMs: number): number[] {
    const entries = this.timestamps.get(principalId) ?? [];
    const cutoff = nowMs - DAY_MS;
    const kept = entries.filter((ts) => ts > cutoff);
    if (kept.length !== entries.length) {
      if (kept.length === 0) {
        this.timestamps.delete(principalId);
      } else {
        this.timestamps.set(principalId, kept);
      }
    }
    return kept;
  }

  private decide(entries: number[], nowMs: number): RateLimitDecision {
    const hourCutoff = nowMs - HOUR_MS;
    const hourCount = entries.reduce((n, ts) => (ts > hourCutoff ? n + 1 : n), 0);
    const dayCount = entries.length;

    const hourlyRemaining = Math.max(0, this.config.hourlyLimit - hourCount);
    const dailyRemaining = Math.max(0, this.config.dailyLimit - dayCount);

    if (hourCount >= this.config.hourlyLimit) {
      const oldestInHour = entries.find((ts) => ts > hourCutoff) ?? nowMs;
      const retryAfterMs = Math.max(0, oldestInHour + HOUR_MS - nowMs);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        hourlyRemaining: 0,
        dailyRemaining,
      };
    }
    if (dayCount >= this.config.dailyLimit) {
      const oldestInDay = entries[0] ?? nowMs;
      const retryAfterMs = Math.max(0, oldestInDay + DAY_MS - nowMs);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        hourlyRemaining,
        dailyRemaining: 0,
      };
    }

    return { allowed: true, hourlyRemaining, dailyRemaining };
  }
}

export const ADMIN_OVERRIDE_RATE_LIMITS = {
  hourlyLimit: 5,
  dailyLimit: 10,
};
