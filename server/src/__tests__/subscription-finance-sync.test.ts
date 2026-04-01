import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFinanceCreateEvent = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "fe-1" }));

vi.mock("../services/finance.js", () => ({
  financeService: () => ({
    createEvent: mockFinanceCreateEvent,
  }),
}));

import { syncSubscriptionFinanceEvents } from "../services/subscription-finance-sync.js";

const PLAN = {
  id: "plan-1",
  companyId: "company-1",
  agentId: "agent-1",
  provider: "anthropic",
  biller: "anthropic",
  monthlyCostCents: 31000,
  seatCount: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveUntil: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeDb(activePlans: unknown[], existingFinanceEvents: unknown[] = []) {
  const selects = [activePlans, existingFinanceEvents, existingFinanceEvents];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const result = selects.shift() ?? [];
          return Object.assign(Promise.resolve(result), {
            then: vi.fn((fn: (v: unknown[]) => unknown) => Promise.resolve(fn(result))),
          });
        }),
      })),
    })),
  };
}

describe("syncSubscriptionFinanceEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a finance event for an active plan with no existing events", async () => {
    const db = makeDb([PLAN], []);
    const result = await syncSubscriptionFinanceEvents(db as any);

    expect(result.created).toBe(1);
    expect(mockFinanceCreateEvent).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        agentId: "agent-1",
        eventKind: "subscription_fee",
        direction: "debit",
        biller: "anthropic",
        provider: "anthropic",
        estimated: true,
      }),
    );
  });

  it("passes subscription plan metadata in the finance event", async () => {
    const db = makeDb([PLAN], []);
    await syncSubscriptionFinanceEvents(db as any);

    expect(mockFinanceCreateEvent).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        metadataJson: expect.objectContaining({
          subscriptionPlanId: "plan-1",
          monthlyCostCents: 31000,
        }),
      }),
    );
  });

  it("creates nothing when no active plans exist", async () => {
    const db = makeDb([], []);
    const result = await syncSubscriptionFinanceEvents(db as any);

    expect(result.created).toBe(0);
    expect(mockFinanceCreateEvent).not.toHaveBeenCalled();
  });

  it("skips plans whose effective period is entirely in the future", async () => {
    const now = new Date();
    const futureMonth = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
    const futurePlan = { ...PLAN, effectiveFrom: futureMonth };
    const db = makeDb([futurePlan], []);

    const result = await syncSubscriptionFinanceEvents(db as any);
    expect(result.created).toBe(0);
  });

  it("skips plans whose effectiveUntil is before the current month", async () => {
    const pastPlan = {
      ...PLAN,
      effectiveFrom: new Date("2025-01-01T00:00:00Z"),
      effectiveUntil: new Date("2025-06-01T00:00:00Z"),
    };
    const db = makeDb([pastPlan], []);

    const result = await syncSubscriptionFinanceEvents(db as any);
    expect(result.created).toBe(0);
  });

  it("prorates cost when plan only covers part of the month", async () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const monthStart = new Date(Date.UTC(year, month, 1));
    const midMonth = new Date(Date.UTC(year, month, 16));
    const monthEnd = new Date(Date.UTC(year, month + 1, 1));
    const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000);
    const activeDays = (monthEnd.getTime() - midMonth.getTime()) / (24 * 60 * 60 * 1000);

    const partialPlan = {
      ...PLAN,
      effectiveFrom: midMonth,
      monthlyCostCents: Math.round(daysInMonth) * 100,
    };
    const db = makeDb([partialPlan], []);

    await syncSubscriptionFinanceEvents(db as any);
    expect(mockFinanceCreateEvent).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        amountCents: Math.round((partialPlan.monthlyCostCents * activeDays) / daysInMonth),
      }),
    );
  });
});
