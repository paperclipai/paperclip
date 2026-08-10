/**
 * Fail-fast circuit breaker for the Postgres connection.
 *
 * When the database becomes unreachable, postgres.js keeps accepting queries
 * and parks each one in its pending queue until `connect_timeout` elapses.
 * Under sustained inbound traffic every request handler stays alive for the
 * whole timeout window, so handlers (and their request/response graphs)
 * accumulate faster than they drain. A multi-minute connectivity blip is
 * therefore enough to exhaust the process memory limit — the failure mode is
 * an out-of-memory kill, not the connection error the operator expected.
 *
 * The breaker converts that pile-up into immediate rejections: after
 * `failureThreshold` consecutive connection-level failures it opens, and every
 * subsequent query rejects right away with {@link DatabaseUnavailableError}
 * instead of waiting on a connection that is not coming. After
 * `resetTimeoutMs` it admits a single probe query; the probe closes the
 * breaker on success and re-opens it on failure.
 *
 * Only connection-level failures count. A query that fails because of a
 * constraint violation or a syntax error says nothing about reachability and
 * leaves the breaker closed — it also resets the consecutive-failure counter,
 * because a server that answers is a server that is up.
 */

/** postgres.js driver codes plus the Node socket codes it passes through. */
const CONNECTION_ERROR_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECTION_REFUSED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

export const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 5_000;

export type CircuitBreakerState = "closed" | "open" | "halfOpen";

export interface CircuitBreakerOptions {
  /** Consecutive connection failures that trip the breaker open. */
  failureThreshold?: number;
  /** How long the breaker stays open before admitting one probe query. */
  resetTimeoutMs?: number;
  /** Injectable clock, so tests do not have to wait out the reset timeout. */
  now?: () => number;
}

export class DatabaseUnavailableError extends Error {
  readonly code = "DATABASE_CIRCUIT_OPEN";
  /** Milliseconds until the breaker will admit its next probe query. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, options?: { cause?: unknown }) {
    super(
      `Database is unavailable: the connection circuit breaker is open. Retry in ${retryAfterMs}ms.`,
      options,
    );
    this.name = "DatabaseUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * True when `error` says the database could not be reached, as opposed to the
 * database answering with an error.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error ? isConnectionFailure(cause) : false;
}

export interface CircuitBreakerSnapshot {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  /** Milliseconds until the next probe is admitted; 0 unless the state is `open`. */
  retryAfterMs: number;
}

export class ConnectionCircuitBreaker {
  readonly #failureThreshold: number;
  readonly #resetTimeoutMs: number;
  readonly #now: () => number;

  #consecutiveFailures = 0;
  #openedAt: number | null = null;
  #probeStartedAt: number | null = null;
  #lastFailure: unknown = undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.#failureThreshold = options.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    this.#resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#failureThreshold) || this.#failureThreshold < 1) {
      throw new Error(`Circuit breaker failureThreshold must be a positive integer, got: ${this.#failureThreshold}`);
    }
    if (!Number.isFinite(this.#resetTimeoutMs) || this.#resetTimeoutMs < 0) {
      throw new Error(`Circuit breaker resetTimeoutMs must be a non-negative number, got: ${this.#resetTimeoutMs}`);
    }
  }

  get state(): CircuitBreakerState {
    if (this.#openedAt === null) return "closed";
    return this.#retryAfterMs() === 0 ? "halfOpen" : "open";
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.#consecutiveFailures,
      retryAfterMs: this.#retryAfterMs(),
    };
  }

  /**
   * Throws {@link DatabaseUnavailableError} when the query must not be
   * attempted. Returns normally when the breaker is closed, and for the single
   * probe query admitted once the reset timeout has elapsed.
   */
  assertAvailable(): void {
    if (this.#openedAt === null) return;

    const retryAfterMs = this.#retryAfterMs();
    if (retryAfterMs > 0) throw new DatabaseUnavailableError(retryAfterMs, { cause: this.#lastFailure });

    // Half-open: exactly one probe may run at a time. Everything else keeps
    // failing fast, otherwise the pile-up the breaker exists to prevent simply
    // resumes the moment the timeout elapses. The probe slot expires after one
    // reset window so a query that is created but never awaited cannot wedge
    // the breaker half-open forever.
    const now = this.#now();
    if (this.#probeStartedAt !== null && now - this.#probeStartedAt < this.#resetTimeoutMs) {
      throw new DatabaseUnavailableError(this.#resetTimeoutMs, { cause: this.#lastFailure });
    }
    this.#probeStartedAt = now;
  }

  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#openedAt = null;
    this.#probeStartedAt = null;
    this.#lastFailure = undefined;
  }

  recordFailure(error: unknown): void {
    if (!isConnectionFailure(error)) {
      // The server answered, so it is reachable. Treat that as a success for
      // reachability purposes even though the query itself failed.
      this.recordSuccess();
      return;
    }

    this.#lastFailure = error;
    this.#consecutiveFailures += 1;
    this.#probeStartedAt = null;
    if (this.#consecutiveFailures >= this.#failureThreshold) {
      // A failed probe restarts the cooldown rather than leaving the breaker
      // permanently half-open.
      this.#openedAt = this.#now();
    }
  }

  #retryAfterMs(): number {
    if (this.#openedAt === null) return 0;
    const elapsed = this.#now() - this.#openedAt;
    return elapsed >= this.#resetTimeoutMs ? 0 : this.#resetTimeoutMs - elapsed;
  }
}
