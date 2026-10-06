import { describe, expect, it, vi } from "vitest";
import { issues, issueThreadInteractions, issueQuestionResponseDeliveries } from "@paperclipai/db";
import { questionSetToAskUserQuestionsPayload } from "@paperclipai/shared";
import { PgDialect } from "drizzle-orm/pg-core";
import * as service from "../services/issue-thread-interactions.js";
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/chat-interaction-publications.js", () => ({ enqueueTerminalIssueInteractionChatPublications: async () => {} }));
function fixture(config: { status?: string; issueStatus?: string; insertError?: Error } = {}) {
  const events: string[] = []; const queries: any[] = []; const deliveries: any[] = [];
  const dialect = new PgDialect(); let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const card: any = { id: "card-1", companyId: "company-1", issueId: "issue-1", kind: "ask_user_questions", status: config.status ?? "pending", effectiveResolverPolicy: "human_only", requestedResolverPolicy: "human_only", payload: questionSetToAskUserQuestionsPayload({ schema: "paperclip.question_set.v1", questions: [{ id: "q1", prompt: "Offline", answerMode: "text", required: true }] }) };
  const tx: any = {
    transaction: () => { throw new Error("nested-transaction"); },
    execute: async () => { events.push("fence"); await barrier; },
    select: () => ({ from: (table: any) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q));
      const name = table === issues ? "issue" : table === issueThreadInteractions ? "card" : "unknown";
      if (name === "unknown") throw new Error("unknown-read"); events.push(name+"-read");
      const rows = name === "issue" ? [{ id: "issue-1", companyId: "company-1", status: config.issueStatus ?? "blocked" }] : [{ ...card }];
      const query: any = { then: (ok: any, no: any) => Promise.resolve(rows).then(ok, no), for: (mode: string) => { expect(mode).toBe("update"); events.push(name+"-lock"); return query; } }; return query;
    } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (q: any) => { expect(table).toBe(issueThreadInteractions); queries.push(dialect.sqlToQuery(q)); events.push("card-write"); return { returning: async () => { Object.assign(card, patch); return [{ ...card }]; } }; } }) }),
    insert: (table: any) => ({ values: async (value: any) => { expect(table).toBe(issueQuestionResponseDeliveries); events.push("delivery-write"); if (config.insertError) throw config.insertError; deliveries.push(value); } }),
  };
  return { tx, card, events, queries, deliveries, release };
}
const invoke = (f: ReturnType<typeof fixture>, input: any = { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, actor: any = { userId: "user-1" }) => (service as any).answerQuestionsInTransaction(f.tx, { id: "issue-1", companyId: "company-1" }, "card-1", input, actor);
describe("dark supplied canonical question answer recording", () => {
  it("waits for fence and captures nested answer and actor before suspension", async () => {
    const f = fixture(); const input = { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }], summaryMarkdown: "Original" }; const actor = { userId: "user-1" };
    const pending = invoke(f, input, actor); expect(f.events).toEqual(["fence"]);
    input.answers[0].otherText = "After"; input.summaryMarkdown = "Changed"; actor.userId = "other-user";
    f.release(); const row = await pending;
    expect(row.result.answers[0].otherText).toBe("Before"); expect(row.result.summaryMarkdown).toBe("Original"); expect(row.resolvedByUserId).toBe("user-1");
  });
  it.each(["done", "cancelled"])("vetoes authoritative %s issue before card/write", async issueStatus => {
    const f = fixture({ issueStatus }); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 409 }); expect(f.events).toEqual(["fence", "issue-read", "issue-lock"]);
  });
  it("vetoes locked terminal card without writes", async () => {
    const f = fixture({ status: "cancelled" }); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 409 }); expect(f.events).not.toContain("card-write");
  });
  it("rejects invalid agent identity without writes", async () => {
    const f = fixture(); f.release(); await expect(invoke(f, undefined, { agentId: "agent-1" })).rejects.toMatchObject({ status: 422 }); expect(f.events).not.toContain("card-write");
  });
  it("preserves inherited resolver restriction", async () => {
    const f = fixture(); f.release(); const actor = Object.create({ resolverPolicyRestriction: { policy: "not_creator", source: "issue_review", excludedActor: { type: "user", id: "user-1" } } }); actor.userId = "user-1";
    await expect(invoke(f, undefined, actor)).rejects.toMatchObject({ status: 403 }); expect(f.events).not.toContain("card-write");
  });
  it.each(["restriction", "excludedActor"])("preserves effective inherited %s audience restriction", async representation => {
    const f = fixture(); f.release();
    const restriction = representation === "restriction"
      ? Object.create({ policy: "not_creator", source: "issue_review", excludedActor: { type: "user", id: "user-1" } })
      : { policy: "not_creator", source: "issue_review", excludedActor: Object.create({ type: "user", id: "user-1" }) };
    await expect(invoke(f, undefined, { userId: "user-1", resolverPolicyRestriction: restriction })).rejects.toMatchObject({ status: 403 });
    expect(f.card.status).toBe("pending"); expect(f.deliveries).toEqual([]); expect(f.events).not.toContain("card-write");
  });
  it("retains string not_creator restriction", async () => {
    const f = fixture(); f.card.createdByUserId = "user-1"; f.release();
    await expect(invoke(f, undefined, { userId: "user-1", resolverPolicyRestriction: "not_creator" })).rejects.toMatchObject({ status: 403 });
    expect(f.card.status).toBe("pending"); expect(f.deliveries).toEqual([]);
  });
  it.each(["restriction", "excludedActor"])("allows a different user with inherited %s fields", async representation => {
    const f = fixture(); f.release();
    const restriction = representation === "restriction"
      ? Object.create({ policy: "not_creator", source: "issue_review", excludedActor: { type: "user", id: "other-user" } })
      : { policy: "not_creator", source: "issue_review", excludedActor: Object.create({ type: "user", id: "other-user" }) };
    expect((await invoke(f, undefined, { userId: "user-1", resolverPolicyRestriction: restriction })).status).toBe("answered");
    expect(f.deliveries).toHaveLength(1);
  });
  it("captures non-enumerable getter fields and nested identity before the fence", async () => {
    const f = fixture(); let excludedId = "user-1"; let policy = "not_creator"; let reads = 0;
    const excludedActor = Object.defineProperties({}, {
      type: { get: () => "user" }, id: { get: () => { reads++; return excludedId; } },
    });
    const restriction = Object.defineProperties({}, {
      policy: { get: () => policy }, source: { get: () => "issue_review" }, excludedActor: { get: () => excludedActor },
    });
    const pending = invoke(f, undefined, { userId: "user-1", resolverPolicyRestriction: restriction });
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    expect(f.events).toEqual(["fence"]); expect(reads).toBe(1);
    excludedId = "other-user"; policy = "anyone"; f.release(); await rejected;
    expect(reads).toBe(1); expect(f.card.status).toBe("pending"); expect(f.deliveries).toEqual([]);
  });
  it("retains fail-closed null excluded identity", async () => {
    const f = fixture(); f.release();
    const restriction = Object.create({ policy: "not_creator", source: "issue_review", excludedActor: null });
    await expect(invoke(f, undefined, { userId: "user-1", resolverPolicyRestriction: restriction })).rejects.toMatchObject({ status: 403 });
    expect(f.deliveries).toEqual([]); expect(f.card.status).toBe("pending");
  });
  it.each([null, undefined, "anyone", "human_only"])("retains non-excluding restriction %s", async restriction => {
    const f = fixture(); f.release();
    expect((await invoke(f, undefined, { userId: "user-1", resolverPolicyRestriction: restriction })).status).toBe("answered");
    expect(f.deliveries).toHaveLength(1);
  });
  it("propagates delivery failure with no successful return (not rollback)", async () => {
    const error = new Error("delivery-store"); const f = fixture({ insertError: error }); f.release(); await expect(invoke(f)).rejects.toBe(error); expect(f.card.status).toBe("answered");
  });
  it("retains required answer validation without writes", async () => {
    const f = fixture(); f.release(); await expect(invoke(f, { answers: [] })).rejects.toMatchObject({ status: 422 }); expect(f.events).not.toContain("card-write");
  });
  it("propagates fence rejection before reads", async () => {
    const f = fixture(); const error = new Error("fence"); f.tx.execute = async () => { throw error; }; await expect(invoke(f)).rejects.toBe(error); expect(f.events).toEqual([]);
  });
  it("fences issue and card before actual answer and delivery persistence without nested tx", async () => {
    const f = fixture(); f.release(); const result = await invoke(f);
    expect(result.status).toBe("answered"); expect(f.events).toEqual(["fence", "issue-read", "issue-lock", "card-read", "card-lock", "card-write", "delivery-write"]);
    expect(f.deliveries).toHaveLength(1); expect(f.queries.at(-1).params).toEqual(["card-1", "pending", "company-1", "issue-1"]);
  });
});
