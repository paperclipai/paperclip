import { describe, expect, it } from "vitest";
import { approvals, issueApprovals, issues, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { issueApprovalService, unlinkIssueApprovalInTransaction } from "../services/issue-approvals.js";

function fixture(config: { missing?: string; issueCompany?: string; approvalCompany?: string; deleteError?: boolean } = {}) {
  const events: string[] = [];
  const reads: Array<{ sql: string; params: unknown[] }> = [];
  const deletes: Array<{ sql: string; params: unknown[] }> = [];
  const dialect = new PgDialect();
  let release!: () => void;
  let reject!: (error: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const tx = {
    execute: async (query: any) => {
      events.push("fence");
      expect(dialect.sqlToQuery(query).params).toEqual(["paperclip:issue-lifecycle:company-1"]);
      await barrier;
    },
    select: () => ({ from: (table: unknown) => ({ where: (query: any) => {
      if (table !== issues && table !== approvals) throw new Error("unknown-read");
      events.push(table === issues ? "issue-read" : "approval-read");
      reads.push(dialect.sqlToQuery(query));
      if (table === issues) return Promise.resolve(config.missing === "issue" ? [] : [{ id: "issue-1", companyId: config.issueCompany ?? "company-1" }]);
      return Promise.resolve(config.missing === "approval" ? [] : [{ id: "approval-1", companyId: config.approvalCompany ?? "company-1", status: "pending" }]);
    } }) }),
    delete: (table: unknown) => {
      expect(table).toBe(issueApprovals);
      return { where: async (query: any) => {
        events.push("delete"); deletes.push(dialect.sqlToQuery(query));
        if (config.deleteError) throw new Error("delete-denied");
      } };
    },
  };
  const root = {
    select: () => { throw new Error("root-read-before-transaction"); },
    transaction: async (callback: any) => { events.push("tx"); const result = await callback(tx); events.push("return"); return result; },
  };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, reads, deletes, release, reject };
}

describe("dark canonical approval unlink (recording only)", () => {
  it("starts owned transaction and awaits fence before canonical unlink reads", async () => {
    const f = fixture();
    const pending = issueApprovalService(f.root).unlink("issue-1", "approval-1", { lifecycleFence: true, companyId: "company-1" });
    void pending.catch(() => {});
    try {
      await Promise.resolve();
      expect(f.events).toEqual(["tx", "fence"]);
      expect(f.deletes).toEqual([]);
    } finally { f.release(); }
    await expect(pending).resolves.toBeUndefined();
    expect(f.events).toEqual(["tx", "fence", "issue-read", "approval-read", "delete", "return"]);
    expect(f.reads.map((r) => r.params)).toEqual([["issue-1", "company-1"], ["approval-1", "company-1"]]);
    expect(f.deletes[0].params).toEqual(["issue-1", "approval-1", "company-1"]);
    expect(f.deletes[0].sql).toContain('"issue_approvals"."company_id"');
  });
  const supplied = (f: ReturnType<typeof fixture>) => f.tx as unknown as Parameters<typeof unlinkIssueApprovalInTransaction>[0];
  it("captures supplied routing before suspension without opening a transaction", async () => {
    const f = fixture();
    const input = { companyId: "company-1", issueId: "issue-1", approvalId: "approval-1" };
    const pending = unlinkIssueApprovalInTransaction(supplied(f), input);
    void pending.catch(() => {});
    try {
      expect(f.events).toEqual(["fence"]);
      input.companyId = "foreign"; input.issueId = "other-issue"; input.approvalId = "other-approval";
    } finally { f.release(); }
    await expect(pending).resolves.toBeUndefined();
    expect(f.events).toEqual(["fence", "issue-read", "approval-read", "delete"]);
    expect(f.deletes[0].params).toEqual(["issue-1", "approval-1", "company-1"]);
  });
  it("captures owned company before deferred transaction startup", async () => {
    const f = fixture();
    let start!: () => void;
    const barrier = new Promise<void>((resolve) => { start = resolve; });
    const root = { ...f.root, transaction: async (callback: any) => { await barrier; return callback(f.tx); } } as Db;
    const options = { lifecycleFence: true, companyId: "company-1" };
    const pending = issueApprovalService(root).unlink("issue-1", "approval-1", options);
    options.companyId = "foreign"; options.lifecycleFence = false;
    start(); f.release();
    await pending;
    expect(f.deletes[0].params).toEqual(["issue-1", "approval-1", "company-1"]);
  });
  for (const owned of [true, false]) {
    it(`propagates fence rejection without domain effects owned=${owned}`, async () => {
      const f = fixture();
      const pending = owned
        ? issueApprovalService(f.root).unlink("issue-1", "approval-1", { lifecycleFence: true, companyId: "company-1" })
        : unlinkIssueApprovalInTransaction(supplied(f), { companyId: "company-1", issueId: "issue-1", approvalId: "approval-1" });
      const assertion = expect(pending).rejects.toThrow("fence-denied");
      f.reject(new Error("fence-denied")); await assertion;
      expect(f.events).toEqual(owned ? ["tx", "fence"] : ["fence"]);
      expect(f.deletes).toEqual([]);
    });
    for (const config of [{ missing: "issue" }, { missing: "approval" }, { issueCompany: "foreign" }, { approvalCompany: "foreign" }, { issueCompany: "foreign", approvalCompany: "foreign" }]) {
      it(`vetoes missing/foreign gate before delete ${JSON.stringify(config)} owned=${owned}`, async () => {
        const f = fixture(config); f.release();
        const pending = owned
          ? issueApprovalService(f.root).unlink("issue-1", "approval-1", { lifecycleFence: true, companyId: "company-1" })
          : unlinkIssueApprovalInTransaction(supplied(f), { companyId: "company-1", issueId: "issue-1", approvalId: "approval-1" });
        await expect(pending).rejects.toThrow();
        expect(f.deletes).toEqual([]); expect(f.events).not.toContain("return");
      });
    }
    it(`propagates canonical delete rejection owned=${owned}`, async () => {
      const f = fixture({ deleteError: true }); f.release();
      const pending = owned
        ? issueApprovalService(f.root).unlink("issue-1", "approval-1", { lifecycleFence: true, companyId: "company-1" })
        : unlinkIssueApprovalInTransaction(supplied(f), { companyId: "company-1", issueId: "issue-1", approvalId: "approval-1" });
      await expect(pending).rejects.toThrow("delete-denied");
      expect(f.deletes).toHaveLength(1); expect(f.events).not.toContain("return");
    });
    it(`requires company before effects owned=${owned}`, async () => {
      const f = fixture();
      const pending = owned
        ? issueApprovalService(f.root).unlink("issue-1", "approval-1", { lifecycleFence: true })
        : unlinkIssueApprovalInTransaction(supplied(f), { companyId: "", issueId: "issue-1", approvalId: "approval-1" });
      await expect(pending).rejects.toMatchObject({ status: 422 });
      expect(f.events).toEqual([]);
    });
  }
  for (const lifecycleFence of [undefined, false]) {
    it(`preserves ordinary root default flag=${lifecycleFence}`, async () => {
      const f = fixture();
      await issueApprovalService(f.tx).unlink("issue-1", "approval-1", { lifecycleFence });
      expect(f.events).toEqual(["issue-read", "approval-read", "delete"]);
      expect(f.reads.map((r) => r.params)).toEqual([["issue-1"], ["approval-1"]]);
      expect(f.deletes[0].params).toEqual(["issue-1", "approval-1"]);
    });
  }
});
