import { getTableColumns, getTableName, type SQL } from "drizzle-orm";
import { PgDialect, PgUpdateBuilder } from "drizzle-orm/pg-core";
import { issues } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: true }) }) }));
function fixture(owned: boolean) {
  let row: any = { id: "issue-1", companyId: "company-1", status: "todo", title: "Work", assigneeAgentId: null, assigneeUserId: null, parentId: null, projectId: null, projectWorkspaceId: null, executionWorkspaceId: null, goalId: null, conversationAgentId: null, originKind: "manual", statusVersion: 1 };
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const fenceEntered = new Promise<void>(resolve => { entered = resolve; });
  const writes: any[] = [];
  const relationDeletes: any[] = [];
  const reads: string[] = [];
  function query(rows: any[]) {
    const q: any = { where: (_p: SQL) => q, for: () => q, limit: () => q, orderBy: () => q, returning: () => q, innerJoin: () => q, leftJoin: () => q, then: (a: any, b: any) => Promise.resolve(rows).then(a,b) }; return q;
  }
  const tx: any = {
    execute: vi.fn(async () => { entered(); await barrier; return []; }),
    transaction: () => { throw new Error("nested-transaction"); },
    select: () => ({ from: (table: any) => { const name = getTableName(table); reads.push(name); if (name === "issues") return query([{...row}]); if (["goals","projects","issue_labels","labels","issue_watchdogs","issue_relations"].includes(name)) return query([]); throw new Error(`unmodeled:${name}`); } }),
    delete: (table: any) => ({ where: (p: SQL) => { expect(getTableName(table)).toBe("issue_relations"); relationDeletes.push(new PgDialect().sqlToQuery(p).params); return query([]); } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (_p: SQL) => { expect(getTableName(table)).toBe("issues"); writes.push(patch); row = {...row,...patch}; return query([{...row}]); } }) }),
  };
  const root: any = { select: () => { throw new Error("root-read"); }, transaction: vi.fn(async (cb: any) => cb(tx)) };
  const publications: any[] = []; const actions: any[] = [];
  const data: any = { companyGuard: "company-1", title: "Requested" };
  return { tx, root, data, writes, reads, relationDeletes, publications, actions, release, fenceEntered,
    run: (options: any = { lifecycleFence: true }) => issueService(root).update("issue-1",data,owned ? root : tx,publications,actions,options) };
}
// Adapted from independent review probe; real service and JSON driver encoder,
// recording queries only. No PostgreSQL, authorization or rollback proof.
describe("dark canonical compatibility (source/driver recording)", () => {
  it.each([false, true])("preserves non-enumerable option and reads getters once (owned=%s)", async owned => {
    const f = fixture(owned); f.release();
    const lifecycle = vi.fn(() => true);
    const workspace = vi.fn(() => false);
    const options = Object.defineProperties({}, {
      lifecycleFence: { get: lifecycle },
      bindRuntimeSharedWorkspace: { get: workspace },
    });
    await expect(f.run(options)).resolves.toMatchObject({ title: "Requested" });
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(workspace).toHaveBeenCalledOnce();
    expect(f.tx.execute).toHaveBeenCalledOnce();
  });
  it.each([false, true])("materializes JSON encoder output before suspension (owned=%s)", async owned => {
    const f = fixture(owned);
    const json = { mode: "safe", nested: { delay: 10 } };
    const toJSON = vi.fn(() => json);
    f.data.executionPolicy = { toJSON };
    const result = f.run();
    try {
      await Promise.race([
        f.fenceEntered,
        result.then(() => { throw new Error("Update returned before entering fence"); }),
      ]);
      json.mode = "changed"; json.nested.delay = 99;
    } finally {
      f.release();
    }
    await expect(result).resolves.toMatchObject({ executionPolicy: { mode: "safe", nested: { delay: 10 } } });
    expect(toJSON).toHaveBeenCalledOnce();
    expect(f.writes[0].executionPolicy).not.toBe(json);
  });
  it.each([false, true])("rejects encoded JSON null rather than silently storing SQL NULL (owned=%s)", async owned => {
    const f = fixture(owned); f.release(); f.data.blockedByIssueIds = [];
    const payload = { toJSON() { return null; } };
    expect(new PgUpdateBuilder(issues, undefined as any, new PgDialect())
      .set({ executionPolicy: payload }).toSQL().params).toEqual(["null"]);
    expect(new PgUpdateBuilder(issues, undefined as any, new PgDialect())
      .set({ executionPolicy: null }).toSQL().params).toEqual([null]);
    f.data.executionPolicy = payload;
    await expect(f.run()).rejects.toThrow(/JSON null/);
    expect(f.root.transaction).not.toHaveBeenCalled();
    expect(f.tx.execute).not.toHaveBeenCalled(); expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]); expect(f.relationDeletes).toEqual([]);
    expect(f.publications).toEqual([]); expect(f.actions).toEqual([]);
  });
  it.each([false, true])("rejects absent encoder output before transaction and relation clear (owned=%s)", async owned => {
    const f = fixture(owned); f.release(); f.data.blockedByIssueIds = [];
    const payload = { toJSON() { return undefined; } };
    expect(issues.executionPolicy.mapToDriverValue(payload)).toBeUndefined();
    f.data.executionPolicy = payload;
    await expect(f.run()).rejects.toThrow(/valid JSON text/);
    expect(f.root.transaction).not.toHaveBeenCalled();
    expect(f.tx.execute).not.toHaveBeenCalled(); expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]); expect(f.relationDeletes).toEqual([]);
    expect(f.publications).toEqual([]); expect(f.actions).toEqual([]);
  });
  it.each(Object.entries(getTableColumns(issues)).filter(([, column]) => column.dataType === "json")
    .flatMap(([key]) => [false, true].flatMap(owned => [null, undefined].map(output => ({ key, owned, output })))))
    ("all JSON columns veto ambiguous/absent encoder output: $key owned=$owned output=$output", async ({ key, owned, output }) => {
      const f = fixture(owned); f.data.blockedByIssueIds = [];
      f.data[key] = { toJSON() { return output; } };
      await expect(f.run()).rejects.toMatchObject({ status: 422 });
      expect(f.root.transaction).not.toHaveBeenCalled(); expect(f.tx.execute).not.toHaveBeenCalled();
      expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.relationDeletes).toEqual([]);
      expect(f.publications).toEqual([]); expect(f.actions).toEqual([]);
    });
  it.each([false, true])("explicit SQL NULL and omitted JSON column remain supported (owned=%s)", async owned => {
    const f = fixture(owned); f.release(); f.data.executionPolicy = null; f.data.executionState = undefined;
    await f.run();
    expect(f.writes[0].executionPolicy).toBeNull(); expect(f.writes[0]).toHaveProperty("executionState", undefined);
    expect(new PgUpdateBuilder(issues, undefined as any, new PgDialect())
      .set({ executionPolicy: f.writes[0].executionPolicy, executionState: f.writes[0].executionState }).toSQL().params).toEqual([null]);
  });
  it.each([false, true])("throwing encoder is rejected before effects (owned=%s)", async owned => {
    const f = fixture(owned); f.data.blockedByIssueIds = [];
    f.data.executionPolicy = { toJSON() { throw new Error("toJSON sentinel"); } };
    await expect(f.run()).rejects.toThrow("toJSON sentinel");
    expect(f.root.transaction).not.toHaveBeenCalled(); expect(f.tx.execute).not.toHaveBeenCalled();
    expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.relationDeletes).toEqual([]);
  });
  it.each([null, undefined])("non-opt-in retains encoder-nullish alias contract: %s", async output => {
    const f = fixture(false); f.data.executionPolicy = { toJSON() { return output; } };
    await f.run({ lifecycleFence: false });
    expect(f.writes[0].executionPolicy).toBe(f.data.executionPolicy);
    expect(f.tx.execute).not.toHaveBeenCalled();
  });
  it.each([false, true])("invalid cyclic JSON rejects before transaction or effects (owned=%s)", async owned => {
    const f = fixture(owned); const payload: any = {}; payload.self = payload;
    f.data.executionPolicy = payload;
    await expect(f.run()).rejects.toThrow(/circular/i);
    expect(f.tx.execute).not.toHaveBeenCalled();
    expect(f.root.transaction).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]); expect(f.relationDeletes).toEqual([]);
  });
  it.each([false,true])("preserves structurally valid inherited opt-in (owned=%s)", async owned => {
    const f = fixture(owned); f.release();
    const options: { lifecycleFence?: boolean } = Object.create({ lifecycleFence: true });
    await expect(f.run(options)).resolves.toMatchObject({title:"Requested"});
    expect(f.tx.execute).toHaveBeenCalledOnce();
    expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
  });
  it.each([false,true])("preserves DB JSON-compatible partial inputs (owned=%s)", async owned => {
    const f = fixture(owned); f.release();
    const payload: Record<string,unknown> = { toJSON() { return { mode: "safe" }; } };
    expect(issues.executionPolicy.mapToDriverValue(payload)).toBe('{"mode":"safe"}');
    f.data.executionPolicy = payload;
    await expect(f.run()).resolves.toMatchObject({title:"Requested"});
    expect(f.writes).toHaveLength(1);
  });
  it("inherited opt-in cannot clear relations without company fence", async () => {
    const f = fixture(false); f.release(); f.data.blockedByIssueIds = [];
    await expect(f.run(Object.create({lifecycleFence:true}))).resolves.toMatchObject({blockedByIssueIds:[]});
    expect(f.relationDeletes).toEqual([["company-1","issue-1","blocks"]]);
    expect(f.tx.execute).toHaveBeenCalledOnce();
  });
  it.each([false,true])("detaches Date, preserves undefined/null and caller queues (owned=%s)", async owned => {
    const f = fixture(owned); const date = new Date("2026-10-05T00:00:00Z");
    f.data.monitorNextCheckAt = date; f.data.description = null; f.data.executionState = undefined;
    const result = f.run(); await f.fenceEntered; date.setUTCFullYear(2030); f.release();
    await expect(result).resolves.toMatchObject({description:null});
    expect(f.writes[0].monitorNextCheckAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(f.writes[0].monitorNextCheckAt).not.toBe(date);
    expect(f.writes[0]).toHaveProperty("executionState",undefined);
    expect(f.publications).toEqual([]); expect(f.actions).toEqual([]);
  });
  it("non-opt-in retains previous caller-mutation semantics and JSON compatibility", async () => {
    const f = fixture(false);
    f.data.executionPolicy = { toJSON() { return {mode:"safe"}; } };
    const result = f.run({lifecycleFence:false}); f.data.title = "Mutated";
    await expect(result).resolves.toMatchObject({title:"Mutated"});
    expect(f.tx.execute).not.toHaveBeenCalled();
    expect(f.writes[0].executionPolicy).toBe(f.data.executionPolicy);
  });
  it("snapshot precedes owned transaction callback scheduling", async () => {
    const f = fixture(true); let start!: () => Promise<any>;
    f.root.transaction.mockImplementation((cb: any) => new Promise((resolve,reject) => { start = () => cb(f.tx).then(resolve,reject); }));
    const result = f.run(); f.data.title = "Mutated before callback"; f.release(); await start();
    await expect(result).resolves.toMatchObject({title:"Requested"});
    expect(f.root.transaction).toHaveBeenCalledOnce();
  });
});
