import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import * as tree from "../services/issue-tree-control.js";

// Actual preview and persistence; synthetic projections, no executed SQL.
function fixture() {
  const events: string[] = []; const writes: any[] = [];
  const root = { id: "root-1", companyId: "company-1", parentId: null, status: "todo",
    identifier: "T-1", title: "Root", assigneeAgentId: null, assigneeUserId: null, executionRunId: null };
  const tx = {
    execute: vi.fn(async (s: SQL) => {
      expect(new PgDialect().sqlToQuery(s).params).toEqual(["paperclip:issue-lifecycle:company-1"]);
      events.push("fence"); return [];
    }),
    transaction: vi.fn(() => { throw new Error("nested-transaction"); }),
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      const q: any = { innerJoin: () => q, orderBy: () => q, where: (p: SQL) => {
        const params = new PgDialect().sqlToQuery(p).params;
        expect(params).toContain("company-1");
        const sql = new PgDialect().sqlToQuery(p).sql;
        q.rows = name === "issues" && params[0] === "root-1" && !sql.includes("conversation_agent_id")
          ? [{ ...root }] : [];
        return q;
      }, then: (resolve: any, reject: any) => Promise.resolve(q.rows).then(resolve, reject) };
      if (!["issues", "heartbeat_runs", "issue_tree_hold_members", "issue_tree_holds"].includes(name)) throw new Error(`unknown-read:${name}`);
      return q;
    } }),
    insert: (table: any) => ({ values: (value: any) => ({ returning: async () => {
      const name = getTableName(table); events.push(`insert:${name}`); writes.push({ name, value });
      if (name === "issue_tree_holds") return [{ id: "hold-1", ...value }];
      if (name === "issue_tree_hold_members") return value.map((v: any) => ({ id: "member-1", ...v }));
      throw new Error(`unknown-write:${name}`);
    } }) }),
  };
  const input = { companyId: "company-1", rootIssueId: "root-1", reason: "Pause requested",
    actor: { actorType: "user" as const, actorId: "user-1", userId: "user-1", agentId: null, runId: null } };
  const run = () => (tree as any).createIssueTreePauseHoldInTransaction(tx, input);
  return { tx, input, root, events, writes, run };
}
describe("dark supplied-tx pause participant (not SQL serialization)", () => {
  it("fences actual preview before storing hold and members on the supplied tx", async () => {
    const f = fixture(); const result = await f.run();
    expect(f.events[0]).toBe("fence");
    expect(f.events.slice(-2)).toEqual(["insert:issue_tree_holds", "insert:issue_tree_hold_members"]);
    expect(f.tx.transaction).not.toHaveBeenCalled();
    expect(result.hold.members).toHaveLength(1);
    expect(result.hold).toMatchObject({ id: "hold-1", mode: "pause", status: "active",
      companyId: "company-1", rootIssueId: "root-1", releasePolicy: { strategy: "manual" } });
    expect(f.writes[1].value).toEqual([expect.objectContaining({ companyId: "company-1", holdId: "hold-1",
      issueId: "root-1", parentIssueId: null, depth: 0, skipped: false, issueStatus: "todo" })]);
  });
  it("contains routing, reason and actor while the fence is suspended", async () => {
    const f = fixture(); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }); const barrier = new Promise<void>(r => { release = r; });
    const execute = f.tx.execute.getMockImplementation()!;
    f.tx.execute.mockImplementationOnce(async s => { enter(); await barrier; return execute(s); });
    const result = f.run();
    try {
      await Promise.race([entered, result.then(() => { throw new Error("settled-before-fence"); })]);
      f.input.companyId = "other-company"; f.input.rootIssueId = "other-root"; f.input.reason = "changed";
      Object.assign(f.input.actor, { actorType: "agent", actorId: "other", userId: "other", agentId: "other", runId: "other" });
      expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
    } finally { release(); }
    await result;
    expect(f.writes[0].value).toMatchObject({ companyId: "company-1", rootIssueId: "root-1",
      reason: "Pause requested", createdByActorType: "user", createdByUserId: "user-1",
      createdByAgentId: null, createdByRunId: null });
  });
  it("fails closed before preview if fence acquisition rejects", async () => {
    const f = fixture(); f.tx.execute.mockRejectedValueOnce(new Error("fence-rejected"));
    await expect(f.run()).rejects.toThrow("fence-rejected"); expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
  });
  it("keeps terminal members as skipped snapshots rather than changing issues", async () => {
    const f = fixture(); f.root.status = "done"; const result = await f.run();
    expect(result.hold.members[0]).toMatchObject({ issueStatus: "done", skipped: true, skipReason: "terminal_status" });
    expect(f.writes.map(w => w.name)).toEqual(["issue_tree_holds", "issue_tree_hold_members"]);
  });
  it("projects runtime mode/policy/metadata extras out of the narrow pause contract", async () => {
    const f = fixture(); Object.assign(f.input, { mode: "cancel", releasePolicy: { strategy: "automatic" }, metadata: { unsafe: true } });
    await f.run(); expect(f.writes[0].value).toMatchObject({ mode: "pause", releasePolicy: { strategy: "manual" } });
    expect(f.writes[0].value).not.toHaveProperty("metadata");
  });
  it("propagates member insertion rejection to the outer owner (not mock rollback)", async () => {
    const f = fixture(); const insert = f.tx.insert;
    f.tx.insert = table => getTableName(table) === "issue_tree_hold_members"
      ? { values: () => ({ returning: async () => { throw new Error("member-rejected"); } }) } : insert(table);
    await expect(f.run()).rejects.toThrow("member-rejected");
    expect(f.writes.map(w => w.name)).toEqual(["issue_tree_holds"]); // eager recording is NOT rolled back
  });
  it.each(["pause", "cancel", "restore"] as const)("leaves ordinary %s preparation and owned transaction behavior unchanged", async mode => {
    const f = fixture(); const rootDb = { ...f.tx, transaction: vi.fn(async (cb: any) => {
      f.events.push("owned-transaction"); return cb(f.tx);
    }) };
    await tree.issueTreeControlService(rootDb as any).createHold("company-1", "root-1", {
      mode, actor: f.input.actor, reason: "ordinary", releasePolicy: { strategy: "manual" },
    });
    expect(f.tx.execute).not.toHaveBeenCalled(); expect(rootDb.transaction).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf("owned-transaction")).toBeGreaterThan(f.events.indexOf("read:issues"));
    expect(f.writes[0].value).toMatchObject({ reason: "ordinary", mode });
  });
});
