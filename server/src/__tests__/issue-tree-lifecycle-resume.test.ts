import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { issueTreeControlService } from "../services/issue-tree-control.js";

// Actual canonical preview/persistence/releases; SQL is recorded, not executed.
function fixture() {
  const events: string[] = []; const writes: any[] = [];
  const root = { id: "root-1", companyId: "company-1", parentId: null, status: "todo",
    identifier: "T-1", title: "Root", assigneeAgentId: null, assigneeUserId: null, executionRunId: null };
  const holds = new Map<string, any>(["pause-1", "pause-2"].map(id => [id, { id,
    companyId: "company-1", rootIssueId: "root-1", mode: "pause", status: "active",
    releasePolicy: { strategy: "manual" } }]));
  const tx = {
    execute: vi.fn(async (s: SQL) => {
      expect(new PgDialect().sqlToQuery(s).params).toEqual(["paperclip:issue-lifecycle:company-1"]);
      events.push("fence"); return [];
    }),
    transaction: vi.fn(() => { throw new Error("nested-transaction"); }),
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      const q: any = { innerJoin: () => q, orderBy: () => q, where: (p: SQL) => {
        const { params, sql } = new PgDialect().sqlToQuery(p); expect(params).toContain("company-1");
        if (name === "issues") q.rows = params[0] === "root-1" ? [{ ...root }] : [];
        else if (name === "issue_tree_holds") q.rows = sql.includes('"issue_tree_holds"."id" =')
          ? (holds.has(params[0] as string) ? [{ ...holds.get(params[0] as string) }] : [])
          : [...holds.values()].filter(h => h.status === "active" && h.mode === "pause").map(h => ({ ...h }));
        else q.rows = [];
        return q;
      }, then: (r: any, j: any) => Promise.resolve(q.rows).then(r, j) };
      if (!["issues", "heartbeat_runs", "issue_tree_holds", "issue_tree_hold_members"].includes(name)) throw new Error(`unknown-read:${name}`);
      return q;
    } }),
    insert: (table: any) => ({ values: (value: any) => ({ returning: async () => {
      const name = getTableName(table); events.push(`insert:${name}`); writes.push({ name, value });
      if (name === "issue_tree_holds") { const row = { id: "resume-1", ...value }; holds.set(row.id, row); return [row]; }
      if (name === "issue_tree_hold_members") return value.map((v: any) => ({ id: "member-1", ...v }));
      throw new Error(`unknown-insert:${name}`);
    } }) }),
    update: (table: any) => ({ set: (value: any) => ({ where: (p: SQL) => ({ returning: async () => {
      expect(getTableName(table)).toBe("issue_tree_holds");
      const query = new PgDialect().sqlToQuery(p);
      expect(query.params[1]).toBe("company-1");
      expect(query.sql).toContain('"issue_tree_holds"."company_id" =');
      const id = query.params[0] as string; events.push(`release:${id}`); writes.push({ name: "release", id, value });
      const row = { ...holds.get(id), ...value }; holds.set(id, row); return [row];
    } }) }) }),
  };
  const rootDb = { ...tx, select: () => { throw new Error("root-read-before-transaction"); },
    insert: () => { throw new Error("root-write"); }, update: () => { throw new Error("root-update"); },
    transaction: vi.fn(async (cb: any) => { events.push("owned-transaction"); return cb(tx); }) };
  const input = { mode: "resume" as const, lifecycleFence: true, reason: "original",
    actor: { actorType: "user" as const, actorId: "user-1", userId: "user-1" } };
  const run = () => issueTreeControlService(rootDb as any).createHold("company-1", "root-1", input);
  return { tx, rootDb, input, holds, writes, events, run };
}

