/**
 * Two-bucket rate limiter with concurrency semaphore (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - Rate limiting uses two token buckets (requests RPM, tokens TPM) + concurrency semaphore.
 * - Concurrency is hard-capped at 2 regardless of flag configuration.
 * - acquire() waits for deficit sleep, debits estimated tokens, and returns a lease.
 * - settle() reconciles actual vs estimated tokens (can push token bucket negative).
 * - release() releases concurrency slot (must be called in finally).
 * - Virtual time supported via injected MonotonicClock and Sleeper.
 */

import { type MonotonicClock, type Sleeper } from "./clock.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export const MAX_RETRY_AFTER_MS = 300_000;

export interface RateLimiterOptions {
  rpm: number;
  tpm: number;
  concurrency?: number;
  maxConcurrencyCap?: number;
  clock: MonotonicClock;
  sleeper: Sleeper;
}

export interface RateLimitLease {
  settle(actualTokens: number): void;
  release(): void;
}

export interface RateLimiter {
  acquire(estimatedTokens: number): Promise<RateLimitLease>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { rpm, tpm, clock, sleeper } = options;
  if (typeof rpm !== "number" || !Number.isFinite(rpm) || rpm <= 0) {
    throw new CompanyMemoryUpgradeError(
      `Rate limiter rpm must be a finite positive number, received ${rpm}`,
      "INVALID_ARGUMENT",
    );
  }
  if (typeof tpm !== "number" || !Number.isFinite(tpm) || tpm <= 0) {
    throw new CompanyMemoryUpgradeError(
      `Rate limiter tpm must be a finite positive number, received ${tpm}`,
      "INVALID_ARGUMENT",
    );
  }
  const rawConcurrency = options.concurrency ?? 2;
  if (typeof rawConcurrency !== "number" || !Number.isFinite(rawConcurrency) || rawConcurrency < 1) {
    throw new CompanyMemoryUpgradeError(
      `Rate limiter concurrency must be a finite number >= 1, received ${rawConcurrency}`,
      "INVALID_ARGUMENT",
    );
  }
  const maxConcurrencyCap = options.maxConcurrencyCap ?? 2;
  const maxConcurrency = Math.min(rawConcurrency, maxConcurrencyCap);

  let inFlight = 0;
  const waiters: Array<() => void> = [];

  function releaseSlot(): void {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      inFlight--;
    }
  }

  let reqTokens = rpm;
  let dataTokens = tpm;
  let lastRefillMs = clock.nowMs();

  const reqRefillPerMs = rpm / 60_000;
  const dataRefillPerMs = tpm / 60_000;

  function refill(): void {
    const now = clock.nowMs();
    const elapsed = Math.max(0, now - lastRefillMs);
    lastRefillMs = now;

    reqTokens = Math.min(rpm, reqTokens + elapsed * reqRefillPerMs);
    dataTokens = Math.min(tpm, dataTokens + elapsed * dataRefillPerMs);
  }

  return {
    async acquire(estimatedTokens: number): Promise<RateLimitLease> {
      if (typeof estimatedTokens !== "number" || !Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
        throw new CompanyMemoryUpgradeError(
          `estimatedTokens must be a finite non-negative number, received ${estimatedTokens}`,
          "INVALID_ARGUMENT",
        );
      }

      // 1. Wait for concurrency slot
      if (inFlight >= maxConcurrency || waiters.length > 0) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      } else {
        inFlight++;
      }

      // 2. Wait for token bucket deficit
      try {
        while (true) {
          refill();

          const reqDeficit = Math.max(0, 1 - reqTokens);
          const tokensForWait = Math.min(estimatedTokens, tpm);
          const tokDeficit = Math.max(0, tokensForWait - dataTokens);

          const reqWaitMs = reqDeficit > 0 ? reqDeficit / reqRefillPerMs : 0;
          const tokWaitMs = tokDeficit > 0 ? tokDeficit / dataRefillPerMs : 0;
          const sleepMs = Math.max(reqWaitMs, tokWaitMs);

          if (sleepMs > 0) {
            await sleeper.sleep(Math.ceil(sleepMs));
          } else {
            reqTokens -= 1;
            dataTokens -= estimatedTokens;
            break;
          }
        }
      } catch (err) {
        releaseSlot();
        throw err;
      }

      let released = false;
      let settled = false;

      return {
        settle(actualTokens: number): void {
          if (settled || released) return;
          if (typeof actualTokens !== "number" || !Number.isFinite(actualTokens) || actualTokens < 0) {
            return;
          }
          settled = true;
          const diff = actualTokens - estimatedTokens;
          dataTokens -= diff;
        },
        release(): void {
          if (!released) {
            released = true;
            releaseSlot();
          }
        },
      };
    },
  };
}

