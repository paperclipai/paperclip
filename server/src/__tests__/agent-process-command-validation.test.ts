import { describe, expect, it, vi } from "vitest";
import { agentService } from "../services/agents.ts";

function makeSelectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return chain;
}

function createDbStub(options: { selectRows: unknown[] }) {
  return {
    select: vi.fn(() => makeSelectChain(options.selectRows)),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(),
        })),
      })),
    })),
  };
}

describe("agentService process adapter validation", () => {
  it("rejects process agents without adapterConfig.command before insert", async () => {
    const db = createDbStub({ selectRows: [] });
    const svc = agentService(db as never);

    await expect(
      svc.create("company-1", {
        name: "Broken Process Agent",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
      }),
    ).rejects.toThrow("Process agents require adapterConfig.command");

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects updates that would remove the process command", async () => {
    const db = createDbStub({
      selectRows: [
        {
          id: "agent-1",
          companyId: "company-1",
          name: "Worker",
          role: "general",
          title: null,
          reportsTo: null,
          capabilities: null,
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          metadata: null,
          status: "idle",
          permissions: {},
        },
      ],
    });
    const svc = agentService(db as never);

    await expect(
      svc.update("agent-1", {
        adapterType: "process",
        adapterConfig: {},
      }),
    ).rejects.toThrow("Process agents require adapterConfig.command");

    expect(db.update).not.toHaveBeenCalled();
  });
});
