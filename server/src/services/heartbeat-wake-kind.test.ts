import { describe, expect, it } from "vitest";
import type { WakeKind } from "@paperclipai/db";

import { mapSourceToWakeKind, WAKE_KIND_PRIORITY } from "./heartbeat-wake-kind-helpers.js";

describe("mapSourceToWakeKind", () => {
  it("maps on_demand to manual", () => {
    expect(mapSourceToWakeKind("on_demand")).toBe("manual");
  });

  it("maps assignment to event", () => {
    expect(mapSourceToWakeKind("assignment")).toBe("event");
  });

  it("maps automation to event", () => {
    expect(mapSourceToWakeKind("automation")).toBe("event");
  });

  it("maps self_trigger to self_trigger", () => {
    expect(mapSourceToWakeKind("self_trigger")).toBe("self_trigger");
  });

  it("maps timer to cron", () => {
    expect(mapSourceToWakeKind("timer")).toBe("cron");
  });

  it("maps unknown sources to cron", () => {
    expect(mapSourceToWakeKind("scheduler")).toBe("cron");
    expect(mapSourceToWakeKind(undefined)).toBe("cron");
    expect(mapSourceToWakeKind(null)).toBe("cron");
  });
});

describe("WAKE_KIND_PRIORITY dispatch order", () => {
  it("manual has highest priority (lowest number)", () => {
    expect(WAKE_KIND_PRIORITY.manual).toBeLessThan(WAKE_KIND_PRIORITY.event);
    expect(WAKE_KIND_PRIORITY.manual).toBeLessThan(WAKE_KIND_PRIORITY.self_trigger);
    expect(WAKE_KIND_PRIORITY.manual).toBeLessThan(WAKE_KIND_PRIORITY.cron);
  });

  it("event beats self_trigger and cron", () => {
    expect(WAKE_KIND_PRIORITY.event).toBeLessThan(WAKE_KIND_PRIORITY.self_trigger);
    expect(WAKE_KIND_PRIORITY.event).toBeLessThan(WAKE_KIND_PRIORITY.cron);
  });

  it("self_trigger beats cron", () => {
    expect(WAKE_KIND_PRIORITY.self_trigger).toBeLessThan(WAKE_KIND_PRIORITY.cron);
  });

  it("priority order is manual(0) > event(1) > self_trigger(2) > cron(3)", () => {
    const kinds = ["cron", "self_trigger", "event", "manual"] as WakeKind[];
    const sorted = [...kinds].sort(
      (a: WakeKind, b: WakeKind) => WAKE_KIND_PRIORITY[a] - WAKE_KIND_PRIORITY[b],
    );
    expect(sorted).toEqual(["manual", "event", "self_trigger", "cron"]);
  });
});
