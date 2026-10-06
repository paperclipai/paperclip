import { describe, expect, it, vi } from "vitest";
import { approvals, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import * as service from "../services/approvals.js";
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));
function fixture(config: { empty?: boolean; error?: Error } = {}) {
  const events: string[] = []; const writes: any[] = []; const patches: any[] = [];
  const dialect = new PgDialect(); let release!: () => void; let reject!: (e: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const tx = {
    execute: async (q: any) => { events.push("fence"); expect(dialect.sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    select: () => { throw new Error("unexpected-read"); },
    update: (table: unknown) => { expect(table).toBe(approvals); return { set: (patch: any) => ({ where: (q: any) => {
      events.push("write"); patches.push(patch); writes.push(dialect.sqlToQuery(q));
      return { returning: async () => { if (config.error) throw config.error; return config.empty ? [] : [{ id: "approval-1", companyId: "company-1", ...patch }]; } };
    } }) }; },
  };
  const root = { update: () => { throw new Error("root-write-before-transaction"); }, transaction: async (cb: any) => { events.push("tx"); const r = await cb(tx); events.push("return"); return r; } };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, writes, patches, release, reject };
}
const supplied = (f: ReturnType<typeof fixture>, input = { companyId: "company-1", approvalId: "approval-1", reason: "duplicate" as string | null | undefined }) =>
  service.cancelApprovalInTransaction(f.tx as unknown as Parameters<typeof service.cancelApprovalInTransaction>[0], input);
describe("dark canonical approval cancellation recording", () => {
  for (const owned of [true, false]) {
    const invoke = (f: ReturnType<typeof fixture>, reason?: string | null, companyId = "company-1") => owned
      ? service.approvalService(f.root).cancel("approval-1", reason, { lifecycleFence: true, companyId })
      : supplied(f, { companyId, approvalId: "approval-1", reason });
    it(`retains empty RETURNING as idempotent null owned=${owned}`, async () => {
      const f = fixture({ empty: true }); f.release();
      await expect(invoke(f)).resolves.toBeNull();
      expect(f.writes[0].params).toEqual(["approval-1", "pending", "revision_requested", "company-1"]);
      expect(f.writes[0].sql).toContain('"approvals"."company_id"');
      expect(f.writes[0].sql).toContain('"approvals"."status"');
    });
    it(`propagates write error identity owned=${owned}`, async () => {
      const error = new Error("write-denied"); const f = fixture({ error }); f.release();
      await expect(invoke(f)).rejects.toBe(error); expect(f.events).not.toContain("return");
    });
    it(`rejects missing company before effects owned=${owned}`, async () => {
      const f = fixture(); await expect(invoke(f, null, "")).rejects.toMatchObject({ status: 422 });
      expect(f.events).toEqual([]);
    });
    it(`rejects fence without canonical writes owned=${owned}`, async () => {
      const f = fixture(); const error = new Error("fence-denied");
      const assertion = expect(invoke(f)).rejects.toBe(error); f.reject(error); await assertion;
      expect(f.writes).toEqual([]); expect(f.events).not.toContain("return");
    });
    it(`waits before writes owned=${owned}`, async () => {
      const f = fixture(); const pending = invoke(f); void pending.catch(() => {});
      try { await Promise.resolve(); expect(f.writes).toEqual([]); expect(f.events).toEqual(owned ? ["tx", "fence"] : ["fence"]); }
      finally { f.release(); } await pending;
    });
    for (const reason of [undefined, null, "", "duplicate"]) {
      it(`preserves reason ${JSON.stringify(reason)} owned=${owned}`, async () => {
        const f = fixture(); f.release(); await invoke(f, reason);
        expect(f.patches[0]).toMatchObject({ status: "cancelled", decisionNote: reason ?? null });
        expect(f.patches[0]).not.toHaveProperty("decidedByUserId");
        expect(f.patches[0].decidedAt).toBeInstanceOf(Date);
        expect(f.patches[0].updatedAt).toBe(f.patches[0].decidedAt);
      });
    }
  }
  it("captures supplied routing and reason before suspension", async () => {
    const f = fixture(); const input = { companyId: "company-1", approvalId: "approval-1", reason: "duplicate" };
    const pending = supplied(f, input); void pending.catch(() => {});
    try { Object.assign(input, { companyId: "foreign", approvalId: "other", reason: "changed" }); }
    finally { f.release(); } await pending;
    expect(f.writes[0].params).toEqual(["approval-1", "pending", "revision_requested", "company-1"]);
    expect(f.patches[0].decisionNote).toBe("duplicate");
  });
  it("captures company before deferred owned startup", async () => {
    const f = fixture(); let start!: () => void; const startup = new Promise<void>((resolve) => { start = resolve; });
    const root = { ...f.root, transaction: async (cb: any) => { await startup; return cb(f.tx); } } as Db;
    const options = { lifecycleFence: true, companyId: "company-1" };
    const pending = service.approvalService(root).cancel("approval-1", "duplicate", options);
    options.companyId = "foreign"; options.lifecycleFence = false; start(); f.release(); await pending;
    expect(f.writes[0].params).toEqual(["approval-1", "pending", "revision_requested", "company-1"]);
  });
  for (const lifecycleFence of [undefined, false]) {
    for (const empty of [false, true]) {
      it(`retains ordinary non-owning default flag=${lifecycleFence} empty=${empty}`, async () => {
        const f = fixture({ empty });
        const result = await service.approvalService(f.tx).cancel("approval-1", undefined, { lifecycleFence, companyId: "ignored" });
        expect(f.events).toEqual(["write"]); expect(f.writes[0].params).toEqual(["approval-1", "pending", "revision_requested"]);
        expect(f.patches[0].decisionNote).toBeNull();
        if (empty) expect(result).toBeNull(); else expect(result).toMatchObject({ status: "cancelled" });
      });
    }
  }
  it("starts owned transaction and awaits fence before canonical cancellation", async () => {
    const f = fixture();
    const pending = service.approvalService(f.root).cancel("approval-1", "duplicate", { lifecycleFence: true, companyId: "company-1" });
    void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["tx", "fence"]); } finally { f.release(); }
    await expect(pending).resolves.toMatchObject({ status: "cancelled", decisionNote: "duplicate" });
    expect(f.events).toEqual(["tx", "fence", "write", "return"]);
    expect(f.writes[0].params).toEqual(["approval-1", "pending", "revision_requested", "company-1"]);
  });
});
