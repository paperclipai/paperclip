import { describe, expect, it } from "vitest";
import { normalizeBilledCostCents } from "../services/heartbeat.js";

// RFC paperclipai/paperclip#5066: covers the normalize path that decides
// whether an adapter-reported costUsd lands in cost_events.cost_cents.

describe("normalizeBilledCostCents", () => {
  it("returns 0 when costUsd is null or undefined (any billingType)", () => {
    expect(normalizeBilledCostCents(null, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(undefined, "subscription_included")).toBe(0);
    expect(normalizeBilledCostCents(null, "credits")).toBe(0);
  });

  it("returns 0 when costUsd is NaN or Infinity", () => {
    expect(normalizeBilledCostCents(Number.NaN, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(Number.POSITIVE_INFINITY, "metered_api")).toBe(0);
  });

  it("rounds metered_api costUsd to cents", () => {
    expect(normalizeBilledCostCents(0, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(0.014, "metered_api")).toBe(1);
    expect(normalizeBilledCostCents(0.5, "metered_api")).toBe(50);
    expect(normalizeBilledCostCents(1.2802922, "metered_api")).toBe(128);
  });

  it("clamps negative costUsd to 0 for metered_api", () => {
    expect(normalizeBilledCostCents(-0.5, "metered_api")).toBe(0);
  });

  it("returns 0 for subscription_included when costUsd is 0 (no adapter estimate)", () => {
    // This is the pre-RFC behaviour: subscription-included with no estimate
    // remains $0 because the user paid a flat subscription, no incremental
    // charge. The adapter has not opted into estimateSubscriptionSpendCents.
    expect(normalizeBilledCostCents(0, "subscription_included")).toBe(0);
    expect(normalizeBilledCostCents(-0.1, "subscription_included")).toBe(0);
  });

  it("honors non-zero costUsd for subscription_included (RFC #5066 path)", () => {
    // When the claude_local adapter has `estimateSubscriptionSpendCents=true`
    // it computes a usage-proxy cost from token counts and Anthropic prices.
    // That estimate must reach cost_events.cost_cents so monthSpendCents
    // becomes non-flat for subscription-authed users.
    expect(normalizeBilledCostCents(0.5, "subscription_included")).toBe(50);
    expect(normalizeBilledCostCents(1.28, "subscription_included")).toBe(128);
    expect(normalizeBilledCostCents(0.0001, "subscription_included")).toBe(0); // < 0.5c rounds down
    expect(normalizeBilledCostCents(0.005, "subscription_included")).toBe(1);
  });

  it("handles subscription_overage and other billing types like metered_api", () => {
    expect(normalizeBilledCostCents(0.25, "subscription_overage")).toBe(25);
    expect(normalizeBilledCostCents(1.0, "credits")).toBe(100);
    expect(normalizeBilledCostCents(0.42, "unknown")).toBe(42);
  });
});
