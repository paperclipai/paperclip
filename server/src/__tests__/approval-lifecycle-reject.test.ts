import { describe, expect, it, vi } from "vitest";
import { approvals, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { approvalService, rejectApprovalInTransaction } from "../services/approvals.js";
vi.mock("../services/agents.js", () => ({ agentService: () => ({ terminate: () => { throw new Error("unexpected-hire-effect"); } }) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));

function fixture(status = "pending", companyId = "company-1", type = "generic", config: { missing?: boolean; lostCas?: boolean; latestStatus?: string; writeError?: Error } = {}) {
  const events: string[] = []; const reads: any[] = []; const writes: any[] = []; const patches: any[] = [];
  const dialect = new PgDialect(); let release!: () => void; let fail!: (e: Error) => void;
  const barrier = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  const row = { id: "approval-1", companyId, status, type, payload: {} }; let readCount = 0;
  const tx = {
    execute: async (q: any) => { events.push("fence"); expect(dialect.sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    select: () => ({ from: (t: unknown) => { expect(t).toBe(approvals); return { where: (q: any) => { events.push("read"); reads.push(dialect.sqlToQuery(q)); const current = readCount++ ? { ...row, status: config.latestStatus ?? status } : row; return Promise.resolve(config.missing ? [] : [current]); } }; } }),
    update: (t: unknown) => { expect(t).toBe(approvals); return { set: (patch: any) => ({ where: (q: any) => { events.push("write"); patches.push(patch); writes.push(dialect.sqlToQuery(q)); return { returning: async () => { if (config.writeError) throw config.writeError; return config.lostCas ? [] : [{ ...row, ...patch }]; } }; } }) }; },
  };
  const root = { select: () => { throw new Error("root-read-before-transaction"); }, transaction: async (cb: any) => { events.push("tx"); const r = await cb(tx); events.push("return"); return r; } };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, reads, writes, patches, release, fail };
}

describe("dark non-hire approval rejection recording", () => {
  it("starts owned transaction and awaits company fence before canonical rejection read", async () => {
    const f = fixture();
    const pending = approvalService(f.root).reject("approval-1", "board", "deny", { lifecycleFence: true, companyId: "company-1" });
    void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["tx", "fence"]); } finally { f.release(); }
    await expect(pending).resolves.toMatchObject({ applied: true, approval: { status: "rejected", decidedByUserId: "board", decisionNote: "deny" } });
    expect(f.events).toEqual(["tx", "fence", "read", "write", "return"]);
    expect(f.reads[0].params).toEqual(["approval-1", "company-1"]);
    expect(f.writes[0].params).toEqual(["approval-1", "pending", "revision_requested", "company-1"]);
  });
  const supplied = (f: ReturnType<typeof fixture>) => f.tx as unknown as Parameters<typeof rejectApprovalInTransaction>[0];
  for (const owned of [true, false]) {
    const invoke = (f: ReturnType<typeof fixture>) => owned
      ? approvalService(f.root).reject("approval-1", "board", undefined, { lifecycleFence: true, companyId: "company-1" })
      : rejectApprovalInTransaction(supplied(f), { companyId: "company-1", approvalId: "approval-1", decidedByUserId: "board" });
    for (const status of ["pending", "revision_requested", "rejected"]) {
      it(`preserves canonical rejection/idempotent result ${status} owned=${owned}`, async () => {
        const f = fixture(status); f.release(); const r = await invoke(f);
        expect(r.applied).toBe(status !== "rejected"); expect(r.approval.status).toBe("rejected");
        expect(f.writes).toHaveLength(status === "rejected" ? 0 : 1);
        if (f.patches.length) expect(f.patches[0].decisionNote).toBeNull();
      });
    }
    for (const [status, company, type] of [["approved", "company-1", "generic"], ["cancelled", "company-1", "generic"], ["pending", "foreign", "generic"], ["pending", "company-1", "hire_agent"]]) {
      it(`denies incompatible/foreign/hire before write ${status}/${company}/${type} owned=${owned}`, async () => {
        const f = fixture(status, company, type); f.release(); await expect(invoke(f)).rejects.toThrow();
        expect(f.writes).toEqual([]); expect(f.events).not.toContain("return");
      });
    }
    it(`awaits fence without domain reads owned=${owned}`, async () => {
      const f = fixture(); const p = invoke(f); void p.catch(() => {});
      try { await Promise.resolve(); expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); } finally { f.release(); }
      await p;
    });
    it(`propagates fence error without domain effects owned=${owned}`, async () => {
      const f = fixture(); const assertion = expect(invoke(f)).rejects.toThrow("fence-denied"); f.fail(new Error("fence-denied")); await assertion;
      expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
    });
    for (const latestStatus of ["rejected", "approved", "pending"]) {
      it(`reconciles synthetic empty update via scoped latest read ${latestStatus} owned=${owned}`, async () => {
        const f = fixture("pending", "company-1", "generic", { lostCas: true, latestStatus }); f.release();
        if (latestStatus === "rejected") await expect(invoke(f)).resolves.toMatchObject({ applied: false, approval: { status: "rejected" } });
        else await expect(invoke(f)).rejects.toMatchObject({ status: 422 });
        expect(f.reads).toHaveLength(2); expect(f.reads[1].params).toEqual(["approval-1", "company-1"]);
      });
    }
    it(`propagates exact update error owned=${owned}`, async () => {
      const error = new Error("write-denied"); const f = fixture("pending", "company-1", "generic", { writeError: error }); f.release();
      await expect(invoke(f)).rejects.toBe(error); expect(f.events).not.toContain("return");
    });
    it(`denies missing approval owned=${owned}`, async () => {
      const f = fixture("pending", "company-1", "generic", { missing: true }); f.release();
      await expect(invoke(f)).rejects.toMatchObject({ status: 404 }); expect(f.writes).toEqual([]);
    });
    it(`denies missing company before effects owned=${owned}`, async () => {
      const f = fixture(); const p = owned ? approvalService(f.root).reject("approval-1", "board", null, { lifecycleFence: true })
        : rejectApprovalInTransaction(supplied(f), { companyId: "", approvalId: "approval-1", decidedByUserId: "board" });
      await expect(p).rejects.toMatchObject({ status: 422 }); expect(f.events).toEqual([]);
    });
  }
  it("captures supplied routing and decision scalars before fence suspension", async () => {
    const f = fixture(); const input = { companyId: "company-1", approvalId: "approval-1", decidedByUserId: "board", decisionNote: "deny" };
    const p = rejectApprovalInTransaction(supplied(f), input); void p.catch(() => {});
    try { Object.assign(input, { companyId: "foreign", approvalId: "other", decidedByUserId: "other-user", decisionNote: "changed" }); } finally { f.release(); }
    await p; expect(f.patches[0]).toMatchObject({ decidedByUserId: "board", decisionNote: "deny" });
    expect(f.reads[0].params).toEqual(["approval-1", "company-1"]);
  });
  it("captures owned options before deferred transaction startup", async () => {
    const f = fixture(); let start!: () => void; const startup = new Promise<void>((resolve) => { start = resolve; });
    const root = { ...f.root, transaction: async (cb: any) => { await startup; return cb(f.tx); } } as Db;
    const options = { lifecycleFence: true, companyId: "company-1" };
    const p = approvalService(root).reject("approval-1", "board", "deny", options);
    options.companyId = "foreign"; options.lifecycleFence = false; start(); f.release(); await p;
    expect(f.reads[0].params).toEqual(["approval-1", "company-1"]);
  });
  for (const lifecycleFence of [undefined, false]) {
    it(`preserves ordinary non-owning ID-only predicates flag=${lifecycleFence}`, async () => {
      const f = fixture(); await approvalService(f.tx).reject("approval-1", "board", undefined, { lifecycleFence, companyId: "ignored" });
      expect(f.events).toEqual(["read", "write"]); expect(f.reads[0].params).toEqual(["approval-1"]);
      expect(f.writes[0].params).toEqual(["approval-1", "pending", "revision_requested"]);
    });
  }
});
