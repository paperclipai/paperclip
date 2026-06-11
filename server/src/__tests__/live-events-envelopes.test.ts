import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import {
  envelopeToEvents,
  packEnvelopes,
  PG_NOTIFY_INLINE_LIMIT,
} from "../services/live-events/transport.js";

function makeEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1,
    companyId: "company-a",
    type: "activity.logged",
    createdAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

describe("packEnvelopes", () => {
  it("packs a single small event as a full envelope", () => {
    const event = makeEvent();
    const envelopes = packEnvelopes("origin-1", [event], PG_NOTIFY_INLINE_LIMIT);
    expect(envelopes).toEqual([{ kind: "full", origin: "origin-1", event }]);
  });

  it("coalesces multiple small events into one batch envelope", () => {
    const events = [makeEvent({ id: 1 }), makeEvent({ id: 2 }), makeEvent({ id: 3 })];
    const envelopes = packEnvelopes("origin-1", events, PG_NOTIFY_INLINE_LIMIT);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toEqual({ kind: "batch", origin: "origin-1", events });
  });

  it("splits into multiple envelopes when a batch would exceed maxBytes", () => {
    const big = "x".repeat(3000);
    const events = [
      makeEvent({ id: 1, payload: { big } }),
      makeEvent({ id: 2, payload: { big } }),
      makeEvent({ id: 3, payload: { big } }),
    ];
    const envelopes = packEnvelopes("origin-1", events, PG_NOTIFY_INLINE_LIMIT);
    expect(envelopes.length).toBeGreaterThan(1);
    const delivered = envelopes.flatMap((e) => envelopeToEvents("company-a", e));
    expect(delivered.map((e) => e.id)).toEqual([1, 2, 3]);
    for (const envelope of envelopes) {
      expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(
        PG_NOTIFY_INLINE_LIMIT,
      );
    }
  });

  it("downgrades an event that can never fit to a resync marker preserving its type", () => {
    const event = makeEvent({ type: "heartbeat.run.log", payload: { huge: "x".repeat(10_000) } });
    const envelopes = packEnvelopes("origin-1", [event], PG_NOTIFY_INLINE_LIMIT);
    expect(envelopes).toEqual([
      { kind: "resync", origin: "origin-1", companyId: "company-a", type: "heartbeat.run.log" },
    ]);
  });

  it("keeps small events batched around an oversized one", () => {
    const events = [
      makeEvent({ id: 1 }),
      makeEvent({ id: 2, payload: { huge: "x".repeat(10_000) } }),
      makeEvent({ id: 3 }),
    ];
    const envelopes = packEnvelopes("origin-1", events, PG_NOTIFY_INLINE_LIMIT);
    const kinds = envelopes.map((e) => e.kind).sort();
    expect(kinds).toContain("resync");
    const delivered = envelopes.flatMap((e) => envelopeToEvents("company-a", e));
    expect(delivered.filter((e) => e.payload.__resync !== true).map((e) => e.id)).toEqual([1, 3]);
  });
});

describe("envelopeToEvents", () => {
  it("synthesizes a __resync event from a resync envelope", () => {
    const [event] = envelopeToEvents("company-a", {
      kind: "resync",
      origin: "origin-1",
      companyId: "company-a",
      type: "activity.logged",
    });
    expect(event.companyId).toBe("company-a");
    expect(event.type).toBe("activity.logged");
    expect(event.payload).toEqual({ __resync: true });
  });
});
