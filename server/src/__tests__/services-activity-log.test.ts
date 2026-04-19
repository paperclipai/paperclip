import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import { logActivity, setPluginEventBus } from "../services/activity-log.js";

const insertValues = vi.fn().mockResolvedValue(undefined);
const publishLiveEvent = vi.hoisted(() => vi.fn());
const db = {
  insert: vi.fn(() => ({
    values: insertValues,
  })),
};

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent,
}));

describe("services/activity-log.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("publishes company live events after writing activity records", async () => {
    await logActivity(db as any, {
      companyId: "cmp-1",
      actorType: "user",
      actorId: "usr-1",
      action: "issue.created",
      entityType: "issue",
      entityId: "iss-1",
      details: { summary: "created from board" },
    });

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "cmp-1",
        type: "activity.logged",
      }),
    );
  });
  it("writes activity records without throwing for valid payloads", async () => {
    await expect(
      logActivity(db as any, {
        companyId: "cmp-1",
        actorType: "user",
        actorId: "usr-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "iss-1",
        details: { foo: "bar" },
      }),
    ).resolves.toBeUndefined();
    expect(insertValues).toHaveBeenCalledTimes(1);
  });
  it("forwards plugin event actions to the plugin event bus", async () => {
    const emit = vi.fn().mockResolvedValue({ errors: [] });
    setPluginEventBus({ emit } as any);

    await logActivity(db as any, {
      companyId: "cmp-1",
      actorType: "user",
      actorId: "usr-1",
      action: PLUGIN_EVENT_TYPES[0] ?? "issue.created",
      entityType: "issue",
      entityId: "iss-2",
      details: { summary: "trigger plugin event bus" },
    });
    await Promise.resolve();

    expect(emit).toHaveBeenCalledTimes(1);
  });
});

