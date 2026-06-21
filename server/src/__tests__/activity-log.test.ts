import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog } from "@paperclipai/db";

const mockPublishLiveEvent = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockGetGeneral = vi.hoisted(() => vi.fn(async () => ({ censorUsernameInLogs: false })));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: mockGetGeneral,
  }),
}));

const { logActivity } = await import("../services/activity-log.js");

describe("logActivity", () => {
  beforeEach(() => {
    mockPublishLiveEvent.mockReset();
    mockLoggerWarn.mockReset();
    mockGetGeneral.mockClear();
  });

  it("retries without the run id when the referenced heartbeat run is missing", async () => {
    const fkError = {
      code: "23503",
      constraint_name: "activity_log_run_id_heartbeat_runs_id_fk",
    };
    const values = vi.fn()
      .mockRejectedValueOnce(fkError)
      .mockResolvedValueOnce(undefined);
    const db = {
      insert: vi.fn((table: unknown) => {
        expect(table).toBe(activityLog);
        return { values };
      }),
    };

    await logActivity(db as never, {
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      agentId: "agent-1",
      runId: "run-123",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
    });

    expect(values).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ runId: "run-123" }));
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({ runId: null }));
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: fkError,
        runId: "run-123",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-1",
      }),
      "activity log run id missing from heartbeat_runs; recording entry without run linkage",
    );
    expect(mockPublishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        runId: null,
      }),
    }));
  });

  it("rethrows unrelated insert failures", async () => {
    const insertError = new Error("boom");
    const values = vi.fn().mockRejectedValueOnce(insertError);
    const db = {
      insert: vi.fn(() => ({ values })),
    };

    await expect(logActivity(db as never, {
      companyId: "company-1",
      actorType: "system",
      actorId: "system",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
    })).rejects.toThrow("boom");

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});
