import { describe, expect, it, vi } from "vitest";
import { agentFolderService } from "../services/agent-folders.js";
import type { Db } from "@paperclipai/db";

// Minimal mock that supports the chainable Drizzle query builder pattern
function makeMockDb(rows: {
  selectRows?: unknown[];
  insertReturn?: unknown[];
  updateAffected?: number;
}) {
  const selectResult = rows.selectRows ?? [];
  const chainable: any = {
    from: vi.fn(() => chainable),
    where: vi.fn(() => chainable),
    orderBy: vi.fn(() => chainable),
    leftJoin: vi.fn(() => chainable),
    groupBy: vi.fn(() => chainable),
    then: vi.fn((resolve: (val: unknown) => unknown) =>
      Promise.resolve(resolve(selectResult))
    ),
  };

  return {
    select: vi.fn(() => chainable),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve(rows.insertReturn ?? [])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(rows.updateAffected ?? 1)),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  } as unknown as Db;
}

describe("agent-folders service", () => {
  it("exposes all expected CRUD methods", () => {
    const svc = agentFolderService(makeMockDb({ selectRows: [] }));
    expect(typeof svc.list).toBe("function");
    expect(typeof svc.get).toBe("function");
    expect(typeof svc.create).toBe("function");
    expect(typeof svc.update).toBe("function");
    expect(typeof svc.moveFolder).toBe("function");
    expect(typeof svc.deleteFolder).toBe("function");
    expect(typeof svc.assignAgents).toBe("function");
    expect(typeof svc.unassignAgent).toBe("function");
    expect(typeof svc.listAgentsInFolder).toBe("function");
    expect(typeof svc.descendantIds).toBe("function");
  });

  it("returns empty list when no folders exist for company", async () => {
    const svc = agentFolderService(makeMockDb({ selectRows: [] }));
    const result = await svc.list("company-1");
    expect(result.folders).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it("returns null when folder not found", async () => {
    const svc = agentFolderService(makeMockDb({ selectRows: [] }));
    const result = await svc.get("company-1", "nonexistent-folder");
    expect(result).toBeNull();
  });
});
