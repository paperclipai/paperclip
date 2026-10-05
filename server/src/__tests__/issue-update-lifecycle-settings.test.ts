import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";

vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));

// Real canonical writer AND settings reader; synthetic rows only, no DB/SQL.
function fixture(owned: boolean, enabled = true) {
  let row: any = { id: "issue-1", companyId: "company-1", status: "todo", title: "Work",
    assigneeAgentId: null, assigneeUserId: null, parentId: null, projectId: null,
    goalId: null, conversationAgentId: null, originKind: "manual", statusVersion: 1 };
  const events: string[] = [];
  const predicates: Array<{ table: string; params: unknown[] }> = [];
  const writes: Array<{ table: string; patch: any }> = [];
  function query(rows: unknown[], table?: string) {
    const q: any = { where: (predicate: SQL) => {
      if (table) predicates.push({ table, params: new PgDialect().sqlToQuery(predicate).params });
      return q;
    }, limit: () => q, orderBy: () => q, for: () => q, returning: () => q,
      innerJoin: () => q, leftJoin: () => q,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const tx: any = {
    execute: vi.fn(async () => { events.push("fence"); return []; }),
    transaction: () => { throw new Error("nested-transaction"); },
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`tx:${name}`);
      if (name === "issues") return query([{ ...row }], name);
      if (name === "instance_settings") return query([{ id: "settings-1", singletonKey: "default",
        general: {}, experimental: { enableIsolatedWorkspaces: enabled } }], name);
      if (["goals", "projects", "issue_labels", "labels", "issue_watchdogs"].includes(name)) return query([], name);
      throw new Error(`unmodeled-tx-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: () => {
      const name = getTableName(table); expect(name).toBe("issues");
      writes.push({ table: name, patch: { ...patch } }); row = { ...row, ...patch }; return query([{ ...row }]);
    } }) }),
  };
  const root: any = {
    select: () => ({ from: (table: any) => { throw new Error(`root-read:${getTableName(table)}`); } }),
    transaction: vi.fn(async (callback: any) => { events.push("begin"); const result = await callback(tx); events.push("callback-return"); return result; }),
  };
  return { events, predicates, writes, root, tx, getRow: () => ({ ...row }),
    run: () => issueService(root).update("issue-1", { companyGuard: "company-1", title: "Edited",
      executionWorkspacePreference: "reuse_existing" }, owned ? root : tx, [], [], { lifecycleFence: true }) };
}

describe("dark canonical settings reader uses preparation executor (recording only)", () => {
  it.each([false, true])("reads real settings on the fenced executor (owned=%s)", async (owned) => {
    const f = fixture(owned);
    await expect(f.run()).resolves.toMatchObject({ title: "Edited", executionWorkspacePreference: "reuse_existing" });
    expect(f.events.indexOf("fence")).toBeLessThan(f.events.indexOf("tx:instance_settings"));
    expect(f.predicates.find((p) => p.table === "instance_settings")?.params).toEqual(["default"]);
    expect(f.events.filter((e) => e === "tx:instance_settings")).toHaveLength(1);
    expect(f.writes).toEqual([{ table: "issues", patch: expect.objectContaining({ title: "Edited", executionWorkspacePreference: "reuse_existing" }) }]);
    expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
    expect(f.events.filter((e) => e === "callback-return")).toHaveLength(owned ? 1 : 0);
  });
  it.each([false, true])("keeps disabled workspace stripping on the real settings path (owned=%s)", async (owned) => {
    const f = fixture(owned, false);
    await f.run();
    expect(f.getRow()).not.toHaveProperty("executionWorkspacePreference");
    expect(f.writes).toEqual([{ table: "issues", patch: expect.not.objectContaining({ executionWorkspacePreference: expect.anything() }) }]);
  });
});
