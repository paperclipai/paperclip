import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

const insertValues = vi.fn().mockResolvedValue(undefined);
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
  publishLiveEvent: vi.fn(),
}));

describe("services/activity-log.ts", () => {
  it("writes activity records without throwing for valid payloads", async () => {
    const { logActivity } = await import("../services/activity-log.js");
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

  it("keeps HttpError type available for service error assertions", () => {
    expect(new HttpError(404, "missing").status).toBe(404);
  });
});

