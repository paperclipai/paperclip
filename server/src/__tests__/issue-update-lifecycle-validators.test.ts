import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";

vi.mock("../services/instance-settings.ts", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: true }) }),
}));
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));

// Real canonical update and validators; synthetic rows, no SQL execution or DB.
// The settings branch is explicitly mocked and is not an executor-read proof.
function fixture(owned: boolean, membership = true) {
  let row: any = { id: "issue-1", companyId: "company-1", status: "todo", title: "Work",
    assigneeAgentId: null, assigneeUserId: null, parentId: null, projectId: null,
    goalId: null, conversationAgentId: null, originKind: "manual", statusVersion: 1 };
  const events: string[] = [];
  const predicates: Array<{ table: string; sql: string; params: unknown[] }> = [];
  const writes: unknown[] = [];
  function query(rows: unknown[], table?: string) {
    const q: any = { where: (predicate: SQL) => {
      if (table) predicates.push({ table, ...new PgDialect().sqlToQuery(predicate) });
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
      if (name === "company_memberships") return query(membership ? [{ id: "membership-1" }] : [], name);
      if (["goals", "projects", "issue_labels", "labels", "issue_watchdogs"].includes(name)) return query([], name);
      throw new Error(`unmodeled-tx-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: () => {
      const name = getTableName(table);
      if (name === "agent_wakeup_requests") { writes.push({ table: name, patch: structuredClone(patch) }); return query([]); }
      expect(name).toBe("issues");
      writes.push({ table: name, patch: { ...patch } }); row = { ...row, ...patch }; return query([{ ...row }]);
    } }) }),
  };
  const root: any = {
    select: () => ({ from: (table: any) => { throw new Error(`root-read:${getTableName(table)}`); } }),
    transaction: vi.fn(async (callback: any) => { events.push("begin"); const result = await callback(tx); events.push("callback-return"); return result; }),
  };
  return { events, predicates, writes, root, tx, getRow: () => structuredClone(row),
    run: () => issueService(root).update("issue-1", {
      companyGuard: "company-1", assigneeUserId: "user-1",
    }, owned ? root : tx, [], [], { lifecycleFence: true }) };
}

describe("dark canonical user validator uses preparation executor (recording only)", () => {
  it.each([false, true])("validates membership on the fenced executor (owned=%s)", async (owned) => {
    const f = fixture(owned);
    await expect(f.run()).resolves.toMatchObject({ assigneeUserId: "user-1" });
    expect(f.events.indexOf("fence")).toBeLessThan(f.events.indexOf("tx:company_memberships"));
    const predicate = f.predicates.find((p) => p.table === "company_memberships")!;
    expect(predicate.params).toEqual(["company-1", "user", "user-1", "active"]);
    expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
  });
  it.each([false, true])("rejects missing membership without recorded writes (owned=%s)", async (owned) => {
    const f = fixture(owned, false); const before = f.getRow();
    await expect(f.run()).rejects.toThrow("Assignee user not found");
    expect(f.writes).toEqual([]); expect(f.getRow()).toEqual(before);
    expect(f.events).not.toContain("callback-return");
  });
});
