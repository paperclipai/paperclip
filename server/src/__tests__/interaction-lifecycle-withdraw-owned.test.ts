import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { withdrawInteractionWithNativeCancellation } from "../services/interaction-native-withdrawal.js";
const sink = vi.hoisted(() => ({ live: [] as any[], events: [] as string[] }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: (e: any) => sink.live.push(e) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/chat-interaction-publications.js", () => ({ enqueueTerminalIssueInteractionChatPublications: async () => {} }));
function fixture(config: { lost?: boolean; status?: string } = {}) {
  sink.live.length = 0; sink.events.length = 0;
  const queries: any[] = []; const patches: any[] = [];
  const row: any = { id: "interaction-1", issueId: "issue-1", companyId: "company-1", kind: "request_confirmation", status: "pending", result: null,
    payload: { version: 1, prompt: "Offline fixture", secretProposal: { version: 1, proposalId: "00000000-0000-4000-8000-000000000001", sourceSecretLabel: "synthetic", configPath: "env.TEST", targetAgentId: "00000000-0000-4000-8000-000000000001", targetAgentName: "Synthetic", justification: "Offline", expiresAt: "2030-01-01T00:00:00Z" } } };
  const tx: any = {
    transaction: () => { throw new Error("nested-transaction"); },
    execute: async () => { sink.events.push("fence"); },
    select: () => ({ from: (table: any) => ({ where: (q: any) => {
      queries.push(new PgDialect().sqlToQuery(q)); const name = getTableName(table);
      if (name === "issues") return { for: async () => [{ id: "issue-1", companyId: "company-1", status: config.status ?? "blocked" }] };
      if (name === "tool_action_requests") return Object.assign(Promise.resolve([]), { orderBy: () => ({ for: async (mode: string) => { expect(mode).toBe("update"); return []; } }) });
      expect(name).toBe("issue_thread_interactions"); return Object.assign(Promise.resolve([row]), { for: async (mode: string) => { expect(mode).toBe("update"); return [row]; } });
    } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (q: any) => {
      const name = getTableName(table); patches.push({ name, patch }); queries.push(new PgDialect().sqlToQuery(q));
      if (name === "tool_action_requests" || name === "issues") return Promise.resolve();
      if (name === "company_secret_proposals") return { returning: async () => [{ id: "proposal-1", proposedByAgentId: null, originRunId: null, originIssueId: "issue-1" }] };
      expect(name).toBe("issue_thread_interactions"); return { returning: async () => config.lost ? [] : [{ ...row, ...patch }] };
    } }) }),
    insert: (table: any) => ({ values: (value: any) => { expect(getTableName(table)).toBe("activity_log"); patches.push({ name: "activity_log", patch: value }); return { returning: async () => [{ id: "activity-1" }] }; } }),
  };
  const root: any = { ...tx, select: () => { throw new Error("root-read-before-transaction"); },
    transaction: async (cb: any) => { sink.events.push("tx"); return cb(tx); } };
  return { tx, root, queries, patches };
}
const invoke = (f: ReturnType<typeof fixture>, issue = { id: "issue-1", companyId: "company-1" }, actor = { userId: "user-1" }, input = { reason: "Offline withdrawal" }, options: any = { lifecycleFence: true }) =>
  (issueThreadInteractionService(f.root).withdrawInteraction as any)(issue, "interaction-1", input, actor, options);
describe("dark owned native composition linked activity recording", () => {
  const compose = (f: ReturnType<typeof fixture>) => withdrawInteractionWithNativeCancellation(f.root, { id: "issue-1", companyId: "company-1" }, "interaction-1", { reason: "Offline" }, { userId: "user-1" });
  it("flushes linked-secret activity exactly once after outer resolve with null native receipt", async () => {
    const f = fixture(); let commit!: () => void; let enter!: () => void;
    const entered = new Promise<void>(r => { enter = r; }); const barrier = new Promise<void>(r => { commit = r; });
    f.root.transaction = async (cb: any) => { const receipt = await cb(f.tx); enter(); await barrier; return receipt; };
    const pending = compose(f); void pending.catch(() => {});
    try { expect(await Promise.race([entered.then(() => "callback"), pending.then(() => "settled")])).toBe("callback"); expect(sink.live).toEqual([]); }
    finally { commit(); await pending.catch(() => {}); }
    expect(await pending).toMatchObject({ nativeRunId: null, interaction: { status: "cancelled" } });
    expect(sink.live).toHaveLength(1); expect(sink.live[0].payload.action).toBe("secret.proposal.withdrawn");
  });
  it("discards linked activity on outer rejection; eager log rows are not rollback", async () => {
    const f = fixture(); const error = new Error("outer-rejected"); f.root.transaction = async (cb: any) => { await cb(f.tx); throw error; };
    await expect(compose(f)).rejects.toBe(error); expect(sink.live).toEqual([]); expect(f.patches.some(p => p.name === "activity_log")).toBe(true);
  });
  it("discards linked activity on callback card rejection", async () => {
    const f = fixture({ lost: true }); await expect(compose(f)).rejects.toMatchObject({ status: 409 }); expect(sink.live).toEqual([]);
  });
});
describe("dark owned withdrawal actual canonical publication recording", () => {
  it("starts root transaction before reads and defers linked activity until outer resolve", async () => {
    const f = fixture(); let done!: () => void; let commit!: () => void;
    const entered = new Promise<void>(r => { done = r; }); const barrier = new Promise<void>(r => { commit = r; });
    f.root.transaction = async (cb: any) => { sink.events.push("tx"); const row = await cb(f.tx); done(); await barrier; return row; };
    const operation = invoke(f); void operation.catch(() => {});
    try { expect(await Promise.race([entered.then(() => "callback"), operation.then(() => "settled")])).toBe("callback"); expect(sink.live).toEqual([]); }
    finally { commit(); await operation.catch(() => {}); }
    expect((await operation).status).toBe("cancelled"); expect(sink.events).toEqual(["tx", "fence"]); expect(sink.live).toHaveLength(1);
    expect(sink.live[0].payload.action).toBe("secret.proposal.withdrawn");
  });
  it("discards activity on simulated outer commit rejection; eager rows are not rollback", async () => {
    const f = fixture(); const error = new Error("commit-rejected");
    f.root.transaction = async (cb: any) => { await cb(f.tx); throw error; };
    await expect(invoke(f)).rejects.toBe(error); expect(sink.live).toEqual([]);
    expect(f.patches.some(p => p.name === "activity_log")).toBe(true);
    expect(f.patches.filter(p => p.name === "issues")).toEqual([]);
  });
  it("discards linked activity when card CAS fails", async () => {
    const f = fixture({ lost: true }); await expect(invoke(f)).rejects.toMatchObject({ status: 409 });
    expect(sink.live).toEqual([]); expect(f.patches.some(p => p.name === "activity_log")).toBe(true);
  });
  it("captures routing reason actor and opt-in before deferred transaction startup", async () => {
    const f = fixture(); let start!: () => void; const barrier = new Promise<void>(r => { start = r; });
    f.root.transaction = async (cb: any) => { await barrier; return cb(f.tx); };
    const issue = { id: "issue-1", companyId: "company-1" }; const actor = { userId: "user-1" }; const input = { reason: " Original " }; const options = { lifecycleFence: true };
    const operation = invoke(f, issue, actor, input, options); void operation.catch(() => {});
    issue.id = "other"; issue.companyId = "foreign"; actor.userId = "other-user"; input.reason = "Changed"; options.lifecycleFence = false; start();
    const row = await operation; expect(row.result.reason).toBe("Original"); expect(row.resolvedByUserId).toBe("user-1");
    expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
    expect(f.queries.at(-1).params).toEqual(["issue-1"]); // post-commit touch retains original ID
    expect(sink.live[0].payload.actorId).toBe("user-1");
  });
  it.each(["done", "cancelled"])("denies authoritative closed %s without card effects", async status => {
    const f = fixture({ status }); await expect(invoke(f)).rejects.toMatchObject({ status: 409 }); expect(f.patches).toEqual([]); expect(sink.live).toEqual([]);
  });
  it("fence rejection has no reads writes or live activity", async () => {
    const f = fixture(); const error = new Error("fence-rejected"); f.tx.execute = async () => { throw error; };
    await expect(invoke(f)).rejects.toBe(error); expect(f.queries).toEqual([]); expect(f.patches).toEqual([]); expect(sink.live).toEqual([]);
  });
  it.each([undefined, false])("keeps ordinary non-opt-in root reads and eager linked activity %s", async lifecycleFence => {
    const f = fixture(); f.root.select = f.tx.select;
    const row = await invoke(f, undefined, undefined, undefined, { lifecycleFence });
    expect(row.status).toBe("cancelled"); expect(sink.events).toEqual(["tx"]); expect(sink.live).toHaveLength(1);
    expect(f.queries[0].params).toEqual(["interaction-1"]);
  });
  it("rejects missing company before startup", async () => {
    const f = fixture(); await expect(invoke(f, { id: "issue-1", companyId: "" })).rejects.toMatchObject({ status: 422 }); expect(sink.events).toEqual([]);
  });
  it("rejects arbitrary hooks before startup", async () => {
    const f = fixture(); await expect(invoke(f, undefined, undefined, undefined, { lifecycleFence: true, afterResolveInTransaction: async () => {} })).rejects.toMatchObject({ status: 422 }); expect(sink.events).toEqual([]);
  });
  it("post-commit touch rejection is not rollback or replay authority", async () => {
    const f = fixture(); const error = new Error("touch-rejected"); f.root.update = () => { throw error; };
    await expect(invoke(f)).rejects.toBe(error); expect(sink.live).toHaveLength(1);
  });
});
