import type { Logger } from "pino";

export interface ErrorThrottlerOptions {
  /**
   * Minimum interval (in ms) between logging repeated identical errors.
   * Default: 5 minutes (300,000 ms).
   */
  minIntervalMs?: number;

  /**
   * Max character length for error message strings before truncating.
   * Prevents multi-kilobyte SQL or query strings from overwhelming logs.
   * Default: 500 characters.
   */
  maxErrorMessageLength?: number;

  /**
   * Custom clock function for testing. Defaults to Date.now.
   */
  clock?: () => number;

  /**
   * Maximum number of distinct (context, error) keys to track at once.
   * Prevents unbounded memory growth when errors carry varying detail
   * (e.g. row ids or query parameters embedded in the message). When the
   * limit is exceeded, the least-recently-logged key is evicted.
   * Default: 500.
   */
  maxTrackedKeys?: number;
}

export interface ErrorSummary {
  message: string;
  code?: string;
}

export function summarizeError(err: unknown, maxLength = 500): ErrorSummary {
  if (err === null || err === undefined) return { message: "Unknown error" };
  let rawMessage = "";
  let code: string | undefined;

  if (err instanceof Error) {
    rawMessage = err.message || err.name || "Error";
    if ("code" in err && typeof (err as any).code === "string") {
      code = (err as any).code;
    }
  } else if (typeof err === "string") {
    rawMessage = err;
  } else if (typeof err === "object") {
    try {
      rawMessage = JSON.stringify(err);
    } catch {
      rawMessage = String(err);
    }
  } else {
    rawMessage = String(err);
  }

  if (rawMessage.length > maxLength) {
    rawMessage = `${rawMessage.slice(0, maxLength)} [truncated]`;
  }

  return { message: rawMessage, code };
}

export class ErrorThrottler {
  private minIntervalMs: number;
  private maxErrorMessageLength: number;
  private maxTrackedKeys: number;
  private clock: () => number;
  // Iteration order doubles as recency order: entries are deleted and
  // re-inserted whenever they're touched, so the first key is always the
  // least-recently-active one (see touch()).
  private state = new Map<string, { lastLoggedAt: number; suppressedCount: number }>();

  constructor(options: ErrorThrottlerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 5 * 60 * 1000;
    this.maxErrorMessageLength = options.maxErrorMessageLength ?? 500;
    this.maxTrackedKeys = Math.max(1, options.maxTrackedKeys ?? 500);
    this.clock = options.clock ?? Date.now;
  }

  private touch(key: string, entry: { lastLoggedAt: number; suppressedCount: number }): void {
    this.state.delete(key);
    this.state.set(key, entry);
    while (this.state.size > this.maxTrackedKeys) {
      const oldestKey = this.state.keys().next().value;
      if (oldestKey === undefined) break;
      this.state.delete(oldestKey);
    }
  }

  logError(
    logger: Logger,
    contextMessage: string,
    err: unknown,
    extraFields?: Record<string, unknown>,
  ): void {
    const summary = summarizeError(err, this.maxErrorMessageLength);
    const key = `${contextMessage}:${summary.code ?? ""}:${summary.message}`;
    const now = this.clock();
    const entry = this.state.get(key);

    if (!entry) {
      this.touch(key, { lastLoggedAt: now, suppressedCount: 0 });
      logger.error({ err, ...extraFields }, contextMessage);
      return;
    }

    const elapsed = now - entry.lastLoggedAt;
    if (elapsed < this.minIntervalMs) {
      entry.suppressedCount += 1;
      this.touch(key, entry);
      return;
    }

    const suppressed = entry.suppressedCount;
    entry.suppressedCount = 0;
    entry.lastLoggedAt = now;
    this.touch(key, entry);

    if (suppressed > 0) {
      logger.error(
        { err, suppressedErrors: suppressed, ...extraFields },
        `[suppressed ${suppressed} repeated errors] ${contextMessage}`,
      );
    } else {
      logger.error({ err, ...extraFields }, contextMessage);
    }
  }

  reset(): void {
    this.state.clear();
  }

  resetKey(contextMessage: string, err: unknown): void {
    const summary = summarizeError(err, this.maxErrorMessageLength);
    const key = `${contextMessage}:${summary.code ?? ""}:${summary.message}`;
    this.state.delete(key);
  }
}

export function createErrorThrottler(options?: ErrorThrottlerOptions): ErrorThrottler {
  return new ErrorThrottler(options);
}

export interface BackoffOptions {
  /** Delay used when there are no consecutive failures. */
  baseIntervalMs: number;
  /** Upper bound on the computed delay, regardless of failure streak. */
  maxIntervalMs: number;
  /** Consecutive-failure count at which the backoff multiplier stops growing. Default: 4. */
  maxBackoffSteps?: number;
}

/**
 * Computes an exponential backoff delay (doubling per consecutive failure,
 * capped at `maxBackoffSteps` doublings and `maxIntervalMs` overall).
 * Pulled out as a pure function so scheduling call sites and tests share the
 * exact same formula instead of a copy that can silently drift.
 */
export function computeBackoffDelayMs(consecutiveFailures: number, options: BackoffOptions): number {
  const maxBackoffSteps = options.maxBackoffSteps ?? 4;
  const clampedFailures = Math.min(Math.max(consecutiveFailures, 0), maxBackoffSteps);
  const backoffFactor = Math.pow(2, clampedFailures);
  return Math.min(options.maxIntervalMs, options.baseIntervalMs * backoffFactor);
}
