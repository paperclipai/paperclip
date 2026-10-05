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

function ownedFixture() {
  const f = fixture();
  const root = {
    select: () => { throw new Error("root-read-before-transaction"); },
    update: () => { throw new Error("root-write-outside-transaction"); },
    transaction: vi.fn(async (callback: any) => {
      f.events.push("transaction");
      const result = await callback(f.tx);
      f.events.push("owner-return");
      return result;
    }),
  };
  const input = { reason: f.input.reason, actor: f.input.actor, lifecycleFence: true };
  const run = () => tree.issueTreeControlService(root as any).releaseHold(
    "company-1", "root-1", "hold-1", input as any,
  );
  return { ...f, root, ownedInput: input, run };
}

describe("dark owned canonical tree release (recording only, not DB commit)", () => {
  it("starts the owned transaction before every canonical release read", async () => {
    const f = ownedFixture();
    await expect(f.run()).resolves.toMatchObject({ id: "hold-1", status: "released" });
    expect(f.events).toEqual(["transaction", "fence", "read:issue_tree_holds", "release", "read:issue_tree_hold_members", "owner-return"]);
    expect(f.root.transaction).toHaveBeenCalledTimes(1);
    expect(f.tx.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { releasePolicy: { strategy: "manual" } },
    { releasePolicy: { strategy: "automatic" } },
    { metadata: {} },
    { metadata: { injected: true } },
  ])("rejects unsupported owned extras before any effects: %j", async extras => {
    const f = ownedFixture(); Object.assign(f.ownedInput, extras);
    await expect(f.run()).rejects.toMatchObject({ status: 422 });
    expect(f.root.transaction).not.toHaveBeenCalled();
    expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
  });
  it("captures reason and actor before deferred transaction startup", async () => {
    const f = ownedFixture();
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }); const barrier = new Promise<void>(r => { release = r; });
    const original = f.root.transaction.getMockImplementation()!;
    f.root.transaction.mockImplementationOnce(async callback => { enter(); await barrier; return original(callback); });
    const result = f.run();
    try {
      await Promise.race([entered, result.then(() => { throw new Error("settled-before-startup"); }, e => { throw e; })]);
      f.ownedInput.reason = "mutated";
      Object.assign(f.ownedInput.actor, { actorType: "agent", actorId: "agent-2", userId: "user-2", agentId: "agent-2", runId: "run-2" });
      f.ownedInput.actor = { actorType: "user", actorId: "user-3", userId: "user-3", agentId: null, runId: null };
      expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
    } finally { release(); }
    await result;
    expect(f.writes[0]).toMatchObject({ releaseReason: "Approved release", releasedByActorType: "user",
      releasedByUserId: "user-1", releasedByAgentId: null, releasedByRunId: null });
  });
  it("has no domain effects while the owned fence is pending", async () => {
    const f = ownedFixture(); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }); const barrier = new Promise<void>(r => { release = r; });
    const original = f.tx.execute.getMockImplementation()!;
    f.tx.execute.mockImplementationOnce(async statement => { enter(); await barrier; return original(statement); });
    const result = f.run();
    try {
      await Promise.race([entered, result.then(() => { throw new Error("settled-before-fence"); }, e => { throw e; })]);
      expect(f.events).toEqual(["transaction"]); expect(f.writes).toEqual([]);
    } finally { release(); }
    await result;
  });
  it.each(["startup", "fence", "owner-return"])("propagates %s rejection (not rollback evidence)", async stage => {
    const f = ownedFixture();
    if (stage === "startup") f.root.transaction.mockRejectedValueOnce(new Error(stage));
    if (stage === "fence") f.tx.execute.mockRejectedValueOnce(new Error(stage));
    if (stage === "owner-return") f.root.transaction.mockImplementationOnce(async callback => {
      await callback(f.tx); throw new Error(stage);
    });
    await expect(f.run()).rejects.toThrow(stage);
    expect(f.writes).toHaveLength(stage === "owner-return" ? 1 : 0);
  });
  it.each(["wrong-root", "released"])("preserves owned %s veto", async gate => {
    const f = ownedFixture();
    if (gate === "wrong-root") f.hold.rootIssueId = "other-root"; else f.hold.status = "released";
    await expect(f.run()).rejects.toThrow(gate === "wrong-root" ? "does not belong" : "already released");
    expect(f.events).toEqual(["transaction", "fence", "read:issue_tree_holds"]);
    expect(f.writes).toEqual([]);
  });
  it.each([undefined, false])("preserves ordinary explicit policy/metadata with opt-in %s", async lifecycleFence => {
    const f = fixture();
    await tree.issueTreeControlService(f.tx as any).releaseHold("company-1", "root-1", "hold-1", {
      actor: f.input.actor, reason: "ordinary", releasePolicy: { strategy: "automatic" } as any,
      metadata: { explicit: true }, lifecycleFence,
    });
    expect(f.tx.execute).not.toHaveBeenCalled(); expect(f.tx.transaction).not.toHaveBeenCalled();
    expect(f.writes[0]).toMatchObject({ releaseReason: "ordinary", releaseMetadata: { explicit: true },
      releasePolicy: { strategy: "automatic" } });
  });
  it("does not publish a successful callback result before the owning transaction returns", async () => {
    const f = ownedFixture(); let enter!: () => void; let release!: () => void; let settled = false;
    const entered = new Promise<void>(r => { enter = r; }); const barrier = new Promise<void>(r => { release = r; });
    const original = f.root.transaction.getMockImplementation()!;
    f.root.transaction.mockImplementationOnce(async callback => {
      const row = await original(callback); enter(); await barrier; return row;
    });
    const result = f.run().then(row => { settled = true; return row; });
    try {
      await Promise.race([entered, result.then(() => { throw new Error("settled-before-owner-return"); }, e => { throw e; })]);
      expect(f.writes).toHaveLength(1); expect(settled).toBe(false);
    } finally { release(); }
    await expect(result).resolves.toMatchObject({ status: "released" }); expect(settled).toBe(true);
  });
  it("accepts explicit null policy/metadata without changing the stored policy", async () => {
    const f = ownedFixture(); Object.assign(f.ownedInput, { releasePolicy: null, metadata: null });
    await f.run(); expect(f.writes[0]).toMatchObject({ releasePolicy: { strategy: "manual" }, releaseMetadata: null });
  });
});

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
