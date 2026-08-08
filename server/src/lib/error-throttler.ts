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
}

export interface ErrorSummary {
  message: string;
  code?: string;
}

export function summarizeError(err: unknown, maxLength = 500): ErrorSummary {
  if (!err) return { message: "Unknown error" };
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
  private clock: () => number;
  private state = new Map<string, { lastLoggedAt: number; suppressedCount: number }>();

  constructor(options: ErrorThrottlerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 5 * 60 * 1000;
    this.maxErrorMessageLength = options.maxErrorMessageLength ?? 500;
    this.clock = options.clock ?? Date.now;
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
      this.state.set(key, { lastLoggedAt: now, suppressedCount: 0 });
      logger.error({ err, ...extraFields }, contextMessage);
      return;
    }

    const elapsed = now - entry.lastLoggedAt;
    if (elapsed < this.minIntervalMs) {
      entry.suppressedCount += 1;
      return;
    }

    const suppressed = entry.suppressedCount;
    entry.suppressedCount = 0;
    entry.lastLoggedAt = now;

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
