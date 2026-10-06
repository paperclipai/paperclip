import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";
import { publishActivity } from "../services/activity-log.js";
const sink = vi.hoisted(() => ({ live: [] as any[] }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: (event: any) => sink.live.push(event) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableIsolatedWorkspaces: false }), getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/status-card-finalization.js", () => ({ finalizeStatusCardsForStalledGeneration: async () => undefined }));
vi.mock("../services/summary-slot-finalization.js", () => ({ finalizeSummarySlotsForTerminalIssue: async () => undefined }));
vi.mock("../services/chat-interaction-publications.js", () => ({ enqueueTerminalIssueInteractionChatPublications: async () => undefined }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
// Actual canonical writer, terminal participant and activity logger. Recording
// rows are eager; outer completion is a Promise, never SQL rollback evidence.
function fixture() {
  sink.live.length = 0;
  const events: string[] = []; const publications: any[] = [];
  let row: any = { id: "issue-1", companyId: "company-1", status: "in_progress", title: "Offline", parentId: null, projectId: null, goalId: null, originKind: "manual", assigneeAgentId: "agent-1", assigneeUserId: null, statusVersion: 1 };
  const card: any = { id: "card-1", companyId: "company-1", issueId: "issue-1", kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Offline" }, result: null };
  function query(rows: any[]) {
    const q: any = { where: () => q, innerJoin: () => q, leftJoin: () => q, orderBy: () => q, limit: () => q, for: () => q, returning: () => q, then: (ok: any, no: any) => Promise.resolve(rows).then(ok, no) }; return q;
  }
  const tx: any = {
    execute: async () => { events.push("fence"); },
    transaction: () => { throw new Error("nested-transaction"); },
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`read:${name}`);
      if (name === "issues") return query([{ ...row }]);
      if (name === "issue_thread_interactions") return query(card.status === "pending" ? [{ ...card }] : []);
      if (name === "companies") return query([{ defaultResponsibleUserId: "user-1" }]);
      if (["goals", "projects", "issue_labels", "labels", "issue_watchdogs"].includes(name)) return query([]);
      throw new Error(`unknown-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: () => {
      const name = getTableName(table); events.push(`write:${name}`);
      if (name === "issues") { row = { ...row, ...patch }; return query([{ ...row }]); }
      if (name === "tool_action_requests") return query([]);
      if (name === "issue_thread_interactions") { Object.assign(card, patch); return query([{ ...card }]); }
      throw new Error(`unknown-write:${name}`);
    } }) }),
    insert: (table: any) => ({ values: (value: any) => {
      expect(getTableName(table)).toBe("activity_log"); events.push("activity-persist"); return query([{ ...value, id: "activity-1" }]);
    } }),
  };
  const root: any = {
    select: () => { throw new Error("root-read"); },
    transaction: async (cb: any) => { events.push("begin"); const result = await cb(tx); events.push("outer-resolve"); return result; },
  };
  const run = (owned: boolean, fence = true) => issueService(root).update("issue-1", { status: "done", companyGuard: "company-1" }, owned ? root : tx, owned ? undefined : publications, [], { lifecycleFence: fence });
  return { root, tx, events, publications, run, card };
}
describe("dark canonical terminal expiry supplied integration", () => {
  it.each(["done", "cancelled"])("rejects supplied %s without caller activity queue before any effects", async status => {
    const f = fixture();
    await expect(issueService(f.root).update("issue-1", { status, companyGuard: "company-1" }, f.tx, undefined, [], { lifecycleFence: true }))
      .rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]);
    expect(f.card.status).toBe("pending");
    expect(f.publications).toEqual([]);
    expect(sink.live).toEqual([]);
  });
  it("rejects a supplied terminal update even when there are no pending cards", async () => {
    const f = fixture(); f.card.status = "expired";
    await expect(issueService(f.root).update("issue-1", { status: "done", companyGuard: "company-1" }, f.tx, undefined, [], { lifecycleFence: true }))
      .rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]); expect(sink.live).toEqual([]);
  });
  it.each([undefined, false])("ordinary supplied terminal without caller queue retains eager default flag=%s", async lifecycleFence => {
    const f = fixture(); f.root.select = f.tx.select;
    f.tx.transaction = async (cb: any) => { f.events.push("ordinary-nested"); return cb(f.tx); };
    const args: any[] = ["issue-1", { status: "done" }, f.tx, undefined, []];
    if (lifecycleFence !== undefined) args.push({ lifecycleFence });
    await (issueService(f.root).update as any)(...args);
    expect(f.card.status).toBe("expired"); expect(sink.live).toHaveLength(1);
    expect(f.events).not.toContain("fence");
  });
  it("a nonterminal dark supplied update does not acquire the terminal queue requirement", async () => {
    const f = fixture();
    await expect(issueService(f.root).update("issue-1", { title: "Renamed", companyGuard: "company-1" }, f.tx, undefined, [], { lifecycleFence: true }))
      .resolves.toMatchObject({ title: "Renamed", status: "in_progress" });
    expect(f.card.status).toBe("pending"); expect(sink.live).toEqual([]);
  });
  it("propagates outer commit rejection without emitting recorded activity", async () => {
    const f = fixture(); const error = new Error("commit-denied");
    f.root.transaction = async (cb: any) => { await cb(f.tx); throw error; };
    await expect(f.run(true)).rejects.toBe(error);
    expect(sink.live).toEqual([]); expect(f.card.status).toBe("expired"); // eager rows, not rollback
  });
  it("propagates second fence rejection after eager status recording with no live event", async () => {
    const f = fixture(); const error = new Error("participant-fence-denied"); let calls = 0;
    f.tx.execute = async () => { if (++calls === 2) throw error; };
    await expect(f.run(false)).rejects.toBe(error);
    expect(f.card.status).toBe("pending"); expect(f.publications).toEqual([]); expect(sink.live).toEqual([]);
  });
  it("waits for the reentrant participant fence before interaction reads", async () => {
    const f = fixture(); let release!: () => void; let signal!: () => void; let calls = 0;
    const barrier = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { signal = r; });
    f.tx.execute = async () => { f.events.push("fence"); if (++calls === 2) { signal(); await barrier; } };
    const operation = f.run(false);
    try {
      expect(await Promise.race([entered.then(() => "fence"), operation.then(() => "settled", () => "rejected")])).toBe("fence");
      expect(f.events).not.toContain("read:issue_thread_interactions"); expect(sink.live).toEqual([]);
    } finally { release(); await operation; }
    expect(f.publications).toHaveLength(1);
  });
  it.each([undefined, false])("ordinary supplied hook remains non-fenced and nested-owning flag=%s", async lifecycleFence => {
    const f = fixture(); f.root.select = f.tx.select;
    f.tx.transaction = async (cb: any) => { f.events.push("ordinary-nested"); return cb(f.tx); };
    await issueService(f.root).update("issue-1", { status: "done" }, f.tx, [], [], { lifecycleFence });
    expect(f.events).toContain("ordinary-nested"); expect(f.events).not.toContain("fence"); expect(sink.live).toHaveLength(1);
  });
  it("supplied transaction activity failure propagates before queue or live delivery", async () => {
    const f = fixture(); const error = new Error("activity-storage-denied"); f.tx.insert = () => { throw error; };
    await expect(f.run(false)).rejects.toBe(error);
    expect(f.publications).toEqual([]); expect(sink.live).toEqual([]);
  });
  it.each([false, true])("uses the supplied participant, no nested owner or precommit live event owned=%s", async owned => {
    const f = fixture();
    if (owned) f.root.transaction = async (cb: any) => { f.events.push("begin"); const result = await cb(f.tx); expect(sink.live).toEqual([]); f.events.push("outer-resolve"); return result; };
    await expect(f.run(owned)).resolves.toMatchObject({ status: "done" });
    expect(f.events.filter(e => e === "fence")).toHaveLength(2);
    expect(f.card.status).toBe("expired");
    if (!owned) { expect(sink.live).toEqual([]); expect(f.publications).toHaveLength(1); for (const p of f.publications) publishActivity(p); }
    expect(sink.live).toHaveLength(1);
  });
});
