import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { restoreDependencyReadyIssueInTransaction } from "../services/issue-dependency-restoration.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";

vi.mock("../services/instance-settings.ts", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: false }) }),
}));
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));

// No SQL, DB, server or adapter. Distinct root/tx identities expose accidental
// transaction ownership; actual readiness/update run over synthetic projected
// rows. Predicates identify issue targets, but SQL/join semantics are not tested.
function fixture() {
  let row: Record<string, any> = { id: "dependent-1", companyId: "company-1", status: "blocked",
    title: "Dependency work", parentId: null, projectId: null, goalId: null,
    assigneeAgentId: "agent-1", assigneeUserId: null, statusVersion: 2, originKind: "manual",
    blockedTransitionAt: new Date("2026-10-05T00:00:00Z"), blockedOwnerNotifiedAt: new Date(),
    executionRunId: null, checkoutRunId: null, conversationAgentId: null,
    unblockDescriptor: null, executionState: null, executionPolicy: null };
  const before = structuredClone(row);
  const blockers = ["blocker-1", "blocker-2"].map((id) => ({ id, companyId: "company-1", status: "done" }));
  const ancestors: Record<string, any>[] = [];
  const pauseHolds: Record<string, any>[] = [];
  const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
  const events: string[] = [];
  const root = { transaction: vi.fn(() => { throw new Error("root-transaction-not-owned"); }),
    select: () => { throw new Error("root-read-outside-transaction"); } };
  function query(rows: unknown[], resolveTarget?: (predicate: SQL) => unknown[]) {
    const q = { where: (predicate: SQL) => { if (resolveTarget) rows = resolveTarget(predicate); return q; }, innerJoin: () => q, leftJoin: () => q,
      limit: () => q, orderBy: () => q, returning: () => q,
      for: (lock: string) => { events.push(`lock:${lock}`); return q; },
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const emptyReads = new Set(["issue_thread_interactions", "issue_approvals", "agent_wakeup_requests",
    "issue_relations", "issue_labels", "labels", "issue_watchdogs", "goals", "projects"]);
  const tx = {
    transaction: vi.fn(() => { throw new Error("nested-transaction-not-owned"); }),
    select: (projection: Record<string, unknown> = {}) => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      if (name === "issues") return query([], (predicate) => {
        const params = new PgDialect().sqlToQuery(predicate).params;
        if (params.includes(row.id)) return [{ ...row }];
        const blocker = blockers.find((b) => params.includes(b.id));
        if (blocker) return [{ ...blocker }];
        const ancestor = ancestors.find((a) => params.includes(a.id));
        if (ancestor) return [{ ...ancestor }];
        throw new Error("Unmodeled canonical issue read target");
      });
      // Synthetic projection only: the recorder does not execute SQL filters.
      if (name === "issue_tree_holds") return query(pauseHolds);
      if (name === "issue_relations" && "assigneeAgentId" in projection) return query([{ ...row }]);
      if (name === "issue_relations" && "blockerStatus" in projection) return query(blockers.map((b) => ({
        issueId: row.id, blockerIssueId: b.id, blockerStatus: b.status, blockerExecutionWorkspaceId: null,
      })));
      if (emptyReads.has(name)) return query([]);
      throw new Error(`Unmodeled canonical read: ${name}`);
    } }),
    update: (table: any) => ({ set: (values: Record<string, unknown>) => ({ where: (predicate: SQL) => {
      const name = getTableName(table);
      expect(name).toBe("issues");
      const params = new PgDialect().sqlToQuery(predicate).params;
      expect(params).toContain("dependent-1"); expect(params).toContain("company-1");
      row = { ...row, ...values }; writes.push({ table: name, values: structuredClone(values) });
      events.push("canonical-write"); return query([{ ...row }]);
    } }) }),
    insert: (table: any) => ({ values: (values: Record<string, unknown>) => {
      const name = getTableName(table); expect(name).toBe("agent_wakeup_requests");
      events.push("intent"); writes.push({ table: name, values: structuredClone(values) });
      return query([{ id: "intent-1" }]);
    } }),
  };
  const postCommit = { db: root, activityPublications: [], actions: [] };
  return { tx, root, before, blockers, ancestors, pauseHolds, writes, events, postCommit,
    setParent: (parentId: string | null) => { row = { ...row, parentId }; },
    getRow: () => structuredClone(row),
    run: () => restoreDependencyReadyIssueInTransaction(tx as any, {
      companyId: "company-1", dependentIssueId: "dependent-1", resolvedBlockerIssueId: "blocker-1",
    }, postCommit as any) };
}

