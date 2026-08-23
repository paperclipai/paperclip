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

/**
 * A provider's stated reset time is a CLAIM, not a fact, and it can be wrong in
 * the expensive direction. Codex quotes a weekly window ("try again at Aug 27th,
 * 2026 9:02 AM"). On 2026-08-23 a rejection quoted Aug 27 while the pool had in
 * fact been reset that morning, sat at 94% free, and genuinely resets Aug 30.
 *
 * An over-long claim is self-sustaining: a parked lane cannot produce the
 * successful run that clears its own cooldown, because
 * findAgentActiveProviderQuotaCooldown stops at the first success it walks back
 * to and a parked lane never runs. Honouring Aug 27 verbatim would have idled a
 * healthy lane for four days while credit sat unused.
 *
 * Cap the honoured cooldown so the lane always re-probes. This keeps nearly all
 * the benefit -- a lane retrying every 2h instead of every few seconds is ~99%
 * fewer doomed requests -- while bounding the cost of a wrong claim to one
 * wasted probe per interval instead of days of silence.
 */
export const QUOTA_COOLDOWN_MAX_MS = 2 * 60 * 60 * 1000;

export function clampQuotaCooldown(resetAt: Date | null, now: Date = new Date()): Date | null {
  if (!resetAt || resetAt.getTime() <= now.getTime()) return null;
  const cap = now.getTime() + QUOTA_COOLDOWN_MAX_MS;
  return resetAt.getTime() > cap ? new Date(cap) : resetAt;
}

export function buildQuotaCooldownCopy(
  run: QuotaFailureCandidate | null | undefined,
): string {
  const resetAt = readQuotaFailureResetAt(run);
  return resetAt ? ` Cooldown until ${resetAt.toISOString()}.` : "";
}
