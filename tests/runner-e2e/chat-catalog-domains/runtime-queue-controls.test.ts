import { expect, it } from "vitest";
import { gradeQueueEdit } from "./runtime-queue-controls.js";
function valid() {
  const before = { issueId: "website", targetRunId: "prior", entries: [
    { position: 0, canEdit: true, comment: { id: "font", body: "Use a readable font with accessible labels.", authorUserId: "human", authorAgentId: null } },
    { position: 1, canEdit: true, comment: { id: "color", body: "Make the website red. Keep the existing note about accessible labels.", authorUserId: "human", authorAgentId: null } },
  ] };
  return { scenarioId: "steering.edit-queued-message", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", agents: [], tasks: [], activity: [], links: [], humanQueries: [], reply: "",
    runs: [{ id: "prior", status: "succeeded" }, { id: "guide", status: "succeeded" }, { id: "consumer", status: "succeeded" }],
    state: { task: { id: "website" }, queueBefore: before, targetId: "color", workerRunId: "prior", humanId: "human", concurrentMarker: "Preserve the human note.",
      queueAfter: { ...before, entries: [{ ...before.entries[1]!, position: 0, comment: { ...before.entries[1]!.comment,
        body: "Make the website blue. Keep the existing note about accessible labels. Preserve the human note." } }, { ...before.entries[0]!, position: 1 }] },
      queryReply: "Your pending red request is in the Website queue. Open its message menu, edit the full request to blue, then move it first.",
      agentEditStatus: 403, agentOrderStatus: 403, concurrentStatus: 409, concurrentErrorVisible: true, concurrentSaveRetained: true,
      dispatchedStatus: 409, dispatchedWarningVisible: true, originalCommentStillReadable: true, nativeDeliveryBound: true, queueEmptyAfterDelivery: true,
      consumingRunCount: 1, initialRevisionRetained: true } };
}
it("accepts actual owned full-text edit, first position and independently observed conflicts/delivery", () => expect(gradeQueueEdit(valid()).passed).toBe(true));
it("accepts natural substantive control guidance", () => { const o = valid(); o.state.queryReply = "The waiting red message belongs to you. Use Edit in its menu and drag the resulting blue message to the first slot."; expect(gradeQueueEdit(o).passed).toBe(true); });
it("rejects missing runtime evidence", () => expect(gradeQueueEdit(undefined).passed).toBe(false));
it("rejects an agent-owned message presented as human-owned", () => { const o = valid(); o.state.queueBefore.entries[1]!.comment.authorUserId = "different-person"; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects changing only a fragment and dropping the concurrent note", () => { const o = valid(); o.state.queueAfter.entries[0]!.comment.body = "Make the website blue."; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects losing the other queued message", () => { const o = valid(); o.state.queueAfter.entries.pop(); expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects agent claims to have forged the human edit", () => { const o = valid(); o.state.queryReply = "I've edited the queued request and reordered it first."; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects stale concurrent acceptance", () => { const o = valid(); o.state.concurrentStatus = 200; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects silently overwriting an already-consumed message", () => { const o = valid(); o.state.dispatchedStatus = 200; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects a plausible wrong consumer without exact saved input and order", () => { const o = valid(); o.state.nativeDeliveryBound = false; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects losing the initial native work", () => { const o = valid(); o.state.initialRevisionRetained = false; expect(gradeQueueEdit(o).passed).toBe(false); });

it.each([200, 403, 500])("rejects late edit status %s rather than replacing the real 409 assertion", status => {
  const o = valid(); o.state.dispatchedStatus = status; expect(gradeQueueEdit(o).passed).toBe(false);
});
