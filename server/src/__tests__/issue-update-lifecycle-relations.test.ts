import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: true }) }) }));
// Actual canonical writer/cycle validator; SQL builder recording only.
function fixture(owned: boolean, invalid: "self" | "company" | "cycle" | "valid" | "empty") {
  const events: string[] = []; const writes: unknown[] = [];
  const locks: Array<{sql:string;params:unknown[]}> = []; const deletes: unknown[][] = []; const inserts: any[] = [];
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>(r => {release=r;}); const fenceEntered = new Promise<void>(r => {entered=r;});
  const row = { id: "issue-1", companyId: "company-1", status: "todo", title: "Work", assigneeAgentId: null, assigneeUserId: null, parentId: null, projectId: null, projectWorkspaceId: null, executionWorkspaceId: null, goalId: null, conversationAgentId: null, originKind: "manual", statusVersion: 1 };
  const dialect = new PgDialect();
  function query(table: string, rows: any[], projection?: any) {
    const q: any = { where: (p: SQL) => { events.push(`read:${table}:${JSON.stringify(dialect.sqlToQuery(p).params)}`); return q; }, for: () => q, limit: () => q, orderBy: () => q, returning: () => q, innerJoin: () => q, leftJoin: () => q,
      then: (a: any,b: any) => Promise.resolve(rows).then(a,b) }; return q;
  }
  const tx: any = {
    execute: async (s: SQL) => { const text = dialect.sqlToQuery(s); if(text.sql.includes("pg_advisory")) {events.push("fence"); entered(); await barrier;} else {events.push("relation-lock");locks.push(text);} return []; },
    transaction: () => { throw new Error("nested-transaction"); },
    select: (projection?: any) => ({ from: (t: any) => { const name = getTableName(t);
      if (name === "issues") return query(name, projection?.id ? (invalid === "company" ? [] : [{id:"blocker-1"}]) : [{...row}], projection);
      if (name === "issue_relations") return query(name, invalid === "cycle" ? [{blockerIssueId:"issue-1",blockedIssueId:"blocker-1"}] : []);
      if (["goals","projects","issue_labels","labels","issue_watchdogs"].includes(name)) return query(name,[]);
      throw new Error(`unmodeled:${name}`);
    } }),
    update: (t: any) => ({ set: (patch: any) => ({ where: () => { events.push(`write:${getTableName(t)}`); writes.push(patch); return query("updated",[{...row,...patch}]); } }) }),
    delete: (t:any) => ({where:(p:SQL) => {expect(getTableName(t)).toBe("issue_relations"); events.push("relation-delete"); deletes.push(dialect.sqlToQuery(p).params); return query("deleted",[]);}}),
    insert: (t:any) => ({values:(v:any) => {expect(getTableName(t)).toBe("issue_relations"); events.push("relation-insert"); inserts.push(...v); return query("inserted",[]);}}),
  };
  const root: any = { select: () => { throw new Error("root-read"); }, transaction: vi.fn(async (cb:any) => cb(tx)) };
  const data = {companyGuard:"company-1", title:"Requested", blockedByIssueIds:invalid === "empty" ? [] : [invalid === "self" ? "issue-1" : "blocker-1"]};
  return { events, writes, locks, deletes, inserts, data, release, fenceEntered, root, run: (lifecycleFence=true) => issueService(root).update("issue-1", data, owned ? root : tx, [], [], {lifecycleFence}) };
}
describe("dark relation pre-write veto (recording, not rollback)", () => {
  it.each(["self","company","cycle"] as const)("non-opt-in preserves late %s validation", async invalid => {
    const f=fixture(false,invalid); f.release();
    await expect(f.run(false)).rejects.toMatchObject({status:422});
    expect(f.events).not.toContain("fence"); expect(f.writes).toHaveLength(1);
    expect(f.deletes).toEqual([]); expect(f.inserts).toEqual([]);
  });
  it.each([false,true].flatMap(owned => (["self","company","cycle"] as const).map(invalid => ({owned,invalid}))))
    ("rejects $invalid before canonical writes owned=$owned", async ({owned,invalid}) => {
      const f = fixture(owned,invalid); f.release();
      await expect(f.run()).rejects.toMatchObject({status:422});
      expect(f.events[0]).toBe("fence");
      expect(f.writes).toEqual([]); expect(f.deletes).toEqual([]); expect(f.inserts).toEqual([]);
      expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
    });
  it.each([false,true].flatMap(owned => (["valid","empty"] as const).map(invalid => ({owned,invalid}))))
    ("replaces $invalid relations on supplied executor owned=$owned", async ({owned,invalid}) => {
      const f = fixture(owned,invalid); const result = f.run();
      try {
        await Promise.race([f.fenceEntered, result.then(() => {throw new Error("early-return");})]);
        expect(f.events).toEqual(["fence"]);
        f.data.blockedByIssueIds.push("retargeted-blocker"); f.data.companyGuard="company-2";
      } finally {f.release();}
      await expect(result).resolves.toMatchObject({blockedByIssueIds:invalid === "empty" ? [] : ["blocker-1"]});
      expect(f.deletes).toEqual([["company-1","issue-1","blocks"]]);
      expect(f.inserts).toEqual(invalid === "empty" ? [] : [{companyId:"company-1",issueId:"blocker-1",relatedIssueId:"issue-1",type:"blocks",createdByAgentId:null,createdByUserId:null}]);
      expect(f.locks.map(l => l.params)).toEqual(invalid === "empty" ? [] : [["company-1","blocker-1","issue-1"],["company-1","blocker-1","issue-1"]]);
      if(invalid === "valid") expect(f.events.indexOf("relation-lock")).toBeLessThan(f.events.indexOf("write:issues"));
      expect(f.writes).toHaveLength(1);
    });
});
