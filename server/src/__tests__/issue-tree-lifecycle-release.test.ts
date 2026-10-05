import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import * as tree from "../services/issue-tree-control.js";

// Actual releaseHold, synthetic rows and SQL-builder recording only. No DB,
// server, adapter, authorization or concurrency claim.
function fixture() {
  const events: string[] = [];
  const writes: any[] = [];
  const hold = { id: "hold-1", companyId: "company-1", rootIssueId: "root-1", status: "active",
    mode: "pause", releasePolicy: { strategy: "manual" } };
  function query(rows: any[]) {
    const q = { where: (predicate: SQL) => {
      expect(new PgDialect().sqlToQuery(predicate).params).toEqual(["hold-1", "company-1"]); return q;
    }, orderBy: () => q, returning: () => q,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const tx = {
    execute: vi.fn(async (statement: SQL) => {
      expect(new PgDialect().sqlToQuery(statement)).toMatchObject({
        sql: "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        params: ["paperclip:issue-lifecycle:company-1"],
      }); events.push("fence"); return [];
    }),
    transaction: vi.fn(() => { throw new Error("nested-transaction"); }),
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      if (name === "issue_tree_holds") return query([{ ...hold }]);
      if (name === "issue_tree_hold_members") return {
        where: (predicate: SQL) => {
          expect(new PgDialect().sqlToQuery(predicate).params).toEqual(["company-1", "hold-1"]);
          return { orderBy: async () => [] };
        },
      };
      throw new Error(`unknown-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (predicate: SQL) => {
      expect(getTableName(table)).toBe("issue_tree_holds");
      expect(new PgDialect().sqlToQuery(predicate).params).toEqual(["hold-1", "company-1"]);
      events.push("release"); writes.push(patch); return { returning: async () => [{ ...hold, ...patch }] };
    } }) }),
  };
  const input = { companyId: "company-1", rootIssueId: "root-1", holdId: "hold-1", reason: "Approved release",
    actor: { actorType: "user" as const, actorId: "user-1", userId: "user-1", agentId: null, runId: null } };
  const run = () => (tree as any).releaseIssueTreeHoldInTransaction(tx, input);
  return { tx, input, hold, writes, events, run };
}

describe("dark tree release participant (actual service recording, not SQL exclusion)", () => {
  it("captures routing, reason and actor before the suspended fence", async () => {
    const f = fixture();
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const barrier = new Promise<void>(r => { release = r; });
    const execute = f.tx.execute.getMockImplementation()!;
    f.tx.execute.mockImplementationOnce(async statement => { enter(); await barrier; return execute(statement); });
    const result = f.run();
    try {
      await Promise.race([entered, result.then(() => { throw new Error("settled-before-fence"); })]);
      f.input.companyId = "other-company"; f.input.rootIssueId = "other-root"; f.input.holdId = "other-hold";
      f.input.reason = "mutated"; f.input.actor.userId = "other-user"; f.input.actor.actorId = "other-user";
      (f.input as any).metadata = { injected: true }; (f.input as any).releasePolicy = { strategy: "automatic" };
      expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
    } finally { release(); }
    await expect(result).resolves.toMatchObject({ id: "hold-1", status: "released" });
    expect(f.writes[0]).toMatchObject({ releaseReason: "Approved release", releasedByUserId: "user-1",
      releasePolicy: { strategy: "manual" }, releaseMetadata: null });
  });
  it("contains actor and reason independently of routing", async () => {
    const f = fixture();
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }); const barrier = new Promise<void>(r => { release = r; });
    const execute = f.tx.execute.getMockImplementation()!;
    f.tx.execute.mockImplementationOnce(async statement => { enter(); await barrier; return execute(statement); });
    const result = f.run();
    try {
      await Promise.race([entered, result.then(() => { throw new Error("settled-before-fence"); })]);
      f.input.reason = "mutated"; Object.assign(f.input.actor, { actorType: "agent", actorId: "agent-2", userId: "user-2", agentId: "agent-2", runId: "run-2" });
    } finally { release(); }
    await result;
    expect(f.writes[0]).toMatchObject({ releaseReason: "Approved release", releasedByActorType: "user",
      releasedByUserId: "user-1", releasedByAgentId: null, releasedByRunId: null });
  });
  it("propagates fence rejection without a canonical read or write", async () => {
    const f = fixture(); f.tx.execute.mockRejectedValueOnce(new Error("fence-rejected"));
    await expect(f.run()).rejects.toThrow("fence-rejected");
    expect(f.events).toEqual([]); expect(f.writes).toEqual([]); expect(f.tx.transaction).not.toHaveBeenCalled();
  });
  it.each(["wrong-root", "released"])("preserves canonical %s veto without writes", async gate => {
    const f = fixture();
    if (gate === "wrong-root") f.hold.rootIssueId = "different-root";
    else f.hold.status = "released";
    await expect(f.run()).rejects.toThrow(gate === "wrong-root" ? "does not belong" : "already released");
    expect(f.events).toEqual(["fence", "read:issue_tree_holds"]); expect(f.writes).toEqual([]);
  });
  it("projects out unsupported policy/metadata fields rather than spreading caller input", async () => {
    const f = fixture(); (f.input as any).metadata = { injected: true }; (f.input as any).releasePolicy = { strategy: "automatic" };
    await f.run(); expect(f.writes[0]).toMatchObject({ releaseMetadata: null, releasePolicy: { strategy: "manual" } });
  });
  it("leaves the ordinary releaseHold entry and its explicit metadata contract unchanged", async () => {
    const f = fixture();
    await tree.issueTreeControlService(f.tx as any).releaseHold("company-1", "root-1", "hold-1", {
      actor: f.input.actor, metadata: { explicit: true }, reason: "ordinary",
    });
    expect(f.tx.execute).not.toHaveBeenCalled();
    expect(f.writes[0]).toMatchObject({ releaseMetadata: { explicit: true }, releaseReason: "ordinary" });
  });
  it("awaits the company lifecycle fence before any canonical release read", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({ id: "hold-1", status: "released" });
    expect(f.events).toEqual(["fence", "read:issue_tree_holds", "release", "read:issue_tree_hold_members"]);
    expect(f.writes).toHaveLength(1); expect(f.tx.transaction).not.toHaveBeenCalled();
  });
});
