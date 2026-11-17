import { describe, expect, it } from "vitest";
import { gradeIntegratorCaseClose } from "./integrator-case-close.js";
function valid() {
  const original = { id: "case", identifier: "COM-C1", workIssueId: "primary", status: "draft", completedAt: null };
  const review = { id: "review", issueId: "primary", latestRevisionId: "reviewed", body: "Accepted: correction permits activation once and retains the Pay name." };
  const base = { scenarioId: "cases.close-case", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { case: original, task: { id: "primary", status: "done" }, worker: { id: "morgan" }, review, reviewRunId: "review-native",
      resultTurn: { questionCommentId: "question", commentIds: ["result-reply"], runIds: ["result-run"], readSavedCase: true,
        replies: [{ id: "result-reply", authorAgentId: "ceo", createdByRunId: "result-run" }], companyPrefix: "COM" } },
    tasks: [{ id: "primary", status: "done" }], projects: [], goals: [], documents: [], revisions: [], links: [], activity: [], humanQueries: [],
    // The observation's comments are the primary task's, never the standing chat's.
    comments: [{ id: "task-comment", authorAgentId: "morgan", createdByRunId: "terminal-native" }],
    renderedLinkEvidence: [{ threadTestId: "task-chat-thread", href: "/COM/cases/COM-C1", source: "reply", conversationId: "chat", anchorCommentId: "result-reply", commentId: "result-reply" },
      { threadTestId: "task-chat-thread", href: "/COM/cases/COM-C2", source: "reply", conversationId: "chat", anchorCommentId: "refusal-reply", commentId: "refusal-reply" }],
    caseRecord: { ...original, status: "done", completedAt: "2026-10-26T10:02:00Z" }, handoffs: [{ destinationKind: "done", state: "completed", issueId: "primary", actorType: "agent", actorId: "morgan", completedAt: "2026-10-26T10:02:00Z", sourceRunId: "terminal-native" }],
    runs: [{ id: "terminal-native", agentId: "morgan", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "primary" } },
      { id: "result-run", agentId: "ceo", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "chat" } }],
    finalDocument: review, finalRevisions: [{ id: "reviewed", body: review.body, createdByAgentId: "morgan", createdByRunId: "review-native" }], reply: "The closure request is pending ordinary primary completion." };
  const result = { ...structuredClone(base), reply: `${base.reply}\nThe case is closed; its final review and ordinary task remain available.` };
  return { ...base, reply: `${result.reply}\nThe other case cannot close: its required review is unresolved.`, negativeCase: { id: "negative", identifier: "COM-C2", workIssueId: "secondary", status: "draft", completedAt: null as string | null },
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
  it("rejects lost final history and false negative-phase success", () => {
    const lost = valid(); lost.finalRevisions = []; expect(gradeIntegratorCaseClose(lost).passed).toBe(false);
    const gate = valid(); gate.negativeCase.status = "done"; expect(gradeIntegratorCaseClose(gate).passed).toBe(false);
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
  // Full cohort 11: the refusal said "I could not close COM-C2 ... my attempt was refused", which a keyword regex
  // rejected although COM-C2 stayed open. The refusal is graded on saved state and its rendered case link, not wording.
  it("grades the refused close on the open saved case and a later link to it, whatever the wording", () => {
    for (const text of ["I could not close [COM-C2](/COM/cases/COM-C2); it is still in draft and my attempt was refused.", "COM-C2 stays open until its review is done."]) {
      const worded = valid(); worded.reply = `${worded.state.acceptedResult.reply}\n${text}`; expect(gradeIntegratorCaseClose(worded).passed, text).toBe(true);
    }
    const closed = valid(); closed.negativeCase = { ...closed.negativeCase, status: "done", completedAt: "2026-10-26T10:05:00Z" }; expect(gradeIntegratorCaseClose(closed).passed).toBe(false);
    const reviewDone = valid(); reviewDone.pendingReview.status = "done"; expect(gradeIntegratorCaseClose(reviewDone).passed).toBe(false);
    const unlinked = valid(); unlinked.renderedLinkEvidence.pop(); expect(gradeIntegratorCaseClose(unlinked).passed).toBe(false);
    const wrongCase = valid(); wrongCase.renderedLinkEvidence[1]!.href = "/COM/cases/COM-C1"; expect(gradeIntegratorCaseClose(wrongCase).passed).toBe(false);
    const resultTurnOnly = valid(); resultTurnOnly.renderedLinkEvidence[1]!.commentId = "result-reply"; expect(gradeIntegratorCaseClose(resultTurnOnly).passed).toBe(false);
  });
});
