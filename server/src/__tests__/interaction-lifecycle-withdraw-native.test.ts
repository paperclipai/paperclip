import { describe, expect, it, vi } from "vitest";
import { heartbeatRuns, issues, issueThreadInteractions, toolActionRequests } from "@paperclipai/db";
import { questionSetToAskUserQuestionsPayload } from "@paperclipai/shared";
import { PgDialect } from "drizzle-orm/pg-core";
import * as composition from "../services/interaction-native-withdrawal.js";
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/chat-interaction-publications.js", () => ({ enqueueTerminalIssueInteractionChatPublications: async () => {} }));
function fixture(config: { runStatus?: string; missingRun?: boolean; markerError?: Error; cardError?: Error } = {}) {
  const events: string[] = []; const queries: any[] = []; const markers: any[] = []; const dialect = new PgDialect();
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const card: any = { id: "card-1", companyId: "company-1", issueId: "issue-1", kind: "ask_user_questions", status: "pending", sourceRunId: "run-1", idempotencyKey: "paperclip-runner-question:run-1:request-1", result: null, payload: { ...questionSetToAskUserQuestionsPayload({ schema: "paperclip.question_set.v1", questions: [{ id: "q1", prompt: "Offline", answerMode: "text", required: true }] }), runtimeRequestId: "request-1" } };
  const tx: any = {
    transaction: () => { throw new Error("nested-transaction"); },
    execute: async () => { events.push("fence"); await barrier; },
    select: () => ({ from: (table: any) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q));
      const name = table === issues ? "issue" : table === issueThreadInteractions ? "card" : table === heartbeatRuns ? "run" : table === toolActionRequests ? "tool" : "unknown";
      if (name === "unknown") throw new Error("unknown-read");
      events.push(name+"-read");
      const rows = name === "issue" ? [{ id: "issue-1", companyId: "company-1", status: "blocked" }] : name === "card" ? [{ ...card }] : name === "tool" || config.missingRun ? [] : [{ id: "run-1", companyId: "company-1", issueId: "issue-1", runtimeMode: "native", status: config.runStatus ?? "running" }];
      const query: any = { then: (ok: any, no: any) => Promise.resolve(rows).then(ok, no), orderBy: () => query, limit: () => query, for: (mode: string) => { expect(mode).toBe("update"); events.push(name+"-lock"); return query; } }; return query;
    } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q));
      if (table === toolActionRequests) return { returning: async () => [] };
      if (table === heartbeatRuns) { events.push("marker-write"); markers.push(dialect.sqlToQuery(patch.contextSnapshot)); return { returning: () => Promise.resolve().then(() => { if (config.markerError) throw config.markerError; return [{ id: "run-1" }]; }) }; }
      expect(table).toBe(issueThreadInteractions); events.push("card-write"); return { returning: async () => { if (config.cardError) throw config.cardError; Object.assign(card, patch); return [{ ...card }]; } };
    } }) }),
  };
  return { tx, events, queries, markers, card, release };
}
const invoke = (f: ReturnType<typeof fixture>, issue = { id: "issue-1", companyId: "company-1" }, input = { reason: "Offline" }, actor = { userId: "user-1" }, queue: any = []) =>
  (composition as any).withdrawInteractionWithNativeCancellationInTransaction(f.tx, issue, "card-1", input, actor, { postCommitPublications: queue });
