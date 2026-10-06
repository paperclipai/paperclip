import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";

const activity = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("../services/instance-settings.ts", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: false }) }) }));
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/status-card-finalization.js", () => ({ finalizeStatusCardsForStalledGeneration: async () => undefined }));
vi.mock("../services/summary-slot-finalization.js", () => ({ finalizeSummarySlotsForTerminalIssue: async () => undefined }));
// Unrelated terminal persistence explicitly mocked in this ownership-only suite.
vi.mock("../services/issue-thread-interactions.js", () => ({ expirePendingInteractionsForTerminalIssueInTransaction: async () => [], issueThreadInteractionService: () => ({ expirePendingInteractionsForTerminalIssue: async () => [] }) }));
vi.mock("../services/activity-log.js", () => ({
  logActivity: async () => undefined,
  persistActivity: async () => { activity.events.push("persist"); return { publication: { marker: "archive" } }; },
  publishActivity: () => { activity.events.push("publish"); },
}));

// Actual canonical update with distinct root/executor; adapted from the
// independent ownership review probe. No SQL, database, server or adapter.
// Commit is callback return only, not a database commit/rollback proof.
function fixture() {
  activity.events.length = 0;
  let row: Record<string, any> = {
    id: "issue-1", companyId: "company-1", status: "blocked", title: "Review",
    parentId: null, projectId: null, goalId: null, assigneeAgentId: "agent-1", assigneeUserId: null,
    originKind: "manual", statusVersion: 2, conversationAgentId: null,
  };
  function query(rows: unknown[]) {
    const q: any = {
      where: () => q, innerJoin: () => q, leftJoin: () => q, orderBy: () => q,
      limit: () => q, for: () => q, returning: () => q, onConflictDoUpdate: () => q,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  }
  const tx: any = {
    execute: async () => { activity.events.push("fence"); return []; },
    transaction: () => { throw new Error("unexpected-nested-transaction"); },
    select: () => ({ from: (table: any) => {
      const name = getTableName(table);
      activity.events.push(`tx-read:${name}`);
      if (name === "issues") return query([{ ...row }]);
      if (["goals", "projects", "issue_labels", "labels", "issue_watchdogs"].includes(name)) return query([]);
      throw new Error(`unmodeled-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: () => {
      const name = getTableName(table);
      if (name === "issues") { row = { ...row, ...patch }; return query([{ ...row }]); }
      if (name === "chat_conversations") return query([]);
      throw new Error(`unmodeled-update:${name}`);
    } }) }),
    insert: (table: any) => ({ values: (values: any) => {
      expect(getTableName(table)).toBe("issue_inbox_archives");
      activity.events.push("archive"); return query([values]);
    } }),
  };
  const root: any = {
    select: () => tx.select(),
    transaction: async (callback: any) => {
      activity.events.push("begin");
      const result = await callback(tx);
      activity.events.push("commit");
      return result;
    },
  };
  return { root, tx, run: (owned: boolean, fence: boolean, publications?: any[]) =>
    issueService(root).update("issue-1", { status: "done", actorUserId: "user-1", companyGuard: "company-1" },
      owned ? root : tx, publications, undefined, { lifecycleFence: fence }) };
}

function expectOwnedPublication() {
  expect(activity.events.filter((event) => event === "begin")).toHaveLength(1);
  expect(activity.events.filter((event) => event === "commit")).toHaveLength(1);
  expect(activity.events.filter((event) => event === "archive")).toHaveLength(1);
  expect(activity.events.filter((event) => event === "persist")).toHaveLength(1);
  expect(activity.events.filter((event) => event === "publish")).toHaveLength(1);
  expect(activity.events.indexOf("persist")).toBeLessThan(activity.events.indexOf("commit"));
  expect(activity.events.indexOf("commit")).toBeLessThan(activity.events.indexOf("publish"));
}

describe("canonical human completion preserves root transaction ownership", () => {
  it("default owned caller publishes once after callback commit", async () => {
    const f = fixture();
    await expect(f.run(true, false)).resolves.toMatchObject({ status: "done" });
    expectOwnedPublication();
  });
  it("opt-in owned caller does not require an external publication queue", async () => {
    const f = fixture();
    await expect(f.run(true, true)).resolves.toMatchObject({ status: "done" });
    expectOwnedPublication();
    expect(activity.events.indexOf("begin")).toBeLessThan(activity.events.indexOf("fence"));
    expect(activity.events.indexOf("fence")).toBeLessThan(activity.events.indexOf("tx-read:issues"));
  });
  it.each([false, true])("supplied caller retains the missing-queue guard (fence=%s)", async (fence) => {
    const f = fixture();
    await expect(f.run(false, fence)).rejects.toThrow(fence
      ? "Lifecycle-fenced terminal updates in an external transaction require a post-commit activity queue"
      : "Human completion in an external transaction requires a post-commit activity queue");
    if (fence) expect(activity.events).toEqual([]);
    expect(activity.events).not.toContain("publish");
    expect(activity.events).not.toContain("archive");
    expect(activity.events).not.toContain("persist");
    expect(activity.events).not.toContain("begin");
  });
  it.each([false, true])("supplied queue is populated, never flushed by update (fence=%s)", async (fence) => {
    const f = fixture(); const publications: any[] = [];
    await expect(f.run(false, fence, publications)).resolves.toMatchObject({ status: "done" });
    expect(publications).toEqual([{ marker: "archive" }]);
    expect(activity.events).not.toContain("publish");
    expect(activity.events).not.toContain("commit");
    expect(activity.events).not.toContain("begin");
  });
  it("opt-in owned caller with explicit queue leaves publication to caller", async () => {
    const f = fixture(); const publications: any[] = [];
    await expect(f.run(true, true, publications)).resolves.toMatchObject({ status: "done" });
    expect(publications).toEqual([{ marker: "archive" }]);
    expect(activity.events).toContain("commit");
    expect(activity.events).not.toContain("publish");
  });
});
