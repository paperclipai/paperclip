/**
 * Per-upstream circuit breaker for the MCP gateway.
 *
 * A dead or hung upstream (e.g. a crash-looping MCP backend whose
 * websocket keeps dropping) would otherwise absorb a full request
 * timeout on every call. Under load — many agents retrying the same
 * dead upstream — those hung requests pile up, each holding a buffered
 * request/response in memory, until the gateway itself OOMs.
 *
 * The breaker trips a prefix "open" after N consecutive failures so
 * subsequent calls fail fast (returning 503 without touching the
 * upstream) until a cooldown elapses. It then admits a single probe
 * ("half-open"): if the probe succeeds the prefix closes, otherwise it
 * reopens for another cooldown.
 *
 * State is per prefix, in-memory, and reset on process restart — the
 * gateway is already stateless across restarts.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Consecutive failures before a closed prefix trips open. */
  failureThreshold: number;
  /** How long a prefix stays open before admitting a half-open probe (ms). */
  openCooldownMs: number;
  /** Concurrent probes admitted while half-open (normally 1). */
  halfOpenMaxProbes: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

interface PrefixState {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenInFlight: number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openCooldownMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly now: () => number;
  private readonly prefixes = new Map<string, PrefixState>();

  constructor(config: CircuitBreakerConfig) {
    this.failureThreshold = config.failureThreshold;
    this.openCooldownMs = config.openCooldownMs;
    this.halfOpenMaxProbes = config.halfOpenMaxProbes;
    this.now = config.now ?? (() => Date.now());
  }

  private ensure(prefix: string): PrefixState {
    let s = this.prefixes.get(prefix);
    if (!s) {
      s = { state: "closed", consecutiveFailures: 0, openedAt: 0, halfOpenInFlight: 0 };
      this.prefixes.set(prefix, s);
    }
    return s;
  }

  /**
   * Whether a request to this prefix may proceed. Transitions
   * open→half-open once the cooldown has elapsed. Returns false when the
   * prefix is open (fast-fail) or when half-open probe capacity is
   * already in use. The caller MUST later report the outcome via
   * {@link recordSuccess} or {@link recordFailure} for every `true`.
   */
  tryAcquire(prefix: string): boolean {
    const s = this.ensure(prefix);
    if (s.state === "open") {
      if (this.now() - s.openedAt >= this.openCooldownMs) {
        s.state = "half-open";
        s.halfOpenInFlight = 0;
      } else {
        return false;
      }
    }
    if (s.state === "half-open") {
      if (s.halfOpenInFlight >= this.halfOpenMaxProbes) return false;
      s.halfOpenInFlight += 1;
      return true;
    }
    return true; // closed
  }

  recordSuccess(prefix: string): void {
    const s = this.ensure(prefix);
    s.consecutiveFailures = 0;
    s.halfOpenInFlight = Math.max(0, s.halfOpenInFlight - 1);
    s.state = "closed";
  }

  recordFailure(prefix: string): void {
    const s = this.ensure(prefix);
    if (s.state === "half-open") {
      // Probe failed → reopen immediately for another cooldown.
      s.halfOpenInFlight = Math.max(0, s.halfOpenInFlight - 1);
      s.state = "open";
      s.openedAt = this.now();
      return;
    }
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= this.failureThreshold) {
      s.state = "open";
      s.openedAt = this.now();
    }
  }

  stateOf(prefix: string): BreakerState {
    return this.prefixes.get(prefix)?.state ?? "closed";
  }

  /** Snapshot of every prefix that has been seen, for /healthz. */
  snapshot(): Record<string, BreakerState> {
    const out: Record<string, BreakerState> = {};
    for (const [prefix, s] of this.prefixes.entries()) out[prefix] = s.state;
    return out;
  }
}
