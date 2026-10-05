import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { restoreDependencyReadyIssueInTransaction } from "../services/issue-dependency-restoration.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";

vi.mock("../services/instance-settings.ts", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: false }) }),
}));
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  return { ...actual, issueService: (db: any) => ({ ...actual.issueService(db),
    // Readiness remains synthetic; canonical update is the real implementation.
    listWakeableBlockedDependents: async () => [{ id: "dependent-1", blockerIssueIds: ["blocker-1", "blocker-2"] }],
  }) };
});

// No SQL, DB, server or adapter. Distinct root/tx identities expose accidental
// transaction ownership; actual canonical update records its writes and cleanup.
function fixture() {
  let row: Record<string, any> = { id: "dependent-1", companyId: "company-1", status: "blocked",
    title: "Dependency work", parentId: null, projectId: null, goalId: null,
    assigneeAgentId: "agent-1", assigneeUserId: null, statusVersion: 2, originKind: "manual",
    blockedTransitionAt: new Date("2026-10-05T00:00:00Z"), blockedOwnerNotifiedAt: new Date(),
    executionRunId: null, checkoutRunId: null, conversationAgentId: null,
    unblockDescriptor: null, executionState: null, executionPolicy: null };
  const before = structuredClone(row);
  const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
  const events: string[] = [];
  const root = { transaction: vi.fn(() => { throw new Error("root-transaction-not-owned"); }),
    select: () => { throw new Error("root-read-outside-transaction"); } };
  function query(rows: unknown[]) {
    const q = { where: (_predicate: SQL) => q, innerJoin: () => q, leftJoin: () => q,
      limit: () => q, orderBy: () => q, returning: () => q,
      for: (lock: string) => { events.push(`lock:${lock}`); return q; },
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const emptyReads = new Set(["issue_thread_interactions", "issue_approvals", "agent_wakeup_requests",
    "issue_relations", "issue_labels", "labels", "issue_watchdogs", "goals", "projects"]);
  const tx = {
    transaction: vi.fn(() => { throw new Error("nested-transaction-not-owned"); }),
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      if (name === "issues") return query([{ ...row }]);
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
  return { tx, root, before, writes, events, postCommit, getRow: () => structuredClone(row),
    run: () => restoreDependencyReadyIssueInTransaction(tx as any, {
      companyId: "company-1", dependentIssueId: "dependent-1", resolvedBlockerIssueId: "blocker-1",
    }, postCommit as any) };
}

describe("dark coordinator with actual canonical update (mock recording, not atomicity)", () => {
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
