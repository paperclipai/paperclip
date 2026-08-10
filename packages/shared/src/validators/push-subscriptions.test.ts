import { describe, expect, it } from "vitest";
import { subscribePushSubscriptionSchema, unsubscribePushSubscriptionSchema } from "./push-subscriptions.js";

const keys = { p256dh: "p256dh", auth: "auth" };

describe("push subscription endpoint validation", () => {
  it.each([
    "http://push.example/device",
    "https://localhost/device",
    "https://push.local/device",
    "https://push.internal/device",
    "https://push/device",
    "https://0.0.0.0/device",
    "https://10.0.0.1/device",
    "https://100.64.0.1/device",
    "https://127.0.0.1/device",
    "https://169.254.169.254/latest/meta-data/",
    "https://172.16.0.1/device",
    "https://192.168.1.1/device",
    "https://198.18.0.1/device",
    "https://224.0.0.1/device",
    "https://[::1]/device",
    "https://[fc00::1]/device",
    "https://[fe80::1]/device",
  ])("rejects private or non-HTTPS endpoint %s", (endpoint) => {
    expect(subscribePushSubscriptionSchema.safeParse({ endpoint, keys }).success).toBe(false);
    expect(unsubscribePushSubscriptionSchema.safeParse({ endpoint }).success).toBe(false);
  });

  it("accepts a public HTTPS endpoint", () => {
    expect(subscribePushSubscriptionSchema.safeParse({ endpoint: "https://push.example/device", keys }).success).toBe(true);
  });
});
