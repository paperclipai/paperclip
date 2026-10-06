import { describe, expect, it, vi } from "vitest";
import { approvals, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { approvalService, requestApprovalRevisionInTransaction } from "../services/approvals.js";
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));

function fixture(status = "pending", companyId = "company-1", config: { missing?: boolean; lostCas?: boolean; writeError?: boolean } = {}) {
  const events: string[] = [];
  const reads: any[] = []; const writes: any[] = []; const patches: any[] = [];
  const dialect = new PgDialect();
  let release!: () => void;
  let reject!: (e: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const row = { id: "approval-1", companyId, status, type: "hire_agent", payload: {} };
  const tx = {
    execute: async (q: any) => { events.push("fence"); expect(dialect.sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    select: () => ({ from: (t: unknown) => { expect(t).toBe(approvals); return { where: (q: any) => { events.push("read"); reads.push(dialect.sqlToQuery(q)); return Promise.resolve(config.missing ? [] : [row]); } }; } }),
    update: (t: unknown) => { expect(t).toBe(approvals); return { set: (patch: any) => ({ where: (q: any) => { events.push("write"); patches.push(patch); writes.push(dialect.sqlToQuery(q)); return { returning: async () => { if (config.writeError) throw new Error("write-denied"); return config.lostCas ? [] : [{ ...row, ...patch }]; } }; } }) }; },
  };
  const root = { select: () => { throw new Error("root-read-before-transaction"); }, transaction: async (cb: any) => { events.push("tx"); const r = await cb(tx); events.push("return"); return r; } };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, reads, writes, patches, release, reject };
}

describe("dark approval revision participant recording", () => {
  it("starts owned transaction and awaits fence before canonical revision read", async () => {
    const f = fixture();
    const pending = approvalService(f.root).requestRevision("approval-1", "board", "revise", { lifecycleFence: true, companyId: "company-1" });
    void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["tx", "fence"]); } finally { f.release(); }
    await expect(pending).resolves.toMatchObject({ status: "revision_requested", decidedByUserId: "board", decisionNote: "revise" });
    expect(f.events).toEqual(["tx", "fence", "read", "write", "return"]);
    expect(f.reads[0].params).toEqual(["approval-1", "company-1"]);
    expect(f.writes[0].params).toEqual(["approval-1", "company-1", "pending"]);
  });
  const supplied = (f: ReturnType<typeof fixture>) => f.tx as unknown as Parameters<typeof requestApprovalRevisionInTransaction>[0];
  for (const owned of [true, false]) {
    for (const config of [{ missing: true }, { lostCas: true }, { writeError: true }]) {
      it(`propagates canonical absent/error outcome ${JSON.stringify(config)} owned=${owned}`, async () => {
        const f = fixture("pending", "company-1", config); f.release();
        const pending = owned
          ? approvalService(f.root).requestRevision("approval-1", "board", null, { lifecycleFence: true, companyId: "company-1" })
          : requestApprovalRevisionInTransaction(supplied(f), { companyId: "company-1", approvalId: "approval-1", decidedByUserId: "board" });
        await expect(pending).rejects.toThrow(); expect(f.events).not.toContain("return");
        expect(f.writes).toHaveLength(config.missing ? 0 : 1);
      });
    }
    for (const [status, companyId] of [["approved", "company-1"], ["rejected", "company-1"], ["revision_requested", "company-1"], ["cancelled", "company-1"], ["pending", "foreign"]]) {
      it(`vetoes non-pending/foreign rows before write ${status}/${companyId} owned=${owned}`, async () => {
        const f = fixture(status, companyId); f.release();
        const pending = owned
          ? approvalService(f.root).requestRevision("approval-1", "board", null, { lifecycleFence: true, companyId: "company-1" })
          : requestApprovalRevisionInTransaction(supplied(f), { companyId: "company-1", approvalId: "approval-1", decidedByUserId: "board" });
        await expect(pending).rejects.toThrow();
        expect(f.writes).toEqual([]); expect(f.events).not.toContain("return");
      });
    }
    it(`propagates fence failure without reads or writes owned=${owned}`, async () => {
      const f = fixture();
      const pending = owned
        ? approvalService(f.root).requestRevision("approval-1", "board", null, { lifecycleFence: true, companyId: "company-1" })
        : requestApprovalRevisionInTransaction(supplied(f), { companyId: "company-1", approvalId: "approval-1", decidedByUserId: "board" });
      const assertion = expect(pending).rejects.toThrow("fence-denied"); f.reject(new Error("fence-denied")); await assertion;
      expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
    });
    it(`rejects missing company before effects owned=${owned}`, async () => {
      const f = fixture();
      const pending = owned
        ? approvalService(f.root).requestRevision("approval-1", "board", null, { lifecycleFence: true })
        : requestApprovalRevisionInTransaction(supplied(f), { companyId: "", approvalId: "approval-1", decidedByUserId: "board" });
      await expect(pending).rejects.toMatchObject({ status: 422 }); expect(f.events).toEqual([]);
    });
  }
  it("captures supplied decision scalars and routing before fence suspension", async () => {
    const f = fixture();
    const input = { companyId: "company-1", approvalId: "approval-1", decidedByUserId: "board", decisionNote: "revise" };
    const pending = requestApprovalRevisionInTransaction(supplied(f), input); void pending.catch(() => {});
    try {
      expect(f.events).toEqual(["fence"]);
      Object.assign(input, { companyId: "foreign", approvalId: "other", decidedByUserId: "other-user", decisionNote: "changed" });
    } finally { f.release(); }
    await pending;
    expect(f.patches[0]).toMatchObject({ decidedByUserId: "board", decisionNote: "revise" });
    expect(f.writes[0].params).toEqual(["approval-1", "company-1", "pending"]);
    expect(f.writes[0].sql).toContain('"approvals"."company_id"');
    expect(f.writes[0].sql).toContain('"approvals"."status"');
  });
  it("captures company before deferred owned transaction startup", async () => {
    const f = fixture(); let start!: () => void;
    const startup = new Promise<void>((resolve) => { start = resolve; });
    const root = { ...f.root, transaction: async (cb: any) => { await startup; return cb(f.tx); } } as Db;
    const options = { lifecycleFence: true, companyId: "company-1" };
    const pending = approvalService(root).requestRevision("approval-1", "board", "revise", options);
    options.companyId = "foreign"; options.lifecycleFence = false; start(); f.release(); await pending;
    expect(f.reads[0].params).toEqual(["approval-1", "company-1"]);
  });
  for (const lifecycleFence of [undefined, false]) {
    it(`preserves ordinary root non-owning predicates flag=${lifecycleFence}`, async () => {
      const f = fixture();
      await approvalService(f.tx).requestRevision("approval-1", "board", undefined, { lifecycleFence, companyId: "ignored" });
      expect(f.events).toEqual(["read", "write"]);
      expect(f.reads[0].params).toEqual(["approval-1"]); expect(f.writes[0].params).toEqual(["approval-1"]);
      expect(f.patches[0].decisionNote).toBeNull();
    });
  }
});
