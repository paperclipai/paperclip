import { describe, expect, it } from "vitest";
import {
  telegramStopSubscriptionPlan,
  telegramStopSubscriptionConfirmed,
} from "./chat-telegram-stop-subscription.js";

describe("Telegram Stop subscription preservation", () => {
  const url = "https://example.test/api/chat-webhooks/fixture/telegram";
  const info = {
    url,
    has_custom_certificate: false,
    max_connections: 37,
    pending_update_count: 99,
    ip_address: "203.0.113.4",
  };
  it.each([undefined, []])(
    "preserves default subscriptions explicitly (%s)",
    (allowed_updates) => {
      expect(
        telegramStopSubscriptionPlan({ ...info, allowed_updates }, url),
      ).toEqual({ allowed_updates: [], max_connections: 37 });
    },
  );
  it("preserves opt-ins and unknown future names without copying routing diagnostics", () => {
    expect(
      telegramStopSubscriptionPlan(
        { ...info, allowed_updates: ["message_reaction", "future_update"] },
        url,
      ),
    ).toEqual({
      allowed_updates: [
        "message_reaction",
        "future_update",
        "stopped_message_generation",
      ],
      max_connections: 37,
    });
  });
  it("never upgrades a contradictory final observation into a confirmation", () => {
    const before = { ...info, allowed_updates: ["message"] };
    const plan = telegramStopSubscriptionPlan(before, url)!;
    expect(telegramStopSubscriptionConfirmed(before, url, plan)).toBe(false);
    expect(
      telegramStopSubscriptionConfirmed(
        { ...info, allowed_updates: plan.allowed_updates },
        url,
        plan,
      ),
    ).toBe(true);
    expect(
      telegramStopSubscriptionConfirmed(
        { ...info, allowed_updates: [...plan.allowed_updates].reverse() },
        url,
        plan,
      ),
    ).toBe(true);
    expect(
      telegramStopSubscriptionConfirmed(
        { ...info, allowed_updates: [...plan.allowed_updates, "message"] },
        url,
        plan,
      ),
    ).toBe(true);
    expect(
      telegramStopSubscriptionConfirmed(info, url, {
        allowed_updates: [],
        max_connections: 37,
      }),
    ).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { ...info, url: "https://other.test/" },
    { ...info, has_custom_certificate: true },
    { ...info, has_custom_certificate: undefined },
    { ...info, max_connections: 0 },
    { ...info, max_connections: 101 },
    { ...info, max_connections: "37" },
    { ...info, allowed_updates: "message" },
    { ...info, allowed_updates: [1] },
    { ...info, allowed_updates: null },
    { ...info, max_connections: null },
    { ...info, allowed_updates: ["private\nvalue"] },
    { ...info, allowed_updates: Array(257).fill("message") },
  ])("refuses unsupported or malformed preservation %j", (value) => {
    expect(telegramStopSubscriptionPlan(value, url)).toBeNull();
  });
});
