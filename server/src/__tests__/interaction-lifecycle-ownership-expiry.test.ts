import { describe, expect, it, vi } from "vitest";
import { issueThreadInteractions, toolOauthStates, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import * as service from "../services/issue-thread-interactions.js";
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));
function fixture(config: { rows?: any[]; writeError?: Error; deleteError?: Error } = {}) {
  const events: string[] = []; const queries: any[] = []; const patches: any[] = [];
  const dialect = new PgDialect(); let release!: () => void; let reject!: (e: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const rows = config.rows ?? [{ id: "interaction-1", status: "expired" }];
  const tx = {
    execute: async (q: any) => { events.push("fence"); expect(dialect.sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    update: (table: unknown) => { expect(table).toBe(issueThreadInteractions); return { set: (patch: any) => ({ where: (q: any) => {
      events.push("write"); patches.push(patch); queries.push(dialect.sqlToQuery(q));
      return { returning: async () => { if (config.writeError) throw config.writeError; return rows; } };
    } }) }; },
    delete: (table: unknown) => { expect(table).toBe(toolOauthStates); return { where: async (q: any) => {
      events.push("delete"); queries.push(dialect.sqlToQuery(q)); if (config.deleteError) throw config.deleteError;
    } }; },
  };
  const root = { update: () => { throw new Error("root-write"); }, transaction: async (cb: any) => { events.push("tx"); const result = await cb(tx); events.push("return"); return result; } };
  return { root: root as unknown as Db, tx: tx as unknown as Db, rows, events, queries, patches, release, reject };
}
describe("dark canonical connection-intent ownership expiry recording", () => {
  for (const owned of [true, false]) {
    const invoke = (f: ReturnType<typeof fixture>, issue = { id: "issue-1", companyId: "company-1" }) => owned
      ? service.issueThreadInteractionService(f.root).expireConnectionIntentsForOwnershipChange(issue, { lifecycleFence: true })
      : service.expireConnectionIntentsForOwnershipChangeInTransaction(f.tx as unknown as Parameters<typeof service.expireConnectionIntentsForOwnershipChangeInTransaction>[0], issue);
    it(`waits on fence before UPDATE owned=${owned}`, async () => {
      const f = fixture(); const pending = invoke(f); void pending.catch(() => {});
      try { await Promise.resolve(); expect(f.queries).toEqual([]); expect(f.events).toEqual(owned ? ["tx", "fence"] : ["fence"]); }
      finally { f.release(); } await pending;
    });
    it(`rejects fence with no domain effects owned=${owned}`, async () => {
      const f = fixture(); const error = new Error("fence-denied");
      const assertion = expect(invoke(f)).rejects.toBe(error); f.reject(error); await assertion;
      expect(f.queries).toEqual([]); expect(f.events).not.toContain("return");
    });
    it(`rejects missing company before transaction or effects owned=${owned}`, async () => {
      const f = fixture(); await expect(invoke(f, { id: "issue-1", companyId: "" })).rejects.toMatchObject({ status: 422 });
      expect(f.events).toEqual([]);
    });
    it(`captures routing before suspension owned=${owned}`, async () => {
      const f = fixture(); const issue = { id: "issue-1", companyId: "company-1" }; const pending = invoke(f, issue);
      Object.assign(issue, { id: "other-issue", companyId: "foreign" }); f.release(); await pending;
      expect(f.queries[0].params).toEqual(["company-1", "issue-1", "connection_intent", "pending"]);
    });
    it(`skips OAuth DELETE on empty expiry owned=${owned}`, async () => {
      const f = fixture({ rows: [] }); f.release(); await expect(invoke(f)).resolves.toBe(f.rows);
      expect(f.events).not.toContain("delete"); expect(f.queries).toHaveLength(1);
    });
    it(`deletes only returned interaction IDs owned=${owned}`, async () => {
      const f = fixture({ rows: [{ id: "interaction-1" }, { id: "interaction-2" }] }); f.release(); await invoke(f);
      expect(f.queries[1].params).toEqual(["interaction-1", "interaction-2"]);
      expect(f.queries[0].sql).toContain('"issue_thread_interactions"."company_id"');
      expect(f.queries[0].sql).toContain('"issue_thread_interactions"."issue_id"');
      expect(f.patches[0]).toMatchObject({ status: "expired", result: { version: 1, outcome: "expired", reason: "The task assignment changed" } });
    });
    it(`propagates UPDATE failure without OAuth DELETE owned=${owned}`, async () => {
      const error = new Error("update-denied"); const f = fixture({ writeError: error }); f.release();
      await expect(invoke(f)).rejects.toBe(error); expect(f.events).not.toContain("delete");
    });
    it(`propagates DELETE failure without caller return owned=${owned}`, async () => {
      const error = new Error("delete-denied"); const f = fixture({ deleteError: error }); f.release();
      await expect(invoke(f)).rejects.toBe(error); expect(f.patches).toHaveLength(1); expect(f.events).not.toContain("return");
    });
  }
  it("captures routing before deferred owned transaction startup", async () => {
    const f = fixture(); let start!: () => void; const startup = new Promise<void>((resolve) => { start = resolve; });
    const root = { ...f.root, transaction: async (cb: any) => { await startup; return cb(f.tx); } } as Db;
    const issue = { id: "issue-1", companyId: "company-1" }; const options = { lifecycleFence: true };
    const pending = service.issueThreadInteractionService(root).expireConnectionIntentsForOwnershipChange(issue, options);
    Object.assign(issue, { id: "other", companyId: "foreign" }); options.lifecycleFence = false; start(); f.release(); await pending;
    expect(f.queries[0].params).toEqual(["company-1", "issue-1", "connection_intent", "pending"]);
  });
  for (const lifecycleFence of [undefined, false, true]) {
    it(`preserves injected clock calls flag=${lifecycleFence}`, async () => {
      const f = fixture(); f.release(); const first = new Date(100); const second = new Date(200);
      const now = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
      await service.issueThreadInteractionService(lifecycleFence ? f.root : f.tx, { now }).expireConnectionIntentsForOwnershipChange(
        { id: "issue-1", companyId: "company-1" }, { lifecycleFence },
      ); expect(now).toHaveBeenCalledTimes(2); expect(f.patches[0].resolvedAt).toBe(first); expect(f.patches[0].updatedAt).toBe(second);
      if (!lifecycleFence) expect(f.events).toEqual(["write", "delete"]);
    });
  }
  it("starts owned transaction and awaits fence before canonical expiry", async () => {
    const f = fixture();
    const pending = service.issueThreadInteractionService(f.root).expireConnectionIntentsForOwnershipChange(
      { id: "issue-1", companyId: "company-1" }, { lifecycleFence: true },
    ); void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["tx", "fence"]); expect(f.queries).toEqual([]); }
    finally { f.release(); }
    await expect(pending).resolves.toBe(f.rows);
    expect(f.events).toEqual(["tx", "fence", "write", "delete", "return"]);
    expect(f.queries[0].params).toEqual(["company-1", "issue-1", "connection_intent", "pending"]);
    expect(f.queries[1].params).toEqual(["interaction-1"]);
  });
});
