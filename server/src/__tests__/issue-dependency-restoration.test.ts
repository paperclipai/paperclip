import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { restoreDependencyReadyIssueInTransaction } from "../services/issue-dependency-restoration.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";

const service = vi.hoisted(() => ({ update: vi.fn(), listWakeableBlockedDependents: vi.fn() }));
vi.mock("../services/issues.js", () => ({ issueService: () => service }));

// Execute the real coordinator. Canonical issue update/readiness are mocked;
// this verifies orchestration, not their SQL or authorization behavior.
function fixture() {
  const row = { id: "dependent-1", companyId: "company-1", assigneeAgentId: "agent-1",
    status: "blocked", statusVersion: 2, blockedTransitionAt: new Date("2026-10-05T00:00:00Z"),
    executionRunId: null, checkoutRunId: null, conversationAgentId: null,
    unblockDescriptor: null, executionState: null, executionPolicy: null };
  const interactions: unknown[] = [];
  const blocker = { id: "blocker-1", companyId: "company-1", status: "done" };
  const approvals: unknown[] = [];
  const wakes: unknown[] = [];
  const events: string[] = [];
  const intents: Record<string, unknown>[] = [];
  function query(rows: unknown[], resolveTarget?: (predicate: SQL) => unknown[]) {
    const q = { where: (predicate: SQL) => { if (resolveTarget) rows = resolveTarget(predicate); return q; }, innerJoin: () => q, limit: () => q, orderBy: () => q,
      for: (lock: string) => { events.push(`lock:${lock}`); return q; },
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const tx = {
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      if (name === "issues") return query([], (predicate) => {
        const params = new PgDialect().sqlToQuery(predicate).params;
        if (params.includes(row.id)) return [row];
        if (params.includes(blocker.id)) return [blocker];
        throw new Error("Unknown restoration issue read target");
      });
      if (name === "issue_thread_interactions") return query(interactions);
      if (name === "issue_approvals") return query(approvals);
      if (name === "issue_tree_holds") return query([]);
      if (name === "agent_wakeup_requests") return query(wakes);
      throw new Error(`Unknown read ${name}`);
    } }),
    insert: (table: any) => ({ values: (values: Record<string, unknown>) => {
      expect(getTableName(table)).toBe("agent_wakeup_requests");
      events.push("intent"); intents.push(structuredClone(values));
      return { returning: () => query([{ id: "intent-1" }]) };
    } }),
  };
  service.update.mockReset(); service.listWakeableBlockedDependents.mockReset();
  service.listWakeableBlockedDependents.mockResolvedValue([{ id: row.id,
    assigneeAgentId: row.assigneeAgentId, blockerIssueIds: ["blocker-1"], blockedTransitionAt: row.blockedTransitionAt }]);
  service.update.mockImplementation(async () => { events.push("canonical-update"); return { ...row, status: "todo" }; });
  const owner = { db: {} as any, activityPublications: [], actions: [] };
  return { row, blocker, interactions, approvals, wakes, events, intents, tx, owner,
    run: () => restoreDependencyReadyIssueInTransaction(tx as any, {
      companyId: "company-1", dependentIssueId: row.id, resolvedBlockerIssueId: "blocker-1" }, owner) };
}

