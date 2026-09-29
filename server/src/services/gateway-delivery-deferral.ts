import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/**
 * Delivery failures from an agent's own gateway are transient infrastructure,
 * not a failed attempt at the task: the API server refused the wake before any
 * provider work started. Measured in production on 2026-09-27: the agent
 * gateway's `max_concurrent_runs` cap answers `POST /v1/runs` with 429 +
 * `Retry-After: 1`, the adapter records `errorFamily: transient_upstream` and
 * `retryNotBefore`, and the run still settled as a terminal failure with
 * `scheduledRetryAt: null` - 50 runs over three minutes, one per second. These
 * codes belong in the same bounded-transient lane as the codex/claude upstream
 * codes, so the retry ladder (and any later Retry-After hint) applies to them.
 */
export const TRANSIENT_GATEWAY_DELIVERY_ERROR_CODES = new Set<string>([
  "hermes_gateway_rate_limited",
  "hermes_gateway_upstream_error",
  "hermes_gateway_connect_failed",
]);

/**
 * A gateway that answers with an implausibly large hint must not park an
 * agent's work for hours, so every window derived from a hint is capped. The
 * bounded retry ladder still governs every attempt after the window closes.
 */
export const MAX_GATEWAY_DELIVERY_HOLD_MS = 15 * 60 * 1000;

/**
 * A hint of `Retry-After: 0`, or one that has already elapsed by the time the
 * refusal is persisted, must still defer the wake instead of re-dispatching it
 * in the same instant.
 */
const GATEWAY_DELIVERY_DEFERRAL_MIN_DELAY_MS = 1_000;

/**
 * Some adapters record the `Retry-After` header verbatim, and the Hermes API
 * server sends it as delta-seconds (`Retry-After: 1`). Read as a date,
 * `new Date("1")` is 2001-01-01 - an expired window - so a recorded hint in that
 * shape would never open a hold. A small bare integer is therefore seconds
 * after the run started, not a timestamp. Bounded to an hour so an epoch value
 * can never be mistaken for a delta.
 */
export function readRetryAfterDeltaSeconds(value: string | number | Date): number | null {
  if (value instanceof Date) return null;
  const raw = typeof value === "number" ? value : value.trim();
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) return null;
  if (typeof raw === "string" && !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3_600) return null;
  return seconds;
}

function clampGatewayDeliveryDeferralUntil(until: Date, now: Date): Date {
  return new Date(
    Math.min(
      Math.max(
        until.getTime(),
        now.getTime() + GATEWAY_DELIVERY_DEFERRAL_MIN_DELAY_MS,
      ),
      now.getTime() + MAX_GATEWAY_DELIVERY_HOLD_MS,
    ),
  );
}

/**
 * The deferred-until time of a refused wake, read from the adapter's
 * `Retry-After` hint: delta-seconds are counted from the refused run's start,
 * an absolute timestamp is used as it is. An absent or unreadable hint yields
 * no deferral window at all.
 */
export function readGatewayDeliveryDeferralUntil(input: {
  retryNotBefore: unknown;
  runCreatedAt: Date | null;
  now: Date;
}): Date | null {
  const raw = input.retryNotBefore;
  if (
    typeof raw !== "string" &&
    typeof raw !== "number" &&
    !(raw instanceof Date)
  ) {
    return null;
  }
  const deltaSeconds = readRetryAfterDeltaSeconds(raw);
  if (deltaSeconds !== null) {
    const startedAt = input.runCreatedAt?.getTime();
    const base =
      startedAt !== undefined && !Number.isNaN(startedAt)
        ? startedAt
        : input.now.getTime();
    return clampGatewayDeliveryDeferralUntil(
      new Date(base + deltaSeconds * 1_000),
      input.now,
    );
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? null
    : clampGatewayDeliveryDeferralUntil(parsed, input.now);
}

/**
 * A refusal is a deferred wake only when it proves that no provider work
 * started (`providerWorkStarted: false`, claimed by the adapter for an HTTP 429
 * refusal of the create call itself) and the adapter recorded a `Retry-After`
 * window. A 5xx answer, a transport failure or a missing hint may have started
 * provider work, so those stay failures that the execution guard reconciles
 * instead of replaying them.
 */
export function resolveGatewayDeliveryDeferral(input: {
  errorCode: string | null;
  executionRecovery: AdapterExecutionResult["executionRecovery"] | null | undefined;
  retryNotBefore: unknown;
  runCreatedAt: Date | null;
  now: Date;
}): { until: Date; retryNotBefore: string | null; errorCode: string } | null {
  const errorCode =
    typeof input.errorCode === "string" && input.errorCode.trim()
      ? input.errorCode.trim()
      : null;
  if (!errorCode || !TRANSIENT_GATEWAY_DELIVERY_ERROR_CODES.has(errorCode)) {
    return null;
  }
  if (
    input.executionRecovery?.kind !== "bootstrap" ||
    input.executionRecovery.providerWorkStarted !== false
  ) {
    return null;
  }
  const until = readGatewayDeliveryDeferralUntil({
    retryNotBefore: input.retryNotBefore,
    runCreatedAt: input.runCreatedAt,
    now: input.now,
  });
  if (!until) return null;
  return {
    until,
    retryNotBefore:
      typeof input.retryNotBefore === "string" ? input.retryNotBefore : null,
    errorCode,
  };
}
