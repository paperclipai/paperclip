import { describe, expect, it, vi } from "vitest";
import {
  publishGlobalLiveEvent,
  publishLiveEvent,
  subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "../services/live-events.js";

describe("services/live-events.ts", () => {
  it("publishes and receives company scoped events", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCompanyLiveEvents("cmp-1", listener);
    const event = publishLiveEvent({ companyId: "cmp-1", type: "activity.logged", payload: { ok: true } });

    expect(listener).toHaveBeenCalledWith(event);
    expect(event.companyId).toBe("cmp-1");
    unsubscribe();
  });

  it("publishes and receives global events", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGlobalLiveEvents(listener);
    const event = publishGlobalLiveEvent({ type: "activity.logged", payload: { scope: "global" } });
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
  });
});

