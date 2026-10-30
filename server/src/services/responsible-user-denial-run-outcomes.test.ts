import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  normalizeResponsibleUserDenialCode,
  recordResponsibleUserDenialOnActiveRun,
} from "./responsible-user-denial-run-outcomes.js";

const publishLiveEventMock = vi.hoisted(() => vi.fn());

vi.mock("./live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

function makeDbReturning(row: Record<string, unknown> | null) {
  const returning = vi.fn(() => Promise.resolve(row ? [row] : []));
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    db: { update } as unknown as Db,
    update,
    set,
    where,
    returning,
  };
}

describe("responsible-user denial run outcomes", () => {
  it("normalizes only responsible-user denial codes", () => {
    expect(normalizeResponsibleUserDenialCode("RESPONSIBLE_USER_UNAUTHORIZED")).toBe(
      "RESPONSIBLE_USER_UNAUTHORIZED",
    );
    expect(normalizeResponsibleUserDenialCode("RESPONSIBLE_USER_UNAVAILABLE")).toBe(
      "RESPONSIBLE_USER_UNAVAILABLE",
    );
    expect(normalizeResponsibleUserDenialCode("access_denied")).toBeNull();
    expect(normalizeResponsibleUserDenialCode(null)).toBeNull();
  });

  it("records the code on an active run and publishes the live status payload", async () => {
    publishLiveEventMock.mockReset();
    const startedAt = new Date("2026-07-02T10:00:00.000Z");
    const row = {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: null,
      error: null,
      errorCode: "RESPONSIBLE_USER_UNAUTHORIZED",
      startedAt,
      finishedAt: null,
    };
    const { db, update, set } = makeDbReturning(row);

    await recordResponsibleUserDenialOnActiveRun(db, {
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "RESPONSIBLE_USER_UNAUTHORIZED",
    }));
    expect(publishLiveEventMock).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "heartbeat.run.status",
      payload: expect.objectContaining({
        runId: "run-1",
        agentId: "agent-1",
        status: "running",
        errorCode: "RESPONSIBLE_USER_UNAUTHORIZED",
        startedAt: startedAt.toISOString(),
        finishedAt: null,
      }),
    });
  });

  it("ignores unrelated error codes before touching the database", async () => {
    const { db, update } = makeDbReturning(null);

    await recordResponsibleUserDenialOnActiveRun(db, {
      runId: "run-1",
      code: "access_denied",
    });

    expect(update).not.toHaveBeenCalled();
  });
});
