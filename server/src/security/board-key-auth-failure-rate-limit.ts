export type BoardKeyAuthFailureRateLimitConfig = {
  windowMs: number;
  credentialLimit: number;
  sourceLimit: number;
  globalLimit: number;
  credentialMaxEntries: number;
  sourceMaxEntries: number;
  sourceInFlightLimit: number;
  globalInFlightLimit: number;
};

export const BOARD_KEY_AUTH_FAILURE_RATE_LIMIT_DEFAULTS = {
  windowMs: 60_000,
  credentialLimit: 10,
  sourceLimit: 50,
  globalLimit: 1_000,
  credentialMaxEntries: 4_096,
  sourceMaxEntries: 1_024,
  sourceInFlightLimit: 8,
  globalInFlightLimit: 128,
} satisfies BoardKeyAuthFailureRateLimitConfig;

type FailureEntry = { count: number; resetAt: number };

class BoundedFixedWindowFailures {
  private readonly entries = new Map<string, FailureEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries: number,
  ) {}

  isLimited(identity: string, now: number) {
    const entry = this.entries.get(identity);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      this.entries.delete(identity);
      return false;
    }
    return entry.count >= this.limit;
  }

  record(identity: string, now: number) {
    const existing = this.entries.get(identity);
    const entry = !existing || existing.resetAt <= now
      ? { count: 1, resetAt: now + this.windowMs }
      : { count: existing.count + 1, resetAt: existing.resetAt };

    // Refresh insertion order so capacity eviction removes the least recently
    // used identity. The store remains bounded even during unique-token floods.
    if (existing) this.entries.delete(identity);
    this.ensureCapacity(now);
    this.entries.set(identity, entry);
    return entry.count > this.limit;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }

  private ensureCapacity(now: number) {
    if (this.entries.size < this.maxEntries) return;
    for (const [identity, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(identity);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldestIdentity = this.entries.keys().next().value;
      if (oldestIdentity === undefined) break;
      this.entries.delete(oldestIdentity);
    }
  }
}

export function createBoardKeyAuthFailureRateLimiter(
  config: BoardKeyAuthFailureRateLimitConfig = BOARD_KEY_AUTH_FAILURE_RATE_LIMIT_DEFAULTS,
) {
  const credentials = new BoundedFixedWindowFailures(
    config.credentialLimit,
    config.windowMs,
    config.credentialMaxEntries,
  );
  const sources = new BoundedFixedWindowFailures(
    config.sourceLimit,
    config.windowMs,
    config.sourceMaxEntries,
  );
  const global = new BoundedFixedWindowFailures(config.globalLimit, config.windowMs, 1);
  const sourceInFlight = new Map<string, number>();
  let globalInFlight = 0;

  return {
    isLimited(input: { credentialId: string; sourceId: string; now?: number }) {
      const now = input.now ?? Date.now();
      return global.isLimited("global", now)
        || sources.isLimited(input.sourceId, now)
        || credentials.isLimited(input.credentialId, now);
    },

    recordFailure(input: { credentialId: string; sourceId: string; now?: number }) {
      const now = input.now ?? Date.now();
      const globalLimited = global.record("global", now);
      const sourceLimited = sources.record(input.sourceId, now);
      const credentialLimited = credentials.record(input.credentialId, now);
      return globalLimited || sourceLimited || credentialLimited;
    },

    tryAcquire(input: { sourceId: string }) {
      const currentSourceInFlight = sourceInFlight.get(input.sourceId) ?? 0;
      const newSourceWouldExceedStorage = currentSourceInFlight === 0
        && sourceInFlight.size >= config.sourceMaxEntries;
      if (
        globalInFlight >= config.globalInFlightLimit
        || currentSourceInFlight >= config.sourceInFlightLimit
        || newSourceWouldExceedStorage
      ) {
        return null;
      }

      globalInFlight += 1;
      sourceInFlight.set(input.sourceId, currentSourceInFlight + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          globalInFlight = Math.max(0, globalInFlight - 1);
          const remainingForSource = (sourceInFlight.get(input.sourceId) ?? 1) - 1;
          if (remainingForSource <= 0) sourceInFlight.delete(input.sourceId);
          else sourceInFlight.set(input.sourceId, remainingForSource);
        },
      };
    },

    reset() {
      credentials.clear();
      sources.clear();
      global.clear();
      sourceInFlight.clear();
      globalInFlight = 0;
    },

    snapshot() {
      return {
        credentialEntries: credentials.size,
        sourceEntries: sources.size,
        globalEntries: global.size,
        sourceInFlightEntries: sourceInFlight.size,
        globalInFlight,
      };
    },
  };
}
