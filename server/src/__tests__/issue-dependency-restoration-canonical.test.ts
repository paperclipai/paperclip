import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { restoreDependencyReadyIssueInTransaction, updateIssueWithDependencyRestorationInTransaction } from "../services/issue-dependency-restoration.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { issueService } from "../services/issues.js";

vi.mock("../services/instance-settings.ts", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: false }) }),
}));
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/status-card-finalization.js", () => ({ finalizeStatusCardsForStalledGeneration: async () => undefined }));
vi.mock("../services/summary-slot-finalization.js", () => ({ finalizeSummarySlotsForTerminalIssue: async () => undefined }));
vi.mock("../services/issue-thread-interactions.js", () => ({ issueThreadInteractionService: () => ({ expirePendingInteractionsForTerminalIssue: async () => [] }) }));

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
  const blockers = ["blocker-1", "blocker-2"].map((id) => ({ ...row, id, status: "done", blockedTransitionAt: null, executionWorkspaceId: null }));
  const ancestors: Record<string, any>[] = [];
  const missingIssueIds = new Set<string>();
  const pauseHolds: Record<string, any>[] = [];
  const interactions: Record<string, any>[] = [];
  const approvals: Record<string, any>[] = [];
  const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
  const events: string[] = [];
  const root = { transaction: vi.fn<(callback: any) => Promise<any>>(() => { throw new Error("root-transaction-not-owned"); }),
    select: () => { throw new Error("root-read-outside-transaction"); } };
  function query(rows: unknown[], resolveTarget?: (predicate: SQL) => unknown[]) {
    const q = { where: (predicate: SQL) => { if (resolveTarget) rows = resolveTarget(predicate); return q; }, innerJoin: () => q, leftJoin: () => q,
      limit: () => q, orderBy: () => q, returning: () => q,
      for: (lock: string) => { events.push(`lock:${lock}`); return q; },
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const emptyReads = new Set(["issue_thread_interactions", "issue_approvals", "agent_wakeup_requests",
    "issue_relations", "issue_labels", "labels", "issue_watchdogs", "goals", "projects", "execution_workspaces", "workspace_operations", "chat_task_handoffs"]);
  const tx = {
    execute: vi.fn(async (statement: SQL) => {
      const built = new PgDialect().sqlToQuery(statement);
      expect(built.sql).toBe("select pg_advisory_xact_lock(hashtextextended($1, 0))");
      expect(built.params).toEqual(["paperclip:issue-lifecycle:company-1"]);
      events.push("lifecycle-fence");
      return [];
    }),
    transaction: vi.fn(() => { throw new Error("nested-transaction-not-owned"); }),
    select: (projection: Record<string, unknown> = {}) => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      if (name === "issues") return query([], (predicate) => {
        const params = new PgDialect().sqlToQuery(predicate).params;
        if (params.includes(row.id)) return [{ ...row }];
        const blocker = blockers.find((b) => params.includes(b.id));
        if (blocker) return [{ ...blocker }];
        const ancestor = ancestors.find((a) => params.includes(a.id));
        if (ancestor) return [{ companyId: "company-1", ...ancestor }];
        if (params.some((p) => missingIssueIds.has(String(p)))) return [];
        throw new Error("Unmodeled canonical issue read target");
      });
      // Synthetic projection only: the recorder does not execute SQL filters.
      if (name === "issue_tree_holds") return query(pauseHolds);
      if (name === "issue_thread_interactions") return query(interactions);
      if (name === "issue_approvals") return query(approvals);
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
      expect(params).toContain("company-1");
      const blockerIndex = blockers.findIndex(b => params.includes(b.id));
      if (params.includes(row.id)) row = { ...row, ...values };
      else if (blockerIndex >= 0) blockers[blockerIndex] = { ...blockers[blockerIndex], ...values };
      else throw new Error("Unmodeled canonical issue write target");
      writes.push({ table: name, values: { ...structuredClone(values), id: blockerIndex >= 0 ? blockers[blockerIndex].id : row.id } });
      events.push("canonical-write"); return query([{ ...(blockerIndex >= 0 ? blockers[blockerIndex] : row) }]);
    } }) }),
    insert: (table: any) => ({ values: (values: Record<string, unknown>) => {
      const name = getTableName(table); expect(name).toBe("agent_wakeup_requests");
      events.push("intent"); writes.push({ table: name, values: structuredClone(values) });
      return query([{ id: "intent-1" }]);
    } }),
  };
  const postCommit = { db: root, activityPublications: [], actions: [] };
  return { tx, root, before, blockers, ancestors, missingIssueIds, pauseHolds, interactions, approvals, writes, events, postCommit,
    assess: () => issueTreeControlService(tx as any).getPauseHoldAssessment("company-1", "dependent-1"),
    setParent: (parentId: string | null) => { row = { ...row, parentId }; },
    getRow: () => structuredClone(row),
    run: () => restoreDependencyReadyIssueInTransaction(tx as any, {
      companyId: "company-1", dependentIssueId: "dependent-1", resolvedBlockerIssueId: "blocker-1",
    }, postCommit as any) };
}