describe("dark owned native withdrawal composition recording", () => {
  it("captures routing actor and reason before deferred root startup", async () => {
    const f = fixture(); f.release(); let start!: () => void; const barrier = new Promise<void>(r => { start = r; });
    const root: any = { transaction: async (cb: any) => { await barrier; return cb(f.tx); } };
    const issue = { id: "issue-1", companyId: "company-1" }; const actor = { userId: "user-1" }; const input = { reason: "Before" };
    const pending = composition.withdrawInteractionWithNativeCancellation(root, issue, "card-1", input, actor); void pending.catch(() => {});
    issue.id = "other"; issue.companyId = "foreign"; actor.userId = "other"; input.reason = "After"; start();
    const result = await pending; expect(result.interaction.result).toMatchObject({ reason: "Before" }); expect(result.interaction.resolvedByUserId).toBe("user-1"); expect(result.nativeRunId).toBe("run-1"); expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
  });
  it("does not expose receipt after outer rejection; eager marker is not rollback", async () => {
    const f = fixture(); f.release(); const error = new Error("outer-rejected");
    const root: any = { transaction: async (cb: any) => { await cb(f.tx); throw error; } };
    await expect(composition.withdrawInteractionWithNativeCancellation(root, { id: "issue-1", companyId: "company-1" }, "card-1", {}, { userId: "user-1" })).rejects.toBe(error); expect(f.markers).toHaveLength(1);
  });
  it("rejects missing company before transaction startup", async () => {
    const transaction = vi.fn(); await expect(composition.withdrawInteractionWithNativeCancellation({ transaction } as any, { id: "issue-1", companyId: "" }, "card-1", {}, {})).rejects.toMatchObject({ status: 422 }); expect(transaction).not.toHaveBeenCalled();
  });
  it("starts at root and exposes receipt only after outer transaction resolves", async () => {
    const f = fixture(); f.release(); let commit!: () => void; let entered!: () => void;
    const signal = new Promise<void>(r => { entered = r; }); const barrier = new Promise<void>(r => { commit = r; });
    const root: any = { select: () => { throw new Error("root-read"); }, transaction: async (cb: any) => { f.events.push("tx"); const result = await cb(f.tx); entered(); await barrier; return result; } };
    const pending = (composition as any).withdrawInteractionWithNativeCancellation(root, { id: "issue-1", companyId: "company-1" }, "card-1", { reason: "Offline" }, { userId: "user-1" });
    let settled = false; const observed = Promise.resolve(pending).then(v => { settled = true; return v; }); void observed.catch(() => {});
    try { expect(await Promise.race([signal.then(() => "callback"), observed.then(() => "settled")])).toBe("callback"); expect(settled).toBe(false); expect(f.markers).toHaveLength(1); }
    finally { commit(); await observed.catch(() => {}); }
    expect(await observed).toMatchObject({ interaction: { status: "cancelled" }, nativeRunId: "run-1" }); expect(f.events[0]).toBe("tx");
  });
});
describe("dark supplied native withdrawal composition recording", () => {
  it.each(["queued", "running", "succeeded", "cancelled"])("eligibility uses actual native status %s", async status => {
    const f = fixture({ runStatus: status }); f.release();
    expect((await invoke(f)).nativeRunId).toBe(["queued", "running"].includes(status) ? "run-1" : null);
    expect(f.markers).toHaveLength(["queued", "running"].includes(status) ? 1 : 0);
  });
  it("returns null receipt for disappeared native run, still withdraws card", async () => {
    const f = fixture({ missingRun: true }); f.release();
    expect(await invoke(f)).toMatchObject({ interaction: { status: "cancelled" }, nativeRunId: null }); expect(f.markers).toEqual([]);
  });
  it("never turns ordinary confirmation withdrawal into a native marker", async () => {
    const f = fixture(); Object.assign(f.card, { kind: "request_confirmation", payload: { version: 1, prompt: "Offline" } }); f.release();
    expect((await invoke(f)).nativeRunId).toBeNull(); expect(f.events).not.toContain("run-read");
  });
  it("does not expose a successful receipt on marker failure (eager recording is NOT rollback)", async () => {
    const error = new Error("marker-rejected"); const f = fixture({ markerError: error }); f.release();
    await expect(invoke(f)).rejects.toBe(error); expect(f.card.status).toBe("cancelled"); expect(f.events).toContain("marker-write");
  });
  it("does not read native run if canonical withdrawal write rejects", async () => {
    const error = new Error("card-rejected"); const f = fixture({ cardError: error }); f.release();
    await expect(invoke(f)).rejects.toBe(error); expect(f.events).not.toContain("run-read");
  });
  it("queue preflight denies missing queue before every effect", async () => {
    const f = fixture();
    await expect((composition as any).withdrawInteractionWithNativeCancellationInTransaction(f.tx, { id: "issue-1", companyId: "company-1" }, "card-1", {}, { userId: "user-1" })).rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]);
  });
  it("captures invocation before first fence; marker uses locked canonical row", async () => {
    const f = fixture(); const issue = { id: "issue-1", companyId: "company-1" }; const input = { reason: "Before" }; const actor = { userId: "user-1" }; const queue = [{ sentinel: true }];
    const pending = invoke(f, issue, input, actor, queue); issue.id = "other"; issue.companyId = "other"; input.reason = "After"; actor.userId = "other";
    expect(f.events).toEqual(["fence"]); f.release(); const result = await pending;
    expect(result.interaction.result).toMatchObject({ reason: "Before" }); expect(result.interaction.resolvedByUserId).toBe("user-1"); expect(result.nativeRunId).toBe("run-1"); expect(queue).toEqual([{ sentinel: true }]);
    expect(f.queries.at(-1).params).toContain("company-1");
  });
  it("awaits marker fence before returning receipt or touching native run", async () => {
    const f = fixture(); let markerRelease!: () => void; let markerEntered!: () => void; const signal = new Promise<void>(r => { markerEntered = r; }); const barrier = new Promise<void>(r => { markerRelease = r; }); let fences = 0;
    f.tx.execute = async () => { if (++fences === 2) { markerEntered(); await barrier; } };
    let settled = false; const pending = invoke(f).then(value => { settled = true; return value; }); await signal;
    expect(settled).toBe(false); expect(f.card.status).toBe("cancelled"); expect(f.events).not.toContain("run-read"); markerRelease(); expect((await pending).nativeRunId).toBe("run-1");
  });
  it("returns cancelled card and same-tx durable native marker receipt under issue-first locks", async () => {
    const f = fixture(); f.release(); const result = await invoke(f);
    expect(result.interaction).toMatchObject({ id: "card-1", status: "cancelled" }); expect(result.nativeRunId).toBe("run-1");
    expect(f.events.indexOf("issue-lock")).toBeLessThan(f.events.indexOf("card-lock"));
    expect(f.events.indexOf("card-write")).toBeLessThan(f.events.indexOf("run-lock"));
    expect(f.events.indexOf("run-lock")).toBeLessThan(f.events.indexOf("marker-write"));
    expect(f.queries.at(-1).params).toEqual(["run-1", "company-1", "issue-1", "native", "queued", "running"]);
    expect(JSON.parse(f.markers[0].params[1])).toMatchObject({ issueId: "issue-1", kind: "interaction_withdrawn", interactionId: "card-1" });
  });
});
