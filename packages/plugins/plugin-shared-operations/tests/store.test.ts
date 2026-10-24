import { describe, expect, it, vi } from "vitest";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { emptyState } from "../src/domain.js";
import { companyId, createStore } from "../src/store.js";

const a = "00000000-0000-0000-0000-000000000001";
const b = "00000000-0000-0000-0000-000000000002";

function database(): PluginDatabaseClient {
  const rows = new Map<string, { revision: number; document: ReturnType<typeof emptyState> }>();
  return {
    namespace: "plugin_shared_operations_test",
    async query<T>(_sql: string, params?: unknown[]): Promise<T[]> {
      const row = rows.get(String(params?.[0]));
      return row ? [structuredClone(row) as T] : [];
    },
    async execute(sql, params = []) {
      if (sql.startsWith("INSERT")) {
        if (!rows.has(String(params[0]))) rows.set(String(params[0]), { revision: 0, document: JSON.parse(String(params[1])) });
        return { rowCount: 1 };
      }
      expect(sql).toContain("WHERE company_id = $2 AND revision = $3");
      const row = rows.get(String(params[1]));
      if (!row || row.revision !== params[2]) return { rowCount: 0 };
      rows.set(String(params[1]), { revision: row.revision + 1, document: JSON.parse(String(params[0])) });
      return { rowCount: 1 };
    },
  };
}

describe("company persistence", () => {
  it("accepts only one competing writer at the same revision", async () => {
    const store = createStore(database());
    const results = await Promise.allSettled([store.save(a, 0, emptyState()), store.save(a, 0, emptyState())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await store.read(a)).revision).toBe(1);
  });
  it("does not return or update another company's state", async () => {
    const store = createStore(database());
    await store.save(a, 0, emptyState());
    expect((await store.read(b)).revision).toBe(0);
    await store.save(b, 0, emptyState());
    expect((await store.read(a)).revision).toBe(1);
  });
  it("rejects malformed companies and revisions", async () => {
    expect(() => companyId("not-a-company")).toThrow();
    const store = createStore(database());
    await expect(store.save(a, undefined, emptyState())).rejects.toMatchObject({ code: "invalid_revision" });
    await expect(store.save(a, -1, emptyState())).rejects.toMatchObject({ code: "invalid_revision" });
  });
  it.each(["", "not-a-task"])("identifies malformed task input %j without querying", async (task) => {
    const db = database();
    const query = vi.spyOn(db, "query");
    await expect(createStore(db).taskHead(a, task)).rejects.toMatchObject({ code: "invalid_task", status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects oversized history rather than discarding it", async () => {
    const state = emptyState();
    state.activePolicyId = "a".repeat(900_001);
    await expect(createStore(database()).save(a, 0, state)).rejects.toMatchObject({ code: "storage_limit" });
  });
});
