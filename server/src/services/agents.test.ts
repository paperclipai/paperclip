import { describe, expect, it, vi } from "vitest";
import { agentService } from "./agents.js";

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Test Agent",
    role: "general",
    title: null,
    icon: null,
    reportsTo: null,
    capabilities: null,
    adapterType: "claude-local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    metadata: null,
    permissions: null,
    status: "idle",
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createSelectSequenceDb(results: unknown[][]) {
  const pending = [...results];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pending.shift() ?? []))),
  };
  return { db: { select: vi.fn(() => chain) } };
}

describe("agentService.list token summary hydration", () => {
  it("returns zero token fields when no cost_events exist for the month", async () => {
    const { db } = createSelectSequenceDb([
      [agentRow()],
      [],
      [],
    ]);
    const agents = agentService(db as any);
    const [agent] = await agents.list("company-1");
    expect(agent).toBeDefined();
    expect(agent!.inputTokensMonthly).toBe(0);
    expect(agent!.cachedInputTokensMonthly).toBe(0);
    expect(agent!.outputTokensMonthly).toBe(0);
    expect(agent!.subscriptionRunCount).toBe(0);
    expect(agent!.apiRunCount).toBe(0);
  });

  it("returns per-agent token totals and run counts split by billing type", async () => {
    const agentA = agentRow({ id: "agent-a", name: "Agent A" });
    const agentB = agentRow({ id: "agent-b", name: "Agent B" });

    const { db } = createSelectSequenceDb([
      [agentA, agentB],
      [
        { agentId: "agent-a", spentMonthlyCents: 100 },
        { agentId: "agent-b", spentMonthlyCents: 0 },
      ],
      [
        {
          agentId: "agent-a",
          inputTokensMonthly: 10000,
          cachedInputTokensMonthly: 2000,
          outputTokensMonthly: 5000,
          subscriptionRunCount: 3,
          apiRunCount: 0,
        },
        {
          agentId: "agent-b",
          inputTokensMonthly: 500,
          cachedInputTokensMonthly: 0,
          outputTokensMonthly: 200,
          subscriptionRunCount: 0,
          apiRunCount: 2,
        },
      ],
    ]);

    const agents = agentService(db as any);
    const list = await agents.list("company-1");
    const a = list.find((ag) => ag.id === "agent-a")!;
    const b = list.find((ag) => ag.id === "agent-b")!;

    expect(a.inputTokensMonthly).toBe(10000);
    expect(a.cachedInputTokensMonthly).toBe(2000);
    expect(a.outputTokensMonthly).toBe(5000);
    expect(a.subscriptionRunCount).toBe(3);
    expect(a.apiRunCount).toBe(0);

    expect(b.inputTokensMonthly).toBe(500);
    expect(b.cachedInputTokensMonthly).toBe(0);
    expect(b.outputTokensMonthly).toBe(200);
    expect(b.subscriptionRunCount).toBe(0);
    expect(b.apiRunCount).toBe(2);
  });

  it("agents absent from token summary rows default to zero", async () => {
    const agentA = agentRow({ id: "agent-a", name: "Agent A" });
    const agentB = agentRow({ id: "agent-b", name: "Agent B" });

    const { db } = createSelectSequenceDb([
      [agentA, agentB],
      [
        { agentId: "agent-a", spentMonthlyCents: 50 },
      ],
      [
        {
          agentId: "agent-a",
          inputTokensMonthly: 8000,
          cachedInputTokensMonthly: 100,
          outputTokensMonthly: 3000,
          subscriptionRunCount: 1,
          apiRunCount: 1,
        },
      ],
    ]);

    const agents = agentService(db as any);
    const list = await agents.list("company-1");
    const b = list.find((ag) => ag.id === "agent-b")!;

    expect(b.inputTokensMonthly).toBe(0);
    expect(b.cachedInputTokensMonthly).toBe(0);
    expect(b.outputTokensMonthly).toBe(0);
    expect(b.subscriptionRunCount).toBe(0);
    expect(b.apiRunCount).toBe(0);
  });
});
