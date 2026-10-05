import { describe, expect, it } from "vitest";
import { approvals, issueApprovals, issues, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { issueApprovalService, linkIssueApprovalInTransaction } from "../services/issue-approvals.js";

function fixture(config: { issueCompany?: string; approvalCompany?: string; missing?: string } = {}) {
  const events: string[] = [];
  const predicates: Array<{ table: unknown; params: unknown[] }> = [];
  const inserts: unknown[] = [];
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
      events.push(table === issues ? "issue-read" : table === approvals ? "approval-read" : "link-read");
      predicates.push({ table, params: dialect.sqlToQuery(query).params });
      if (table === issues) return Promise.resolve(config.missing === "issue" ? [] : [{ id: "issue-1", companyId: config.issueCompany ?? "company-1" }]);
      if (table === approvals) return Promise.resolve(config.missing === "approval" ? [] : [{ id: "approval-1", companyId: config.approvalCompany ?? "company-1", status: "pending" }]);
      if (table === issueApprovals) return Promise.resolve(inserts);
      throw new Error("unknown-read");
    } }) }),
    insert: (table: unknown) => {
      expect(table).toBe(issueApprovals);
      return { values: (value: unknown) => ({ onConflictDoNothing: async () => { events.push("insert"); inserts.push(value); } }) };
    },
  };
  const root = {
    select: () => { throw new Error("root-read-before-transaction"); },
    transaction: async (callback: any) => { events.push("tx"); const result = await callback(tx); events.push("return"); return result; },
  };
  return { root: root as unknown as Db, tx: tx as unknown as Db, events, inserts, predicates, release, reject };
}

describe("dark canonical approval link participant (recording only)", () => {
  it("starts owned transaction and awaits company fence before actual link reads", async () => {
    const f = fixture();
    const actor = { agentId: "agent-1", userId: "user-1" };
    const options = { lifecycleFence: true, companyId: "company-1" };
    const pending = issueApprovalService(f.root).link("issue-1", "approval-1", actor, options);
    void pending.catch(() => {});
    try {
      await Promise.resolve();
      expect(f.events).toEqual(["tx", "fence"]);
      expect(f.inserts).toEqual([]);
      actor.agentId = "mutated"; options.companyId = "other-company";
    } finally { f.release(); }
    await expect(pending).resolves.toEqual({ companyId: "company-1", issueId: "issue-1", approvalId: "approval-1", linkedByAgentId: "agent-1", linkedByUserId: "user-1" });
    expect(f.events).toEqual(["tx", "fence", "issue-read", "approval-read", "insert", "link-read", "return"]);
    expect(f.predicates.map((p) => p.params)).toEqual([["issue-1", "company-1"], ["approval-1", "company-1"], ["issue-1", "approval-1", "company-1"]]);
  });

  const txType = (f: ReturnType<typeof fixture>) => f.tx as unknown as Parameters<typeof linkIssueApprovalInTransaction>[0];
  it("captures supplied routing and actor before fence suspension without owning a transaction", async () => {
    const f = fixture();
    const input = { companyId: "company-1", issueId: "issue-1", approvalId: "approval-1", actor: { userId: "user-1" } };
    const pending = linkIssueApprovalInTransaction(txType(f), input);
    try {
      expect(f.events).toEqual(["fence"]);
      input.issueId = "other-issue"; input.approvalId = "other-approval";
      input.companyId = "other-company"; input.actor.userId = "other-user";
    } finally { f.release(); }
    const result = await pending;
    expect(result).toMatchObject({ companyId: "company-1", issueId: "issue-1", approvalId: "approval-1", linkedByUserId: "user-1" });
    expect(f.events).toEqual(["fence", "issue-read", "approval-read", "insert", "link-read"]);
  });

  for (const owned of [true, false]) {
    it(`propagates fence rejection without domain effects owned=${owned}`, async () => {
      const f = fixture();
      const pending = owned
        ? issueApprovalService(f.root).link("issue-1", "approval-1", undefined, { lifecycleFence: true, companyId: "company-1" })
        : linkIssueApprovalInTransaction(txType(f), { companyId: "company-1", issueId: "issue-1", approvalId: "approval-1" });
      const assertion = expect(pending).rejects.toThrow("fence-denied");
      f.reject(new Error("fence-denied")); await assertion;
      expect(f.events).toEqual(owned ? ["tx", "fence"] : ["fence"]);
      expect(f.inserts).toEqual([]);
    });
    for (const config of [{ missing: "issue" }, { missing: "approval" }, { issueCompany: "foreign" }, { approvalCompany: "foreign" }, { issueCompany: "foreign", approvalCompany: "foreign" }]) {
      it(`vetoes missing/foreign gate before insertion ${JSON.stringify(config)} owned=${owned}`, async () => {
        const f = fixture(config); f.release();
        const pending = owned
          ? issueApprovalService(f.root).link("issue-1", "approval-1", undefined, { lifecycleFence: true, companyId: "company-1" })
          : linkIssueApprovalInTransaction(txType(f), { companyId: "company-1", issueId: "issue-1", approvalId: "approval-1" });
        await expect(pending).rejects.toThrow();
        expect(f.inserts).toEqual([]);
        expect(f.events).not.toContain("return");
      });
    }
  }
  for (const lifecycleFence of [undefined, false]) {
    it(`preserves ordinary non-owning link without a fence flag=${lifecycleFence}`, async () => {
      const f = fixture();
      await issueApprovalService(f.tx).link("issue-1", "approval-1", { userId: "user-1" }, { lifecycleFence });
      expect(f.events).toEqual(["issue-read", "approval-read", "insert", "link-read"]);
      expect(f.predicates.map((p) => p.params)).toEqual([["issue-1"], ["approval-1"], ["issue-1", "approval-1"]]);
    });
  }
  it("rejects missing company before transaction startup", async () => {
    const f = fixture();
    await expect(issueApprovalService(f.root).link("issue-1", "approval-1", undefined, { lifecycleFence: true })).rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]);
  });
  it("contains actor values before deferred owned transaction startup", async () => {
    const f = fixture();
    let start!: () => void;
    const barrier = new Promise<void>((resolve) => { start = resolve; });
    const root = { ...f.root, transaction: async (callback: any) => { await barrier; return callback(f.tx); } } as Db;
    const actor = { agentId: "agent-1", userId: "user-1" };
    const options = { lifecycleFence: true, companyId: "company-1" };
    const pending = issueApprovalService(root).link("issue-1", "approval-1", actor, options);
    actor.agentId = "other-agent"; actor.userId = "other-user"; options.companyId = "foreign";
    start(); f.release();
    expect(await pending).toMatchObject({ companyId: "company-1", linkedByAgentId: "agent-1", linkedByUserId: "user-1" });
  });
});
