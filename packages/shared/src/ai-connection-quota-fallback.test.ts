import { describe, expect, it } from "vitest";
import {
  aiConnectionBindingSchema,
  bindingQuotaFallback,
  quotaFallbackBinding,
  type AiConnectionQuotaFallback,
} from "./ai-connections.js";

const fallback: AiConnectionQuotaFallback = {
  provider: "anthropic",
  method: "api_key",
  connectionId: "11111111-1111-4111-8111-111111111111",
  grantId: "22222222-2222-4222-8222-222222222222",
};

describe("quota fallback binding helpers", () => {
  it("accepts an optional quotaFallback on responsible_user and shared bindings", () => {
    expect(
      aiConnectionBindingSchema.safeParse({
        mode: "responsible_user",
        provider: "anthropic",
        method: "subscription",
        quotaFallback: fallback,
      }).success,
    ).toBe(true);
    expect(
      aiConnectionBindingSchema.safeParse({
        mode: "shared",
        provider: "anthropic",
        method: "subscription",
        connectionId: "33333333-3333-4333-8333-333333333333",
        grantId: "44444444-4444-4444-8444-444444444444",
        quotaFallback: fallback,
      }).success,
    ).toBe(true);
  });

  it("rejects a quotaFallback on a delegated binding", () => {
    expect(
      aiConnectionBindingSchema.safeParse({
        mode: "delegated",
        provider: "anthropic",
        method: "subscription",
        connectionId: "33333333-3333-4333-8333-333333333333",
        grantId: "44444444-4444-4444-8444-444444444444",
        quotaFallback: fallback,
      }).success,
    ).toBe(false);
  });

  it("reads the fallback only from binding modes that carry one", () => {
    expect(
      bindingQuotaFallback({
        mode: "responsible_user",
        provider: "anthropic",
        method: "subscription",
        quotaFallback: fallback,
      }),
    ).toEqual(fallback);
    expect(
      bindingQuotaFallback({
        mode: "responsible_user",
        provider: "anthropic",
        method: "subscription",
      }),
    ).toBeUndefined();
    expect(
      bindingQuotaFallback({
        mode: "delegated",
        provider: "anthropic",
        method: "subscription",
        connectionId: "33333333-3333-4333-8333-333333333333",
        grantId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBeUndefined();
  });

  it("derives a shared binding that select() can resolve", () => {
    expect(quotaFallbackBinding(fallback)).toEqual({
      mode: "shared",
      provider: "anthropic",
      method: "api_key",
      connectionId: fallback.connectionId,
      grantId: fallback.grantId,
    });
  });
});
