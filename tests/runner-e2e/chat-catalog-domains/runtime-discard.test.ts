import { expect, it } from "vitest";
import { gradeDiscard } from "./runtime-discard.js";
function valid() {
  const neighbour = { position: 0, comment: { id: "font", body: "Use a readable font.", authorUserId: "human", authorAgentId: null } };
  return { scenarioId: "steering.discard-queued-message", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "",
    tasks: [{ id: "website", status: "done" }], runs: ["initial", "guidance", "contact", "new-direction", "remove"].map(id => ({ id, status: "succeeded" })),
    activity: [{ id: "discard", action: "issue.queued_comment_discarded", actorType: "user", actorId: "human", entityId: "website", details: { commentId: "pending-contact" } }],
    state: { task: { id: "website" }, humanId: "human", targetId: "pending-contact", queueBefore: { issueId: "website", entries: [neighbour,
      { position: 1, comment: { id: "pending-contact", body: "Also add a contact section to the website.", authorUserId: "human", authorAgentId: null } }] },
    queueAfterDiscard: { issueId: "website", entries: [structuredClone(neighbour)] }, discardVisible: true, discardedCommentStatus: 404, discardedNeverDelivered: true,
    queryReply: "Use the human Discard control on your pending contact request in the task queue.", agentDiscardStatus: 403,
    consumedBeforeCancellation: true, consumedStillReadable: true, lateDiscardStatus: 409, latePhaseAttributed: true,
    lateReply: "The later request was already consumed. I sent new direction to remove that section; its original history remains intact.",
    cancelDirectionRunBound: true, finalQueueEmpty: true, finalPlanWithoutContact: true, initialRevisionRetained: true } };
}
it("accepts genuine pending discard and distinct consumed-input cancellation as new direction", () => expect(gradeDiscard(valid()).passed).toBe(true));
it("accepts natural human-control and subsequent consumed-input guidance", () => { const o = valid(); o.state.queryReply = "That waiting message is yours. Open its queue menu and remove it with Discard."; o.state.lateReply = "Morgan processed the second request before you cancelled it. A follow-up now asks for the contact section to be removed; the delivered input stays in history."; expect(gradeDiscard(o).passed).toBe(true); });
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
