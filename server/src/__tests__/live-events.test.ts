import { describe, it, expect } from "vitest";
import {
  publishLiveEvent,
  publishGlobalLiveEvent,
  subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "../services/live-events.js";
import type { LiveEvent } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// publishLiveEvent
// ---------------------------------------------------------------------------

describe("publishLiveEvent", () => {
  it("returns an event object with the correct shape", () => {
    const event = publishLiveEvent({
      companyId: "co-1",
      type: "agent.status",
      payload: { status: "active" },
    });
    expect(event.companyId).toBe("co-1");
    expect(event.type).toBe("agent.status");
    expect(event.payload).toEqual({ status: "active" });
    expect(typeof event.id).toBe("number");
    expect(typeof event.createdAt).toBe("string");
  });

  it("defaults payload to an empty object when omitted", () => {
    const event = publishLiveEvent({ companyId: "co-1", type: "agent.status" });
    expect(event.payload).toEqual({});
  });

  it("increments the event id with each call", () => {
    const e1 = publishLiveEvent({ companyId: "co-1", type: "agent.status" });
    const e2 = publishLiveEvent({ companyId: "co-1", type: "agent.status" });
    expect(e2.id).toBe(e1.id + 1);
  });

  it("delivers the event to a subscribed company listener", () => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("co-deliver", (e) => received.push(e));

    publishLiveEvent({ companyId: "co-deliver", type: "activity.logged" });

    unsubscribe();
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("activity.logged");
  });

  it("does NOT deliver to a listener for a different company", () => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("co-other", (e) => received.push(e));

    publishLiveEvent({ companyId: "co-isolated", type: "agent.status" });

    unsubscribe();
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// publishGlobalLiveEvent
// ---------------------------------------------------------------------------

describe("publishGlobalLiveEvent", () => {
  it("returns an event with companyId='*'", () => {
    const event = publishGlobalLiveEvent({ type: "plugin.ui.updated" });
    expect(event.companyId).toBe("*");
    expect(event.type).toBe("plugin.ui.updated");
  });

  it("delivers the event to a global subscriber", () => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeGlobalLiveEvents((e) => received.push(e));

    publishGlobalLiveEvent({ type: "plugin.worker.crashed", payload: { pluginId: "x" } });

    unsubscribe();
    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ pluginId: "x" });
  });

  it("does NOT deliver to a company-scoped subscriber", () => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("co-global-check", (e) => received.push(e));

    publishGlobalLiveEvent({ type: "agent.status" });

    unsubscribe();
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// subscribeCompanyLiveEvents — unsubscribe
// ---------------------------------------------------------------------------

describe("subscribeCompanyLiveEvents (unsubscribe)", () => {
  it("stops receiving events after unsubscribe is called", () => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("co-unsub", (e) => received.push(e));

    publishLiveEvent({ companyId: "co-unsub", type: "agent.status" });
    unsubscribe();
    publishLiveEvent({ companyId: "co-unsub", type: "agent.status" });

    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// subscribeGlobalLiveEvents — unsubscribe
// ---------------------------------------------------------------------------

describe("subscribeGlobalLiveEvents (unsubscribe)", () => {
  it("stops receiving events after unsubscribe is called", () => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeGlobalLiveEvents((e) => received.push(e));

    publishGlobalLiveEvent({ type: "agent.status" });
    unsubscribe();
    publishGlobalLiveEvent({ type: "agent.status" });

    expect(received).toHaveLength(1);
  });

  it("multiple subscribers receive the same global event independently", () => {
    const r1: LiveEvent[] = [];
    const r2: LiveEvent[] = [];
    const u1 = subscribeGlobalLiveEvents((e) => r1.push(e));
    const u2 = subscribeGlobalLiveEvents((e) => r2.push(e));

    publishGlobalLiveEvent({ type: "agent.status" });

    u1();
    u2();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });
});
