import { describe, expect, it, vi } from "vitest";
import {
  agentService,
  deduplicateAgentName,
  hasAgentShortnameCollision,
} from "../services/agents.js";

function createDbForAgentCreate(existingAgents: Array<{ id: string; name: string; status: string }>) {
  let insertedValues: Record<string, unknown> | null = null;
  const selectWhere = vi.fn().mockResolvedValue(existingAgents);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const insertReturning = vi.fn(async () => [
    {
      id: "agent-created",
      companyId: "company-1",
      ...(insertedValues ?? {}),
      status: "idle",
      spentMonthlyCents: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]);
  const insertValues = vi.fn((values: Record<string, unknown>) => {
    insertedValues = values;
    return { returning: insertReturning };
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  return {
    db: { select, insert },
    insertValues,
  };
}

describe("services/agents.ts", () => {
  it("detects shortname collisions while ignoring terminated agents", () => {
    expect(
      hasAgentShortnameCollision("CEO Agent", [
        { id: "a1", name: "ceo-agent", status: "active" },
        { id: "a2", name: "ceo-agent", status: "terminated" },
      ]),
    ).toBe(true);
    expect(
      hasAgentShortnameCollision("CEO Agent", [{ id: "a2", name: "ceo-agent", status: "terminated" }]),
    ).toBe(false);
  });

  it("supports excluding a specific agent id from collision checks", () => {
    expect(
      hasAgentShortnameCollision(
        "CEO Agent",
        [
          { id: "a1", name: "ceo-agent", status: "active" },
          { id: "a2", name: "chief-architect", status: "active" },
        ],
        { excludeAgentId: "a1" },
      ),
    ).toBe(false);
  });

  it("deduplicates to a numeric suffix when shortname is occupied", () => {
    const next = deduplicateAgentName("Engineer", [
      { id: "a1", name: "Engineer", status: "active" },
      { id: "a2", name: "Engineer 2", status: "active" },
    ]);
    expect(next).toBe("Engineer 3");
  });

  it("creates agents with deduplicated names and normalized defaults", async () => {
    const { db, insertValues } = createDbForAgentCreate([
      { id: "a1", name: "Engineer", status: "active" },
      { id: "a2", name: "Engineer 2", status: "active" },
    ]);
    const service = agentService(db as any);

    const created = await service.create("company-1", {
      name: "Engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      metadata: null,
      budgetMonthlyCents: 0,
      capabilities: null,
      title: null,
      reportsTo: null,
      status: "idle",
      spentMonthlyCents: 0,
      permissions: undefined,
      lastHeartbeatAt: null,
    } as any);

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({
      name: "Engineer 3",
      role: "general",
      companyId: "company-1",
      permissions: { canCreateAgents: false },
    });
    expect(created).toMatchObject({
      name: "Engineer 3",
      urlKey: "engineer-3",
      role: "general",
      permissions: { canCreateAgents: false },
    });
  });
});
