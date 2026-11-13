import { describe, expect, it } from "vitest";
import { gradeIntegratorCaseClose } from "./integrator-case-close.js";
function valid() {
  const original = { id: "case", identifier: "COM-C1", workIssueId: "primary", status: "draft", completedAt: null };
  const review = { id: "review", issueId: "primary", latestRevisionId: "reviewed", body: "Accepted: correction permits activation once and retains the Pay name." };
  const base = { scenarioId: "cases.close-case", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { case: original, task: { id: "primary", status: "done" }, worker: { id: "morgan" }, review, reviewRunId: "review-native", firstReplyTime: "2026-10-26T10:00:00Z",
      resultTurn: { questionCommentId: "question", commentIds: ["result-reply"], runIds: ["result-run"], readSavedCase: true,
        replies: [{ id: "result-reply", authorAgentId: "ceo", createdByRunId: "result-run" }], companyPrefix: "COM" } },
    tasks: [{ id: "primary", status: "done" }], projects: [], goals: [], documents: [], revisions: [], links: [], activity: [], humanQueries: [],
    // The observation's comments are the primary task's, never the standing chat's.
    comments: [{ id: "task-comment", authorAgentId: "morgan", createdByRunId: "terminal-native" }],
    renderedLinkEvidence: [{ threadTestId: "task-chat-thread", href: "/COM/cases/COM-C1", source: "reply", conversationId: "chat", anchorCommentId: "result-reply", commentId: "result-reply" }],
    caseRecord: { ...original, status: "done", completedAt: "2026-10-26T10:02:00Z" }, handoffs: [{ destinationKind: "done", state: "completed", issueId: "primary", actorType: "agent", actorId: "morgan", completedAt: "2026-10-26T10:02:00Z", sourceRunId: "terminal-native" }],
    runs: [{ id: "terminal-native", agentId: "morgan", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "primary" } },
      { id: "result-run", agentId: "ceo", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "chat" } }],
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
  // Full cohort 3: the follow-up reply said "Case COM-C1 is saved as closed", read the case and linked it.
  // The follow-up turn is graded on its saved replies, its run's case read and its rendered case link, not its wording.
  it("accepts any wording of a grounded result turn, and rejects an ungrounded or unlinked one", () => {
    for (const text of ["Case COM-C1 is saved as closed:\n\n- **Status:** done", "Saved result: COM-C1 finished (status done, completed 00:54)."]) {
      const worded = valid(); worded.state.acceptedResult.reply = `${worded.state.initialDirection.reply}\n${text}`;
      worded.reply = `${worded.state.acceptedResult.reply}\nThe other case cannot close: its required review is unresolved.`; expect(gradeIntegratorCaseClose(worded).passed, text).toBe(true);
    }
    const unread = valid(); unread.state.resultTurn.readSavedCase = false; expect(gradeIntegratorCaseClose(unread).passed).toBe(false);
    const silent = valid(); silent.state.resultTurn.commentIds = []; expect(gradeIntegratorCaseClose(silent).passed).toBe(false);
    const foreign = valid(); foreign.state.resultTurn.replies[0]!.authorAgentId = "morgan"; expect(gradeIntegratorCaseClose(foreign).passed).toBe(false);
    const unlinked = valid(); unlinked.renderedLinkEvidence[0]!.href = "/COM/issues/COM-1"; expect(gradeIntegratorCaseClose(unlinked).passed).toBe(false);
    const lowercase = valid(); lowercase.renderedLinkEvidence[0]!.href = "/com/cases/COM-C1"; expect(gradeIntegratorCaseClose(lowercase).passed).toBe(true);
    const wrongPrefix = valid(); wrongPrefix.renderedLinkEvidence[0]!.href = "/TYPO/cases/COM-C1"; expect(gradeIntegratorCaseClose(wrongPrefix).passed).toBe(false);
    const otherCase = valid(); otherCase.renderedLinkEvidence[0]!.href = "/COM/cases/COM-C2"; expect(gradeIntegratorCaseClose(otherCase).passed).toBe(false);
    const firstTurnLink = valid(); firstTurnLink.renderedLinkEvidence[0]!.commentId = "first-reply"; expect(gradeIntegratorCaseClose(firstTurnLink).passed).toBe(false);
    const open = valid(); open.state.acceptedResult.caseRecord = { ...open.state.acceptedResult.caseRecord, status: "in_progress", completedAt: "" }; expect(gradeIntegratorCaseClose(open).passed).toBe(false);
  });
});
