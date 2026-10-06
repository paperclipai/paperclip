import { eq, getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { issues } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.ts";

vi.mock("../services/instance-settings.ts", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: false }) }),
}));
vi.mock("../services/chat-completion-delivery.js", () => ({
  recordChatCompletion: async () => undefined,
}));
vi.mock("../services/status-card-finalization.js", () => ({
  finalizeStatusCardsForStalledGeneration: async () => undefined,
}));
vi.mock("../services/summary-slot-finalization.js", () => ({
  finalizeSummarySlotsForTerminalIssue: async () => undefined,
}));
vi.mock("../services/issue-thread-interactions.js", () => ({
  issueThreadInteractionService: () => ({ expirePendingInteractionsForTerminalIssue: async () => [] }),
}));

// Recording service-writer diagnostic, not a SQL interpreter or DB atomicity
// proof. The real update implementation runs; unrelated terminal lifecycle
// hooks are mocked. No route, adapter, server or PostgreSQL is started.
function writerFixture() {
  const blocker = {
    id: "blocker-1", companyId: "company-1", status: "in_progress",
    title: "Final blocker", parentId: null, projectId: null, goalId: null,
    assigneeAgentId: "agent-1", assigneeUserId: null, statusVersion: 1,
    originKind: "manual", executionWorkspaceId: null,
  };
  const dependent = {
    ...blocker, id: "dependent-1", title: "Dependency work", status: "blocked",
    blockedTransitionAt: new Date("2026-10-05T00:00:00Z"),
  };
  const before = structuredClone(blocker);
  let blockerRow = { ...blocker };
  const events: string[] = [];
  const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
  let atCommit: { status: string; writes: typeof writes } | null = null;
  let inTransaction = false;
  function query(rows: unknown[]) {
    const q = {
      where: (_predicate: unknown) => q,
      innerJoin: (_table: unknown, _predicate: unknown) => q,
      leftJoin: (_table: unknown, _predicate: unknown) => q,
      orderBy: (..._args: unknown[]) => q,
      limit: (_count: number) => q,
      for: (lock: string) => { events.push(`lock:${lock}:${inTransaction}`); return q; },
      returning: () => q,
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  }
  const emptyReads = new Set([
    "goals", "projects", "chat_conversations", "chat_task_handoffs", "issue_summary_slots", "status_cards",
    "issue_labels", "labels", "issue_watchdogs", "issue_thread_interactions", "issue_approvals", "approvals",
    "execution_workspaces", "workspace_operations", "issue_relations", "agent_wakeup_requests",
  ]);
  const db = {
    select: (projection: Record<string, unknown> = {}) => ({
      from: (table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table);
        events.push(`read:${name}:${inTransaction}`);
        if (name === "issues") return query([{ ...blockerRow }]);
        // Candidate projections model the synthetic dependency edge, only if
        // the real writer begins consuming readiness. They are not SQL results.
        if (name === "issue_relations" && "assigneeAgentId" in projection) return query([{ ...dependent }]);
        if (name === "issue_relations" && "blockerStatus" in projection) return query([{
          issueId: dependent.id, blockerIssueId: blocker.id,
          blockerStatus: blockerRow.status, blockerExecutionWorkspaceId: null,
        }]);
        if (emptyReads.has(name)) return query([]);
        throw new Error(`Unmodeled writer read: ${name}/${Object.keys(projection).join(",")}`);
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (values: Record<string, unknown>) => {
        const name = getTableName(table);
        if (name !== "issues") throw new Error(`Unmodeled writer update: ${name}`);
        return {
          where: (predicate: SQL) => {
            const params = new PgDialect().sqlToQuery(predicate).params;
            const targetId = params.find((value) => value === blocker.id || value === dependent.id);
            if (!targetId) throw new Error("Unmodeled issue write target");
            events.push(`update:${name}:${inTransaction}`);
            writes.push({ table: name, values: { ...structuredClone(values), id: targetId } });
            if (targetId === blocker.id) blockerRow = { ...blockerRow, ...values };
            else Object.assign(dependent, values);
            return query([{ ...(targetId === blocker.id ? blockerRow : dependent) }]);
          },
        };
      },
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown>) => {
        const name = getTableName(table);
        if (name !== "agent_wakeup_requests") throw new Error(`Unmodeled writer insert: ${name}`);
        events.push(`insert:${name}:${inTransaction}`);
        writes.push({ table: name, values: structuredClone(values) });
        return query([{ id: "intent-1", ...values }]);
      },
    }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      events.push("transaction:begin");
      inTransaction = true;
      const result = await callback(db);
      atCommit = { status: dependent.status, writes: structuredClone(writes) };
      events.push("transaction:commit");
      inTransaction = false;
      return result;
    },
  };
  return {
    update: () => issueService(db as any).update(blocker.id, { status: "done" }),
    events, writes, before, blocker,
    getCommit: () => atCommit,
    fixtureOnlyRestore: () => db.update(issues).set({ status: "todo" }).where(eq(issues.id, dependent.id)),
    getDependentStatus: () => dependent.status,
  };
}

describe("writer recording fixture sensitivity only", () => {
  it("targets dependent writes without changing the blocker snapshot", async () => {
    const f = writerFixture();
    await f.fixtureOnlyRestore();
    expect(f.getDependentStatus()).toBe("todo");
    expect(f.blocker).toEqual(f.before);
    expect(f.writes).toEqual([{ table: "issues", values: { id: "dependent-1", status: "todo" } }]);
  });

  it("does not mistake a post-commit restore for restoration inside the transaction", async () => {
    const f = writerFixture();
    await f.update();
    await f.fixtureOnlyRestore();
    expect(f.getDependentStatus()).toBe("todo");
    expect(f.getCommit()?.status).toBe("blocked");
    expect(f.getCommit()?.writes).not.toContainEqual(expect.objectContaining({
      values: expect.objectContaining({ id: "dependent-1" }),
    }));
  });
});

describe("dependency restoration service writer (mock-only known-red contract)", () => {
  it("records the canonical blocker write inside its owned transaction", async () => {
    const f = writerFixture();
    expect(await f.update()).toMatchObject({ id: "blocker-1", status: "done" });
    expect(f.blocker).toEqual(f.before);
    expect(f.events).toContain("lock:update:true");
    expect(f.events).toContain("update:issues:true");
    expect(f.events.at(-1)).toBe("transaction:commit");
    expect(f.getCommit()).not.toBeNull();
  });

  it("requires restoration and durable dependency intent before the writer transaction returns", async () => {
    const f = writerFixture();
    expect(await f.update()).toMatchObject({ id: "blocker-1", status: "done" });
    expect(f.blocker).toEqual(f.before);
    const committed = f.getCommit();
    expect(committed).not.toBeNull();
    // Durable intent is checked first: detached route wakeups cannot satisfy
    // this service boundary contract by patching the dependent afterward.
    expect(committed!.writes).toContainEqual(expect.objectContaining({
      table: "agent_wakeup_requests",
      values: expect.objectContaining({ reason: "issue_blockers_resolved" }),
    }));
    expect(["todo", "in_progress"]).toContain(committed!.status);
  });
});
