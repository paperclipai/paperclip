import { describe, it, expect } from "vitest";
import { formatMeterEvents } from "../src/services/meter.js";

describe("formatMeterEvents", () => {
  it("creates two meter events from a cost event (input + output)", () => {
    const events = formatMeterEvents({
      costEventId: "evt_1",
      stripeCustomerId: "cus_123",
      model: "claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      occurredAt: "2026-03-20T12:00:00Z",
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.identifier).toBe("evt_1-input");
    expect(events[0]!.payload.value).toBe("1000");
    expect(events[0]!.payload.token_type).toBe("input");
    expect(events[1]!.identifier).toBe("evt_1-output");
    expect(events[1]!.payload.value).toBe("500");
    expect(events[1]!.payload.token_type).toBe("output");
  });

  it("skips events with zero tokens", () => {
    const events = formatMeterEvents({
      costEventId: "evt_2",
      stripeCustomerId: "cus_123",
      model: "claude-opus-4-6",
      inputTokens: 0,
      outputTokens: 500,
      occurredAt: "2026-03-20T12:00:00Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.token_type).toBe("output");
  });

  it("returns empty array when both token counts are zero", () => {
    const events = formatMeterEvents({
      costEventId: "evt_3",
      stripeCustomerId: "cus_123",
      model: "claude-opus-4-6",
      inputTokens: 0,
      outputTokens: 0,
      occurredAt: "2026-03-20T12:00:00Z",
    });

    expect(events).toHaveLength(0);
  });
});
