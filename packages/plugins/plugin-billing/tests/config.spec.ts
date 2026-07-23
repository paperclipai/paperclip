import { describe, expect, it } from "vitest";
import { DEFAULT_BILLING_CONFIG, parseBillingConfig } from "../src/config.js";

describe("parseBillingConfig", () => {
  it("returns spec defaults for empty/missing config", () => {
    expect(parseBillingConfig(undefined)).toEqual(DEFAULT_BILLING_CONFIG);
    expect(parseBillingConfig({})).toEqual(DEFAULT_BILLING_CONFIG);
    expect(DEFAULT_BILLING_CONFIG).toEqual({
      currency: "EUR",
      defaultMonthlyPriceCents: 4900,
      trialDays: 7,
      graceDays: 7,
      trialPolicy: "first-company-per-owner",
      provider: "stub",
      instanceBaseUrl: "http://127.0.0.1:3100",
    });
  });

  it("accepts valid overrides", () => {
    expect(
      parseBillingConfig({
        currency: "USD",
        defaultMonthlyPriceCents: 9900,
        trialDays: 14,
        graceDays: 3,
        trialPolicy: "every-company",
        provider: "stub",
        instanceBaseUrl: "http://paperclip.internal:3100",
      }),
    ).toEqual({
      currency: "USD",
      defaultMonthlyPriceCents: 9900,
      trialDays: 14,
      graceDays: 3,
      trialPolicy: "every-company",
      provider: "stub",
      instanceBaseUrl: "http://paperclip.internal:3100",
    });
  });

  it("falls back per-field on invalid values (never throws — billing must fail safe)", () => {
    const parsed = parseBillingConfig({
      currency: 42,
      defaultMonthlyPriceCents: -5,
      trialDays: "soon",
      graceDays: -1,
      trialPolicy: "sometimes",
      provider: "stripe",
      instanceBaseUrl: 0,
    });
    expect(parsed).toEqual(DEFAULT_BILLING_CONFIG);
  });

  it("allows zero trialDays and zero graceDays", () => {
    const parsed = parseBillingConfig({ trialDays: 0, graceDays: 0 });
    expect(parsed.trialDays).toBe(0);
    expect(parsed.graceDays).toBe(0);
  });
});
