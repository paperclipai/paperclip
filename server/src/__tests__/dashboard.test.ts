import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardService } from "../services/dashboard.ts";

function makeSelectBuilder(result: unknown) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    groupBy: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled?: ((value: unknown) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
      Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined),
  };

  return builder;
}

function makeMockDb(selectResults: unknown[]) {
  const queue = [...selectResults];

  return {
    select: vi.fn(() => makeSelectBuilder(queue.shift())),
  };
}

describe("dashboardService.summary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
  });

  it("builds workload and capacity metrics from current agent/task state", async () => {
    const db = makeMockDb([
      [{ id: "company-1", budgetMonthlyCents: 1000 }],
      [
        { status: "idle", count: 1 },
        { status: "running", count: 1 },
        { status: "paused", count: 1 },
      ],
      [
        { status: "todo", count: 2 },
        { status: "in_progress", count: 1 },
        { status: "blocked", count: 1 },
        { status: "done", count: 4 },
      ],
      [{ count: 2 }],
      [
        { id: "agent-1", name: "Engineer One", status: "idle" },
        { id: "agent-2", name: "Engineer Two", status: "running" },
      ],
      [
        {
          id: "issue-1",
          identifier: "KTA-101",
          title: "Finish dashboard widget",
          assigneeAgentId: "agent-2",
          startedAt: new Date("2026-03-15T10:30:00.000Z"),
        },
      ],
      [{ count: 3 }],
      [{ monthSpend: 250, monthInputTokens: 1200, monthOutputTokens: 3400 }],
    ]);

    const summary = await dashboardService(db as any).summary("company-1");

    expect(summary.agents).toEqual({
      active: 1,
      running: 1,
      paused: 1,
      error: 0,
    });
    expect(summary.tasks).toEqual({
      open: 4,
      inProgress: 1,
      blocked: 1,
      done: 4,
    });
    expect(summary.costs).toEqual({
      monthSpendCents: 250,
      monthBudgetCents: 1000,
      monthUtilizationPercent: 25,
      monthInputTokens: 1200,
      monthOutputTokens: 3400,
    });
    expect(summary.pendingApprovals).toBe(2);
    expect(summary.agentWorkload).toEqual({
      capacityStatus: "GREEN",
      idleEngineers: 1,
      queuedTasks: 3,
      engineers: [
        {
          agentId: "agent-1",
          name: "Engineer One",
          urlKey: "engineer-one",
          status: "idle",
          currentTasks: [],
          timeInCurrentTaskSec: null,
        },
        {
          agentId: "agent-2",
          name: "Engineer Two",
          urlKey: "engineer-two",
          status: "running",
          currentTasks: [
            {
              issueId: "issue-1",
              identifier: "KTA-101",
              title: "Finish dashboard widget",
              startedAt: "2026-03-15T10:30:00.000Z",
            },
          ],
          timeInCurrentTaskSec: 5400,
        },
      ],
    });
  });

  it("marks capacity red when everyone is busy and work is queued", async () => {
    const db = makeMockDb([
      [{ id: "company-1", budgetMonthlyCents: 1000 }],
      [{ status: "running", count: 2 }],
      [{ status: "in_progress", count: 2 }],
      [{ count: 0 }],
      [
        { id: "agent-1", name: "Engineer One", status: "running" },
        { id: "agent-2", name: "Engineer Two", status: "running" },
      ],
      [
        {
          id: "issue-1",
          identifier: "KTA-101",
          title: "Task one",
          assigneeAgentId: "agent-1",
          startedAt: new Date("2026-03-15T11:00:00.000Z"),
        },
        {
          id: "issue-2",
          identifier: "KTA-102",
          title: "Task two",
          assigneeAgentId: "agent-2",
          startedAt: new Date("2026-03-15T11:15:00.000Z"),
        },
      ],
      [{ count: 1 }],
      [{ monthSpend: 0, monthInputTokens: 0, monthOutputTokens: 0 }],
    ]);

    const summary = await dashboardService(db as any).summary("company-1");

    expect(summary.agentWorkload.capacityStatus).toBe("RED");
    expect(summary.agentWorkload.idleEngineers).toBe(0);
    expect(summary.agentWorkload.queuedTasks).toBe(1);
  });
});
