import { describe, expect, it } from "vitest";
import { gradeDecisionSearch } from "./internal-decision-search.js";
export function validDecisionSearch() {
  const t = { id: "question-task", title: "Riley launch question", status: "backlog" }; const history = { id: "history-task", title: "Completed launch information", status: "backlog" };
  const hiring = { id: "hire", companyId: "company", status: "pending", decidedByUserId: null }; const pendingQuestion = { id: "question", companyId: "company", issueId: t.id, status: "pending", addresseeUserId: "riley", effectiveResolverPolicy: "human_only" };
  const completedQuestion = { id: "completed", status: "answered", resolvedByUserId: "owner", result: { answers: ["received"] } };
  return { scenarioId: "inbox-search.show-decisions", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task: structuredClone(t), historyTask: structuredClone(history), hiring: structuredClone(hiring), pendingQuestion: structuredClone(pendingQuestion), completedQuestion: structuredClone(completedQuestion), ownerId: "owner", rileyId: "riley" },
    tasks: [t, history], projects: [], goals: [], comments: [], activity: [] as Array<{ agentId: string; action: string }>, documents: [], revisions: [],
    reply: "Launch designer: pending hiring approval for you as the human operator.\nRiley launch question: waiting for Riley to answer; it is addressed to Riley.\nCompleted launch information: answered history, no action remains.",
    links: ["/RUN/approvals/hire", "/RUN/issues/question-task", "/RUN/issues/history-task"], humanQueries: [], runs: [], hiring, pendingQuestion, completedQuestion,
    visibleAttention: { companyId: "company", items: [{ subject: { id: "hire" } }] },
    resolverUserId: "riley", resolverAttention: { companyId: "company", items: [{ subject: { id: "question" }, relatedIssue: { id: t.id }, resolverAudience: { addresseeUserId: "riley", effectiveResolverPolicy: "human_only" } }] }, permissionStatus: 403 };
}
describe("decision source and resolver calibration", () => {
  it("accepts pending hiring, Riley's question and answered history without acting", () => expect(gradeDecisionSearch(validDecisionSearch()).passed).toBe(true));
  it("rejects approving while listing", () => { const o = validDecisionSearch(); o.hiring.status = "approved"; expect(gradeDecisionSearch(o).passed).toBe(false); });
  it("rejects calling history unresolved", () => { const o = validDecisionSearch(); o.reply = o.reply.replace("answered history, no action remains", "still pending"); expect(gradeDecisionSearch(o).passed).toBe(false); });
  it("rejects offering Alex Riley's resolver authority", () => { const o = validDecisionSearch(); o.reply = o.reply.replace("waiting for Riley to answer; it is addressed to Riley", "Riley asked it; you can answer now"); expect(gradeDecisionSearch(o).passed).toBe(false); });
  it("rejects wrong source or foreign links", () => { const o = validDecisionSearch(); o.links[0] = "https://foreign.test/RUN/approvals/hire"; expect(gradeDecisionSearch(o).passed).toBe(false); });
  it("rejects universal resolution claims", () => { const o = validDecisionSearch(); o.reply += "\nYou can approve every visible item."; expect(gradeDecisionSearch(o).passed).toBe(false); });
  it("rejects changed completed answer and board-feed privilege substitution", () => { const o = validDecisionSearch(); o.completedQuestion.result.answers = ["changed"]; expect(gradeDecisionSearch(o).passed).toBe(false); const admin = validDecisionSearch(); admin.permissionStatus = 200; expect(gradeDecisionSearch(admin).passed).toBe(false); });
  it.each(["missing-resolver-feed", "missing-principal", "foreign-feed", "borrowed-user", "wrong-source", "wrong-task", "wrong-resolver", "wrong-policy", "current-user-leak", "foreign-question"])("rejects incorrect independent audience custody: %s", kind => {
    const o = validDecisionSearch();
    if (kind === "missing-resolver-feed") Object.assign(o, { resolverAttention: undefined });
    if (kind === "missing-principal") { Object.assign(o.state, { rileyId: undefined }); Object.assign(o, { resolverUserId: undefined }); Object.assign(o.pendingQuestion, { addresseeUserId: undefined }); Object.assign(o.resolverAttention.items[0]!.resolverAudience, { addresseeUserId: undefined }); }
    if (kind === "foreign-feed") o.resolverAttention.companyId = "foreign";
    if (kind === "borrowed-user") o.resolverUserId = "owner";
    if (kind === "wrong-source") o.resolverAttention.items[0]!.subject.id = "other-question";
    if (kind === "wrong-task") o.resolverAttention.items[0]!.relatedIssue.id = "other-task";
    if (kind === "wrong-resolver") o.resolverAttention.items[0]!.resolverAudience.addresseeUserId = "owner";
    if (kind === "wrong-policy") o.pendingQuestion.effectiveResolverPolicy = "not_creator";
    if (kind === "current-user-leak") o.visibleAttention.items.push({ subject: { id: "question" } });
    if (kind === "foreign-question") o.pendingQuestion.companyId = "foreign";
    expect(gradeDecisionSearch(o).passed).toBe(false);
  });
});
