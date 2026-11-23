import { expect, it } from "vitest";
import { deliveryRevisionBound, gradeInterruption } from "./runtime-interruption.js";
function valid() {
  return { scenarioId: "steering.interrupt-with-direction", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website", status: "done" }], activity: [],
    runs: [{ id: "old", status: "cancelled" }, { id: "source", status: "succeeded" }, { id: "new", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, workerRunId: "old", approvedDirection: { id: "accepted-plan" },
      directionQueue: { issueId: "website", targetRunId: "old", protocol: "paperclip_runner_v1", entries: [{ source: { kind: "interaction", requiresFreshSession: true, interactionId: "accepted-plan" } }] },
      planApprovedByHuman: true, interruptControlEnabled: true, humanInterrupted: true, interruptStatus: 200,
      oldRunAfter: { id: "old", status: "cancelled", finishedAt: "2026-10-26T12:00:00.000Z" }, nativeStopAcknowledged: true, oldEvidenceRetained: true,
      queryReply: "Use the supported Interrupt button beside your saved simpler plan response. It stops the current attempt before sending the accepted direction to one eligible fresh continuation.", workerRunningAfterReply: true, humanFollowedReplyTaskLink: true,
      successorCount: 1, successor: { id: "new", agentId: "morgan", status: "succeeded", startedAt: "2026-10-26T12:00:01.000Z" }, neverConcurrentOwners: true,
      acceptedDirectionInputBound: true, freshSessionBound: true, queueEmptyAfterDelivery: true, actualSimplePage: true, planRevisionRetained: true, deliveryRevisionBound: true } };
}
it("accepts a genuine fresh-response Interrupt and one post-cleanup owner", () => expect(gradeInterruption(valid()).passed).toBe(true));
it("accepts natural human control guidance", () => { const o = valid(); o.state.queryReply = "You can stop this execution with Interrupt on the waiting approved plan; after cleanup the next turn receives the saved simpler layout."; expect(gradeInterruption(o).passed).toBe(true); });
it("rejects a legacy protocol substitute", () => { const o = valid(); o.state.directionQueue.protocol = "legacy"; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects an invented fresh-session response", () => { const o = valid(); o.state.directionQueue.entries[0]!.source.requiresFreshSession = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects pending direction without actual human approval", () => { const o = valid(); o.state.planApprovedByHuman = false; expect(gradeInterruption(o).passed).toBe(false); });
it("does not grade the reply's wording", () => { const o = valid(); o.state.queryReply = "Open [the task](/COM/issues/COM-1) and press the control beside the queued plan."; expect(gradeInterruption(o).passed).toBe(true); });
it("rejects the agent stopping the run itself before the person acts", () => { const o = valid(); o.state.workerRunningAfterReply = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects a reply that leaves the person no rendered link to the task's Interrupt control", () => { const o = valid(); o.state.humanFollowedReplyTaskLink = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects a stop request without confirmed native acknowledgement", () => { const o = valid(); o.state.nativeStopAcknowledged = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects starting the new owner before the original settles", () => { const o = valid(); o.state.successor.startedAt = "2026-10-26T11:59:59.000Z"; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects observed concurrent ownership", () => { const o = valid(); o.state.neverConcurrentOwners = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects duplicate accepted-direction consumers", () => { const o = valid(); o.state.successorCount = 2; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects consuming a different plan revision", () => { const o = valid(); o.state.acceptedDirectionInputBound = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects continuing the old session despite the fresh bound response", () => { const o = valid(); o.state.freshSessionBound = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects rewriting the accepted plan after the interruption", () => { const o = valid(); o.state.planRevisionRetained = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects a friendly completion with no real simpler page", () => { const o = valid(); o.state.actualSimplePage = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects lost original run history", () => { const o = valid(); o.state.oldEvidenceRetained = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects missing actual interruption evidence", () => expect(gradeInterruption(undefined).passed).toBe(false));
// Shaped like run 42592781763: the successor saved website-delivery in its own
// words, without the plan's setup marker.
function delivery() {
  return { documents: [{ id: "plan-doc", key: "plan", issueId: "website", latestRevisionId: "plan-r1" }, { id: "brief-doc", key: "website-brief", issueId: "website", latestRevisionId: "brief-r1" }, { id: "delivery-doc", key: "website-delivery", issueId: "website", latestRevisionId: "delivery-r1" }],
    revisions: [{ id: "plan-r1", documentId: "plan-doc", createdByRunId: null, createdByAgentId: null, body: "# Approved simpler website direction\nSimpler layout nonce-1" },
      { id: "brief-r1", documentId: "brief-doc", createdByRunId: "new", createdByAgentId: "morgan", body: "# Website brief" },
      { id: "delivery-r1", documentId: "delivery-doc", createdByRunId: "new", createdByAgentId: "morgan", body: "# Website delivery\n- Deliverable: website.html, single semantic page." }] };
}
it("binds the successor's own current website-delivery revision without a copied setup marker", () => expect(deliveryRevisionBound(delivery(), "website", "new", "morgan")).toBe(true));
it("accepts reworded delivery prose", () => { const o = delivery(); (o.revisions[2] as { body: string }).body = "Shipped the one-page Acorn Notes site."; expect(deliveryRevisionBound(o, "website", "new", "morgan")).toBe(true); });
it("rejects a delivery document written by the stopped attempt", () => { const o = delivery(); o.revisions[2]!.createdByRunId = "old"; expect(deliveryRevisionBound(o, "website", "new", "morgan")).toBe(false); });
it("rejects a delivery written by another agent", () => { const o = delivery(); o.revisions[2]!.createdByAgentId = "ceo"; expect(deliveryRevisionBound(o, "website", "new", "morgan")).toBe(false); });
it("rejects a superseded successor revision", () => { const o = delivery(); o.documents[2]!.latestRevisionId = "later"; expect(deliveryRevisionBound(o, "website", "new", "morgan")).toBe(false); });
it("rejects only some other successor document", () => { const o = delivery(); o.documents.pop(); expect(deliveryRevisionBound(o, "website", "new", "morgan")).toBe(false); });
it("rejects a delivery document on a different task", () => { const o = delivery(); o.documents[2]!.issueId = "other"; expect(deliveryRevisionBound(o, "website", "new", "morgan")).toBe(false); });
