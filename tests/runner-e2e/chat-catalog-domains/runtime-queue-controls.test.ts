import { expect, it } from "vitest";
import { gradeQueueEdit } from "./runtime-queue-controls.js";
function valid() {
  const before = { issueId: "website", targetRunId: "prior", entries: [
    { position: 0, canEdit: true, comment: { id: "font", body: "Use a readable font with accessible labels.", authorUserId: "human", authorAgentId: null } },
    { position: 1, canEdit: true, comment: { id: "color", body: "Make the website red. Keep the existing note about accessible labels.", authorUserId: "human", authorAgentId: null } },
  ] };
  return { scenarioId: "steering.edit-queued-message", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", agents: [], tasks: [], activity: [], links: [], humanQueries: [], reply: "",
    runs: [{ id: "prior", agentId: "morgan", status: "succeeded" }, { id: "guide", agentId: "ceo", status: "succeeded" }, { id: "consumer", agentId: "morgan", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, queueBefore: before, targetId: "color", workerRunId: "prior", humanId: "human", concurrentMarker: "Preserve the human note.",
      queuedComments: [{ id: "color", updatedAt: "2026-11-12T21:52:30.494Z" }, { id: "font", updatedAt: "2026-11-12T21:50:24.404Z" }],
      workerCommentReceipts: { reads: {} as Record<string, string>, cited: [] as string[] }, taskDone: true, inTurnOutcomeApplied: false,
      finalOutcomeApplied: true, continuationWarnedEarlierReads: true,
      queueAfter: { ...before, entries: [{ ...before.entries[1]!, position: 0, comment: { ...before.entries[1]!.comment,
        body: "Make the website blue. Keep the existing note about accessible labels. Preserve the human note." } }, { ...before.entries[0]!, position: 1 }] },
      queryReply: "Your pending red request is in the Website queue. Open its message menu, edit the full request to blue, then move it first.",
      queryLinks: ["/COM/issues/website"], queueAtReply: structuredClone(before),
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
// Full cohort 4: correct guidance worded as "change ... and drag it above" failed the old edit|control|menu keyword list.
it("accepts reworded guidance that links the task, on the same saved evidence", () => {
  const o = valid(); o.state.queryReply = "Changing a queued message's text and order is board-only, so I couldn't apply it. On [COM-1](/COM/issues/COM-1), change that queued message to blue and drag it above the font note.";
  o.state.queryLinks = ["/COM/agents/ceo/overview", "/COM/issues/website"]; expect(gradeQueueEdit(o).passed).toBe(true);
});
it("rejects guidance without a rendered link to the task", () => { const o = valid(); o.state.queryLinks = ["/COM/agents/ceo/overview"]; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects an empty reply", () => { const o = valid(); o.state.queryReply = " "; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects an edit or reorder applied before the person acted", () => {
  const edited = valid(); edited.state.queueAtReply.entries[1]!.comment.body = "Make the website blue. Keep the existing note about accessible labels."; expect(gradeQueueEdit(edited).passed).toBe(false);
  const reordered = valid(); reordered.state.queueAtReply.entries[0]!.position = 1; reordered.state.queueAtReply.entries[1]!.position = 0; expect(gradeQueueEdit(reordered).passed).toBe(false);
  const missing = valid(); delete (missing.state as Record<string, unknown>).queueAtReply; expect(gradeQueueEdit(missing).passed).toBe(false);
});
it("rejects an agent that can edit or reorder the person's message", () => {
  const edit = valid(); edit.state.agentEditStatus = 200; expect(gradeQueueEdit(edit).passed).toBe(false);
  const order = valid(); order.state.agentOrderStatus = 200; expect(gradeQueueEdit(order).passed).toBe(false);
});
it("rejects stale concurrent acceptance", () => { const o = valid(); o.state.concurrentStatus = 200; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects silently overwriting an already-consumed message", () => { const o = valid(); o.state.dispatchedStatus = 200; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects a plausible wrong consumer without exact saved input and order", () => { const o = valid(); o.state.nativeDeliveryBound = false; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects losing the initial native work", () => { const o = valid(); o.state.initialRevisionRetained = false; expect(gradeQueueEdit(o).passed).toBe(false); });

it.each([200, 403, 500])("rejects late edit status %s rather than replacing the real 409 assertion", status => {
  const o = valid(); o.state.dispatchedStatus = status; expect(gradeQueueEdit(o).passed).toBe(false);
});

function inTurn() {
  const o = valid(); o.runs.pop();
  o.state.workerCommentReceipts = { reads: { color: "2026-11-12T21:52:30.494Z", font: "2026-11-12T21:50:24.404Z" }, cited: ["color", "font"] };
  Object.assign(o.state, { consumingRunCount: 0, nativeDeliveryBound: false, inTurnOutcomeApplied: true });
  return o;
}
it("accepts the running turn consuming the current edited revision with no continuation", () => expect(gradeQueueEdit(inTurn()).passed).toBe(true));
it("accepts an in-turn read made after the last edit", () => { const o = inTurn(); o.state.workerCommentReceipts.reads.color = "2026-11-12T21:52:39.000Z"; expect(gradeQueueEdit(o).passed).toBe(true); });
it("still accepts one continuation when the running turn read only the earlier revision", () => {
  const o = valid(); o.state.workerCommentReceipts = { reads: { color: "2026-11-12T21:50:32.657Z" }, cited: ["color"] }; expect(gradeQueueEdit(o).passed).toBe(true);
});
it("rejects an in-turn read of the earlier revision only", () => { const o = inTurn(); o.state.workerCommentReceipts.reads.color = "2026-11-12T21:50:32.657Z"; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects an in-turn read of only one queued message", () => { const o = inTurn(); delete (o.state.workerCommentReceipts.reads as Record<string, string>).font; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects an in-turn read whose change was never saved", () => { const o = inTurn(); o.state.inTurnOutcomeApplied = false; expect(gradeQueueEdit(o).passed).toBe(false); });
it("rejects in-turn reads of both messages that cite only one, with no continuation", () => {
  const o = inTurn(); o.state.workerCommentReceipts.cited = ["color"]; expect(gradeQueueEdit(o).passed).toBe(false);
});
it("rejects a double application: an in-turn read cited as handled and a continuation", () => {
  const o = valid(); o.state.workerCommentReceipts = { reads: { color: "2026-11-12T21:52:30.494Z", font: "2026-11-12T21:50:24.404Z" }, cited: ["color", "font"] }; o.state.inTurnOutcomeApplied = true;
  expect(gradeQueueEdit(o).passed).toBe(false);
});
it("rejects two continuations", () => {
  const o = valid(); o.runs.push({ id: "again", agentId: "morgan", status: "succeeded" }); o.state.consumingRunCount = 2; expect(gradeQueueEdit(o).passed).toBe(false);
});
it("rejects consumption that leaves the queue or task unfinished", () => {
  const queued = inTurn(); queued.state.queueEmptyAfterDelivery = false; expect(gradeQueueEdit(queued).passed).toBe(false);
  const open = inTurn(); open.state.taskDone = false; expect(gradeQueueEdit(open).passed).toBe(false);
});
function mixed() {
  const o = valid() as ReturnType<typeof valid> & { state: Record<string, unknown> };
  Object.assign(o.state, { workerCommentReceipts: { reads: { color: "2026-11-12T21:52:30.494Z" }, cited: ["color"] }, inTurnOutcomeApplied: false, inTurnOutcomeSaved: true, latestOutcomeKept: true,
    finalOutcomeApplied: false });
  return o;
}
it("grades the whole limit-1 partial read: the turn saved blue, the continuation got only the font note and saved the latest revision", () => {
  const result = gradeQueueEdit(mixed()); expect(result.checks.filter(check => !check.passed)).toEqual([]); expect(result.passed).toBe(true);
});
it("rejects a partial read whose later continuation dropped the saved blue change", () => { const o = mixed(); o.state.latestOutcomeKept = false; expect(gradeQueueEdit(o).passed).toBe(false); });
it("accepts the running turn reading only the edited message and one continuation delivering the unread one", () => expect(gradeQueueEdit(mixed()).passed).toBe(true));
it("rejects the edited message read in the running turn whose change was never saved, even with a continuation", () => {
  const o = mixed(); o.state.inTurnOutcomeSaved = false; expect(gradeQueueEdit(o).passed).toBe(false);
});
it("rejects a continuation that re-delivers the message the running turn already read", () => { const o = mixed(); o.state.nativeDeliveryBound = false; expect(gradeQueueEdit(o).passed).toBe(false); });
function readNotCited() {
  const o = valid(); o.state.workerCommentReceipts = { reads: { color: "2026-11-12T21:52:30.494Z", font: "2026-11-12T21:50:24.404Z" }, cited: [] };
  return o;
}
it("accepts reads the running turn did not cite, delivered once to a continuation told about the earlier reads", () => expect(gradeQueueEdit(readNotCited()).passed).toBe(true));
it("rejects that continuation when it was not told the running turn already read the messages", () => {
  const o = readNotCited(); o.state.continuationWarnedEarlierReads = false; expect(gradeQueueEdit(o).passed).toBe(false);
});
it("rejects that continuation when it saves no latest revision", () => {
  const o = readNotCited(); o.state.finalOutcomeApplied = false; expect(gradeQueueEdit(o).passed).toBe(false);
});
it("rejects messages the running turn read but did not cite, with no continuation", () => {
  const o = inTurn(); o.state.workerCommentReceipts.cited = []; expect(gradeQueueEdit(o).passed).toBe(false);
});
