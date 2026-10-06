import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expirePendingInteractionsForTerminalIssueInTransaction, issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { publishActivity, type ActivityPublication } from "../services/activity-log.js";
// Adapted from independent review probe; real linked-secret helper and activity logger.
const sink = vi.hoisted(() => ({ live: [] as any[], chats: [] as string[] }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: (e: any) => sink.live.push(e) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/chat-interaction-publications.js", () => ({ enqueueTerminalIssueInteractionChatPublications: async (_tx: any, row: any) => { sink.chats.push(row.id); } }));
function fixture(config: { lost?: boolean; laterError?: Error; activityError?: Error } = {}) {
  sink.live.length = 0; sink.chats.length = 0;
  const queued: ActivityPublication[] = []; const patches: any[] = []; const queries: any[] = [];
  const row: any = { id: "interaction-1", issueId: "issue-1", companyId: "company-1", kind: "request_confirmation", status: "pending", result: null,
    payload: { version: 1, prompt: "Offline fixture", secretProposal: { version: 1, proposalId: "00000000-0000-4000-8000-000000000001", sourceSecretLabel: "synthetic", configPath: "env.TEST", targetAgentId: "00000000-0000-4000-8000-000000000001", targetAgentName: "Synthetic", justification: "Offline", expiresAt: "2030-01-01T00:00:00Z" } } };
  const rows = config.laterError ? [row, { ...row, id: "interaction-2", kind: "connection_intent" }] : [row];
  const tx: any = {
    transaction: () => { throw new Error("nested-transaction"); },
    execute: async () => {},
    select: () => ({ from: (table: any) => ({ where: (q: any) => {
      queries.push(new PgDialect().sqlToQuery(q));
      if (getTableName(table) === "issues") return { for: async () => [{ id: "issue-1", companyId: "company-1", status: "done" }] };
      expect(getTableName(table)).toBe("issue_thread_interactions"); return Promise.resolve(rows);
    } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (q: any) => {
      const name = getTableName(table); patches.push({ name, patch }); queries.push(new PgDialect().sqlToQuery(q));
      if (name === "tool_action_requests" || name === "issues") return Promise.resolve();
      if (name === "company_secret_proposals") return { returning: async () => [{ id: "proposal-1", proposedByAgentId: null, originRunId: null, originIssueId: "issue-1" }] };
      expect(name).toBe("issue_thread_interactions"); return { returning: async () => config.lost ? [] : [{ ...row, ...patch }] };
    } }) }),
    insert: (table: any) => ({ values: (value: any) => {
      expect(getTableName(table)).toBe("activity_log"); patches.push({ name: "activity_log", patch: value });
      return { returning: async () => { if (config.activityError) throw config.activityError; return [{ id: "activity-1" }]; } };
    } }),
    delete: (table: any) => ({ where: async () => { expect(getTableName(table)).toBe("tool_oauth_states"); throw config.laterError; } }),
  };
  const root: any = { ...tx, transaction: (cb: any) => cb(tx) };
  return { tx, root, queued, patches, queries };
}
const run = (f: ReturnType<typeof fixture>) => (expirePendingInteractionsForTerminalIssueInTransaction as any)(
  f.tx, { id: "issue-1", companyId: "company-1" }, { userId: "user-1" }, { postCommitPublications: f.queued },
);
describe("supplied terminal expiry caller-owned activity publication", () => {
  it("does not publish before lost card CAS; caller discards transaction-local queue", async () => {
    const f = fixture({ lost: true }); await expect(run(f)).rejects.toThrow("resolved concurrently");
    expect(sink.live).toEqual([]); expect(sink.chats).toEqual([]);
    expect(f.queued).toHaveLength(1); f.queued.length = 0;
    expect(f.patches.find(p => p.name === "company_secret_proposals").patch.valueCiphertext).toBeNull();
    // Eager recording writes survive: no database rollback claim.
  });
  it("defers success until caller flush after simulated outer commit", async () => {
    const f = fixture(); const rows = await run(f); expect(rows[0].status).toBe("expired");
    expect(sink.live).toEqual([]); expect(f.queued).toHaveLength(1);
    expect(f.queued[0]).toMatchObject({ companyId: "company-1", payload: { action: "secret.proposal.expired", actorId: "user-1", entityId: "proposal-1" } });
    // Actual publication helper; simulated commit, not SQL commit evidence.
    for (const publication of f.queued.splice(0)) publishActivity(publication);
    expect(sink.live).toHaveLength(1); expect(f.queued).toEqual([]);
    expect(sink.chats).toEqual(["interaction-1"]); // durable chat enqueue mock, not live delivery
  });
  it("does not leak earlier activity when later OAuth row fails", async () => {
    const error = new Error("oauth-denied"); const f = fixture({ laterError: error });
    await expect(run(f)).rejects.toBe(error); expect(sink.live).toEqual([]);
    expect(f.queued).toHaveLength(1); f.queued.length = 0;
    expect(sink.chats).toEqual(["interaction-1"]); // eager mock enqueue, not rollback
  });
  it("propagates activity storage rejection with no queue or live publication", async () => {
    const error = new Error("activity-denied"); const f = fixture({ activityError: error });
    await expect(run(f)).rejects.toBe(error); expect(f.queued).toEqual([]); expect(sink.live).toEqual([]);
  });
  it("refuses a missing caller queue before reads or writes", async () => {
    const f = fixture(); await expect((expirePendingInteractionsForTerminalIssueInTransaction as any)(f.tx, { id: "issue-1", companyId: "company-1" }, { userId: "user-1" })).rejects.toMatchObject({ status: 422 });
    expect(f.queries).toEqual([]); expect(f.patches).toEqual([]);
  });
  it("retains ordinary inherited eager timing independently", async () => {
    const f = fixture({ lost: true }); const rows = await issueThreadInteractionService(f.root).expirePendingInteractionsForTerminalIssue({ id: "issue-1", companyId: "company-1", status: "done" }, { userId: "user-1" });
    expect(rows).toEqual([]); expect(sink.live).toHaveLength(1); expect(f.queued).toEqual([]);
  });
});
