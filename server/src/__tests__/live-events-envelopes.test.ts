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

  it("keeps small events batched around an oversized one, preserving event order", () => {
    const events = [
      makeEvent({ id: 1 }),
      makeEvent({ id: 2, payload: { huge: "x".repeat(10_000) } }),
      makeEvent({ id: 3 }),
    ];
    const envelopes = packEnvelopes("origin-1", events, PG_NOTIFY_INLINE_LIMIT);
    // The pending batch is flushed before a resync marker is pushed, so the
    // marker never overtakes earlier inline events: envelope order matches
    // event order.
    expect(envelopes.map((e) => e.kind)).toEqual(["full", "resync", "full"]);
    const delivered = envelopes.flatMap((e) => envelopeToEvents("company-a", e));
    expect(delivered.map((e) => e.id)).toEqual([1, 0, 3]);
    expect(delivered[1]?.payload).toEqual({ __resync: true });
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

  it("returns [] for an unknown envelope kind instead of throwing", () => {
    const bogus = { kind: "bogus", origin: "origin-1" } as unknown as Parameters<
      typeof envelopeToEvents
    >[1];
    expect(envelopeToEvents("company-a", bogus)).toEqual([]);
  });

  it("returns [] for shape mismatches (full without event object, batch without array)", () => {
    const fullNoEvent = { kind: "full", origin: "origin-1" } as unknown as Parameters<
      typeof envelopeToEvents
    >[1];
    expect(envelopeToEvents("company-a", fullNoEvent)).toEqual([]);
    const batchNoArray = { kind: "batch", origin: "origin-1", events: "nope" } as unknown as Parameters<
      typeof envelopeToEvents
    >[1];
    expect(envelopeToEvents("company-a", batchNoArray)).toEqual([]);
  });

  it("treats the pre-hardening wire format { origin, event } (no kind) as a full envelope", () => {
    const event = makeEvent({ id: 7 });
    const legacy = { origin: "origin-1", event } as unknown as Parameters<typeof envelopeToEvents>[1];
    expect(envelopeToEvents("company-a", legacy)).toEqual([event]);
  });

  it("filters a batch envelope down to the channel's company", () => {
    const mine1 = makeEvent({ id: 1 });
    const foreign = makeEvent({ id: 2, companyId: "company-b" });
    const mine2 = makeEvent({ id: 3 });
    const delivered = envelopeToEvents("company-a", {
      kind: "batch",
      origin: "origin-1",
      events: [mine1, foreign, mine2],
    });
    expect(delivered).toEqual([mine1, mine2]);
  });

  it("returns [] for a full envelope whose event belongs to another company", () => {
    const delivered = envelopeToEvents("company-a", {
      kind: "full",
      origin: "origin-1",
      event: makeEvent({ companyId: "company-b" }),
    });
    expect(delivered).toEqual([]);
  });

  it("returns [] for a resync envelope addressed to another company", () => {
    const delivered = envelopeToEvents("company-a", {
      kind: "resync",
      origin: "origin-1",
      companyId: "company-b",
      type: "activity.logged",
    });
    expect(delivered).toEqual([]);
  });

  it("returns [] for a null envelope (parsed JSON null from wire)", () => {
    expect(envelopeToEvents("company-a", null as any)).toEqual([]);
  });

  it("returns [] for a non-object envelope (primitive string from wire)", () => {
    expect(envelopeToEvents("company-a", "x" as any)).toEqual([]);
  });

  it("returns [] for a resync envelope with a missing or non-string type", () => {
    const missingType = {
      kind: "resync",
      origin: "origin-1",
      companyId: "company-a",
    } as unknown as Parameters<typeof envelopeToEvents>[1];
    expect(envelopeToEvents("company-a", missingType)).toEqual([]);

    const numericType = {
      kind: "resync",
      origin: "origin-1",
      companyId: "company-a",
      type: 42,
    } as unknown as Parameters<typeof envelopeToEvents>[1];
    expect(envelopeToEvents("company-a", numericType)).toEqual([]);
  });
});
