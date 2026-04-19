import { describe, expect, it, vi } from "vitest";
import { costService } from "../services/costs.js";
const mockEvaluateCostEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({
    evaluateCostEvent: mockEvaluateCostEvent,
  }),
}));

function createDb(selectRows: Array<Array<Record<string, unknown>>>) {
  const pending = [...selectRows];
  const selectWhere = vi.fn(async () => pending.shift() ?? []);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const insertValues = vi.fn(() => ({
    returning: vi.fn(async () => []),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateWhere = vi.fn(async () => []);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  return {
    db: { select, insert, update },
    insertValues,
  };
}

describe("services/costs.ts", () => {
  it("throws notFound when creating a cost event for a missing agent", async () => {
    const { db } = createDb([[]]);
    const service = costService(db as any);

    await expect(
      service.createEvent("company-1", {
        agentId: "agent-1",
        provider: "openai",
        model: "gpt-4o-mini",
        costCents: 10,
        inputTokens: 1,
        outputTokens: 1,
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      } as any),
    ).rejects.toThrow("Agent not found");
  });

  it("rejects createEvent when the agent belongs to another company", async () => {
    const { db } = createDb([[
      {
        id: "agent-1",
        companyId: "company-2",
      },
    ]]);
    const service = costService(db as any);

    await expect(
      service.createEvent("company-1", {
        agentId: "agent-1",
        provider: "openai",
        model: "gpt-4o-mini",
        costCents: 10,
        inputTokens: 1,
        outputTokens: 1,
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      } as any),
    ).rejects.toThrow("Agent does not belong to company");
  });

  it("throws notFound for summary when company is missing", async () => {
    const { db } = createDb([[]]);
    const service = costService(db as any);

    await expect(service.summary("missing-company")).rejects.toThrow("Company not found");
  });

  it("returns spend and utilization summary for existing companies", async () => {
    const { db } = createDb([
      [
        {
          id: "company-1",
          budgetMonthlyCents: 1000,
        },
      ],
      [{ total: 250 }],
    ]);
    const service = costService(db as any);

    const summary = await service.summary("company-1");
    expect(summary).toEqual({
      companyId: "company-1",
      spendCents: 250,
      budgetCents: 1000,
      utilizationPercent: 25,
    });
  });

  it("exposes expected service methods", () => {
    const service = costService(createDb([]).db as any);
    expect(service).toMatchObject({
      createEvent: expect.any(Function),
      summary: expect.any(Function),
      byAgent: expect.any(Function),
      byProvider: expect.any(Function),
      byProject: expect.any(Function),
      windowSpend: expect.any(Function),
      byBiller: expect.any(Function),
      byAgentModel: expect.any(Function),
    });
  });
});

