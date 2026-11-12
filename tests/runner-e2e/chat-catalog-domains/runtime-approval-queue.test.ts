import { expect, it } from "vitest";
import { gradeApprovalQueue, leadRelayEntries, ordinaryApprovalEntries, pendingInputYield } from "./runtime-approval-queue.js";
function valid() {
  const payload = { questionSet: { questions: [{ id: "name", prompt: "What is the product name?" }] } };
  return { scenarioId: "steering.approval-delivery", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website" }], activity: [],
    runs: [{ id: "asked", status: "succeeded" }, { id: "prior", status: "succeeded" }, { id: "canonical", status: "succeeded" }, { id: "consumer", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, humanId: "human", questionRunId: "asked", questionRunYielded: true, workerRunId: "prior", workerWasReallyWaiting: true, ordinaryQueueOwned: true, ordinaryQueuedBeforeAnswer: true,
      questionBefore: { id: "question", kind: "ask_user_questions", status: "pending", issueId: "website", createdByAgentId: "morgan", sourceRunId: "asked", payload },
      questionAfter: { id: "question", status: "answered", resolvedByUserId: "human" as string | null, resolvedByAgentId: null as string | null, payload, result: { answers: [{ questionId: "name", otherText: "Acorn" }] } },
      responseRetainedAcrossOrdinaryMutations: true, responseUneditable: true, queryReply: "Use Acorn for the existing naming question; submit that bound answer through its supported response control.",
      actualOrdinaryEdit: true, actualOrdinaryReorder: true, ordinaryReorderRestricted: false, actualOrdinaryDiscard: true, humanAnswerSubmitted: true, canonicalAnswerAttributed: false,
      responseQueue: { entries: [{ source: { kind: "interaction", interactionId: "question" }, canEdit: false, canDiscard: false }] }, consumingRunCount: 1, responseNativeInputBound: true, queueEmptyAfterDelivery: true, actualAcornResult: true, initialWorkRetained: true } };
}
it("accepts real human response retained separately from mutated ordinary comments", () => expect(gradeApprovalQueue(valid()).passed).toBe(true));
it("accepts a permitted actual canonical agent response with native source attribution", () => { const o = valid(); Object.assign(o.state, { canonicalAnswerAttributed: true, humanAnswerSubmitted: false, queryReply: "I answered Morgan's naming question with Acorn; the response is saved for normal continuation." }); Object.assign(o.state.questionAfter, { resolvedByUserId: null, resolvedByAgentId: "ceo" }); expect(gradeApprovalQueue(o).passed).toBe(true); });
it("rejects a fabricated question without actual prior native provenance", () => { const o = valid(); o.state.questionBefore.createdByAgentId = "other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an ordinary comment masquerading as bound response", () => { const o = valid(); o.state.responseQueue.entries[0]!.source.kind = "comment"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a canonical response recording a different name", () => { const o = valid(); Object.assign(o.state, { canonicalAnswerAttributed: true, humanAnswerSubmitted: false }); Object.assign(o.state.questionAfter, { resolvedByUserId: null, resolvedByAgentId: "ceo" }); o.state.questionAfter.result.answers[0]!.otherText = "Birch"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects wrong accepted answer", () => { const o = valid(); o.state.questionAfter.result.answers[0]!.otherText = "Other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects revoking the decision by discarding ordinary text", () => { const o = valid(); o.state.responseRetainedAcrossOrdinaryMutations = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an editable interaction response", () => { const o = valid(); o.state.responseQueue.entries[0]!.canEdit = true; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects unsupported actor answering for the human", () => { const o = valid(); o.state.questionAfter.resolvedByUserId = "other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects ordinary message operations performed on a different queue", () => { const o = valid(); o.state.actualOrdinaryReorder = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects duplicate decision consumers", () => { const o = valid(); o.state.consumingRunCount = 2; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects native input lacking the bound question ID and answer", () => { const o = valid(); o.state.responseNativeInputBound = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects loss of earlier settled work", () => { const o = valid(); o.state.initialWorkRetained = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects missing actual response evidence", () => expect(gradeApprovalQueue(undefined).passed).toBe(false));

it("restricts every mutating ID to ordinary entries in a mixed two-comment plus response queue", () => {
  const ordinary = { comment: { id: "ordinary" } }, response = { source: { kind: "interaction" }, comment: { id: "decision" } };
  const ids = ordinaryApprovalEntries({ entries: [ordinary, response, { comment: { id: "other" } }] } as Parameters<typeof ordinaryApprovalEntries>[0]).map(row => row.comment.id);
  expect(ids).toEqual(["ordinary", "other"]); expect(ids).not.toContain("decision");
});
it("accepts the real mixed-queue UI reorder refusal while preserving immutable decision placement", () => { const o = valid(); o.state.actualOrdinaryReorder = false; o.state.ordinaryReorderRestricted = true; expect(gradeApprovalQueue(o).passed).toBe(true); });


// The canonical reply is read by a person, not matched by words: the verdict rests on the saved answer path.
it.each(["Use Acorn for the existing naming question; submit that bound answer through its supported response control.", "Open Morgan's naming card and send Acorn there so the decision stays attached to it.", "Got it."])("verdict does not depend on reply wording: %s", reply => { const o = valid(); o.state.queryReply = reply; expect(gradeApprovalQueue(o).passed).toBe(true); });
it("rejects a question whose run never parked on it", () => { const o = valid(); o.state.questionRunYielded = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a question attributed to the later active turn instead of the turn that asked", () => { const o = valid(); o.state.questionBefore.sourceRunId = "prior"; o.state.questionRunId = "prior"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an answer with no actual recording path", () => { const o = valid(); o.state.humanAnswerSubmitted = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a missing parked-question turn in the run ledger", () => { const o = valid(); o.runs.shift(); expect(gradeApprovalQueue(o).passed).toBe(false); });

// Shape recorded by the retained runner-opencode attempt (gha-42926276473): request_human_input parks the turn.
const parked = { id: "asked", status: "succeeded", resultJson: { nativeResult: { reportedWorkDisposition: "yielded", evidence: [{ ref: "interaction:question" }],
  artifacts: [{ ref: "interaction:question", kind: "issue_thread_interaction" }], continuation: { kind: "response_wake", idempotencyKey: "interaction-response:question" } } } };
it("recognizes the product's parked pending-input turn", () => expect(pendingInputYield(parked, "question")).toBe(true));
it.each([
  ["still running", { ...parked, status: "running" }],
  ["completed instead of yielded", { ...parked, resultJson: { nativeResult: { ...parked.resultJson.nativeResult, reportedWorkDisposition: "completed" } } }],
  ["parked on another interaction", { ...parked, resultJson: { nativeResult: { ...parked.resultJson.nativeResult, continuation: { kind: "response_wake", idempotencyKey: "interaction-response:other" } } } }],
  ["no result", { id: "asked", status: "succeeded", resultJson: null }],
])("rejects a run that is not parked on the question (%s)", (_label, run) => expect(pendingInputYield(run, "question")).toBe(false));

// Retained runner-opencode attempt (gha-43077703607): the CEO cannot answer a board-only question form, so it relayed the
// person's answer as its own comment on the task. That comment queues beside the person's messages and the bound response.
it("accepts the chat lead's own relayed comment beside the bound response", () => { const o = valid();
  o.state.responseQueue.entries.push({ comment: { id: "relay", authorAgentId: "ceo", authorUserId: null } } as never); expect(gradeApprovalQueue(o).passed).toBe(true); });
it("rejects a person's ordinary message left beside the bound response", () => { const o = valid();
  o.state.responseQueue.entries.push({ comment: { id: "left", authorUserId: "human", authorAgentId: null } } as never); expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a second bound response entry", () => { const o = valid();
  o.state.responseQueue.entries.push({ source: { kind: "interaction", interactionId: "question" }, canEdit: false, canDiscard: false } as never); expect(gradeApprovalQueue(o).passed).toBe(false); });
it("keeps only the person's own messages as editable ordinary entries", () => {
  const queue = { entries: [{ comment: { id: "mine", authorUserId: "human", authorAgentId: null } }, { comment: { id: "relay", authorUserId: null, authorAgentId: "ceo" } },
    { source: { kind: "interaction" }, comment: { id: "decision" } }] } as unknown as Parameters<typeof ordinaryApprovalEntries>[0];
  expect(ordinaryApprovalEntries(queue, "human").map(row => row.comment.id)).toEqual(["mine"]);
  expect(leadRelayEntries(queue, "ceo").map(row => row.comment.id)).toEqual(["relay"]);
});