describe("dark common blocker writer (actual canonical recording, not DB atomicity)", () => {
  it.each(["pending-interaction", "pending-approval", "revision-requested", "ancestor-hold", "unresolved-second"])
    ("completes blocker but preserves dependent under %s", async gate => {
      const f = fixture(); f.blockers[0].status = "in_progress";
      if (gate === "pending-interaction") f.interactions.push({ status: "pending", kind: "request_confirmation", resolverPolicy: "human_only", continuationPolicy: "none" });
      if (gate === "pending-approval") f.approvals.push({ status: "pending" });
      if (gate === "revision-requested") f.approvals.push({ status: "revision_requested" });
      if (gate === "ancestor-hold") f.pauseHolds.push({ id: "hold-1", rootIssueId: "dependent-1" });
      if (gate === "unresolved-second") f.blockers[1].status = "in_progress";
      const gatesBefore = structuredClone([f.interactions, f.approvals, f.pauseHolds]);
      await expect(updateIssueWithDependencyRestorationInTransaction(f.tx as any,
        { issueId: "blocker-1", patch: { status: "done", companyGuard: "company-1" } }, f.postCommit as any))
        .resolves.toMatchObject({ issue: { status: "done" }, intentIds: [] });
      expect(f.getRow()).toEqual(f.before);
      expect([f.interactions, f.approvals, f.pauseHolds]).toEqual(gatesBefore);
      expect(f.writes.map(w => [w.table, w.values.id])).toEqual([["issues", "blocker-1"]]);
    });
  it("propagates missing intent and never returns a caller commit snapshot", async () => {
    const f = fixture(); f.blockers[0].status = "in_progress";
    f.tx.insert = () => ({ values: () => { throw new Error("intent-insert-rejected"); } }) as any;
    let committed: any = null;
    await expect((async () => {
      await updateIssueWithDependencyRestorationInTransaction(f.tx as any,
        { issueId: "blocker-1", patch: { status: "done", companyGuard: "company-1" } }, f.postCommit as any);
      committed = structuredClone(f.writes);
    })()).rejects.toThrow("intent-insert-rejected");
    expect(committed).toBeNull();
    // Recording mutates rows eagerly. This is error propagation, NOT rollback.
    expect(f.getRow().status).toBe("todo");
  });
  it("contains caller patch mutation while canonical fence is suspended", async () => {
    const f = fixture(); f.blockers[0].status = "in_progress";
    let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const entry = new Promise<void>(r => { entered = r; });
    const originalExecute = f.tx.execute.getMockImplementation()!;
    f.tx.execute.mockImplementationOnce(async statement => { entered(); await barrier; return originalExecute(statement); });
    const input = { issueId: "blocker-1", patch: { status: "done", companyGuard: "company-1" } };
    const result = updateIssueWithDependencyRestorationInTransaction(f.tx as any, input, f.postCommit as any);
    try { await Promise.race([entry, result.then(() => { throw new Error("settled-before-fence"); })]);
      input.issueId = "dependent-1"; input.patch.status = "cancelled"; input.patch.companyGuard = "other-company";
      expect(f.writes).toEqual([]);
    } finally { release(); }
    await expect(result).resolves.toMatchObject({ issue: { id: "blocker-1", status: "done" }, intentIds: ["intent-1"] });
    expect(f.getRow().status).toBe("todo");
  });
  it("stores final blocker completion, restored dependent and exact intent in one caller commit snapshot", async () => {
    const f = fixture(); f.blockers[0].status = "in_progress";
    let committed: any = null;
    f.root.transaction.mockImplementation(async callback => {
      const updated = await callback(f.tx);
      committed = { dependent: f.getRow(), blockers: structuredClone(f.blockers), writes: structuredClone(f.writes) };
      return updated;
    });
    const result = await f.root.transaction(async (tx: any) => updateIssueWithDependencyRestorationInTransaction(tx,
      { issueId: "blocker-1", patch: { status: "done", companyGuard: "company-1" } }, f.postCommit as any));
    expect(result).toMatchObject({ issue: { id: "blocker-1", status: "done" }, intentIds: ["intent-1"] });
    expect(committed.blockers[0].status).toBe("done");
    expect(committed.dependent.status).toBe("todo");
    expect(committed.writes).toContainEqual({ table: "agent_wakeup_requests", values: expect.objectContaining({
      companyId: "company-1", agentId: "agent-1", reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: "dependent-1", blockerIssueIds: ["blocker-1", "blocker-2"], blockedTransitionAt: f.before.blockedTransitionAt }),
      payload: { issueId: "dependent-1", taskId: "dependent-1", resolvedBlockerIssueId: "blocker-1", blockerIssueIds: ["blocker-1", "blocker-2"] },
    }) });
    expect(f.events[0]).toBe("lifecycle-fence");
    expect(f.root.transaction).toHaveBeenCalledOnce(); expect(f.tx.transaction).not.toHaveBeenCalled();
  });
});