/**
 * Extracts a header value case-insensitively from Headers or Record.
 */
function getHeaderValue(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lowerName = name.toLowerCase();

  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(lowerName);
  }

  const rec = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === lowerName) {
      const val = rec[key];
      if (Array.isArray(val)) return val[0] ?? null;
      return val ?? null;
    }
  }
  return null;
}

/**
 * Parses duration strings with repeated-unit grammar (e.g. "6m0s", "1m30s", "2m", "500ms", "1.5s").
 * Bare unit-less numbers are interpreted as seconds per HTTP Retry-After RFC 7231 §7.1.3.
 * Any unmatched residue, negative value, or invalid format returns null.
 */
export function parseDurationMs(str: string): number | null {
  // str is typed as string; redundant typeof str === "string" check removed
  const trimmed = str.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;

  // Bare unit-less number: seconds
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const s = Number(trimmed);
    if (Number.isFinite(s) && s >= 0) {
      return Math.ceil(s * 1000);
    }
    return null;
  }

  // Repeated-unit grammar: (\d+(?:\.\d+)?)(ms|s|m|h)
  const unitRegex = /^(\d+(?:\.\d+)?)(ms|s|m|h)/;
  let remaining = trimmed;
  let totalMs = 0;
  let matchedAny = false;

  while (remaining.length > 0) {
    const match = remaining.match(unitRegex);
    if (!match) {
      return null; // unmatched residue -> invalid
    }
    matchedAny = true;
    const amount = parseFloat(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount < 0) return null;

    switch (unit) {
      case "ms":
        totalMs += amount;
        break;
      case "s":
        totalMs += amount * 1000;
        break;
      case "m":
        totalMs += amount * 60 * 1000;
        break;
      case "h":
        totalMs += amount * 3600 * 1000;
        break;
      default:
        return null;
    }
    remaining = remaining.slice(match[0].length).trim();
  }

  return matchedAny ? Math.ceil(totalMs) : null;
}

function parseCandidateHeaderValue(value: string, nowMs: number): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;

  const durationMs = parseDurationMs(trimmed);
  if (durationMs !== null) {
    return durationMs;
  }

  // Attempt HTTP-date parse only if string contains non-digit characters that could be a date
  if (/[a-zA-Z]/.test(trimmed)) {
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
      return Math.max(0, Math.ceil(parsedDate - nowMs));
    }
  }

  return null;
}

/**
 * Parses Retry-After or OpenAI rate-limit reset headers into milliseconds.
 * Takes the MAX over every candidate that parses and clamps to MAX_RETRY_AFTER_MS.
 */
export function parseRetryAfterMs(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
  nowMs: number,
): number | null {
  if (!headers) return null;

  const candidateHeaderNames = [
    "retry-after",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ];

  let maxMs: number | null = null;

  for (const name of candidateHeaderNames) {
    const val = getHeaderValue(headers, name);
    if (val) {
      const parsed = parseCandidateHeaderValue(val, nowMs);
      if (parsed !== null && parsed >= 0) {
        if (maxMs === null || parsed > maxMs) {
          maxMs = parsed;
        }
      }
    }
  }

  if (maxMs === null) return null;
  return Math.min(maxMs, MAX_RETRY_AFTER_MS);
}

/**
 * Detects OpenAI insufficient_quota errors either from structured JSON error objects
 * (err.code or err.type === "insufficient_quota") or via raw substring match fallback.
 * Checks substring whenever structured check does not match, not only when JSON.parse throws.
 */
export function isInsufficientQuotaError(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody);
    const err = parsed?.error;
    if (err && typeof err === "object") {
      if (err.code === "insufficient_quota" || err.type === "insufficient_quota") {
        return true;
      }
    }
  } catch {
    // Non-JSON or malformed body falls through to substring check
  }
  return rawBody.includes("insufficient_quota");
}

/**
 * Estimates LLM input+output tokens for a single conversion request based on budget.ts heuristic.
 * 600 fixed prompt/schema tokens + ceil(text.length / 4) input source tokens + 80 expected output tokens.
 */
export function estimateChatTokens(text: string): number {
  return 600 + Math.ceil(text.length / 4) + 80;
}
