import { describe, expect, it } from "vitest";
import {
  QUOTA_COOLDOWN_MAX_MS,
  QUOTA_EXHAUSTED_ERROR_CODES,
  clampQuotaCooldown,
  isQuotaExhaustedFailureRun,
  readQuotaFailureResetAt,
} from "./automatic-retry-policy.js";

const NOW = new Date("2026-08-23T10:00:00Z");

describe("clampQuotaCooldown", () => {
  it("honours a near reset unchanged — antigravity quotes minutes", () => {
    // "Resets in 14m32s."
    const resetAt = new Date(NOW.getTime() + 14 * 60_000 + 32_000);
    expect(clampQuotaCooldown(resetAt, NOW)?.toISOString()).toBe(resetAt.toISOString());
  });

  it("caps a reset that would park a healthy lane for days", () => {
    // The real 2026-08-23 codex message quoted Aug 27 while the pool had been
    // reset that morning and sat at 94% free. Honouring it verbatim would have
    // idled the lane for four days.
    const claimed = new Date("2026-08-27T08:02:00Z");
    const capped = clampQuotaCooldown(claimed, NOW);
    expect(capped?.getTime()).toBe(NOW.getTime() + QUOTA_COOLDOWN_MAX_MS);
    expect(capped!.getTime()).toBeLessThan(claimed.getTime());
  });

  it("treats a reset already in the past as no cooldown at all", () => {
    expect(clampQuotaCooldown(new Date("2026-08-23T09:00:00Z"), NOW)).toBeNull();
    expect(clampQuotaCooldown(NOW, NOW)).toBeNull();
  });

  it("returns null when the provider offered no reset time", () => {
    expect(clampQuotaCooldown(null, NOW)).toBeNull();
  });

  it("sits exactly on the boundary without rounding a lane past it", () => {
    const exactly = new Date(NOW.getTime() + QUOTA_COOLDOWN_MAX_MS);
    expect(clampQuotaCooldown(exactly, NOW)?.getTime()).toBe(exactly.getTime());
    const oneMsOver = new Date(NOW.getTime() + QUOTA_COOLDOWN_MAX_MS + 1);
    expect(clampQuotaCooldown(oneMsOver, NOW)?.getTime()).toBe(exactly.getTime());
  });
});

describe("quota failure classification", () => {
  it("recognises every adapter that can report exhaustion, including ACPX", () => {
    for (const code of ["gemini_quota_exhausted", "antigravity_quota_exhausted", "acpx_provider_quota_exhausted"]) {
      expect(QUOTA_EXHAUSTED_ERROR_CODES.has(code)).toBe(true);
      expect(isQuotaExhaustedFailureRun({ errorCode: code })).toBe(true);
    }
  });

  it("does not treat a generic ACPX turn failure as quota exhaustion", () => {
    expect(isQuotaExhaustedFailureRun({ errorCode: "acpx_turn_failed" })).toBe(false);
    expect(isQuotaExhaustedFailureRun({ errorCode: null })).toBe(false);
    expect(isQuotaExhaustedFailureRun(null)).toBe(false);
  });

  it("reads resetAt from either the quotaFailure envelope or the run root", () => {
    const iso = "2026-08-30T10:20:12.000Z";
    expect(readQuotaFailureResetAt({ resultJson: { quotaFailure: { resetAt: iso } } })?.toISOString()).toBe(iso);
    expect(readQuotaFailureResetAt({ resultJson: { resetAt: iso } })?.toISOString()).toBe(iso);
    expect(readQuotaFailureResetAt({ resultJson: { quotaFailure: { resetAt: "not a date" } } })).toBeNull();
    expect(readQuotaFailureResetAt({ resultJson: {} })).toBeNull();
  });
});
