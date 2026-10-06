import { describe, expect, it, vi } from "vitest";
import { approvals, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { approvalService, resubmitApprovalInTransaction } from "../services/approvals.js";
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));

function fixture(status = "revision_requested", companyId = "company-1", config: { missing?: boolean; empty?: boolean; error?: Error } = {}) {
  const events: string[] = []; const reads: any[] = []; const writes: any[] = []; const patches: any[] = [];
  const dialect = new PgDialect(); let release!: () => void; let reject!: (e: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const row = { id: "approval-1", companyId, status, payload: { retained: true } };
  const tx = {
    execute: async (q: any) => { events.push("fence"); expect(dialect.sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    select: () => ({ from: (t: unknown) => { expect(t).toBe(approvals); return { where: (q: any) => { events.push("read"); reads.push(dialect.sqlToQuery(q)); return Promise.resolve(config.missing ? [] : [row]); } }; } }),
    update: (t: unknown) => { expect(t).toBe(approvals); return { set: (p: any) => ({ where: (q: any) => { events.push("write"); patches.push(p); writes.push(dialect.sqlToQuery(q)); return { returning: async () => { if (config.error) throw config.error; return config.empty ? [] : [{ ...row, ...p }]; } }; } }) }; },
  };
  const root = { select: () => { throw new Error("root-read-before-transaction"); }, transaction: async (cb: any) => { events.push("tx"); const r = await cb(tx); events.push("return"); return r; } };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, reads, writes, patches, release, reject };
}
const invoke = (f: ReturnType<typeof fixture>, payload?: Record<string, unknown>, options: any = { lifecycleFence: true, companyId: "company-1" }) =>
  approvalService(f.root).resubmit("approval-1", payload, options);
const supplied = (f: ReturnType<typeof fixture>, input: any) => resubmitApprovalInTransaction(f.tx as unknown as Parameters<typeof resubmitApprovalInTransaction>[0], input);

describe("dark resubmit invocation payload containment", () => {
  for (const owned of [true, false]) {
    for (const encoded of [null, undefined]) {
      it(`rejects non-null input encoded as ${encoded} before effects owned=${owned}`, async () => {
        const f = fixture(); const payload = { toJSON: () => encoded };
        const pending = owned ? invoke(f, payload) : supplied(f, { companyId: "company-1", approvalId: "approval-1", payload });
        const assertion = expect(pending).rejects.toMatchObject({ status: 422 });
        f.release(); await assertion; expect(f.events).toEqual([]);
      });
    }
    it(`captures JSON payload before startup or suspension owned=${owned}`, async () => {
      const f = fixture(); let start!: () => void;
      const startup = new Promise<void>((resolve) => { start = resolve; });
      const root = { ...f.root, transaction: async (cb: any) => { await startup; return cb(f.tx); } } as Db;
      const payload = { nested: { values: ["original"] } };
      const input = { companyId: "company-1", approvalId: "approval-1", payload };
      const options = { lifecycleFence: true, companyId: "company-1" };
      const pending = owned ? approvalService(root).resubmit("approval-1", payload, options) : supplied(f, input);
      void pending.catch(() => {});
      payload.nested.values[0] = "mutated"; input.companyId = "foreign"; input.approvalId = "other"; options.companyId = "foreign";
      start(); f.release(); await pending;
      expect(f.patches[0].payload).toEqual({ nested: { values: ["original"] } });
      expect(f.writes[0].params).toEqual(["approval-1", "company-1", "revision_requested"]);
    });
  }
});

describe("dark canonical approval resubmit recording", () => {
  for (const owned of [true, false]) {
    const call = (f: ReturnType<typeof fixture>, payload?: Record<string, unknown>) => owned
      ? invoke(f, payload) : supplied(f, { companyId: "company-1", approvalId: "approval-1", payload });
    it(`awaits fence before reads owned=${owned}`, async () => {
      const f = fixture(); const pending = call(f); void pending.catch(() => {});
      try { await Promise.resolve(); expect(f.events).toEqual(owned ? ["tx", "fence"] : ["fence"]); } finally { f.release(); }
      await pending; expect(f.patches[0].payload).toEqual({ retained: true });
    });
    for (const [status, companyId] of [["pending", "company-1"], ["approved", "company-1"], ["cancelled", "company-1"], ["rejected", "company-1"], ["revision_requested", "foreign"]]) {
      it(`rejects state/company ${status}/${companyId} without writes owned=${owned}`, async () => {
        const f = fixture(status, companyId); f.release(); await expect(call(f)).rejects.toThrow();
        expect(f.writes).toEqual([]); expect(f.events).not.toContain("return");
      });
    }
    for (const config of [{ missing: true }, { empty: true }, { error: new Error("storage-error") }]) {
      it(`propagates absent/empty/write outcome ${JSON.stringify(config)} owned=${owned}`, async () => {
        const f = fixture("revision_requested", "company-1", config); f.release();
        await expect(call(f)).rejects.toThrow(); expect(f.events).not.toContain("return");
        expect(f.writes).toHaveLength(config.missing ? 0 : 1);
      });
    }
    it(`propagates fence rejection without reads/writes owned=${owned}`, async () => {
      const f = fixture(); const pending = call(f); const error = new Error("fence-denied");
      const assertion = expect(pending).rejects.toBe(error); f.reject(error); await assertion;
      expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
    });
    it(`rejects missing company before effects owned=${owned}`, async () => {
      const f = fixture(); const pending = owned ? invoke(f, undefined, { lifecycleFence: true }) : supplied(f, { companyId: "", approvalId: "approval-1" });
      await expect(pending).rejects.toMatchObject({ status: 422 }); expect(f.events).toEqual([]);
    });
    for (const payload of [undefined, null]) {
      it(`retains authoritative payload for ${payload} owned=${owned}`, async () => {
        const f = fixture(); f.release(); await call(f, payload as any);
        expect(f.patches[0].payload).toEqual({ retained: true });
      });
    }
    it(`accepts driver-compatible toJSON and captures original content owned=${owned}`, async () => {
      const f = fixture(); const value = { text: "original" };
      const pending = call(f, { toJSON: () => ({ nested: value, date: new Date("2026-01-01T00:00:00Z") }) }); void pending.catch(() => {});
      value.text = "changed"; f.release(); await pending;
      expect(f.patches[0].payload).toEqual({ nested: { text: "original" }, date: "2026-01-01T00:00:00.000Z" });
    });
    it(`rejects cyclic JSON before effects owned=${owned}`, async () => {
      const f = fixture(); const payload: any = {}; payload.self = payload;
      await expect(call(f, payload)).rejects.toThrow(); expect(f.events).toEqual([]);
    });
  }
  for (const lifecycleFence of [undefined, false]) {
    for (const empty of [true, false]) {
      it(`preserves ordinary non-owning predicate/outcome flag=${lifecycleFence} empty=${empty}`, async () => {
        const f = fixture("revision_requested", "company-1", { empty });
        const result = await approvalService(f.tx).resubmit("approval-1", undefined, { lifecycleFence, companyId: "ignored" });
        expect(f.events).toEqual(["read", "write"]); expect(f.reads[0].params).toEqual(["approval-1"]); expect(f.writes[0].params).toEqual(["approval-1"]);
        expect(f.patches[0]).toMatchObject({ payload: { retained: true }, status: "pending", decisionNote: null, decidedByUserId: null, decidedAt: null });
        if (empty) expect(result).toBeUndefined(); else expect(result.status).toBe("pending");
      });
    }
  }
  it("starts owned transaction before reads and awaits company fence", async () => {
    const f = fixture(); const pending = invoke(f, { revised: true }); void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["tx", "fence"]); } finally { f.release(); }
    await expect(pending).resolves.toMatchObject({ status: "pending", payload: { revised: true }, decidedByUserId: null, decisionNote: null, decidedAt: null });
    expect(f.events).toEqual(["tx", "fence", "read", "write", "return"]);
    expect(f.reads[0].params).toEqual(["approval-1", "company-1"]);
    expect(f.writes[0].params).toEqual(["approval-1", "company-1", "revision_requested"]);
  });
});
