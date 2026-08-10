import { describe, expect, it } from "vitest";
import { subscribePushSubscriptionSchema, unsubscribePushSubscriptionSchema } from "./push-subscriptions.js";

const keys = { p256dh: "p256dh", auth: "auth" };

describe("push subscription endpoint validation", () => {
  it.each([
    "http://push.example/device",
    "https://localhost/device",
    "https://169.254.169.254/latest/meta-data/",
    "https://192.168.1.1/device",
    "https://[::1]/device",
    "https://push.internal/device",
  ])("rejects private or non-HTTPS endpoint %s", (endpoint) => {
    expect(subscribePushSubscriptionSchema.safeParse({ endpoint, keys }).success).toBe(false);
    expect(unsubscribePushSubscriptionSchema.safeParse({ endpoint }).success).toBe(false);
  });

  it("accepts a public HTTPS endpoint", () => {
    expect(subscribePushSubscriptionSchema.safeParse({ endpoint: "https://push.example/device", keys }).success).toBe(true);
  });
});