describe("opt-in canonical lifecycle boundary (recording, not SQL serialization)", () => {
  it.each([false, true])("blocks all canonical domain effects while fence is pending (owned=%s)", async (owned) => {
    const f = fixture();
    let release!: () => void;
    f.tx.execute.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }) as any);
    if (owned) f.root.transaction.mockImplementation(async (callback: any) => callback(f.tx));
    const running = issueService(f.root as any).update("dependent-1", { status: "todo", companyGuard: "company-1" },
      owned ? f.root : f.tx, f.postCommit.activityPublications, f.postCommit.actions, { lifecycleFence: true });
    await Promise.resolve(); await Promise.resolve();
    expect(f.tx.execute).toHaveBeenCalledOnce(); expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
    release(); await running;
    expect(f.getRow().status).toBe("todo"); expect(f.tx.transaction).not.toHaveBeenCalled();
    expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
  });
  it.each([false, true])("rejects before domain effects when fence fails (owned=%s)", async (owned) => {
    const f = fixture(); f.tx.execute.mockRejectedValue(new Error("fence-denied"));
    if (owned) f.root.transaction.mockImplementation(async (callback: any) => callback(f.tx));
    await expect(issueService(f.root as any).update("dependent-1", { status: "todo", companyGuard: "company-1" },
      owned ? f.root : f.tx, f.postCommit.activityPublications, f.postCommit.actions, { lifecycleFence: true }))
      .rejects.toThrow("fence-denied");
    expect(f.events).toEqual([]); expect(f.writes).toEqual([]); expect(f.getRow()).toEqual(f.before);
    expect(f.tx.transaction).not.toHaveBeenCalled();
  });
  it("requires company routing before opening the owned transaction", async () => {
    const f = fixture();
    await expect(issueService(f.root as any).update("dependent-1", { status: "todo" }, f.root,
      [], [], { lifecycleFence: true })).rejects.toThrow("requires companyGuard");
    expect(f.root.transaction).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });
  it("awaits the supplied fence before the first canonical read", async () => {
    const f = fixture();
    await issueService(f.root as any).update("dependent-1", { status: "todo", companyGuard: "company-1" },
      f.tx, f.postCommit.activityPublications, f.postCommit.actions, { lifecycleFence: true } as any);
    expect(f.events[0]).toBe("lifecycle-fence");
    expect(f.events.indexOf("read:issues")).toBeLessThan(f.events.indexOf("lock:update"));
    expect(f.events.indexOf("lock:update")).toBeLessThan(f.events.indexOf("canonical-write"));
    expect(f.root.transaction).not.toHaveBeenCalled(); expect(f.tx.transaction).not.toHaveBeenCalled();
  });
});

