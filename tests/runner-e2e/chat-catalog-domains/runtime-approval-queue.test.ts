import { expect, it } from "vitest";
import { gradeApprovalQueue, acornNamingDirection, ordinaryApprovalEntries } from "./runtime-approval-queue.js";
function valid() {
  const payload = { questionSet: { questions: [{ id: "name", prompt: "What is the product name?" }] } };
  return { scenarioId: "steering.approval-delivery", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website" }], activity: [],
    runs: [{ id: "prior", status: "succeeded" }, { id: "canonical", status: "succeeded" }, { id: "consumer", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, humanId: "human", workerRunId: "prior", workerWasReallyWaiting: true, ordinaryQueueOwned: true, ordinaryQueuedBeforeAnswer: true,
      questionBefore: { id: "question", kind: "ask_user_questions", status: "pending", issueId: "website", createdByAgentId: "morgan", sourceRunId: "prior", payload },
      questionAfter: { id: "question", status: "answered", resolvedByUserId: "human" as string | null, resolvedByAgentId: null as string | null, payload, result: { answers: [{ questionId: "name", otherText: "Acorn" }] } },
      responseRetainedAcrossOrdinaryMutations: true, responseUneditable: true, queryReply: "Use Acorn for the existing naming question; submit that bound answer through its supported response control.",
      actualOrdinaryEdit: true, actualOrdinaryReorder: true, ordinaryReorderRestricted: false, actualOrdinaryDiscard: true, humanAnswerSubmitted: true, canonicalAnswerAttributed: false,
      responseQueue: { entries: [{ source: { kind: "interaction", interactionId: "question" }, canEdit: false, canDiscard: false }] }, consumingRunCount: 1, responseNativeInputBound: true, queueEmptyAfterDelivery: true, actualAcornResult: true, initialWorkRetained: true } };
}
it("accepts real human response retained separately from mutated ordinary comments", () => expect(gradeApprovalQueue(valid()).passed).toBe(true));
it("accepts a permitted actual canonical agent response with native source attribution", () => { const o = valid(); Object.assign(o.state, { canonicalAnswerAttributed: true, humanAnswerSubmitted: false, queryReply: "I answered Morgan's naming question with Acorn; the response is saved for normal continuation." }); Object.assign(o.state.questionAfter, { resolvedByUserId: null, resolvedByAgentId: "ceo" }); expect(gradeApprovalQueue(o).passed).toBe(true); });
it("accepts natural correct-answer guidance", () => { const o = valid(); o.state.queryReply = "The product name is Acorn. Use the question's response card so this decision stays attached to the naming request."; expect(gradeApprovalQueue(o).passed).toBe(true); });
it("rejects a fabricated question without actual prior native provenance", () => { const o = valid(); o.state.questionBefore.createdByAgentId = "other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an ordinary comment masquerading as bound response", () => { const o = valid(); o.state.responseQueue.entries[0]!.source.kind = "comment"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects wrong accepted answer", () => { const o = valid(); o.state.questionAfter.result.answers[0]!.otherText = "Other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects revoking the decision by discarding ordinary text", () => { const o = valid(); o.state.responseRetainedAcrossOrdinaryMutations = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an editable interaction response", () => { const o = valid(); o.state.responseQueue.entries[0]!.canEdit = true; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects source claim of answering without an attributed actual answer", () => { const o = valid(); o.state.queryReply = "I have answered with Acorn."; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects unsupported actor answering for the human", () => { const o = valid(); o.state.questionAfter.resolvedByUserId = "other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects ordinary message operations performed on a different queue", () => { const o = valid(); o.state.actualOrdinaryReorder = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects duplicate decision consumers", () => { const o = valid(); o.state.consumingRunCount = 2; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects native input lacking the bound question ID and answer", () => { const o = valid(); o.state.responseNativeInputBound = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects loss of earlier settled work", () => { const o = valid(); o.state.initialWorkRetained = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects missing actual response evidence", () => expect(gradeApprovalQueue(undefined).passed).toBe(false));

it.each(["Use Birch, not Acorn, as the name", "Acorn is wrong; use Birch for the product name", "The requested name was Acorn; Use Birch instead to answer the question"])("rejects contradictory named direction without rescue by later human input", reply => { const o = valid(); o.state.queryReply = reply; expect(gradeApprovalQueue(o).passed).toBe(false); });
it.each(["Use Acorn, not Birch, as the product name", "The answer is Acorn; submit it on the naming question", "Name it Acorn and retain the actual answer on the response card"])("accepts natural correct naming direction", reply => expect(acornNamingDirection(reply)).toBe(true));
it("restricts every mutating ID to ordinary entries in a mixed two-comment plus response queue", () => {
  const ordinary = { comment: { id: "ordinary" } }, response = { source: { kind: "interaction" }, comment: { id: "decision" } };
  const ids = ordinaryApprovalEntries({ entries: [ordinary, response, { comment: { id: "other" } }] } as Parameters<typeof ordinaryApprovalEntries>[0]).map(row => row.comment.id);
  expect(ids).toEqual(["ordinary", "other"]); expect(ids).not.toContain("decision");
});
it("accepts the real mixed-queue UI reorder refusal while preserving immutable decision placement", () => { const o = valid(); o.state.actualOrdinaryReorder = false; o.state.ordinaryReorderRestricted = true; expect(gradeApprovalQueue(o).passed).toBe(true); });

it("accepts explicit rejection of a different name while selecting the actual answer", () => expect(acornNamingDirection("Do not use Birch; the product name is Acorn.")).toBe(true));
