import { expect, it } from "vitest";
import { gradeInterruption } from "./runtime-interruption.js";
function valid() {
  return { scenarioId: "steering.interrupt-with-direction", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website", status: "done" }], activity: [],
    runs: [{ id: "old", status: "cancelled" }, { id: "source", status: "succeeded" }, { id: "new", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, workerRunId: "old", approvedDirection: { id: "accepted-plan" },
      directionQueue: { issueId: "website", targetRunId: "old", protocol: "paperclip_runner_v1", entries: [{ source: { kind: "interaction", requiresFreshSession: true, interactionId: "accepted-plan" } }] },
      planApprovedByHuman: true, interruptControlEnabled: true, humanInterrupted: true, interruptStatus: 200,
      oldRunAfter: { id: "old", status: "cancelled", finishedAt: "2026-10-26T12:00:00.000Z" }, nativeStopAcknowledged: true, oldEvidenceRetained: true,
      queryReply: "Use the supported Interrupt button beside your saved simpler plan response. It stops the current attempt before sending the accepted direction to one eligible fresh continuation.",
      successorCount: 1, successor: { id: "new", agentId: "morgan", status: "succeeded", startedAt: "2026-10-26T12:00:01.000Z" }, neverConcurrentOwners: true,
      acceptedDirectionInputBound: true, freshSessionBound: true, queueEmptyAfterDelivery: true, actualSimplePage: true, planRevisionRetained: true, deliveryRevisionBound: true } };
}
it("accepts a genuine fresh-response Interrupt and one post-cleanup owner", () => expect(gradeInterruption(valid()).passed).toBe(true));
it("accepts natural human control guidance", () => { const o = valid(); o.state.queryReply = "You can stop this execution with Interrupt on the waiting approved plan; after cleanup the next turn receives the saved simpler layout."; expect(gradeInterruption(o).passed).toBe(true); });
it("rejects a legacy protocol substitute", () => { const o = valid(); o.state.directionQueue.protocol = "legacy"; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects an invented fresh-session response", () => { const o = valid(); o.state.directionQueue.entries[0]!.source.requiresFreshSession = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects pending direction without actual human approval", () => { const o = valid(); o.state.planApprovedByHuman = false; expect(gradeInterruption(o).passed).toBe(false); });
it("rejects chat claiming a human interruption it did not perform", () => { const o = valid(); o.state.queryReply = "I have stopped Morgan; use the Interrupt control next."; expect(gradeInterruption(o).passed).toBe(false); });
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
