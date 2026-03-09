import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitDomainEvent, publishLiveEvent } = vi.hoisted(() => ({
  emitDomainEvent: vi.fn(),
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/domain-events.js", () => ({
  emitDomainEvent,
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent,
}));

import { logActivity } from "../services/activity-log.js";

function createDbMock() {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as any, values };
}

describe("logActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always emits activity.logged and publishes a live event", async () => {
    const { db, values } = createDbMock();

    await logActivity(db, {
      companyId: "co-1",
      actorType: "user",
      actorId: "u-1",
      action: "agent.updated",
      entityType: "agent",
      entityId: "ag-1",
      details: { foo: "bar" },
    });

    expect(values).toHaveBeenCalledTimes(1);
    expect(emitDomainEvent).toHaveBeenCalledTimes(1);
    expect(emitDomainEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "activity.logged",
        companyId: "co-1",
        entityId: "ag-1",
      }),
    );
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-1",
        type: "activity.logged",
      }),
    );
  });

  it("derives approval.created from approval.created activity", async () => {
    const { db } = createDbMock();

    await logActivity(db, {
      companyId: "co-1",
      actorType: "user",
      actorId: "u-1",
      action: "approval.created",
      entityType: "approval",
      entityId: "ap-1",
      details: { type: "hire_agent" },
    });

    expect(emitDomainEvent).toHaveBeenCalledTimes(2);
    expect(emitDomainEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "approval.created",
        companyId: "co-1",
        entityType: "approval",
        entityId: "ap-1",
        payload: expect.objectContaining({
          approvalId: "ap-1",
          action: "approval.created",
        }),
      }),
    );
  });

  it("derives approval.decided from approval.approved activity", async () => {
    const { db } = createDbMock();

    await logActivity(db, {
      companyId: "co-1",
      actorType: "user",
      actorId: "u-1",
      action: "approval.approved",
      entityType: "approval",
      entityId: "ap-1",
      details: { type: "hire_agent" },
    });

    expect(emitDomainEvent).toHaveBeenCalledTimes(2);
    expect(emitDomainEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "approval.decided",
        payload: expect.objectContaining({
          approvalId: "ap-1",
          action: "approval.approved",
          decision: "approved",
        }),
      }),
    );
  });

  it("derives cost_event.created from cost.reported activity", async () => {
    const { db } = createDbMock();

    await logActivity(db, {
      companyId: "co-1",
      actorType: "agent",
      actorId: "ag-1",
      action: "cost.reported",
      entityType: "cost_event",
      entityId: "ce-1",
      details: { costCents: 123, model: "gpt-5" },
    });

    expect(emitDomainEvent).toHaveBeenCalledTimes(2);
    expect(emitDomainEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "cost_event.created",
        companyId: "co-1",
        entityType: "cost_event",
        entityId: "ce-1",
        payload: expect.objectContaining({
          action: "cost.reported",
          costEventId: "ce-1",
        }),
      }),
    );
  });
});
