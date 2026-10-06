import { describe, expect, it, vi } from "vitest";
import { approvals, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { approvalService, createApprovalInTransaction } from "../services/approvals.js";
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));

function fixture(config: { empty?: boolean; error?: Error } = {}) {
  const events: string[] = []; const values: any[] = [];
  let release!: () => void; let reject!: (e: Error) => void;
  const barrier = new Promise<void>((ok, fail) => { release = ok; reject = fail; });
  const tx = {
    execute: async (q: any) => { events.push("fence"); expect(new PgDialect().sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    insert: (t: unknown) => { expect(t).toBe(approvals); return { values: (v: any) => { events.push("insert"); values.push(v); return { returning: async () => { if (config.error) throw config.error; return config.empty ? [] : [{ id: "new-approval", ...v }]; } }; } }; },
  };
  const root = { insert: () => { throw new Error("root-write-before-transaction"); }, transaction: async (cb: any) => { events.push("tx"); const r = await cb(tx); events.push("return"); return r; } };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, values, release, reject };
}
describe("dark canonical pending approval creation recording", () => {
  for (const lifecycleFence of [undefined, false]) {
    for (const empty of [true, false]) {
      it(`preserves ordinary spread/default/no-owned-tx flag=${lifecycleFence} empty=${empty}`, async () => {
        const f = fixture({ empty });
        const payload = { toJSON: () => ({ original: true }) };
        const data = { id: "chosen", type: "test", payload, status: "approved", decidedByUserId: "user", companyId: "ignored" };
        const row = await approvalService(f.tx).create("company-1", data, { lifecycleFence });
        expect(f.events).toEqual(["insert"]); expect(f.values[0]).toEqual({ ...data, companyId: "company-1" });
        expect(f.values[0].payload).toBe(payload);
        if (empty) expect(row).toBeUndefined(); else expect(row.status).toBe("approved");
      });
    }
    it(`preserves ordinary synchronous builder rejection flag=${lifecycleFence}`, () => {
      const f = fixture(); expect(() => approvalService(f.root).create("company-1", { type: "test", payload: {} }, { lifecycleFence })).toThrow("root-write-before-transaction");
      expect(f.events).toEqual([]);
    });
  }
  for (const owned of [true, false]) {
    const call = (f: ReturnType<typeof fixture>, data: any, companyId = "company-1") => owned
      ? approvalService(f.root).create(companyId, data, { lifecycleFence: true })
      : createApprovalInTransaction(f.tx as unknown as Parameters<typeof createApprovalInTransaction>[0], { companyId, data });
    it(`denies empty insertion result owned=${owned}`, async () => {
      const f = fixture({ empty: true }); f.release();
      await expect(call(f, { type: "test", payload: {} })).rejects.toMatchObject({ status: 422 });
      expect(f.events).not.toContain("return");
    });
    it(`awaits fence before insertion owned=${owned}`, async () => {
      const f = fixture(); const pending = call(f, { type: "test", payload: {} }); void pending.catch(() => {});
      try { await Promise.resolve(); expect(f.events).toEqual(owned ? ["tx", "fence"] : ["fence"]); } finally { f.release(); }
      await pending;
    });
    it(`propagates fence rejection without insert owned=${owned}`, async () => {
      const f = fixture(); const error = new Error("fence-denied");
      const pending = call(f, { type: "test", payload: {} }); const assertion = expect(pending).rejects.toBe(error);
      f.reject(error); await assertion; expect(f.values).toEqual([]); expect(f.events).not.toContain("return");
    });
    it(`propagates insert error identity owned=${owned}`, async () => {
      const error = new Error("insert-failed"); const f = fixture({ error }); f.release();
      await expect(call(f, { type: "test", payload: {} })).rejects.toBe(error); expect(f.events).not.toContain("return");
    });
    it(`denies missing company before effects owned=${owned}`, async () => {
      const f = fixture(); await expect(call(f, { type: "test", payload: {} }, "")).rejects.toMatchObject({ status: 422 });
      expect(f.events).toEqual([]);
    });
    it(`accepts actual driver-compatible toJSON owned=${owned}`, async () => {
      const f = fixture(); const data = { text: "original" };
      const pending = call(f, { type: "test", payload: { toJSON: () => ({ data, date: new Date("2026-01-01T00:00:00Z") }) } });
      void pending.catch(() => {}); data.text = "changed"; f.release(); await pending;
      expect(f.values[0].payload).toEqual({ data: { text: "original" }, date: "2026-01-01T00:00:00.000Z" });
    });
    it(`rejects cyclic JSON without effects owned=${owned}`, async () => {
      const f = fixture(); const payload: any = {}; payload.self = payload;
      await expect(call(f, { type: "test", payload })).rejects.toThrow(); expect(f.events).toEqual([]);
    });
    it(`permits explicit pending and inherited requester values owned=${owned}`, async () => {
      const f = fixture(); const data = Object.assign(Object.create({ requestedByUserId: "user-1" }), { type: "test", payload: {}, status: "pending" });
      f.release(); await call(f, data); expect(f.values[0]).toMatchObject({ requestedByUserId: "user-1", status: "pending" });
    });
    it(`captures routing/requester/payload before startup or suspension owned=${owned}`, async () => {
      const f = fixture(); let start!: () => void;
      const startup = new Promise<void>((ok) => { start = ok; });
      const root = { ...f.root, transaction: async (cb: any) => { await startup; return cb(f.tx); } } as Db;
      const data = { type: "test", requestedByAgentId: "agent-1", requestedByUserId: "user-1", payload: { nested: ["original"] } };
      const input = { companyId: "company-1", data };
      const pending = owned ? approvalService(root).create("company-1", data, { lifecycleFence: true })
        : createApprovalInTransaction(f.tx as any, input);
      void pending.catch(() => {});
      data.type = "changed"; data.requestedByAgentId = "other"; data.payload.nested[0] = "changed"; input.companyId = "foreign";
      start(); f.release(); await pending;
      expect(f.values[0]).toEqual({ companyId: "company-1", type: "test", requestedByAgentId: "agent-1", requestedByUserId: "user-1", payload: { nested: ["original"] }, status: "pending" });
    });
    for (const extra of [{ status: "approved" }, { id: "chosen-id" }, { decidedByUserId: "operator" }, { companyId: "foreign" }, { createdAt: new Date() }]) {
      it(`rejects lifecycle extras before effects ${Object.keys(extra)} owned=${owned}`, async () => {
        const f = fixture(); const pending = call(f, { type: "test", payload: {}, ...extra });
        const assertion = expect(pending).rejects.toMatchObject({ status: 422 }); f.release(); await assertion;
        expect(f.events).toEqual([]);
      });
    }
    for (const payload of [null, undefined, { toJSON: () => null }, { toJSON: () => undefined }]) {
      it(`rejects absent/null encoded payload ${String(payload)} owned=${owned}`, async () => {
        const f = fixture(); const pending = call(f, { type: "test", payload });
        const assertion = expect(pending).rejects.toMatchObject({ status: 422 }); f.release(); await assertion;
        expect(f.events).toEqual([]);
      });
    }
  }
  it("starts owned transaction before insertion and awaits company fence", async () => {
    const f = fixture();
    const pending = approvalService(f.root).create("company-1", { type: "test", payload: { requested: true } }, { lifecycleFence: true } as any);
    void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["tx", "fence"]); } finally { f.release(); }
    await expect(pending).resolves.toMatchObject({ companyId: "company-1", status: "pending" });
    expect(f.events).toEqual(["tx", "fence", "insert", "return"]);
  });
});
