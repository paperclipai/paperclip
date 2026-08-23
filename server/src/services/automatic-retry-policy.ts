import { parseObject } from "../adapters/utils.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const QUOTA_EXHAUSTED_ERROR_CODES = new Set<string>([
  "gemini_quota_exhausted",
  "antigravity_quota_exhausted",
  // Every codex lane runs through the ACPX engine, which reported quota
  // rejections as the generic "acpx_turn_failed". Codex is the fleet's
  // highest-volume adapter, so the omission was also the largest: 110
  // rejections on 2026-08-23 all classed as genuine failures.
  "acpx_provider_quota_exhausted",
]);

type QuotaFailureCandidate = {
  errorCode?: string | null;
  resultJson?: unknown;
};

export function isQuotaExhaustedErrorCode(errorCode: string | null | undefined): boolean {
  return Boolean(errorCode && QUOTA_EXHAUSTED_ERROR_CODES.has(errorCode));
}

export function isQuotaExhaustedFailureRun(run: QuotaFailureCandidate | null | undefined): boolean {
  return isQuotaExhaustedErrorCode(readNonEmptyString(run?.errorCode));
}

export function readQuotaFailureResetAt(
  run: QuotaFailureCandidate | null | undefined,
): Date | null {
  const quotaFailure = parseObject(parseObject(run?.resultJson).quotaFailure);
  const resetAtRaw =
    readNonEmptyString(quotaFailure.resetAt) ??
    readNonEmptyString(parseObject(run?.resultJson).resetAt);
  if (!resetAtRaw) return null;
  const resetAt = new Date(resetAtRaw);
  return Number.isNaN(resetAt.getTime()) ? null : resetAt;
}

export function buildQuotaCooldownCopy(
  run: QuotaFailureCandidate | null | undefined,
): string {
  const resetAt = readQuotaFailureResetAt(run);
  return resetAt ? ` Cooldown until ${resetAt.toISOString()}.` : "";
}
