/**
 * runId validation was moved from logActivity into actorMiddleware.
 * See actor-middleware-run-id.test.ts for the validation tests.
 *
 * This file verifies that logActivity itself is simple: it writes whatever
 * runId it receives directly, without performing any DB lookup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logActivity } from "../services/activity-log.js";

const mockPublishLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
}));

function makeDb() {
  const inserted: unknown[] = [];
  const values = vi.fn(async (row: unknown) => {
    inserted.push(row);
  });
  const insert = vi.fn(() => ({ values }));
  const select = vi.fn(); // should not be called
  return { db: { insert, select } as any, inserted, values, select };
}

describe("logActivity — simple pass-through (no run lookup)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the provided runId directly without querying heartbeat_runs", async () => {
    const { db, values, select } = makeDb();

    await logActivity(db, {
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-1",
      runId: "run-abc",
    });

    const inserted = (values.mock.calls[0] as any)[0];
    expect(inserted.runId).toBe("run-abc");
    expect((select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("writes null when runId is null, without querying heartbeat_runs", async () => {
    const { db, values, select } = makeDb();

    await logActivity(db, {
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-1",
      runId: null,
    });

    const inserted = (values.mock.calls[0] as any)[0];
    expect(inserted.runId).toBeNull();
    expect((select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