describe("dark coordinator with actual canonical update (mock recording, not atomicity)", () => {
  it.each([false, true])("missing ancestor is indeterminate with unrelated hold=%s", async (withHold) => {
    const f = fixture(); f.setParent("missing-parent"); f.missingIssueIds.add("missing-parent");
    if (withHold) f.pauseHolds.push({ id: "other-hold", rootIssueId: "other-tree" });
    expect(await f.assess()).toEqual({ state: "indeterminate", reason: "missing_or_cross_company_issue" });
    const before = f.getRow();
    expect(await f.run()).toBeNull(); expect(f.getRow()).toEqual(before); expect(f.writes).toEqual([]);
  });
  it("cross-company projected ancestor is indeterminate, not clear", async () => {
    const f = fixture(); f.setParent("parent-1");
    f.ancestors.push({ id: "parent-1", companyId: "other-company", parentId: null });
    expect(await f.assess()).toEqual({ state: "indeterminate", reason: "missing_or_cross_company_issue" });
    const before = f.getRow();
    expect(await f.run()).toBeNull(); expect(f.getRow()).toEqual(before); expect(f.writes).toEqual([]);
  });
  it.each([99, 100])("deep pause depth %s cannot be treated as a clear tree", async (depth) => {
    const f = fixture(); f.setParent("ancestor-1");
    for (let i = 1; i <= depth; i++) f.ancestors.push({ id: `ancestor-${i}`, parentId: i === depth ? null : `ancestor-${i + 1}` });
    f.pauseHolds.push({ id: "deep-hold", rootIssueId: `ancestor-${depth}`, reason: "pause", releasePolicy: null });
    const assessment = await f.assess();
    if (depth === 99) expect(assessment).toMatchObject({ state: "held", gate: { holdId: "deep-hold" } });
    else expect(assessment).toEqual({ state: "indeterminate", reason: "depth_exhausted" });
    const before = f.getRow();
    expect(await f.run()).toBeNull(); expect(f.getRow()).toEqual(before); expect(f.writes).toEqual([]);
  });
  it("accepts a fully traversed root at the last allowed depth", async () => {
    const f = fixture(); f.setParent("ancestor-1");
    for (let i = 1; i <= 99; i++) f.ancestors.push({ id: `ancestor-${i}`, parentId: i === 99 ? null : `ancestor-${i + 1}` });
    expect(await f.assess()).toEqual({ state: "clear" });
    expect(await f.run()).toBe("intent-1"); expect(f.getRow().status).toBe("todo");
  });
  it("fails closed on cyclic ancestry even with no active pause rows", async () => {
    const f = fixture(); f.setParent("dependent-1");
    const before = f.getRow();
    expect(await f.assess()).toEqual({ state: "indeterminate", reason: "cycle" });
    expect(await f.run()).toBeNull();
    expect(f.getRow()).toEqual(before); expect(f.writes).toEqual([]);
    expect(f.events).not.toContain("read:issue_relations");
    expect(f.events).not.toContain("read:issue_thread_interactions");
  });
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
