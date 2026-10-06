import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { questionSetToAskUserQuestionsPayload } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { publishActivity } from "../services/activity-log.js";
import { nativeQuestionRunToCancelInTransaction, nativeQuestionRunToCancel, requestNativeQuestionRunCancellationInTransaction } from "../services/native-runtime/native-question-bridge.js";
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
  const native: any = { run: null, marker: null, predicates: [] };
  const dialect = new PgDialect();
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
      if (name === "heartbeat_runs") {
        const q = query(native.run ? [{ ...native.run }] : []);
        q.where = (predicate: any) => { native.predicates.push(dialect.sqlToQuery(predicate)); return q; };
        return q;
      }
      if (["goals", "projects", "issue_labels", "labels", "issue_watchdogs"].includes(name)) return query([]);
      throw new Error(`unknown-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (predicate: any) => {
      const name = getTableName(table); events.push(`write:${name}`);
      if (name === "heartbeat_runs") {
        native.marker = dialect.sqlToQuery(patch.contextSnapshot);
        native.predicates.push(dialect.sqlToQuery(predicate));
        return query([{ id: native.run.id }]);
      }
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
  return { root, tx, events, publications, run, card, native };
}
function nativeFixture() {
  const f = fixture();
  Object.assign(f.card, { kind: "ask_user_questions", sourceRunId: "run-1", idempotencyKey: "paperclip-runner-question:run-1:request-1", payload: { ...questionSetToAskUserQuestionsPayload({ schema: "paperclip.question_set.v1", questions: [{ id: "q1", prompt: "Offline question", answerMode: "text", required: true }] }), runtimeRequestId: "request-1" } });
  f.native.run = { id: "run-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1", runtimeMode: "native", status: "running" };
  return f;
}
describe("dark canonical terminal expiry supplied integration", () => {
  it("fences native cancellation lookup without writing a marker", async () => {
    const f = nativeFixture();
    await expect(nativeQuestionRunToCancelInTransaction(f.tx, f.card)).resolves.toBe("run-1");
    expect(f.events).toEqual(["fence", "read:heartbeat_runs"]);
    expect(f.native.predicates[0].params).toEqual(["run-1", "company-1", "issue-1", "native"]);
    expect(f.native.marker).toBeNull(); expect(sink.live).toEqual([]);
  });
  it("captures native lookup identity before its suspended fence", async () => {
    const f = nativeFixture(); let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>(r => { release = r; }); const signal = new Promise<void>(r => { entered = r; });
    f.tx.execute = async () => { f.events.push("fence"); entered(); await barrier; };
    const operation = nativeQuestionRunToCancelInTransaction(f.tx, f.card);
    try {
      expect(await Promise.race([signal.then(() => "fence"), operation.then(() => "settled", () => "rejected")])).toBe("fence");
      expect(f.events).toEqual(["fence"]);
      Object.assign(f.card, { companyId: "other-company", issueId: "other-issue", sourceRunId: "other-run", idempotencyKey: "bad" });
      f.card.payload.runtimeRequestId = "other-request"; f.card.payload.questionSet = null;
    } finally { release(); }
    expect(await operation).toBe("run-1");
    expect(f.native.predicates[0].params).toEqual(["run-1", "company-1", "issue-1", "native"]);
    expect(f.native.marker).toBeNull();
  });
  it("propagates lookup fence rejection without a read", async () => {
    const f = nativeFixture(); const error = new Error("lookup-fence"); f.tx.execute = async () => { throw error; };
    await expect(nativeQuestionRunToCancelInTransaction(f.tx, f.card)).rejects.toBe(error);
    expect(f.events).toEqual([]); expect(f.native.marker).toBeNull();
  });
  it("denies missing lookup company before effects", async () => {
    const f = nativeFixture(); f.card.companyId = "";
    await expect(nativeQuestionRunToCancelInTransaction(f.tx, f.card)).rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]);
  });
  it.each(["queued", "running", "succeeded", "cancelled"])("preserves native lookup ordinary result without writes for status=%s", async status => {
    const f = nativeFixture(); f.native.run.status = status;
    const expected = ["queued", "running"].includes(status) ? "run-1" : null;
    expect(await nativeQuestionRunToCancelInTransaction(f.tx, f.card)).toBe(expected);
    expect(f.events).toEqual(["fence", "read:heartbeat_runs"]);
    f.events.length = 0;
    expect(await nativeQuestionRunToCancel(f.tx, f.card)).toBe(expected);
    expect(f.events).toEqual(["read:heartbeat_runs"]); expect(f.native.marker).toBeNull();
  });
  it("fenced invalid binding lookup is a no-read null", async () => {
    const f = nativeFixture(); f.card.payload.runtimeRequestId = "other-request";
    expect(await nativeQuestionRunToCancelInTransaction(f.tx, f.card)).toBeNull();
    expect(f.events).toEqual(["fence"]); expect(f.native.marker).toBeNull();
  });
  it("lookup read rejection preserves error identity and never writes", async () => {
    const f = nativeFixture(); const error = new Error("lookup-read"); f.tx.select = () => { throw error; };
    await expect(nativeQuestionRunToCancelInTransaction(f.tx, f.card)).rejects.toBe(error);
    expect(f.events).toEqual(["fence"]); expect(f.native.marker).toBeNull();
  });
  it("fences the native marker participant before its own authoritative read", async () => {
    const f = nativeFixture();
    await expect(requestNativeQuestionRunCancellationInTransaction(f.tx, f.card, { kind: "issue_terminal", issueStatus: "done" })).resolves.toBe("run-1");
    expect(f.events).toEqual(["fence", "read:heartbeat_runs", "write:heartbeat_runs"]);
    expect(sink.live).toEqual([]);
  });
  it("captures native identity and cause before a suspended participant fence", async () => {
    const f = nativeFixture(); let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>(r => { release = r; }); const signal = new Promise<void>(r => { entered = r; });
    const cause: any = { kind: "issue_terminal", issueStatus: "done" };
    f.tx.execute = async () => { f.events.push("fence"); entered(); await barrier; };
    const operation = requestNativeQuestionRunCancellationInTransaction(f.tx, f.card, cause);
    try {
      expect(await Promise.race([signal.then(() => "fence"), operation.then(() => "settled", () => "rejected")])).toBe("fence");
      expect(f.events).toEqual(["fence"]);
      Object.assign(f.card, { companyId: "other-company", issueId: "other-issue", sourceRunId: "other-run", idempotencyKey: "bad" });
      f.card.payload.runtimeRequestId = "mutated"; f.card.payload.questionSet = null; cause.issueStatus = "cancelled";
    } finally { release(); }
    expect(await operation).toBe("run-1");
    expect(f.native.predicates[0].params).toEqual(["run-1", "company-1", "issue-1", "native"]);
    expect(JSON.parse(f.native.marker.params[1])).toMatchObject({ issueId: "issue-1", kind: "issue_terminal", issueStatus: "done" });
  });
  it("propagates participant fence rejection before reads or marker writes", async () => {
    const f = nativeFixture(); const error = new Error("native-fence-denied"); f.tx.execute = async () => { throw error; };
    await expect(requestNativeQuestionRunCancellationInTransaction(f.tx, f.card, { kind: "issue_terminal", issueStatus: "done" })).rejects.toBe(error);
    expect(f.events).toEqual([]); expect(f.native.marker).toBeNull();
  });
  it("denies missing native company before acquiring the participant fence", async () => {
    const f = nativeFixture(); f.card.companyId = "";
    await expect(requestNativeQuestionRunCancellationInTransaction(f.tx, f.card, { kind: "issue_terminal", issueStatus: "done" })).rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]);
  });
  it.each([undefined, null, {}, "queue"])("rejects missing or malformed native action queue before effects: %s", async queue => {
    const f = nativeFixture();
    await expect(issueService(f.root).update("issue-1", { status: "done", companyGuard: "company-1" }, f.tx, f.publications, queue as any, { lifecycleFence: true })).rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]); expect(f.card.status).toBe("pending");
    expect(f.native.marker).toBeNull(); expect(sink.live).toEqual([]);
  });
  it.each(["done", "cancelled"])("records actual native marker and retains caller queues for %s without executing cancellation", async status => {
    const f = nativeFixture(); const sentinel: any = { type: "caller-sentinel" }; const actions: any[] = [sentinel];
    await issueService(f.root).update("issue-1", { status, companyGuard: "company-1" }, f.tx, f.publications, actions, { lifecycleFence: true });
    expect(actions[0]).toBe(sentinel);
    expect(actions.slice(1)).toEqual([{ type: "cancel_native_question_run", runId: "run-1", issueId: "issue-1", issueStatus: status }]);
    expect(f.native.predicates.map((p: any) => p.params)).toEqual([
      ["run-1", "company-1", "issue-1", "native"],
      ["run-1", "company-1", "issue-1", "native", "queued", "running"],
    ]);
    expect(f.native.marker.sql).toContain("jsonb_set");
    expect(f.native.marker.params[0]).toBe("nativeQuestionCancellation");
    expect(JSON.parse(f.native.marker.params[1])).toMatchObject({ version: 1, issueId: "issue-1", kind: "issue_terminal", issueStatus: status });
    expect(f.events.indexOf("write:heartbeat_runs")).toBeGreaterThan(f.events.indexOf("write:issue_thread_interactions"));
    expect(f.events.filter(e => e === "fence")).toHaveLength(3);
    expect(f.card.status).toBe("expired"); expect(f.publications).toHaveLength(1); expect(sink.live).toEqual([]);
  });
  it.each(["succeeded", "cancelled"])("does not queue cancellation for synthetic non-live native run %s", async status => {
    const f = nativeFixture(); f.native.run.status = status; const actions: any[] = [];
    await issueService(f.root).update("issue-1", { status: "done", companyGuard: "company-1" }, f.tx, f.publications, actions, { lifecycleFence: true });
    expect(actions).toEqual([]); expect(f.native.marker).toBeNull(); expect(sink.live).toEqual([]);
  });
  it("does not reinterpret invalid request binding as native cancellation", async () => {
    const f = nativeFixture(); f.card.payload.runtimeRequestId = "other-request"; const actions: any[] = [];
    await issueService(f.root).update("issue-1", { status: "done", companyGuard: "company-1" }, f.tx, f.publications, actions, { lifecycleFence: true });
    expect(actions).toEqual([]); expect(f.native.predicates).toEqual([]); expect(f.native.marker).toBeNull();
  });
  it("propagates native marker storage rejection without an action or live publication", async () => {
    const f = nativeFixture(); const error = new Error("marker-denied"); const update = f.tx.update; const actions: any[] = [];
    f.tx.update = (table: any) => { if (getTableName(table) === "heartbeat_runs") throw error; return update(table); };
    await expect(issueService(f.root).update("issue-1", { status: "done", companyGuard: "company-1" }, f.tx, f.publications, actions, { lifecycleFence: true })).rejects.toBe(error);
    expect(actions).toEqual([]); expect(f.publications).toEqual([]); expect(sink.live).toEqual([]);
    expect(f.card.status).toBe("expired"); // eager recorder, NOT rollback
  });
  it.each(["done", "cancelled"])("rejects supplied %s without caller action queue before effects", async status => {
    const f = fixture();
    await expect(issueService(f.root).update("issue-1", { status, companyGuard: "company-1" }, f.tx, f.publications, undefined, { lifecycleFence: true }))
      .rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]); expect(f.card.status).toBe("pending");
    expect(f.publications).toEqual([]); expect(sink.live).toEqual([]);
  });
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
