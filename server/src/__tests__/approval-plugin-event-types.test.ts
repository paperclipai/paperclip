import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishActivity, setPluginEventBus } from "../services/activity-log.js";

/**
 * Regression tests for the approval.approved / approval.rejected event types.
 *
 * The specific constants were missing from PLUGIN_EVENT_TYPES, so the dot-form
 * route actions fell through the underscore map and reached plugins only as the
 * catch-all "approval.decided". Adding the constants routes the specific events
 * directly — and publishActivity keeps emitting the legacy "approval.decided"
 * companion so existing subscribers continue to receive approval decisions.
 */
describe("approval plugin event types", () => {
  it("includes approval.approved so plugins can subscribe to approval decisions", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("approval.approved");
  });

  it("includes approval.rejected so plugins can subscribe to approval rejections", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("approval.rejected");
  });

  function pluginEvent(eventType: PluginEvent["eventType"]): PluginEvent {
    return {
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date().toISOString(),
      actorId: "user-1",
      actorType: "user",
      entityId: randomUUID(),
      entityType: "approval",
      companyId: randomUUID(),
      payload: {},
    };
  }

  function captureEmits() {
    const emitted: PluginEvent[] = [];
    setPluginEventBus({
      emit: vi.fn(async (event: PluginEvent) => {
        emitted.push(event);
        return { errors: [] };
      }),
    } as never);
    return emitted;
  }

  it("publishes the legacy approval.decided companion alongside approval.approved and approval.rejected", () => {
    const emitted = captureEmits();

    const approved = pluginEvent("approval.approved");
    publishActivity({ companyId: approved.companyId, payload: {} as never, pluginEvent: approved });
    const rejected = pluginEvent("approval.rejected");
    publishActivity({ companyId: rejected.companyId, payload: {} as never, pluginEvent: rejected });

    expect(emitted.map((e) => e.eventType)).toEqual([
      "approval.approved",
      "approval.decided",
      "approval.rejected",
      "approval.decided",
    ]);
    // The companion is a distinct event, not a mutation of the original.
    expect(emitted[1].eventId).not.toBe(emitted[0].eventId);
    expect(emitted[1].entityId).toBe(emitted[0].entityId);
  });

  it("does not add a companion event for non-approval plugin events", () => {
    const emitted = captureEmits();

    const created = pluginEvent("approval.created");
    publishActivity({ companyId: created.companyId, payload: {} as never, pluginEvent: created });

    expect(emitted.map((e) => e.eventType)).toEqual(["approval.created"]);
  });
});
