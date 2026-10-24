export const PROFILE_DEFERRED_CAPACITY_CODE = "profile_deferred_capacity";

export const PROFILE_DEFERRED_CAPACITY_ERROR_CODES: ReadonlySet<string> = new Set([
  PROFILE_DEFERRED_CAPACITY_CODE,
  "hermes_profile_deferred_capacity",
  "hermes_gateway_profile_deferred_capacity",
  "profile_deferred",
]);

export const PROFILE_DEFERRED_CAPACITY_RETRY_REASON = PROFILE_DEFERRED_CAPACITY_CODE;

export const PROFILE_DEFERRED_CAPACITY_STOP_REASON = PROFILE_DEFERRED_CAPACITY_CODE;

export const DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S = 300;
export const MIN_PROFILE_DEFERRED_RETRY_AFTER_S = 5;
export const MAX_PROFILE_DEFERRED_RETRY_AFTER_S = 3_600;

export const PROFILE_DEFERRED_BACKOFF_GROWTH = 4;

export interface ProfileDeferral {
  errorCode: typeof PROFILE_DEFERRED_CAPACITY_CODE;
  adapterErrorCode: string;
  retryAfterS: number;
  retryable: boolean;
  profile: string | null;
  message: string | null;
}

export interface ProfileDeferralBooking {
  status: "scheduled_retry";
  errorCode: typeof PROFILE_DEFERRED_CAPACITY_CODE;
  stopReason: typeof PROFILE_DEFERRED_CAPACITY_STOP_REASON;
  retryReason: typeof PROFILE_DEFERRED_CAPACITY_RETRY_REASON;
  retryAfterS: number;
  attempt: number;
  multiplier: number;
  delayMs: number;
  retryAt: Date;
}

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readProfileDeferralFromAdapterResult(adapterResult: {
  errorCode?: string | null;
  retryAfterS?: number | null;
  retryable?: boolean;
  deferredProfile?: string | null;
  errorMessage?: string | null;
} | null | undefined): ProfileDeferral | null {
  const errorCode = readNonEmptyString(adapterResult?.errorCode);
  if (!errorCode || !PROFILE_DEFERRED_CAPACITY_ERROR_CODES.has(errorCode)) return null;
  const rawRetryAfter = toPositiveNumber(adapterResult?.retryAfterS);
  const retryAfterS = Math.min(
    MAX_PROFILE_DEFERRED_RETRY_AFTER_S,
    Math.max(
      MIN_PROFILE_DEFERRED_RETRY_AFTER_S,
      Math.round(rawRetryAfter ?? DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S),
    ),
  );
  return {
    errorCode: PROFILE_DEFERRED_CAPACITY_CODE,
    adapterErrorCode: errorCode,
    retryAfterS,
    retryable: adapterResult?.retryable !== false,
    profile: readNonEmptyString(adapterResult?.deferredProfile),
    message: readNonEmptyString(adapterResult?.errorMessage),
  };
}

export function resolveProfileDeferralBooking(input: {
  retryAfterS?: number | null;
  attempt?: number | null;
  now?: Date;
}): ProfileDeferralBooking {
  const retryAfterS = Math.min(
    MAX_PROFILE_DEFERRED_RETRY_AFTER_S,
    Math.max(
      MIN_PROFILE_DEFERRED_RETRY_AFTER_S,
      Math.round(toPositiveNumber(input?.retryAfterS) ?? DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S),
    ),
  );
  const attempt = Math.max(0, Math.floor(toPositiveNumber(input?.attempt) ?? 0));
  const multiplier = Math.min(PROFILE_DEFERRED_BACKOFF_GROWTH, attempt + 1);
  const delayMs = retryAfterS * 1_000 * multiplier;
  const now =
    input?.now instanceof Date && !Number.isNaN(input.now.getTime()) ? input.now : new Date();
  return {
    status: "scheduled_retry",
    errorCode: PROFILE_DEFERRED_CAPACITY_CODE,
    stopReason: PROFILE_DEFERRED_CAPACITY_STOP_REASON,
    retryReason: PROFILE_DEFERRED_CAPACITY_RETRY_REASON,
    retryAfterS,
    attempt,
    multiplier,
    delayMs,
    retryAt: new Date(now.getTime() + delayMs),
  };
}