describe("dark dependency restoration coordinator (mock-only)", () => {
  it.each(["in_progress", "blocked", "cancelled"])("rejects resolved-blocker input whose authoritative status is %s", async (status) => {
    const f = fixture(); f.blocker.status = status;
    expect(await f.run()).toBeNull();
    expect(service.update).not.toHaveBeenCalled(); expect(f.intents).toEqual([]);
  });
  it("rejects an authoritative blocker from another company", async () => {
    const f = fixture(); f.blocker.companyId = "other-company";
    expect(await f.run()).toBeNull();
    expect(service.update).not.toHaveBeenCalled(); expect(f.intents).toEqual([]);
  });
  it("rejects readiness whose owner no longer matches the locked dependent", async () => {
    const f = fixture();
    service.listWakeableBlockedDependents.mockResolvedValue([{ id: f.row.id, assigneeAgentId: "other-agent", blockerIssueIds: [f.blocker.id] }]);
    expect(await f.run()).toBeNull();
    expect(service.update).not.toHaveBeenCalled(); expect(f.intents).toEqual([]);
  });
  it.each(["none", "wake_assignee"])("vetoes pending human_only confirmation with continuation %s", async (continuationPolicy) => {
    const f = fixture();
    f.interactions.push({ id: "human-1", status: "pending", kind: "request_confirmation",
      effectiveResolverPolicy: "human_only", continuationPolicy, addresseeUserId: "owner" });
    const before = structuredClone(f.interactions);
    expect(await f.run()).toBeNull();
    expect(service.update).not.toHaveBeenCalled();
    expect(f.intents).toEqual([]);
    expect(f.interactions).toEqual(before);
  });
  it.each(["pending", "revision_requested"])("vetoes formal approval %s without replacing it", async (status) => {
    const f = fixture(); f.approvals.push({ id: "approval-1", status });
    const before = structuredClone(f.approvals);
    expect(await f.run()).toBeNull();
    expect(service.update).not.toHaveBeenCalled();
    expect(f.intents).toEqual([]); expect(f.approvals).toEqual(before);
  });
  it.each(["executionRunId", "checkoutRunId", "unblockDescriptor", "executionState", "executionPolicy", "conversationAgentId"])(
    "does not overwrite unmodeled hold/lease %s", async (field) => {
      const f = fixture(); (f.row as any)[field] = field.endsWith("Id") ? "held-1" : { status: "pending" };
      expect(await f.run()).toBeNull(); expect(service.update).not.toHaveBeenCalled(); expect(f.intents).toEqual([]);
    });
  it("suppresses a same-cycle durable intent before modifying status", async () => {
    const f = fixture(); f.wakes.push({ id: "previous-intent", status: "completed",
      requestedAt: new Date(), idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: f.row.id, blockerIssueIds: ["blocker-1"], blockedTransitionAt: f.row.blockedTransitionAt }) });
    expect(await f.run()).toBeNull(); expect(service.update).not.toHaveBeenCalled(); expect(f.intents).toEqual([]);
  });
  it("does not restore when readiness has no eligible dependent", async () => {
    const f = fixture(); service.listWakeableBlockedDependents.mockResolvedValue([]);
    expect(await f.run()).toBeNull(); expect(service.update).not.toHaveBeenCalled(); expect(f.intents).toEqual([]);
  });
  it("does not use a candidate whose resolved blocker is not in the edge set", async () => {
    const f = fixture(); service.listWakeableBlockedDependents.mockResolvedValue([{ id: f.row.id,
      assigneeAgentId: f.row.assigneeAgentId, blockerIssueIds: ["other-blocker"] }]);
    expect(await f.run()).toBeNull(); expect(service.update).not.toHaveBeenCalled(); expect(f.intents).toEqual([]);
  });
  it("allows resolved gates without mutating their records", async () => {
    const f = fixture(); f.interactions.push({ status: "resolved" }); f.approvals.push({ status: "approved" });
    const before = structuredClone([f.interactions, f.approvals]);
    expect(await f.run()).toBe("intent-1"); expect([f.interactions, f.approvals]).toEqual(before);
  });
  it("propagates canonical restore failure before inserting an intent", async () => {
    const f = fixture(); service.update.mockRejectedValue(new Error("canonical-denied"));
    await expect(f.run()).rejects.toThrow("canonical-denied"); expect(f.intents).toEqual([]);
  });
  it("does not insert an intent after an unsuccessful canonical restore", async () => {
    const f = fixture(); service.update.mockResolvedValue(null);
    await expect(f.run()).rejects.toThrow("dependency_restore_not_persisted"); expect(f.intents).toEqual([]);
  });
  it("requires a persisted intent, propagating the error to the owning transaction", async () => {
    const f = fixture(); f.tx.insert = () => ({ values: () => ({ returning: () => ({
      then: (resolve: any, reject: any) => Promise.resolve([]).then(resolve, reject) }) }) }) as any;
    await expect(f.run()).rejects.toThrow("dependency_restore_intent_not_persisted");
    expect(service.update).toHaveBeenCalled(); // rollback is NOT proved by this mock
  });
  it("uses the supplied transaction for canonical restore and exact cycle-bound durable intent", async () => {
    const f = fixture();
    expect(await f.run()).toBe("intent-1");
    expect(service.update).toHaveBeenCalledWith("dependent-1", {
      status: "todo", companyGuard: "company-1" }, f.tx, f.owner.activityPublications, f.owner.actions);
    expect(service.update.mock.calls[0][3]).toBe(f.owner.activityPublications);
    expect(service.update.mock.calls[0][4]).toBe(f.owner.actions);
    expect(f.events.indexOf("canonical-update")).toBeLessThan(f.events.indexOf("intent"));
    expect(f.events).toContain("lock:update");
    expect(f.events).toContain("lock:share");
    expect(f.events.indexOf("lock:share")).toBeLessThan(f.events.indexOf("lock:update"));
    expect(f.intents).toEqual([expect.objectContaining({ companyId: "company-1", agentId: "agent-1",
      reason: "issue_blockers_resolved", status: "queued", source: "automation",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: "dependent-1",
        blockerIssueIds: ["blocker-1"], blockedTransitionAt: f.row.blockedTransitionAt }),
      payload: expect.objectContaining({ issueId: "dependent-1", taskId: "dependent-1",
        resolvedBlockerIssueId: "blocker-1", blockerIssueIds: ["blocker-1"] }) })]);
  });
});