describe("dark coordinator with actual canonical update (mock recording, not atomicity)", () => {
  it.each(["dependent-1", "parent-1", "grandparent-1"])("actual tree gate vetoes active pause at %s before writes", async (rootIssueId) => {
    const f = fixture(); f.setParent("parent-1");
    f.ancestors.push({ id: "parent-1", parentId: "grandparent-1" }, { id: "grandparent-1", parentId: null });
    f.pauseHolds.push({ id: "pause-1", rootIssueId, reason: "human pause", releasePolicy: { strategy: "manual" } });
    const before = f.getRow(); const holdsBefore = structuredClone(f.pauseHolds);
    expect(await f.run()).toBeNull();
    expect(f.getRow()).toEqual(before); expect(f.writes).toEqual([]);
    expect(f.pauseHolds).toEqual(holdsBefore);
    expect(f.events).toContain("read:issue_tree_holds");
    expect(f.root.transaction).not.toHaveBeenCalled(); expect(f.tx.transaction).not.toHaveBeenCalled();
  });
  it("does not confuse an unrelated active pause with a dependent ancestor", async () => {
    const f = fixture(); f.setParent("parent-1");
    f.ancestors.push({ id: "parent-1", parentId: null });
    f.pauseHolds.push({ id: "unrelated-pause", rootIssueId: "other-tree", reason: "pause", releasePolicy: null });
    expect(await f.run()).toBe("intent-1");
    expect(f.events).toContain("read:issue_tree_holds");
    expect(f.getRow().status).toBe("todo");
  });
  it.each(["in_progress", "blocked", "cancelled"])("actual readiness vetoes unresolved second blocker %s before canonical writes", async (status) => {
    const f = fixture(); f.blockers[1].status = status;
    expect(await f.run()).toBeNull();
    expect(f.getRow()).toEqual(f.before); expect(f.writes).toEqual([]);
    expect(f.events).toContain("read:issue_relations");
    expect(f.root.transaction).not.toHaveBeenCalled(); expect(f.tx.transaction).not.toHaveBeenCalled();
  });
  it("does not return a commit snapshot when durable insert rejects after canonical cleanup", async () => {
    const f = fixture();
    f.tx.insert = () => ({ values: () => { throw new Error("intent-insert-rejected"); } }) as any;
    let committed: unknown = null;
    await expect((async () => {
      await f.run();
      committed = f.getRow();
    })()).rejects.toThrow("intent-insert-rejected");
    expect(committed).toBeNull();
    expect(f.getRow().status).toBe("todo"); // recorder does NOT model rollback
    expect(f.writes).toHaveLength(1);
    expect(f.tx.transaction).not.toHaveBeenCalled();
  });

  it("leaves transaction ownership with the caller and records canonical cleanup before the intent", async () => {
    const f = fixture();
    expect(await f.run()).toBe("intent-1");
    expect(f.tx.transaction).not.toHaveBeenCalled(); expect(f.root.transaction).not.toHaveBeenCalled();
    expect(f.before.status).toBe("blocked");
    expect(f.getRow()).toMatchObject({ status: "todo", blockedTransitionAt: null,
      blockedOwnerNotifiedAt: null, unblockDescriptor: null, checkoutRunId: null, executionRunId: null });
    expect(f.events.indexOf("canonical-write")).toBeLessThan(f.events.indexOf("intent"));
    expect(f.writes).toContainEqual({ table: "agent_wakeup_requests", values: expect.objectContaining({
      companyId: "company-1", agentId: "agent-1", source: "automation", status: "queued",
      reason: "issue_blockers_resolved", idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: "dependent-1", blockerIssueIds: ["blocker-1", "blocker-2"],
        blockedTransitionAt: f.before.blockedTransitionAt }),
      payload: { issueId: "dependent-1", taskId: "dependent-1", resolvedBlockerIssueId: "blocker-1",
        blockerIssueIds: ["blocker-1", "blocker-2"] },
    }) });
  });
});
