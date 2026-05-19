import { describe, expect, it, vi } from "vitest";
import { activityLog, agents as agentsTable, issueComments, issueExecutionDecisions } from "@paperclipai/db";
import { agentService } from "../services/agents.ts";

type Row = Record<string, unknown>;

function createAgentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "agent-1",
    companyId: "",
    name: "Cleanup Agent",
    role: "general",
    title: null,
    reportsTo: null,
    capabilities: null,
    adapterType: "codex-local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    metadata: null,
    permissions: null,
    status: "idle",
    pauseReason: null,
    pausedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("agentService.remove", () => {
  it("cleans nullable and non-nullable FK references before deleting the agent", async () => {
    const existingRow = createAgentRow();
    const deletedRow = createAgentRow({ status: "terminated" });

    const selectChain = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      then: vi.fn((resolve: (rows: Row[]) => unknown) => Promise.resolve(resolve([existingRow]))),
    };

    const updateCalls: unknown[] = [];
    const deleteCalls: unknown[] = [];

    const tx = {
      update: vi.fn((table: unknown) => {
        updateCalls.push(table);
        return {
          set: vi.fn(() => ({
            where: vi.fn(async () => []),
          })),
        };
      }),
      delete: vi.fn((table: unknown) => {
        deleteCalls.push(table);
        if (table === agentsTable) {
          const deleteAgentChain = {
            returning: vi.fn(() => ({
              then: vi.fn((resolve: (rows: Row[]) => unknown) => Promise.resolve(resolve([deletedRow]))),
            })),
          };
          return {
            where: vi.fn(() => deleteAgentChain),
          };
        }

        return {
          where: vi.fn(async () => []),
        };
      }),
    };

    const db = {
      select: vi.fn(() => selectChain),
      transaction: vi.fn(async (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx)),
    };

    const service = agentService(db as any);
    const removed = await service.remove("agent-1");

    expect(removed?.id).toBe("agent-1");
    expect(updateCalls).toHaveLength(39);
    expect(deleteCalls).toHaveLength(8);
    expect(updateCalls).toContain(activityLog);
    expect(updateCalls).toContain(issueComments);
    expect(updateCalls).toContain(issueExecutionDecisions);
    expect(deleteCalls).not.toContain(activityLog);
    expect(deleteCalls).not.toContain(issueComments);
    expect(deleteCalls).not.toContain(issueExecutionDecisions);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
