import { expect, it } from "vitest";
import { approvalResponseListing, classifyApprovalSuccessors, gradeApprovalQueue, leadRelayEntries, ordinaryApprovalEntries, pendingInputYield } from "./runtime-approval-queue.js";
function valid() {
  const payload = { questionSet: { questions: [{ id: "name", prompt: "What is the product name?" }] } };
  return { scenarioId: "steering.approval-delivery", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website" }], activity: [],
    runs: [{ id: "asked", status: "succeeded" }, { id: "prior", status: "succeeded" }, { id: "canonical", status: "succeeded" }, { id: "consumer", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, humanId: "human", questionRunId: "asked", questionRunYielded: true, workerRunId: "prior", workerWasReallyWaiting: true, ordinaryQueueOwned: true, ordinaryQueuedBeforeAnswer: true,
      questionBefore: { id: "question", kind: "ask_user_questions", status: "pending", issueId: "website", createdByAgentId: "morgan", sourceRunId: "asked", payload },
      questionAfter: { id: "question", status: "answered", resolvedByUserId: "human" as string | null, resolvedByAgentId: null as string | null, payload, result: { answers: [{ questionId: "name", otherText: "Acorn" }] } },
      responseRetainedAcrossOrdinaryMutations: true, responseUneditable: true, queryReply: "Use Acorn for the existing naming question; submit that bound answer through its supported response control.",
      actualOrdinaryEdit: true, actualOrdinaryReorder: true, ordinaryReorderRestricted: false, actualOrdinaryDiscard: true, humanAnswerSubmitted: true, canonicalAnswerAttributed: false,
      responseQueue: { entries: [{ source: { kind: "interaction", interactionId: "question" }, canEdit: false, canDiscard: false }] } as { entries: unknown[] }, responseListing: "listed", responseListedImmutable: true,
      consumingRunCount: 1, relayRunCount: 0, unexpectedSuccessorRunCount: 0, responseNativeInputBound: true, queueEmptyAfterDelivery: true, actualAcornResult: true, initialWorkRetained: true } };
}
it("accepts real human response retained separately from mutated ordinary comments", () => expect(gradeApprovalQueue(valid()).passed).toBe(true));
it("accepts a permitted actual canonical agent response with native source attribution", () => { const o = valid(); Object.assign(o.state, { canonicalAnswerAttributed: true, humanAnswerSubmitted: false, queryReply: "I answered Morgan's naming question with Acorn; the response is saved for normal continuation." }); Object.assign(o.state.questionAfter, { resolvedByUserId: null, resolvedByAgentId: "ceo" }); expect(gradeApprovalQueue(o).passed).toBe(true); });
it("rejects a fabricated question without actual prior native provenance", () => { const o = valid(); o.state.questionBefore.createdByAgentId = "other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an ordinary comment masquerading as bound response", () => { const o = valid(); (o.state.responseQueue.entries[0] as { source: { kind: string } }).source.kind = "comment"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a canonical response recording a different name", () => { const o = valid(); Object.assign(o.state, { canonicalAnswerAttributed: true, humanAnswerSubmitted: false }); Object.assign(o.state.questionAfter, { resolvedByUserId: null, resolvedByAgentId: "ceo" }); o.state.questionAfter.result.answers[0]!.otherText = "Birch"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects wrong accepted answer", () => { const o = valid(); o.state.questionAfter.result.answers[0]!.otherText = "Other"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects revoking the decision by discarding ordinary text", () => { const o = valid(); o.state.responseRetainedAcrossOrdinaryMutations = false; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an editable interaction response", () => { const o = valid(); (o.state.responseQueue.entries[0] as { canEdit: boolean }).canEdit = true; expect(gradeApprovalQueue(o).passed).toBe(false); });
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

// Retained runner-opencode attempt (gha-43120714598): the chat lead relayed the person's answer as its own comment on the task.
// The composer lists one wake at a time and prefers that editable comment, so the answer's own wake waited unlisted behind it.
// After the gate, the lead's relay may take one extra worker turn; the answer must still reach exactly one bound turn.
function behindRelay() { const o = valid();
  Object.assign(o.state, { responseQueue: { entries: [{ comment: { id: "relay", authorAgentId: "ceo", authorUserId: null } }] }, responseListing: "behind_lead_relay", responseListedImmutable: undefined, relayRunCount: 1 });
  o.runs.push({ id: "relay-turn", status: "succeeded" }); return o; }
it("accepts the answer waiting unlisted behind the chat lead's own relay when it is then delivered once", () => expect(gradeApprovalQueue(behindRelay()).passed).toBe(true));
it("accepts the answer behind the relay when the relay never needed its own turn", () => { const o = behindRelay(); o.state.relayRunCount = 0; o.runs.pop(); expect(gradeApprovalQueue(o).passed).toBe(true); });
it("rejects an answer that waited behind the relay but was never delivered to a bound turn", () => { const o = behindRelay(); o.state.consumingRunCount = 0; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects an answer behind the relay delivered to two turns", () => { const o = behindRelay(); o.state.consumingRunCount = 2; o.runs.push({ id: "replay", status: "succeeded" }); expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a person's message still queued behind the relay", () => { const o = behindRelay();
  o.state.responseQueue.entries.push({ comment: { id: "left", authorUserId: "human", authorAgentId: null } }); expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a worker turn that is neither the bound answer nor the lead's relay", () => { const o = behindRelay(); o.state.unexpectedSuccessorRunCount = 1; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects more relay-only turns than one relay wake can produce", () => { const o = behindRelay(); o.state.relayRunCount = 2; o.runs.push({ id: "relay-2", status: "succeeded" }); expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a recorded listing that disagrees with the queue actually observed", () => { const o = behindRelay(); o.state.responseListing = "listed"; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a listed answer whose card controls were never shown as locked", () => { const o = valid(); o.state.responseListedImmutable = undefined as never; expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a person's ordinary message left beside the bound response", () => { const o = valid();
  o.state.responseQueue.entries.push({ comment: { id: "left", authorUserId: "human", authorAgentId: null } }); expect(gradeApprovalQueue(o).passed).toBe(false); });
it("rejects a second bound response entry", () => { const o = valid();
  o.state.responseQueue.entries.push({ source: { kind: "interaction", interactionId: "question" }, canEdit: false, canDiscard: false }); expect(gradeApprovalQueue(o).passed).toBe(false); });
it("classifies the queue listing from the observed entries", () => {
  const answer = { source: { kind: "interaction", interactionId: "question" }, canEdit: false, canDiscard: false, comment: { id: "question" } };
  const relay = { comment: { id: "relay", authorAgentId: "ceo", authorUserId: null } }, mine = { comment: { id: "mine", authorUserId: "human", authorAgentId: null } };
  const listing = (entries: unknown[]) => approvalResponseListing({ entries } as Parameters<typeof approvalResponseListing>[0], "question", "ceo");
  expect(listing([answer])).toBe("listed");
  expect(listing([relay])).toBe("behind_lead_relay");
  expect(listing([relay, mine])).toBeNull();
  expect(listing([{ ...answer, canEdit: true }])).toBeNull();
  expect(listing([{ ...answer, source: { kind: "interaction", interactionId: "other" } }])).toBeNull();
  expect(listing([])).toBeNull();
});
it("splits later worker turns into the bound answer, the lead's relay and anything else", () => {
  const split = classifyApprovalSuccessors([
    { id: "bound", contextSnapshot: { interactionId: "question" } },
    { id: "relay", contextSnapshot: { wakeCommentIds: ["relay-comment"] } },
    { id: "mixed", contextSnapshot: { wakeCommentIds: ["relay-comment", "person-comment"] } },
    { id: "other-answer", contextSnapshot: { interactionId: "other" } },
    { id: "bare", contextSnapshot: {} },
  ], "question", new Set(["relay-comment"]));
  expect(split).toEqual({ bound: ["bound"], relay: ["relay"], other: ["mixed", "other-answer", "bare"] });
});
it("keeps only the person's own messages as editable ordinary entries", () => {
  const queue = { entries: [{ comment: { id: "mine", authorUserId: "human", authorAgentId: null } }, { comment: { id: "relay", authorUserId: null, authorAgentId: "ceo" } },
    { source: { kind: "interaction" }, comment: { id: "decision" } }] } as unknown as Parameters<typeof ordinaryApprovalEntries>[0];
  expect(ordinaryApprovalEntries(queue, "human").map(row => row.comment.id)).toEqual(["mine"]);
  expect(leadRelayEntries(queue, "ceo").map(row => row.comment.id)).toEqual(["relay"]);
});
