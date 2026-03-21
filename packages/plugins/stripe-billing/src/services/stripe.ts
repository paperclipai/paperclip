import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import { STRIPE_API_BASE } from "../constants.js";
import type { MeterEventPayload } from "../types.js";
import { createHmac, timingSafeEqual } from "node:crypto";

export type StripeService = ReturnType<typeof createStripeService>;

export function createStripeService(http: PluginHttpClient, apiKey: string) {
  async function stripeRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    contentType: "json" | "form" = "json",
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };

    let bodyStr: string | undefined;
    if (body) {
      if (contentType === "form") {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        bodyStr = new URLSearchParams(
          Object.entries(body).map(([k, v]) => [k, String(v)]),
        ).toString();
      } else {
        headers["Content-Type"] = "application/json";
        bodyStr = JSON.stringify(body);
      }
    }

    const response = await http.fetch(`${STRIPE_API_BASE}${path}`, {
      method,
      headers,
      ...(bodyStr ? { body: bodyStr } : {}),
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};

    if (response.status >= 400) {
      const msg = (parsed as any)?.error?.message ?? `Stripe API error: ${response.status}`;
      throw new Error(msg);
    }

    return parsed;
  }

  return {
    async sendMeterEvent(payload: MeterEventPayload): Promise<void> {
      await stripeRequest("POST", "/v2/billing/meter_events", payload as unknown as Record<string, unknown>);
    },

    async createCustomer(name: string, email: string): Promise<{ id: string }> {
      return (await stripeRequest("POST", "/v1/customers", { name, email }, "form")) as { id: string };
    },

    async createSubscription(
      customerId: string,
      priceItems: Array<{ price: string }>,
    ): Promise<{ id: string }> {
      const body: Record<string, unknown> = {
        customer: customerId,
      };
      priceItems.forEach((item, i) => {
        body[`items[${i}][price]`] = item.price;
      });
      return (await stripeRequest("POST", "/v1/subscriptions", body, "form")) as { id: string };
    },

    verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
      if (!signatureHeader) return false;
      const parts = signatureHeader.split(",").reduce<Record<string, string>>((acc, part) => {
        const [key, value] = part.split("=");
        if (key && value) acc[key] = value;
        return acc;
      }, {});

      const timestamp = parts["t"];
      const signature = parts["v1"];
      if (!timestamp || !signature) return false;

      const payload = `${timestamp}.${rawBody}`;
      const expected = createHmac("sha256", secret).update(payload).digest("hex");

      try {
        return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      } catch {
        return false;
      }
    },
  };
}
