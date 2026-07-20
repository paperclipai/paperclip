import { describe, expect, it } from "vitest";
import {
  buildBillingPreview,
  calculateOverage,
  classifyUsageBilling,
  createCheckoutSession,
  createPortalSession,
  resolveStripePriceId,
  TIERS,
} from "./usage-metering.js";

describe("classifyUsageBilling", () => {
  it("bills managed metered usage", () => {
    expect(classifyUsageBilling("metered_api")).toBe("billable");
  });

  it("skips customer-paid and subscription usage", () => {
    expect(classifyUsageBilling("subscription_included")).toBe("customer_paid");
    expect(classifyUsageBilling("subscription_overage")).toBe("customer_paid");
  });

  it("does not silently waive unknown usage", () => {
    expect(classifyUsageBilling("unknown")).toBe("needs_review");
    expect(classifyUsageBilling(null)).toBe("needs_review");
  });
});

describe("calculateOverage", () => {
  it("multiplies the included allowance by seat count", () => {
    expect(calculateOverage(18_000, TIERS.pro, 3)).toEqual({
      includedAllowanceCents: 15_000,
      actualCostCents: 18_000,
      overageCents: 3_000,
      overageMarkupCents: 450,
      totalOverageCents: 3_450,
      markupPercent: 15,
    });
  });

  it("never charges overage below the included allowance", () => {
    expect(calculateOverage(4_999, TIERS.pro, 1).totalOverageCents).toBe(0);
  });
});

describe("buildBillingPreview", () => {
  it("adds seat subscription and managed usage overage", () => {
    expect(buildBillingPreview({ tier: "pro", seatCount: 3, actualCostCents: 18_000 })).toEqual({
      tier: "pro",
      seatCount: 3,
      subscriptionCents: 6_000,
      includedAllowanceCents: 15_000,
      managedUsageCents: 18_000,
      overageCents: 3_000,
      markupCents: 450,
      projectedInvoiceCents: 9_450,
      usageBilling: "billable",
    });
  });

  it("charges seats but skips usage when the customer pays the provider", () => {
    expect(
      buildBillingPreview({
        tier: "team",
        seatCount: 2,
        actualCostCents: 90_000,
        usageBilling: "customer_paid",
      }),
    ).toMatchObject({
      subscriptionCents: 10_000,
      includedAllowanceCents: 40_000,
      overageCents: 0,
      markupCents: 0,
      projectedInvoiceCents: 10_000,
      usageBilling: "customer_paid",
    });
  });

  it("rejects tiers without a published seat price", () => {
    expect(() => buildBillingPreview({ tier: "enterprise", seatCount: 1, actualCostCents: 0 }))
      .toThrow("Tier enterprise requires custom billing configuration");
  });
});

describe("Stripe subscription requests", () => {
  it("resolves monthly and annual price IDs from explicit environment keys", () => {
    expect(resolveStripePriceId("pro", "monthly", { STRIPE_PRICE_PRO_MONTHLY: "price_pro" })).toBe("price_pro");
    expect(resolveStripePriceId("team", "annual", { STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual" })).toBe("price_team_annual");
  });

  it("fails closed when a Stripe price is not configured", () => {
    expect(() => resolveStripePriceId("pro", "monthly", {})).toThrow(
      "Missing STRIPE_PRICE_PRO_MONTHLY",
    );
  });

  it("creates a seat-quantity Checkout Session without exposing the secret", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(createCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_pro_monthly",
      companyId: "company-123",
      seatCount: 3,
      successUrl: "https://app.test/billing?success=1",
      cancelUrl: "https://app.test/billing?cancelled=1",
      fetcher,
    })).resolves.toEqual({ id: "cs_test_123", url: "https://checkout.stripe.test/session" });

    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer sk_test_secret" });
    const body = calls[0]?.init?.body as URLSearchParams;
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("client_reference_id")).toBe("company-123");
    expect(body.get("line_items[0][price]")).toBe("price_pro_monthly");
    expect(body.get("line_items[0][quantity]")).toBe("3");
  });

  it("fails closed when Stripe rejects a request", async () => {
    const fetcher = async () => new Response(JSON.stringify({ error: { message: "invalid price" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    await expect(createCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_bad",
      companyId: "company-123",
      seatCount: 1,
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
      fetcher,
    })).rejects.toThrow("Stripe request failed (400): invalid price");
  });

  it("creates a customer portal session", async () => {
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("customer")).toBe("cus_123");
      expect(body.get("return_url")).toBe("https://app.test/billing");
      return new Response(JSON.stringify({ url: "https://billing.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await expect(createPortalSession({
      secretKey: "sk_test_secret",
      customerId: "cus_123",
      returnUrl: "https://app.test/billing",
      fetcher,
    })).resolves.toEqual({ url: "https://billing.stripe.test/session" });
  });
});