describe("dark owned multi-hold resume (not SQL atomicity)", () => {
  it("fences preview, persists resume and releases every pause within one supplied callback", async () => {
    const f = fixture(); const result = await f.run();
    expect(f.events.slice(0, 3)).toEqual(["owned-transaction", "fence", "read:issues"]);
    expect(f.rootDb.transaction).toHaveBeenCalledTimes(1); expect(f.tx.transaction).not.toHaveBeenCalled();
    expect(result.resumedPauseHoldIds).toEqual(["pause-1", "pause-2"]);
    expect(result.hold).toMatchObject({ id: "resume-1", mode: "resume", status: "released" });
    expect(f.events.filter(e => e.startsWith("release:"))).toEqual(["release:pause-1", "release:pause-2", "release:resume-1"]);
    expect(f.holds.get("pause-1")).toMatchObject({ status: "released", releaseReason: "original",
      releaseMetadata: { resumedByResumeHoldId: "resume-1", resumedPauseHoldId: "pause-1", resumeHoldMode: "tree_resume" } });
  });
  it("captures mode, reason and actor before deferred startup", async () => {
    const f = fixture(); let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    f.rootDb.transaction.mockImplementationOnce(async cb => { await barrier; return cb(f.tx); });
    const pending = f.run();
    try {
      Object.assign(f.input, { mode: "cancel", lifecycleFence: false, reason: "mutated", releasePolicy: { strategy: "automatic" } });
      Object.assign(f.input.actor, { actorType: "agent", actorId: "other", userId: "other", agentId: "other", runId: "other" });
      expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
    } finally { release(); }
    const result = await pending;
    expect(result.hold).toMatchObject({ mode: "resume", reason: "original", releasedByActorType: "user",
      releasedByUserId: "user-1", releasedByAgentId: null, releasedByRunId: null });
  });
  it("awaits the fence before resume reads and propagates rejection", async () => {
    const f = fixture(); let enter!: () => void; let reject!: (e: Error) => void;
    const entered = new Promise<void>(r => { enter = r; }); const barrier = new Promise<never>((_, r) => { reject = r; });
    f.tx.execute.mockImplementationOnce(async () => { enter(); return barrier; });
    const settled = f.run().then(() => { throw new Error("unexpected-success"); }, e => e);
    try {
      await Promise.race([entered, settled.then(() => { throw new Error("settled-before-fence"); })]);
      expect(f.events).toEqual(["owned-transaction"]); expect(f.writes).toEqual([]);
    } finally { reject(new Error("fence-denied")); }
    expect((await settled).message).toBe("fence-denied"); expect(f.writes).toEqual([]);
  });
  it("handles an empty pause set without fabricating a release", async () => {
    const f = fixture(); f.holds.clear(); const result = await f.run();
    expect(result.resumedPauseHoldIds).toEqual([]);
    expect(f.events.filter(e => e.startsWith("release:"))).toEqual(["release:resume-1"]);
    expect(result.hold.releaseMetadata).toEqual({ resumedPauseHoldIds: [], resumeMode: "subtree" });
  });
  it("rejects explicit resume policy before transaction and effects", async () => {
    const f = fixture(); Object.assign(f.input, { releasePolicy: { strategy: "manual" } });
    await expect(f.run()).rejects.toMatchObject({ status: 422 });
    expect(f.rootDb.transaction).not.toHaveBeenCalled(); expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
  });
  it("propagates a later release error without returning (not mock rollback)", async () => {
    const f = fixture(); const update = f.tx.update;
    f.tx.update = table => ({ set: value => ({ where: p => {
      if (new PgDialect().sqlToQuery(p).params[0] === "pause-2") return { returning: async () => { throw new Error("release-denied"); } };
      return update(table).set(value).where(p);
    } }) });
    await expect(f.run()).rejects.toThrow("release-denied");
    expect(f.holds.get("pause-1").status).toBe("released"); // eager recorder cannot rollback
    expect(f.holds.get("resume-1").status).toBe("active");
  });
  it.each([undefined, false])("retains ordinary resume without fencing (opt-in=%s)", async lifecycleFence => {
    const f = fixture(); const db = { ...f.tx, transaction: vi.fn(async (cb: any) => cb(f.tx)) };
    const result = await issueTreeControlService(db as any).createHold("company-1", "root-1", { ...f.input, lifecycleFence });
    expect(f.tx.execute).not.toHaveBeenCalled(); expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result.resumedPauseHoldIds).toEqual(["pause-1", "pause-2"]);
    expect(result.hold.status).toBe("released");
  });
});
