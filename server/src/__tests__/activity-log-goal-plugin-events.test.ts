import { beforeEach, describe, expect, it, vi } from "vitest";

// logActivity reads instance settings for username redaction — irrelevant here.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

import { logActivity, setPluginEventBus } from "../services/activity-log.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const emitted: PluginEvent[] = [];
const fakeBus = {
  emit: vi.fn(async (event: PluginEvent) => {
    emitted.push(event);
    return { errors: [] };
  }),
} as unknown as PluginEventBus;

// logActivity only needs insert().values() from the db.
const dbStub = { insert: () => ({ values: async () => undefined }) } as never;

function activity(action: string, entityType: string) {
  return {
    companyId: "c-1",
    actorType: "system" as const,
    actorId: "test",
    action,
    entityType,
    entityId: "e-1",
    details: { title: "t" },
  };
}

describe("activity actions publish plugin events through logActivity", () => {
  beforeEach(() => {
    emitted.length = 0;
    setPluginEventBus(fakeBus);
  });

  // Pins the eventTypeForActivityAction pass-through: these activity actions
  // share their name with a declared plugin event type, so a rename on either
  // side would silently stop emission — this test makes that failure visible.
  it.each([
    ["goal.created", "goal"],
    ["goal.updated", "goal"],
    ["goal.deleted", "goal"],
    ["agent.deleted", "agent"],
  ])("logActivity(action=%s) emits the same-named plugin event", async (action, entityType) => {
    await logActivity(dbStub, activity(action, entityType));
    await vi.waitFor(() => expect(emitted.map((e) => e.eventType)).toContain(action));
    expect(emitted.find((e) => e.eventType === action)).toMatchObject({
      companyId: "c-1",
      entityType,
      entityId: "e-1",
    });
  });

  // Pins the ACTIVITY_ACTION_TO_PLUGIN_EVENT mapping (including the dot→snake
  // normalization applied to logged actions before the map lookup).
  it.each([
    ["agent.paused"],
    ["agent.resumed"],
    ["agent.terminated"],
    ["agent.approved"],
  ])("logActivity(action=%s) emits agent.status_changed", async (action) => {
    await logActivity(dbStub, activity(action, "agent"));
    await vi.waitFor(() =>
      expect(emitted.map((e) => e.eventType)).toContain("agent.status_changed"),
    );
    expect(emitted.find((e) => e.eventType === "agent.status_changed")).toMatchObject({
      companyId: "c-1",
      entityType: "agent",
      entityId: "e-1",
    });
  });

  it("does NOT emit for activity actions that are neither event types nor mapped", async () => {
    await logActivity(dbStub, activity("goal.reviewed", "goal"));
    // If this breaks because the action became a declared plugin event: move the
    // case to an emitting group above — NEVER delete the assertion.
    expect(emitted).toHaveLength(0);
  });
});
