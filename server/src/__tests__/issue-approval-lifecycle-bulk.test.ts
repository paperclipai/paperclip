import { describe, expect, it } from "vitest";
import { approvals, issueApprovals, issues, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import * as service from "../services/issue-approvals.js";

function fixture(config: { missingApproval?: boolean; approvalCompany?: string; rows?: Array<{ id: string; companyId: string }>; insertError?: boolean } = {}) {
  const events: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const inserts: any[] = [];
  let release!: () => void;
  let reject!: (error: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const dialect = new PgDialect();
  const tx = {
    execute: async (query: any) => {
      events.push("fence");
      expect(dialect.sqlToQuery(query).params).toEqual(["paperclip:issue-lifecycle:company-1"]);
      await barrier;
    },
    select: () => ({ from: (table: unknown) => ({ where: (query: any) => {
      queries.push(dialect.sqlToQuery(query));
      if (table === approvals) { events.push("approval-read"); return Promise.resolve(config.missingApproval ? [] : [{ id: "approval-1", companyId: config.approvalCompany ?? "company-1", status: "pending" }]); }
      if (table === issues) { events.push("issues-read"); return Promise.resolve(config.rows ?? [{ id: "issue-2", companyId: "company-1" }, { id: "issue-1", companyId: "company-1" }]); }
      throw new Error("unknown-read");
    } }) }),
    insert: (table: unknown) => {
      expect(table).toBe(issueApprovals);
      return { values: (values: any[]) => ({ onConflictDoNothing: async () => {
        events.push("insert"); if (config.insertError) throw new Error("insert-denied"); inserts.push(...values);
      } }) };
    },
  };
  const root = { select: () => { throw new Error("root-read-before-transaction"); }, transaction: async (callback: any) => {
    events.push("tx"); const result = await callback(tx); events.push("return"); return result;
  } };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, queries, inserts, release, reject };
}

const ownedCall = (f: ReturnType<typeof fixture>, ids = ["issue-1", "issue-2", "issue-1"], actor = { userId: "user-1" }) =>
  (service.issueApprovalService(f.root).linkManyForApproval as any)("approval-1", ids, actor, { lifecycleFence: true, companyId: "company-1" });

describe("dark canonical bulk approval link (recording only)", () => {
  it("starts owned transaction before reads and awaits fence before canonical bulk insert", async () => {
    const f = fixture();
    const ids = ["issue-1", "issue-2", "issue-1"];
    const actor = { userId: "user-1" };
    const pending = ownedCall(f, ids, actor); void pending.catch(() => {});
    try {
      await Promise.resolve();
      expect(f.events).toEqual(["tx", "fence"]);
      expect(f.inserts).toEqual([]);
      ids.splice(0, ids.length, "other-issue"); actor.userId = "other-user";
    } finally { f.release(); }
    await expect(pending).resolves.toBeUndefined();
    expect(f.events).toEqual(["tx", "fence", "approval-read", "issues-read", "insert", "return"]);
    expect(f.inserts).toEqual(["issue-1", "issue-2"].map((issueId) => ({ companyId: "company-1", issueId, approvalId: "approval-1", linkedByUserId: "user-1", linkedByAgentId: null })));
    expect(f.queries.map((q) => q.params)).toEqual([["approval-1", "company-1"], ["issue-1", "issue-2", "company-1"]]);
    expect(f.queries.every((q) => q.sql.includes('"company_id"'))).toBe(true);
  });

  const suppliedCall = (f: ReturnType<typeof fixture>, input = { companyId: "company-1", approvalId: "approval-1", issueIds: ["issue-1", "issue-2", "issue-1"], actor: { userId: "user-1" } }) =>
    service.linkManyIssuesApprovalInTransaction(f.tx as unknown as Parameters<typeof service.linkManyIssuesApprovalInTransaction>[0], input);
  it("captures supplied bulk array, routing and actor before suspension", async () => {
    const f = fixture();
    const input = { companyId: "company-1", approvalId: "approval-1", issueIds: ["issue-1", "issue-2", "issue-1"], actor: { userId: "user-1" } };
    const pending = suppliedCall(f, input); void pending.catch(() => {});
    try {
      expect(f.events).toEqual(["fence"]);
      input.companyId = "foreign"; input.approvalId = "other-approval";
      input.issueIds.splice(0, 3, "other-issue"); input.actor.userId = "other-user";
    } finally { f.release(); }
    await pending;
    expect(f.inserts.map((row) => [row.companyId, row.approvalId, row.issueId, row.linkedByUserId])).toEqual([
      ["company-1", "approval-1", "issue-1", "user-1"], ["company-1", "approval-1", "issue-2", "user-1"],
    ]);
    expect(f.events).not.toContain("tx");
  });
  it("captures owned values before deferred transaction startup", async () => {
    const f = fixture(); let start!: () => void;
    const startup = new Promise<void>((resolve) => { start = resolve; });
    const root = { ...f.root, transaction: async (callback: any) => { await startup; return callback(f.tx); } } as Db;
    const ids = ["issue-1", "issue-2"]; const actor = { userId: "user-1" };
    const options = { lifecycleFence: true, companyId: "company-1" };
    const pending = service.issueApprovalService(root).linkManyForApproval("approval-1", ids, actor, options);
    ids.splice(0, 2, "other-issue"); actor.userId = "other-user"; options.companyId = "foreign";
    start(); f.release(); await pending;
    expect(f.inserts.map((row) => [row.issueId, row.linkedByUserId, row.companyId])).toEqual([
      ["issue-1", "user-1", "company-1"], ["issue-2", "user-1", "company-1"],
    ]);
  });
  for (const owned of [true, false]) {
    it(`fails closed on fence rejection owned=${owned}`, async () => {
      const f = fixture(); const pending = owned ? ownedCall(f) : suppliedCall(f);
      const assertion = expect(pending).rejects.toThrow("fence-denied");
      f.reject(new Error("fence-denied")); await assertion;
      expect(f.events).toEqual(owned ? ["tx", "fence"] : ["fence"]);
      expect(f.queries).toEqual([]); expect(f.inserts).toEqual([]);
    });
    for (const config of [
      { missingApproval: true }, { approvalCompany: "foreign" }, { rows: [] },
      { rows: [{ id: "issue-1", companyId: "company-1" }] },
      { rows: [{ id: "issue-1", companyId: "company-1" }, { id: "issue-2", companyId: "foreign" }] },
    ]) {
      it(`rejects missing/foreign bulk endpoints before insert ${JSON.stringify(config)} owned=${owned}`, async () => {
        const f = fixture(config); f.release();
        await expect(owned ? ownedCall(f) : suppliedCall(f)).rejects.toThrow();
        expect(f.inserts).toEqual([]); expect(f.events).not.toContain("insert"); expect(f.events).not.toContain("return");
      });
    }
    it(`propagates insert rejection rather than returning success owned=${owned}`, async () => {
      const f = fixture({ insertError: true }); f.release();
      await expect(owned ? ownedCall(f) : suppliedCall(f)).rejects.toThrow("insert-denied");
      expect(f.events).toContain("insert"); expect(f.events).not.toContain("return");
    });
    it(`validates company even on empty dark input owned=${owned}`, async () => {
      const f = fixture();
      const pending = owned
        ? service.issueApprovalService(f.root).linkManyForApproval("approval-1", [], undefined, { lifecycleFence: true })
        : service.linkManyIssuesApprovalInTransaction(f.tx as any, { companyId: "", approvalId: "approval-1", issueIds: [] });
      await expect(pending).rejects.toMatchObject({ status: 422 }); expect(f.events).toEqual([]);
    });
    it(`empty valid dark batch fences but performs no domain reads/writes owned=${owned}`, async () => {
      const f = fixture(); f.release();
      await (owned ? ownedCall(f, []) : suppliedCall(f, { companyId: "company-1", approvalId: "approval-1", issueIds: [], actor: { userId: "user-1" } }));
      expect(f.events).toEqual(owned ? ["tx", "fence", "return"] : ["fence"]);
      expect(f.queries).toEqual([]); expect(f.inserts).toEqual([]);
    });
  }
  for (const lifecycleFence of [undefined, false]) {
    it(`preserves ordinary bulk defaults and dedup flag=${lifecycleFence}`, async () => {
      const f = fixture();
      await service.issueApprovalService(f.tx).linkManyForApproval("approval-1", ["issue-1", "issue-2", "issue-1"], { userId: "user-1" }, { lifecycleFence });
      expect(f.events).toEqual(["approval-read", "issues-read", "insert"]);
      expect(f.queries.map((q) => q.params)).toEqual([["approval-1"], ["issue-1", "issue-2"]]);
      expect(f.inserts.map((row) => row.issueId)).toEqual(["issue-1", "issue-2"]);
    });
    it(`ordinary empty batch has no effects flag=${lifecycleFence}`, async () => {
      const f = fixture();
      await service.issueApprovalService(f.root).linkManyForApproval("approval-1", [], undefined, { lifecycleFence });
      expect(f.events).toEqual([]);
    });
  }
});
