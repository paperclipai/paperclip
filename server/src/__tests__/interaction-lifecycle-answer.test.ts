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
  it("routes canonical owned opt-in through pre-read transaction boundary", async () => {
    const f = fixture(); f.release();
    const root: any = { select: () => { throw new Error("root-read"); }, transaction: async (callback: any) => {
      f.events.push("owned-tx"); return callback(f.tx);
    } };
    const row = await service.issueThreadInteractionService(root).answerQuestions(
      { id: "issue-1", companyId: "company-1" }, "card-1",
      { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] },
      { userId: "user-1" }, {}, undefined, { lifecycleFence: true },
    );
    expect(row.status).toBe("answered");
    expect(f.events[0]).toBe("owned-tx"); expect(f.events[1]).toBe("fence");
    expect(f.deliveries).toHaveLength(1);
  });
  it.each(["beforeResolveInTransaction", "afterResolveInTransaction"])("denies canonical owned opt-in hook %s before effects", async hook => {
    const f = fixture(); const transaction = vi.fn();
    await expect(service.issueThreadInteractionService({ transaction } as any).answerQuestions(
      { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [] }, {},
      { [hook]: vi.fn() }, undefined, { lifecycleFence: true },
    )).rejects.toMatchObject({ status: 422 });
    expect(transaction).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });
  it.each([
    ["beforeResolveInTransaction", "inherited"], ["beforeResolveInTransaction", "non-enumerable"], ["beforeResolveInTransaction", "class"],
    ["afterResolveInTransaction", "inherited"], ["afterResolveInTransaction", "non-enumerable"], ["afterResolveInTransaction", "class"],
  ] as const)("denies effective canonical owned hook %s via %s before effects", async (hook, representation) => {
      const f = fixture(); f.release(); const hookCall = vi.fn();
      class BeforeOptions { async beforeResolveInTransaction() { hookCall(); } }
      class AfterOptions { async afterResolveInTransaction() { hookCall(); } }
      const options = representation === "inherited" ? Object.create({ [hook]: hookCall })
        : representation === "non-enumerable" ? Object.defineProperty({}, hook, { value: hookCall })
        : hook === "beforeResolveInTransaction" ? new BeforeOptions() : new AfterOptions();
      const transaction = vi.fn(async (callback: any) => { f.events.push("owned-tx"); return callback(f.tx); });
      await expect(service.issueThreadInteractionService({ transaction } as any).answerQuestions(
        { id: "issue-1", companyId: "company-1" }, "card-1",
        { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] },
        { userId: "user-1" }, options, undefined, { lifecycleFence: true },
      )).rejects.toMatchObject({ status: 422 });
      expect(transaction).not.toHaveBeenCalled(); expect(hookCall).not.toHaveBeenCalled();
      expect(f.events).toEqual([]); expect(f.card.status).toBe("pending"); expect(f.deliveries).toEqual([]);
  });
  it.each(["beforeResolveInTransaction", "afterResolveInTransaction"] as const)("propagates effective hook getter error for %s before effects", async hook => {
    const f = fixture(); const error = new Error("hook-read-failure"); const transaction = vi.fn();
    const options = Object.create(Object.defineProperty({}, hook, { get() { throw error; } }));
    await expect(service.issueThreadInteractionService({ transaction } as any).answerQuestions(
      { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [] }, {}, options, undefined, { lifecycleFence: true },
    )).rejects.toBe(error);
    expect(transaction).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
    expect(f.card.status).toBe("pending"); expect(f.deliveries).toEqual([]);
  });
  it.each([undefined, false])("preserves canonical ordinary inherited hooks opt-in=%s", async lifecycleFence => {
    const f = fixture(); f.release(); const before = vi.fn(); const after = vi.fn();
    const root: any = { ...f.tx,
      transaction: async (callback: any) => callback(f.tx),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    await service.issueThreadInteractionService(root).answerQuestions(
      { id: "issue-1", companyId: "company-1" }, "card-1",
      { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, { userId: "user-1" },
      Object.create({ beforeResolveInTransaction: before, afterResolveInTransaction: after }), undefined,
      lifecycleFence === undefined ? undefined : { lifecycleFence },
    );
    expect(before).toHaveBeenCalledTimes(1); expect(after).toHaveBeenCalledTimes(1);
    expect(f.card.status).toBe("answered"); expect(f.deliveries).toHaveLength(1);
    expect(f.events).not.toContain("lifecycle-fence");
  });
  it("denies canonical owned opt-in on an explicit supplied tx before effects", async () => {
    const f = fixture(); const transaction = vi.fn();
    await expect(service.issueThreadInteractionService({ transaction } as any).answerQuestions(
      { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [] }, {}, {}, f.tx, { lifecycleFence: true },
    )).rejects.toMatchObject({ status: 422 });
    expect(transaction).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });
  it.each([undefined, false])("preserves canonical ordinary opt-in=%s read/owned-write/touch order", async lifecycleFence => {
    const f = fixture(); f.release();
    const root: any = { ...f.tx,
      transaction: async (callback: any) => { f.events.push("ordinary-tx"); return callback(f.tx); },
      update: (table: any) => { expect(table).toBe(issues); return { set: () => ({ where: async () => { f.events.push("touch"); } }) }; },
    };
    const args: any[] = [{ id: "issue-1", companyId: "company-1" }, "card-1", { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, { userId: "user-1" }];
    if (lifecycleFence === false) args.push({}, undefined, { lifecycleFence: false });
    const row = await (service.issueThreadInteractionService(root).answerQuestions as any)(...args);
    expect(row.status).toBe("answered");
    expect(f.events).toEqual(["card-read", "ordinary-tx", "card-write", "delivery-write", "touch"]);
  });
  it("captures canonical opt-in routing and audience before deferred startup", async () => {
    const f = fixture(); let start!: () => void;
    const startup = new Promise<void>(r => { start = r; });
    const root: any = { transaction: async (callback: any) => { f.events.push("owned-tx"); await startup; return callback(f.tx); } };
    const issue = { id: "issue-1", companyId: "company-1" };
    const restriction = Object.create({ policy: "not_creator", source: "issue_review", excludedActor: { type: "user", id: "user-1" } });
    const actor = { userId: "user-1", resolverPolicyRestriction: restriction };
    const pending = service.issueThreadInteractionService(root).answerQuestions(issue, "card-1", { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, actor, {}, undefined, { lifecycleFence: true });
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    try {
      issue.id = "other-issue"; issue.companyId = "other-company"; restriction.policy = "anyone";
      start(); f.release(); await rejected;
      expect(f.card.status).toBe("pending"); expect(f.deliveries).toEqual([]);
      expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
    } finally { start(); f.release(); await Promise.allSettled([pending]); }
  });
  it("propagates canonical opt-in outer rejection without receipt (not rollback)", async () => {
    const f = fixture(); f.release(); const error = new Error("outer-commit");
    const root: any = { transaction: async (callback: any) => { await callback(f.tx); throw error; } };
    await expect(service.issueThreadInteractionService(root).answerQuestions(
      { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, { userId: "user-1" }, {}, undefined, { lifecycleFence: true },
    )).rejects.toBe(error);
    expect(f.card.status).toBe("answered"); expect(f.deliveries).toHaveLength(1);
  });
  it("starts owned answer before reads and captures input before deferred transaction startup", async () => {
    const f = fixture(); let start!: () => void; let commit!: () => void;
    const startup = new Promise<void>(r => { start = r; });
    const committed = new Promise<void>(r => { commit = r; });
    const root: any = { select: () => { throw new Error("root-read"); }, transaction: async (callback: any) => {
      f.events.push("owned-tx"); await startup; const result = await callback(f.tx); await committed; return result;
    } };
    const issue = { id: "issue-1", companyId: "company-1" };
    const input = { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }], summaryMarkdown: "Original" };
    const actor = { userId: "user-1" };
    const pending = (service as any).answerQuestionsWithLifecycleFence(root, issue, "card-1", input, actor);
    let returned = false; const observed = pending.then((row: any) => { returned = true; return row; });
    void observed.catch(() => {});
    try {
      expect(f.events).toEqual(["owned-tx"]);
      issue.id = "other-issue"; issue.companyId = "other-company"; input.answers[0].otherText = "After"; actor.userId = "other-user";
      start(); f.release();
      await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
      expect(returned).toBe(false); commit(); const row = await observed;
      expect(row.result.answers[0].otherText).toBe("Before"); expect(row.resolvedByUserId).toBe("user-1");
      expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
    } finally {
      start(); f.release(); commit(); await Promise.allSettled([observed]);
    }
  });
  it("keeps inherited audience veto across owned deferred startup", async () => {
    const f = fixture(); let start!: () => void;
    const startup = new Promise<void>(r => { start = r; });
    const root: any = { transaction: async (callback: any) => { await startup; return callback(f.tx); } };
    const restriction = Object.create({ policy: "not_creator", source: "issue_review", excludedActor: { type: "user", id: "user-1" } });
    const actor = { userId: "user-1", resolverPolicyRestriction: restriction };
    const pending = (service as any).answerQuestionsWithLifecycleFence(root, { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, actor);
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    restriction.policy = "anyone"; restriction.excludedActor = { type: "user", id: "other-user" };
    start(); f.release(); await rejected;
    expect(f.card.status).toBe("pending"); expect(f.deliveries).toEqual([]); expect(f.events).not.toContain("card-write");
  });
  it("does not return an owned receipt when outer commit promise rejects (not rollback)", async () => {
    const f = fixture(); f.release(); const error = new Error("outer-commit");
    const root: any = { transaction: async (callback: any) => { await callback(f.tx); throw error; } };
    await expect((service as any).answerQuestionsWithLifecycleFence(root, { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, { userId: "user-1" })).rejects.toBe(error);
    expect(f.card.status).toBe("answered"); expect(f.deliveries).toHaveLength(1);
  });
  it("propagates owned delivery rejection without successful return", async () => {
    const error = new Error("delivery-store"); const f = fixture({ insertError: error }); f.release();
    const root: any = { transaction: async (callback: any) => callback(f.tx) };
    await expect((service as any).answerQuestionsWithLifecycleFence(root, { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [{ questionId: "q1", optionIds: [], otherText: "Before" }] }, { userId: "user-1" })).rejects.toBe(error);
    expect(f.card.status).toBe("answered"); expect(f.deliveries).toEqual([]);
  });
  it("denies missing company and getter failure before owned startup", async () => {
    const f = fixture(); const transaction = vi.fn(); const root: any = { transaction };
    await expect((service as any).answerQuestionsWithLifecycleFence(root, { id: "issue-1", companyId: "" }, "card-1", { answers: [] }, {})).rejects.toMatchObject({ status: 422 });
    const error = new Error("audience-getter");
    const actor = Object.defineProperty({ userId: "user-1" }, "resolverPolicyRestriction", { get: () => { throw error; } });
    await expect((service as any).answerQuestionsWithLifecycleFence(root, { id: "issue-1", companyId: "company-1" }, "card-1", { answers: [] }, actor)).rejects.toBe(error);
    expect(transaction).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });
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
