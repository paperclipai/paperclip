import { describe, expect, it, vi } from "vitest";
import { logActivity } from "../services/activity-log.js";
import { heartbeatService } from "../services/heartbeat.js";

const publishLiveEventMock = vi.hoisted(() => vi.fn());

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

describe("run id normalization", () => {
  it("stores null activity run ids when the actor run id is not a UUID", async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      insert: vi.fn(() => ({
        values(values: Record<string, unknown>) {
          inserted = values;
          return Promise.resolve();
        },
      })),
    };

    await logActivity(db as any, {
      companyId: "11111111-1111-4111-8111-111111111111",
      actorType: "agent",
      actorId: "22222222-2222-4222-8222-222222222222",
      action: "issue.updated",
      entityType: "issue",
      entityId: "33333333-3333-4333-8333-333333333333",
      runId: "test-run",
    });

    expect(inserted).toMatchObject({ runId: null });
    expect(publishLiveEventMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ runId: null }),
    }));
  });

  it("does not touch the database when detached cleanup receives a non-UUID run id", async () => {
    const db = {
      update: vi.fn(() => {
        throw new Error("db should not be called for non-UUID run ids");
      }),
    };

    await expect(heartbeatService(db as any).reportRunActivity("test-run")).resolves.toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });
});
