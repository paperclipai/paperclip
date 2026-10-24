import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S,
  MAX_PROFILE_DEFERRED_RETRY_AFTER_S,
  PROFILE_DEFERRED_CAPACITY_CODE,
  readProfileDeferralFromAdapterResult,
  resolveProfileDeferralBooking,
} from "./profile-deferral.js";

describe("readProfileDeferralFromAdapterResult", () => {
  it("canonicalizes the hermes adapter deferral code", () => {
    expect(
      readProfileDeferralFromAdapterResult({
        errorCode: "hermes_profile_deferred_capacity",
        retryAfterS: 300,
        retryable: true,
        deferredProfile: "nwc",
        errorMessage: "no slot among 17 served of 43 installed (ceiling 17)",
      }),
    ).toMatchObject({
      errorCode: PROFILE_DEFERRED_CAPACITY_CODE,
      adapterErrorCode: "hermes_profile_deferred_capacity",
      retryAfterS: 300,
      retryable: true,
      profile: "nwc",
    });
  });

  it("leaves ordinary adapter failures on the adapter_failed path", () => {
    expect(readProfileDeferralFromAdapterResult({ errorCode: "adapter_failed" })).toBeNull();
    expect(readProfileDeferralFromAdapterResult({ errorCode: "hermes_gateway_run_failed" })).toBeNull();
    expect(readProfileDeferralFromAdapterResult({})).toBeNull();
    expect(readProfileDeferralFromAdapterResult(null)).toBeNull();
  });

  it("defaults and caps the wait the runtime asked for", () => {
    expect(
      readProfileDeferralFromAdapterResult({ errorCode: "hermes_profile_deferred_capacity" })?.retryAfterS,
    ).toBe(DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S);
    expect(
      readProfileDeferralFromAdapterResult({
        errorCode: "hermes_profile_deferred_capacity",
        retryAfterS: 999_999,
      })?.retryAfterS,
    ).toBe(MAX_PROFILE_DEFERRED_RETRY_AFTER_S);
  });
});

describe("resolveProfileDeferralBooking", () => {
  const now = new Date("2026-10-22T19:00:00.000Z");

  it("parks the run as a scheduled retry at retryAfterS", () => {
    const booking = resolveProfileDeferralBooking({ retryAfterS: 300, attempt: 0, now });
    expect(booking).toMatchObject({
      status: "scheduled_retry",
      errorCode: PROFILE_DEFERRED_CAPACITY_CODE,
      stopReason: PROFILE_DEFERRED_CAPACITY_CODE,
      retryReason: PROFILE_DEFERRED_CAPACITY_CODE,
      delayMs: 300_000,
      multiplier: 1,
    });
    expect(booking.retryAt.toISOString()).toBe("2026-10-22T19:05:00.000Z");
  });

  it("backs a parked profile off instead of re-dispatching every retryAfterS forever", () => {
    expect(resolveProfileDeferralBooking({ retryAfterS: 300, attempt: 2, now }).delayMs).toBe(900_000);
    expect(resolveProfileDeferralBooking({ retryAfterS: 300, attempt: 99, now }).delayMs).toBe(1_200_000);
  });
});
