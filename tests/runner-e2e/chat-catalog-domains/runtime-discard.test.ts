import { expect, it } from "vitest";
import { gradeDiscard, promptCarries, replyLinkHrefs } from "./runtime-discard.js";
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
    cancelDirectionRunBound: true, finalQueueEmpty: true, finalPlanWithoutContact: true, initialRevisionRetained: true } };
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
