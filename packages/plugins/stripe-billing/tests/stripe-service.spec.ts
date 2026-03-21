import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStripeService } from "../src/services/stripe.js";

describe("StripeService", () => {
  let mockHttp: { fetch: ReturnType<typeof vi.fn> };
  let stripe: ReturnType<typeof createStripeService>;

  beforeEach(() => {
    mockHttp = {
      fetch: vi.fn().mockResolvedValue({ status: 200, text: async () => "{}" }),
    };
    stripe = createStripeService(mockHttp as any, "sk_test_123");
  });

  describe("sendMeterEvent", () => {
    it("sends meter event to Stripe API", async () => {
      mockHttp.fetch.mockResolvedValue({ status: 200, text: async () => "{}" });
      const payload = {
        event_name: "llm_token_usage",
        timestamp: "2026-03-20T00:00:00Z",
        payload: {
          stripe_customer_id: "cus_123",
          value: "1000",
          model: "claude-opus-4-6",
          token_type: "input" as const,
        },
        identifier: "evt_1-input",
      };

      await stripe.sendMeterEvent(payload);

      expect(mockHttp.fetch).toHaveBeenCalledWith(
        "https://api.stripe.com/v2/billing/meter_events",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer sk_test_123",
          }),
        }),
      );
    });

    it("throws on non-200 response", async () => {
      mockHttp.fetch.mockResolvedValue({
        status: 400,
        text: async () => '{"error":{"message":"Invalid"}}',
      });

      await expect(stripe.sendMeterEvent({
        event_name: "llm_token_usage",
        timestamp: "2026-03-20T00:00:00Z",
        payload: { stripe_customer_id: "cus_123", value: "1000", model: "test", token_type: "input" },
        identifier: "evt_1-input",
      })).rejects.toThrow();
    });
  });

  describe("createCustomer", () => {
    it("creates a Stripe customer", async () => {
      mockHttp.fetch.mockResolvedValue({
        status: 200,
        text: async () => '{"id":"cus_new"}',
      });

      const result = await stripe.createCustomer("Test Co", "test@example.com");

      expect(result.id).toBe("cus_new");
      expect(mockHttp.fetch).toHaveBeenCalledWith(
        "https://api.stripe.com/v1/customers",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("verifyWebhookSignature", () => {
    it("returns false for missing signature", () => {
      expect(stripe.verifyWebhookSignature("body", "", "whsec_123")).toBe(false);
    });
  });
});
