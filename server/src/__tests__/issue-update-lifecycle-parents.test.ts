import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: true }) }) }));
// Actual canonical preparation/writer; synthetic rows, predicates not executed.
function fixture(owned: boolean, kind: string) {
  let row: any = { id: "issue-1", companyId: "company-1", parentId: null, status: "todo", title: "Work", assigneeAgentId: null, assigneeUserId: null, projectId: null, goalId: null, conversationAgentId: null, originKind: "manual", statusVersion: 1 };
  const parents: Record<string, any> = {
    "parent-1": { id: "parent-1", companyId: "company-1", parentId: kind === "cycle" ? "issue-1" : kind === "existing-cycle" ? "parent-2" : null, conversationAgentId: kind === "conversation" ? "agent-1" : null },
    "parent-2": { id: "parent-2", companyId: "company-1", parentId: "parent-1" },
  };
  if (kind === "missing") delete parents["parent-1"];
  if (kind === "company") parents["parent-1"].companyId = "company-2";
  if (kind === "malformed") parents["parent-1"].parentId = undefined;
  if (kind === "deep-clear" || kind === "depth") {
    const count = kind === "deep-clear" ? 100 : 101;
    for (let n=1;n<=count;n++) parents[`parent-${n}`] = {id:`parent-${n}`,companyId:"company-1",parentId:n === count ? null : `parent-${n+1}`};
  }
  const events: string[] = []; const writes: any[] = []; const reads: any[] = [];
  let release!: () => void; let enter!: () => void;
  const barrier = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { enter = r; });
  const q = (rows: any[]) => { const query: any = { for: () => query, limit: () => query, orderBy: () => query, innerJoin: () => query, leftJoin: () => query, returning: () => query, then: (a: any,b: any) => Promise.resolve(rows).then(a,b) }; return query; };
  const tx: any = {
    execute: async () => { events.push("fence"); enter(); await barrier; return []; },
    transaction: () => { throw new Error("nested-transaction"); },
    select: () => ({ from: (t: any) => { const chain: any = { innerJoin: () => chain, leftJoin: () => chain, where: (p: SQL) => {
      const name = getTableName(t); const query = new PgDialect().sqlToQuery(p); events.push(`read:${name}`); reads.push({ name, ...query });
      if (name === "issues") { const id = query.params[0] as string; return q(id === "issue-1" ? [{...row}] : parents[id] ? [{...parents[id]}] : []); }
      if (["goals","projects","issue_labels","labels","issue_watchdogs"].includes(name)) return q([]);
      throw new Error(`unknown-read:${name}`);
    } }; return chain; } }),
    update: (t: any) => ({ set: (patch: any) => ({ where: () => { expect(getTableName(t)).toBe("issues"); events.push("write:issues"); writes.push(patch); row = {...row,...patch}; return q([{...row}]); } }) }),
  };
  const root: any = { select: () => { throw new Error("root-read"); }, transaction: vi.fn(async (cb: any) => cb(tx)) };
  const data = { companyGuard: "company-1", title: "Edited", parentId: kind === "self" ? "issue-1" : kind === "clear" ? null : "parent-1" };
  return { root, data, reads, events, writes, release, entered, setExistingParent: (parentId: string | null) => { row.parentId = parentId; }, run: (...args: [boolean?]) => issueService(root).update("issue-1",data,owned ? root : tx,[],[],{lifecycleFence: args.length ? args[0] : true}) };
}
describe("dark parent edit complete-ancestry veto (not common serialization)", () => {
  it.each([false,true].flatMap(owned => ["omitted","unchanged"].flatMap(input => ["missing","cycle","existing-cycle","company","malformed","depth"].map(kind => ({owned,input,kind})))))
    ("revalidates retained $kind ancestry input=$input owned=$owned before writes", async ({owned,input,kind}) => {
      const f=fixture(owned,kind); f.setExistingParent("parent-1");
      if (input === "omitted") delete (f.data as any).parentId;
      f.release();
      await expect(f.run()).rejects.toMatchObject({status:422});
      expect(f.writes).toEqual([]);
    });
  it.each([false,true].flatMap(owned => ["omitted","unchanged"].flatMap(input => ["valid","conversation","deep-clear"].map(kind => ({owned,input,kind})))))
    ("accepts complete retained $kind ancestry input=$input owned=$owned", async ({owned,input,kind}) => {
      const f=fixture(owned,kind); f.setExistingParent("parent-1");
      if (input === "omitted") delete (f.data as any).parentId;
      f.release();
      await expect(f.run()).resolves.toMatchObject({parentId:"parent-1",title:"Edited"});
      expect(f.reads.filter(r => r.name === "issues" && r.params[0] === "parent-1")).toHaveLength(1);
      expect(f.writes).toHaveLength(1);
    });
  it.each([false,true])("permits explicit removal of invalid retained ancestry owned=%s", async owned => {
    const f=fixture(owned,"cycle"); f.setExistingParent("parent-1"); f.data.parentId=null as any; f.release();
    await expect(f.run()).resolves.toMatchObject({parentId:null});
    expect(f.reads.filter(r => r.params[0] === "parent-1")).toEqual([]);
  });
  it.each([undefined,false])("keeps ordinary retained-parent behavior opt-in=%s", async optIn => {
    const f=fixture(false,"missing"); f.setExistingParent("parent-1"); delete (f.data as any).parentId; f.release();
    await expect(f.run(optIn as any)).resolves.toMatchObject({parentId:"parent-1"});
    expect(f.events).not.toContain("fence");
  });
  it.each([false,true])("rejects self-parent before writes owned=%s", async owned => {
    const f=fixture(owned,"self"); f.release();
    await expect(f.run()).rejects.toMatchObject({status:422}); expect(f.writes).toEqual([]);
  });
  it.each([false,true].flatMap(owned => ["cycle","existing-cycle","missing","company","conversation","malformed","depth"].map(kind => ({owned,kind}))))("rejects $kind ancestry before writes owned=$owned", async ({owned,kind}) => {
    const f=fixture(owned,kind); f.release();
    await expect(f.run()).rejects.toMatchObject({status:422}); expect(f.writes).toEqual([]);
  });
  it.each([false,true])("captures valid parent edit while fence waits owned=%s", async owned => {
    const f=fixture(owned,"valid"); const pending=f.run();
    try { await Promise.race([f.entered,pending.then(() => { throw new Error("early-return"); })]);
      expect(f.events).toEqual(["fence"]); expect(f.writes).toEqual([]);
      f.data.parentId="issue-1"; f.data.companyGuard="company-2";
    } finally { f.release(); }
    await expect(pending).resolves.toMatchObject({parentId:"parent-1",title:"Edited"});
    expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
    const parentRead=f.reads.find(r => r.name === "issues" && r.params[0] === "parent-1");
    expect(parentRead.params).toEqual(["parent-1","company-1"]);
    expect(f.writes).toHaveLength(1);
  });
  it.each([false,true].flatMap(owned => ["clear","deep-clear"].map(kind => ({owned,kind}))))("accepts $kind parent snapshot owned=$owned", async ({owned,kind}) => {
    const f=fixture(owned,kind); f.release();
    await expect(f.run()).resolves.toMatchObject({parentId:kind === "clear" ? null : "parent-1"});
    expect(f.writes).toHaveLength(1);
  });
  it.each([undefined,false])("preserves ordinary parent contract opt-in=%s", async optIn => {
    const f=fixture(false,"self"); f.release();
    await expect(f.run(optIn as any)).resolves.toMatchObject({parentId:"issue-1"});
    expect(f.events).not.toContain("fence");
  });
});
