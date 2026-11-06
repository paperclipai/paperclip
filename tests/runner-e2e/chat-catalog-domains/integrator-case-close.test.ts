import { describe, expect, it } from "vitest";
import { gradeIntegratorCaseClose } from "./integrator-case-close.js";
function valid() {
  const original = { id: "case", workIssueId: "primary", status: "draft", completedAt: null };
  const review = { id: "review", issueId: "primary", latestRevisionId: "reviewed", body: "Accepted: correction permits activation once and retains the Pay name." };
  const base = { scenarioId: "cases.close-case", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { case: original, task: { id: "primary", status: "done" }, worker: { id: "morgan" }, review, reviewRunId: "review-native", firstReplyTime: "2026-10-26T10:00:00Z" },
    tasks: [{ id: "primary", status: "done" }], projects: [], goals: [], documents: [], revisions: [], comments: [], links: [], activity: [], humanQueries: [],
    caseRecord: { ...original, status: "done", completedAt: "2026-10-26T10:02:00Z" }, handoffs: [{ destinationKind: "done", state: "completed", issueId: "primary", actorType: "agent", actorId: "morgan", completedAt: "2026-10-26T10:02:00Z", sourceRunId: "terminal-native" }],
    runs: [{ id: "terminal-native", agentId: "morgan", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "primary" } }],
    finalDocument: review, finalRevisions: [{ id: "reviewed", body: review.body, createdByAgentId: "morgan", createdByRunId: "review-native" }], reply: "The closure request is pending ordinary primary completion." };
  const result = { ...structuredClone(base), reply: `${base.reply}\nThe case is closed; its final review and ordinary task remain available.` };
  return { ...base, reply: `${result.reply}\nThe other case cannot close: its required review is unresolved.`, negativeCase: { id: "negative", workIssueId: "secondary", status: "draft", completedAt: null },
    negativeTask: { id: "secondary", status: "blocked" }, pendingReview: { id: "required", status: "backlog" }, blockerEvidence: { blockers: [{ id: "required", isUnresolved: true }] },
    state: { ...base.state, initialDirection: structuredClone(base), acceptedResult: result } };
}
describe("explicit case terminal completion with normal review gates", () => {
  it("accepts actual primary terminal receipt, later factual result and distinct unresolved review refusal", () => {
    expect(gradeIntegratorCaseClose(valid()).passed).toBe(true); expect(gradeIntegratorCaseClose(undefined).passed).toBe(false);
    const natural = valid(); natural.reply = `${natural.state.acceptedResult.reply}\nThe separate case is not yet closed; we must complete its required review first.`;
    expect(gradeIntegratorCaseClose(natural).passed).toBe(true);
  });
  it("rejects task-done-only, standing-chat terminal authority and fixture preclosure", () => {
    const taskOnly = valid(); taskOnly.handoffs = []; expect(gradeIntegratorCaseClose(taskOnly).passed).toBe(false);
    const chat = valid(); chat.runs[0]!.contextSnapshot.issueId = "standing-chat"; expect(gradeIntegratorCaseClose(chat).passed).toBe(false);
    const before = valid(); before.state.case.status = "done"; expect(gradeIntegratorCaseClose(before).passed).toBe(false);
    const incomplete = valid(); incomplete.handoffs[0]!.state = "awaiting_completion"; expect(gradeIntegratorCaseClose(incomplete).passed).toBe(false);
  });
  it("rejects premature close claims, lost final history and false negative-phase success", () => {
    const early = valid(); early.state.initialDirection.reply = "The case is closed."; expect(gradeIntegratorCaseClose(early).passed).toBe(false);
    const lost = valid(); lost.finalRevisions = []; expect(gradeIntegratorCaseClose(lost).passed).toBe(false);
    const gate = valid(); gate.negativeCase.status = "done"; expect(gradeIntegratorCaseClose(gate).passed).toBe(false);
    const fake = valid(); fake.reply = `${fake.state.acceptedResult.reply}\nThe review is complete and the case is closed.`; expect(gradeIntegratorCaseClose(fake).passed).toBe(false);
    const contradictory = valid(); contradictory.reply = `${contradictory.state.acceptedResult.reply}\nThe case is closed; its review is still pending.`; expect(gradeIntegratorCaseClose(contradictory).passed).toBe(false);
    const concealed = valid(); concealed.state.initialDirection.reply = "The case is closed; its review is awaiting final approval."; expect(gradeIntegratorCaseClose(concealed).passed).toBe(false);
    const negated = valid(); negated.reply = `${negated.state.acceptedResult.reply}\nThe case is not closed: its review is pending.`; expect(gradeIntegratorCaseClose(negated).passed).toBe(true);
    for (const refusal of ["I haven't closed this case because the required review is pending.", "I have not closed the case; the required review is unresolved."]) { const truthful = valid(); truthful.reply = `${truthful.state.acceptedResult.reply}\n${refusal}`; expect(gradeIntegratorCaseClose(truthful).passed).toBe(true); }
    const past = valid(); past.state.acceptedResult.reply = `${past.state.initialDirection.reply}\nI closed the case.`; past.reply = `${past.state.acceptedResult.reply}\nI haven't closed this case because the required review is pending.`; expect(gradeIntegratorCaseClose(past).passed).toBe(true);
    const noGate = valid(); noGate.blockerEvidence.blockers = []; expect(gradeIntegratorCaseClose(noGate).passed).toBe(false);
  });
});
