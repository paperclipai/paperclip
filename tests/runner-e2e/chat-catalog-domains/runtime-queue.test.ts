import { it, expect } from "vitest";
import { gradeQueuedFollowup } from "./runtime-queue.js";
function valid() { return { scenarioId: "steering.queue-follow-up", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
  state: { task: { id: "website" }, worker: { id: "morgan" }, workerStatusAtReply: "running", canonicalRunId: "controller",
    queuedAtReply: { issueId: "website", state: "queued", entries: [{ position: 0, comment: { id: "contact", body: "Add a contact section", authorAgentId: "ceo", createdByRunId: "controller" } }] },
    queryReply: "I saved the contact request in the task queue for the next eligible turn.", consumedCommentId: "contact", deliveryNativeInputBound: true,
    consumingRunCount: 1, queueEmptyAfterDelivery: true, initialBriefRevisionRetained: true, contactResultRevision: true },
  agents: [], tasks: [{ id: "website", assigneeAgentId: "morgan", status: "done" }], links: [], activity: [], reply: "", humanQueries: [],
  runs: [{ id: "prior", agentId: "morgan", status: "succeeded" }, { id: "controller", agentId: "ceo", status: "succeeded" }, { id: "successor", agentId: "morgan", status: "succeeded" }] }; }
it("accepts actual ordered queue admission and one later consuming native turn", () => expect(gradeQueuedFollowup(valid()).passed).toBe(true));
it("accepts natural pending-delivery guidance", () => { const o = valid(); o.state.queryReply = "Morgan is occupied with the current turn. Your contact requirement will wait behind it for the next eligible continuation."; expect(gradeQueuedFollowup(o).passed).toBe(true); });
it("rejects absent queue evidence", () => expect(gradeQueuedFollowup(undefined).passed).toBe(false));
it("rejects forwarding to a similarly named task", () => { const o = valid(); o.state.queuedAtReply.issueId = "other"; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects claiming implementation while the requirement is only queued", () => { const o = valid(); o.state.queryReply = "The contact section is complete."; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a successor without the actual saved comment in its native input", () => { const o = valid(); o.state.deliveryNativeInputBound = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects duplicate requirement admission", () => { const o = valid(); o.state.queuedAtReply.entries.push({ ...o.state.queuedAtReply.entries[0]!, position: 1 }); expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects losing the original worker's saved work", () => { const o = valid(); o.state.initialBriefRevisionRetained = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects output attributed to the wrong native revision", () => { const o = valid(); o.state.contactResultRevision = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
