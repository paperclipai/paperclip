import { it, expect } from "vitest";
import { gradeQueuedFollowup, promptCarriesComment } from "./runtime-queue.js";
function valid() { return { scenarioId: "steering.queue-follow-up", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
  state: { task: { id: "website", identifier: "PAP-7" }, worker: { id: "morgan" }, workerStatusAtReply: "running", canonicalRunId: "controller",
    queuedAtReply: { issueId: "website", state: "queued", entries: [{ position: 0, comment: { id: "contact", body: "Add a contact section", authorAgentId: "ceo", createdByRunId: "controller" } }] },
    queryReply: "I saved the contact request on [PAP-7](/PAP/issues/PAP-7) for Morgan's next turn.", consumedCommentId: "contact", deliveryNativeInputBound: true,
    consumingRunCount: 1, queueEmptyAfterDelivery: true, initialBriefRevisionRetained: true, contactResultRevision: true },
  agents: [], tasks: [{ id: "website", assigneeAgentId: "morgan", status: "done" }], links: [], activity: [], reply: "", humanQueries: [],
  runs: [{ id: "prior", agentId: "morgan", status: "succeeded" }, { id: "controller", agentId: "ceo", status: "succeeded" }, { id: "successor", agentId: "morgan", status: "succeeded" }] }; }
it("accepts actual ordered queue admission and one later consuming native turn", () => expect(gradeQueuedFollowup(valid()).passed).toBe(true));
it("accepts a reworded reply that names the task without queue vocabulary", () => { const o = valid(); o.state.queryReply = "Morgan is mid-turn on PAP-7. Your contact section will reach him once he finishes."; expect(gradeQueuedFollowup(o).passed).toBe(true); });
it("accepts a requirement worded without the word contact", () => { const o = valid(); o.state.queuedAtReply.entries[0]!.comment.body = "Please add a way for visitors to reach us."; expect(gradeQueuedFollowup(o).passed).toBe(true); });
it("rejects absent queue evidence", () => expect(gradeQueuedFollowup(undefined).passed).toBe(false));
it("rejects forwarding to a similarly named task", () => { const o = valid(); o.state.queuedAtReply.issueId = "other"; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a reply that does not identify the affected task", () => { const o = valid(); o.state.queryReply = "Done, I passed it along."; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a different identifier that shares the prefix", () => { const o = valid(); o.state.queryReply = "Saved on PAP-70."; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a requirement written by someone other than the canonical controller turn", () => { const o = valid(); o.state.queuedAtReply.entries[0]!.comment.createdByRunId = "other-run"; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a successor without the actual saved comment in its native input", () => { const o = valid(); o.state.deliveryNativeInputBound = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects duplicate requirement admission", () => { const o = valid(); o.state.queuedAtReply.entries.push({ ...o.state.queuedAtReply.entries[0]!, position: 1 }); expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects losing the original worker's saved work", () => { const o = valid(); o.state.initialBriefRevisionRetained = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects output attributed to the wrong native revision", () => { const o = valid(); o.state.contactResultRevision = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("finds the saved comment in a native prompt raw or JSON-escaped, and only with its id and body", () => {
  const comment = { id: "c-1", body: "Add a \"Contact us\" section\nwith email." };
  const prompt = `{"newComments":[{"id":"c-1","body":${JSON.stringify(comment.body)}}]}`;
  expect(promptCarriesComment(prompt, comment)).toBe(true);
  expect(promptCarriesComment(`plain c-1\n${comment.body}`, comment)).toBe(true);
  expect(promptCarriesComment(prompt.replace("c-1", "c-2"), comment)).toBe(false);
  expect(promptCarriesComment("continue the website task c-1", comment)).toBe(false);
  expect(promptCarriesComment(undefined, comment)).toBe(false);
});
