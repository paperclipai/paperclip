import { expect, it } from "vitest";
import { documentContactRemoved, gradeDiscard, promptCarries, replyLinkHrefs } from "./runtime-discard.js";
function valid() {
  const neighbour = { position: 0, comment: { id: "font", body: "Use a readable font.", authorUserId: "human", authorAgentId: null } };
  return { scenarioId: "steering.discard-queued-message", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "",
    tasks: [{ id: "website", status: "done" }], runs: ["initial", "guidance", "contact", "new-direction", "remove"].map(id => ({ id, status: "succeeded" })),
    activity: [{ id: "discard", action: "issue.queued_comment_discarded", actorType: "user", actorId: "human", entityId: "website", details: { commentId: "pending-contact" } }],
    state: { task: { id: "website" }, humanId: "human", targetId: "pending-contact", queueBefore: { issueId: "website", entries: [neighbour,
      { position: 1, comment: { id: "pending-contact", body: "Also add a contact section to the website.", authorUserId: "human", authorAgentId: null } }] },
    queueAfterDiscard: { issueId: "website", entries: [structuredClone(neighbour)] }, discardVisible: true, discardedCommentStatus: 404, discardedNeverDelivered: true,
    queryReply: "Use the human Discard control on your pending contact request in the task queue.", agentDiscardStatus: 403,
    queryLinkedTask: true, targetPendingAfterReply: true, consumedLabelSaved: true,
    consumedBeforeCancellation: true, consumedStillReadable: true, lateDiscardStatus: 409, latePhaseAttributed: true,
    lateReply: "The later request was already consumed. I sent new direction to remove that section; its original history remains intact.",
    cancelDirectionRunBound: true, finalQueueEmpty: true, finalPlanWithoutContact: true, initialRevisionRetained: true,
    workerRunId: "initial", secondContactId: "second-contact", consumerRunId: "contact", firstDeliveryRunCount: 3, continuationConsumerCount: 1, continuationInputBound: true,
    queuedFollowUps: [{ id: "font", updatedAt: "2026-11-13T04:01:28.647Z" }, { id: "second-contact", updatedAt: "2026-11-13T04:03:45.909Z" }],
    workerCommentReceipts: { reads: {} as Record<string, string>, cited: [] as string[] } } };
}
it("accepts genuine pending discard and distinct consumed-input cancellation as new direction", () => expect(gradeDiscard(valid()).passed).toBe(true));
it("accepts natural human-control and subsequent consumed-input guidance", () => { const o = valid(); o.state.queryReply = "That waiting message is yours. Open its queue menu and remove it with Discard."; o.state.lateReply = "Morgan processed the second request before you cancelled it. A follow-up now asks for the contact section to be removed; the delivered input stays in history."; expect(gradeDiscard(o).passed).toBe(true); });
it("accepts the retained live reply and a reworded equivalent without wording checks", () => {
  for (const reply of [
    "I found the contact-section request: it's the queued comment on [RUN-1](/RUN/issues/RUN-1), still pending (not yet delivered to Morgan). I couldn't cancel it from this agent: Paperclip returned 403. Since you're the comment author, cancel it from that queued comment's controls on RUN-1.",
    "Only you can pull that one back. It's sitting unsent on [RUN-1](/RUN/issues/RUN-1); open it and use the menu next to the message.",
  ]) { const o = valid(); o.state.queryReply = reply; o.state.lateReply = "Done: Morgan got new instructions to drop that section. Your earlier message is kept as it was."; expect(gradeDiscard(o).passed).toBe(true); }
});
it("rejects guidance that does not link the task holding the queued request", () => { const o = valid(); o.state.queryLinkedTask = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a reply after which the pending request had already vanished", () => { const o = valid(); o.state.targetPendingAfterReply = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects an empty guidance or later reply", () => {
  const a = valid(); a.state.queryReply = " "; expect(gradeDiscard(a).passed).toBe(false);
  const b = valid(); b.state.lateReply = ""; expect(gradeDiscard(b).passed).toBe(false);
});
it("rejects a saved plan that still carries the cancelled contact label", () => { const o = valid(); o.state.finalPlanWithoutContact = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a vacuous removal where the consumed contact request was never saved", () => { const o = valid(); o.state.consumedLabelSaved = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects missing cancellation evidence", () => expect(gradeDiscard(undefined).passed).toBe(false));
it("rejects discarding a similarly named request owned by another person", () => { const o = valid(); o.state.queueBefore.entries[1]!.comment.authorUserId = "other"; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects removing unrelated queue content", () => { const o = valid(); o.state.queueAfterDiscard.entries = []; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects missing retained discard history", () => { const o = valid(); o.activity = []; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a supposedly discarded request that was actually delivered", () => { const o = valid(); o.state.discardedNeverDelivered = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects agent-forged human discard", () => { const o = valid(); o.state.agentDiscardStatus = 200; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects accepting a stale discard of consumed input", () => { const o = valid(); o.state.lateDiscardStatus = 200; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a later answer borrowed from another native phase", () => { const o = valid(); o.state.latePhaseAttributed = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects new direction never reaching the actual later worker", () => { const o = valid(); o.state.cancelDirectionRunBound = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects overwriting the already-delivered historical request", () => { const o = valid(); o.state.consumedStillReadable = false; expect(gradeDiscard(o).passed).toBe(false); });

it.each([403, 500])("rejects late discard status %s even when the human fixture otherwise looks valid", status => {
  const o = valid(); o.state.lateDiscardStatus = status; expect(gradeDiscard(o).passed).toBe(false);
});

it("recognises a multi-line direction carried as JSON in the native prompt, and rejects one that is absent", () => {
  const body = "New direction.\n\n- Remove the contact section.\n- Keep the font guidance.";
  const prompt = `{"messages":[{"body":${JSON.stringify(body)}}]}`;
  expect(promptCarries(prompt, body)).toBe(true);
  expect(promptCarries(prompt.replace("Remove", "Add"), body)).toBe(false);
  expect(promptCarries(undefined, body)).toBe(false);
});
it("reads task links saved in the reply even before they render", () => {
  expect(replyLinkHrefs("Discard it on [RUN-1](/RUN/issues/RUN-1).", [])).toEqual(["/RUN/issues/RUN-1"]);
  expect(replyLinkHrefs("Discard it on RUN-1.", [])).toEqual([]);
});
it("rejects a native prompt that carries other comments but not the direction comment, raw or JSON-escaped", () => {
  const body = "New direction.\n\n- Remove the contact section.\n- Keep the font guidance.";
  const other = "I have changed my mind: add a contact section.\nKeep the font requirement.";
  const prompt = `{"messages":[{"body":${JSON.stringify(other)}}]}\n${other}`;
  expect(promptCarries(prompt, body)).toBe(false);
  // A prefix of the direction is not the direction.
  expect(promptCarries(`{"body":${JSON.stringify("New direction.\n\n- Remove the contact section.")}}`, body)).toBe(false);
  expect(promptCarries(prompt, "")).toBe(false);
});
it("rejects an unbound later worker in the grade when its prompt lacks the direction", () => {
  const o = valid(); o.state.cancelDirectionRunBound = promptCarries(`{"body":${JSON.stringify("unrelated")}}`, "Remove the contact section.\nKeep fonts.");
  expect(gradeDiscard(o).passed).toBe(false);
});
const label = "e972d9c1aa95-1";
const initialPlan = "# Website Plan (Initial)\n\n## Accessible Font Guidance\n\n- Readable base size.\n\n## Proposed Pages\n1. Home\n2. Contact\n";
// Full cohort 11: the consuming run saved the label as a plain line under a "## Contact" heading.
const consumedPlan = `# Website Plan (Initial)\n\n## Accessible Font Guidance\n\n- Readable base size.\n\n## Contact\nSection label: \`${label}\`\n\n- Add a contact form.\n\n## Proposed Pages\n1. Home\n2. Contact\n`;
const finalPlan = "# Website Plan (Initial)\n\n## Accessible Font Guidance\n\n- Readable base size.\n\n## Proposed Pages\n1. Home\n";
const revs = (finalBody: string) => [
  { id: "r1", revisionNumber: 1, createdByRunId: "initial", body: initialPlan },
  { id: "r2", revisionNumber: 2, createdByRunId: "consumer", body: consumedPlan },
  { id: "final", revisionNumber: 3, createdByRunId: "final", body: finalBody },
];
it("full cohort 11: passes when the final revision drops the setup label, whatever form the label was saved in", () => {
  expect(documentContactRemoved(revs(finalPlan), "final", label)).toBe(true);
  for (const form of [`## Contact section (label: ${label})`, `### Reach us (${label})`, `Contact - ${label}`]) {
    const consumed = consumedPlan.replace(`## Contact\nSection label: \`${label}\``, form);
    expect(documentContactRemoved([...revs(finalPlan)].map(row => row.id === "r2" ? { ...row, body: consumed } : row), "final", label), form).toBe(true);
  }
});
it("fails while the final revision still carries the setup label in any form", () => {
  expect(documentContactRemoved(revs(consumedPlan), "final", label)).toBe(false);
  expect(documentContactRemoved(revs(`${finalPlan}\nContact (${label}): email us.\n`), "final", label)).toBe(false);
});
it("fails when the final revision is missing or the label is empty", () => {
  expect(documentContactRemoved(revs(finalPlan), "missing", label)).toBe(false);
  expect(documentContactRemoved(revs(finalPlan), "final", "")).toBe(false);
});

function citedInTurn() {
  const o = valid(); o.runs = o.runs.filter(row => row.id !== "contact");
  Object.assign(o.state, { consumerRunId: "initial", firstDeliveryRunCount: 2, continuationConsumerCount: 0, continuationInputBound: false, consumedBeforeCancellation: false });
  o.state.workerCommentReceipts = { reads: { "second-contact": "2026-11-13T04:03:45.909Z", font: "2026-11-13T04:01:28.647Z" }, cited: ["font", "second-contact"] };
  return o;
}
it("accepts the retained cohort-10 shape: the running turn read and cited both follow-ups, saved the contact label, and no continuation ran", () => expect(gradeDiscard(citedInTurn()).passed).toBe(true));
it("accepts the later request handled in turn while the uncited font note reaches one continuation", () => {
  const o = citedInTurn(); o.state.workerCommentReceipts.cited = ["second-contact"]; Object.assign(o.state, { firstDeliveryRunCount: 3, continuationConsumerCount: 1, continuationInputBound: true });
  o.runs.splice(2, 0, { id: "font-consumer", status: "succeeded" }); expect(gradeDiscard(o).passed).toBe(true);
});
it.each([
  ["reads the later request without citing it and starts no continuation", (o: ReturnType<typeof citedInTurn>) => { o.state.workerCommentReceipts.cited = ["font"]; }],
  ["cites a request it never read", (o: ReturnType<typeof citedInTurn>) => { delete o.state.workerCommentReceipts.reads["second-contact"]; }],
  ["cites the request but never saves the labelled contact section", (o: ReturnType<typeof citedInTurn>) => { o.state.consumedLabelSaved = false; }],
  ["cites the request and still replays it in a continuation", (o: ReturnType<typeof citedInTurn>) => { Object.assign(o.state, { firstDeliveryRunCount: 3, continuationConsumerCount: 1 }); o.runs.splice(2, 0, { id: "replay", status: "succeeded" }); }],
  ["handles both in turn and admits an extra later run", (o: ReturnType<typeof citedInTurn>) => { o.runs.push({ id: "extra", status: "succeeded" }); }],
  ["cites the discarded request as handled", (o: ReturnType<typeof citedInTurn>) => { o.state.workerCommentReceipts.cited.push("pending-contact"); }],
  ["credits the later request to a run other than the one that handled it", (o: ReturnType<typeof citedInTurn>) => { o.state.consumerRunId = "new-direction"; }],
])("rejects a running turn that %s", (_label, mutate) => { const o = citedInTurn(); mutate(o); expect(gradeDiscard(o).passed).toBe(false); });
it.each([
  ["no continuation consumes the owed follow-ups", (o: ReturnType<typeof valid>) => { o.state.continuationConsumerCount = 0; }],
  ["the continuation input lacks an owed follow-up", (o: ReturnType<typeof valid>) => { o.state.continuationInputBound = false; }],
  ["the continuation never received the later request", (o: ReturnType<typeof valid>) => { o.state.consumedBeforeCancellation = false; }],
])("rejects the continuation path when %s", (_label, mutate) => { const o = valid(); mutate(o); expect(gradeDiscard(o).passed).toBe(false); });
