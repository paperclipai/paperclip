import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { createPluginEventBus } from "./plugin-event-bus.js";

/**
 * Builds a minimal, well-typed `PluginEvent`. `overrides` lets tests blank
 * out `companyId` to simulate an event without company context (the bus
 * treats a falsy value as "absent" for gating purposes).
 */
function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.created",
    occurredAt: new Date().toISOString(),
    companyId: "company-1",
    payload: {},
    ...overrides,
  } as PluginEvent;
}

describe("per-company event delivery gate", () => {
  function busWithChecker(deliverable: boolean) {
    const isPluginDeliverableForCompany = vi.fn(async () => deliverable);
    const bus = createPluginEventBus({ isPluginDeliverableForCompany });
    return { bus, isPluginDeliverableForCompany };
  }

  it("skips delivery to a plugin disabled for the event's company", async () => {
    const { bus, isPluginDeliverableForCompany } = busWithChecker(false);
    const handler = vi.fn(async () => {});
    bus.forPlugin("plugin-a").subscribe("issue.created", handler);

    const result = await bus.emit(makeEvent());

    expect(handler).not.toHaveBeenCalled();
    expect(isPluginDeliverableForCompany).toHaveBeenCalledWith("plugin-a", "company-1");
    expect(result.errors).toEqual([]);
  });

  it("delivers when the checker allows", async () => {
    const { bus } = busWithChecker(true);
    const handler = vi.fn(async () => {});
    bus.forPlugin("plugin-a").subscribe("issue.created", handler);

    const result = await bus.emit(makeEvent());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
  });

  it("does not consult the checker for events without a companyId", async () => {
    const { bus, isPluginDeliverableForCompany } = busWithChecker(false);
    const handler = vi.fn(async () => {});
    bus.forPlugin("plugin-a").subscribe("activity.logged", handler);

    await bus.emit(makeEvent({
      eventType: "activity.logged",
      companyId: undefined as unknown as string,
    }));

    expect(isPluginDeliverableForCompany).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("memoizes the check per plugin within one emit and re-checks on the next", async () => {
    const { bus, isPluginDeliverableForCompany } = busWithChecker(true);
    const handlerA1 = vi.fn(async () => {});
    const handlerA2 = vi.fn(async () => {});
    bus.forPlugin("plugin-a").subscribe("issue.created", handlerA1);
    bus.forPlugin("plugin-a").subscribe("issue.created", handlerA2);

    await bus.emit(makeEvent());
    expect(isPluginDeliverableForCompany).toHaveBeenCalledTimes(1);
    expect(handlerA1).toHaveBeenCalledTimes(1);
    expect(handlerA2).toHaveBeenCalledTimes(1);

    await bus.emit(makeEvent());
    expect(isPluginDeliverableForCompany).toHaveBeenCalledTimes(2);
  });

  it("fails open (delivers) when the checker throws", async () => {
    const isPluginDeliverableForCompany = vi.fn(async () => {
      throw new Error("enablement lookup failed");
    });
    const bus = createPluginEventBus({ isPluginDeliverableForCompany });
    const handler = vi.fn(async () => {});
    bus.forPlugin("plugin-a").subscribe("issue.created", handler);

    const result = await bus.emit(makeEvent());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
  });

  it("keeps the existing no-arg call form working unchanged", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn(async () => {});
    bus.forPlugin("plugin-a").subscribe("issue.created", handler);

    const result = await bus.emit(makeEvent());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
  });
});
