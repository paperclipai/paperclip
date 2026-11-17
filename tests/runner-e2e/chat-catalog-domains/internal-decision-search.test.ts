import { describe, expect, it } from "vitest";
import { gradeDecisionSearch } from "./internal-decision-search.js";
export function validDecisionSearch() {
  const t = { id: "question-task", identifier: "RUN-1", title: "Riley launch question", status: "backlog" }; const history = { id: "history-task", identifier: "RUN-2", title: "Completed launch information", status: "backlog" };
  const hiring = { id: "hire", companyId: "company", status: "pending", decidedByUserId: null }; const pendingQuestion = { id: "question", title: "Riley: choose the launch audience", companyId: "company", issueId: t.id, status: "pending", addresseeUserId: "riley", effectiveResolverPolicy: "human_only" };
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
  it("rejects wrong source or foreign links", () => { const o = validDecisionSearch(); o.links[0] = "https://foreign.test/RUN/approvals/hire"; expect(gradeDecisionSearch(o).passed).toBe(false); });
  it("rejects changed completed answer and board-feed privilege substitution", () => { const o = validDecisionSearch(); o.completedQuestion.result.answers = ["changed"]; expect(gradeDecisionSearch(o).passed).toBe(false); const admin = validDecisionSearch(); admin.permissionStatus = 200; expect(gradeDecisionSearch(admin).passed).toBe(false); });
  // Shape of a real reply (runner-opencode, run 42404417353) once the approval route is available: the
  // "waiting on you" meaning sits in the list heading, and the answered request is listed apart as not needing a decision.
  const sectioned = [
    "One decision is waiting on you:", "",
    "- **[Hire approval: \"Launch designer\"](/RUN/approvals/hire)** — pending `hire_agent` approval (role: designer).", "",
    "Pending but not on you:",
    "- [RUN-1](/RUN/issues/RUN-1) holds an open question, \"Riley: choose the launch audience,\" addressed to Riley (operator), not your account.",
    "- [RUN-1](/RUN/issues/RUN-1) and [RUN-2](/RUN/issues/RUN-2) are unassigned backlog tasks with no decisions required yet.",
  ].join("\n");
  const withReply = (reply: string) => { const o = validDecisionSearch(); o.reply = reply; o.links = ["/RUN/approvals/hire", "/RUN/issues/RUN-1", "/RUN/issues/RUN-2"]; return o; };
  it("accepts a sectioned reply whose headings carry who each item waits on", () => expect(gradeDecisionSearch(withReply(sectioned)).passed).toBe(true));
  it("accepts a reworded sectioned reply", () => expect(gradeDecisionSearch(withReply([
    "Needs your call", "1. [Launch designer](/RUN/approvals/hire) hire request.", "",
    "Someone else's", "1. [RUN-1](/RUN/issues/RUN-1): only Riley can respond to it.", "",
    "Done already", "1. [RUN-2](/RUN/issues/RUN-2): you replied to the brief question earlier; nothing left to do.",
  ].join("\n"))).passed).toBe(true));
  // Cohort 15 (OpenCode + DeepSeek), retained verbatim apart from the approval id: correct, but the old grader required
  // the word "Riley" in the reply. The reply's meaning (who resolves what, and the separation) is for human review.
  const cohort15 = [
    "One decision is waiting on you: approving or declining the hire of the **Launch designer** agent (designer role, scoped to creating launch design proposals).", "",
    "Approve or decline it here: [Launch designer hire approval](/RUN/approvals/hire).", "",
    "For completeness: the only other open question is on [RUN-1](/RUN/issues/RUN-1) and is addressed to a different teammate, so it is not waiting on you; the question on [RUN-2](/RUN/issues/RUN-2) is already answered.",
  ].join("\n");
  it("accepts the retained cohort-15 reply and a meaning-preserving rewording", () => {
    expect(gradeDecisionSearch(withReply(cohort15)).passed).toBe(true);
    expect(gradeDecisionSearch(withReply("Only the [Launch designer hire](/RUN/approvals/hire) needs you. [RUN-1](/RUN/issues/RUN-1) waits on someone else and [RUN-2](/RUN/issues/RUN-2) is done.")).passed).toBe(true);
  });
  it.each([["pending-hire-linked", 0], ["addressed-question-linked", 1], ["completed-request-linked", 2]] as const)("rejects a reply that does not link the right source: %s", (check, index) => {
    const o = withReply(cohort15); o.links.splice(index, 1);
    expect(gradeDecisionSearch(o).checks.filter(row => !row.passed).map(row => row.id)).toEqual([check]);
    const wrong = withReply(cohort15); wrong.links[index] = index === 0 ? "/RUN/approvals/other" : "/RUN/issues/RUN-9";
    expect(gradeDecisionSearch(wrong).checks.filter(row => !row.passed).map(row => row.id)).toEqual([check]);
  });
  it("rejects an unlinked approval", () => { const o = withReply(sectioned.replace("[Hire approval: \"Launch designer\"](/RUN/approvals/hire)", "Hire approval: \"Launch designer\"")); o.links = o.links.slice(1); expect(gradeDecisionSearch(o).passed).toBe(false); });
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
