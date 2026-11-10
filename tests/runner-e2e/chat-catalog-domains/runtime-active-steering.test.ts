import { expect, it } from "vitest";
import { gradeActiveSteering, isBlueColor, hasVisibleBlueDesign } from "./runtime-active-steering.js";
function valid() {
  return { scenarioId: "steering.steer-active", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website" }], activity: [],
    runs: [{ id: "worker", status: "succeeded" }, { id: "source", status: "succeeded" }],
    state: { task: { id: "website" }, targetId: "blue", humanId: "human", workerRunId: "worker", workerWasReallyWaiting: true,
      queueBefore: { issueId: "website", targetRunId: "worker", protocol: "paperclip_runner_v1", steeringDisposition: "available", entries: [{ comment: { id: "blue", body: "Switch to a blue design while you are working.", authorUserId: "human", authorAgentId: null } }] },
      queueAfterAction: { entries: [] as Array<{ comment: { id: string; body: string } }> }, humanSteerSelected: true, agentSteerStatus: 403,
      queryReply: "Use Steer beside your saved message to send this direction to Morgan's active turn; waiting in the queue is separate from delivery.",
      steerObservedBranch: "same-run-acknowledged", steerStatus: 200, acknowledgedSameRun: true, steerAuditBound: true, idempotentRetryStatus: 200, ordinaryConsumerCount: 0,
      actualBlueArtifact: true, blueRevisionBound: true, workerTaskDone: true, queueEmptyAtEnd: true,
      steerFailureCode: "", providerFailureVisible: false, failureRetainedMessage: false, supportedContinuationVisible: false, continuationInputBound: false } };
}
it("accepts real explicit same-turn delivery and actual blue result", () => expect(gradeActiveSteering(valid()).passed).toBe(true));
it("accepts natural human-control guidance", () => { const o = valid(); o.state.queryReply = "Your direction is saved. Select the Steer action in Morgan's task to apply it during this execution."; expect(gradeActiveSteering(o).passed).toBe(true); });
it("accepts an actual visible provider rejection with retained one-time normal delivery", () => {
  const o = valid(); Object.assign(o.state, { steerObservedBranch: "provider-rejected-normal-continuation", steerStatus: 409, steerFailureCode: "steering_rejected", providerFailureVisible: true, failureRetainedMessage: true, supportedContinuationVisible: true, ordinaryConsumerCount: 1, continuationInputBound: true, acknowledgedSameRun: false, steerAuditBound: false });
  o.state.queueAfterAction.entries = [{ comment: { id: "blue", body: "Switch to a blue design while you are working." } }]; o.runs.push({ id: "ordinary", status: "succeeded" });
  expect(gradeActiveSteering(o).passed).toBe(true);
  o.state.failureRetainedMessage = false; expect(gradeActiveSteering(o).passed).toBe(false);
});
it("rejects queue admission without actual same-run acknowledgement", () => { const o = valid(); o.state.acknowledgedSameRun = false; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects hidden normal replay after accepted same-turn delivery", () => { const o = valid(); o.state.ordinaryConsumerCount = 1; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects steering a foreign run", () => { const o = valid(); o.state.queueBefore.targetRunId = "other"; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects falsely claiming the queued direction was already implemented", () => { const o = valid(); o.state.queryReply = "I have implemented the blue design with Steer."; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects a forged human steering action", () => { const o = valid(); o.state.agentSteerStatus = 200; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects saved blue prose without a rendered blue deliverable", () => { const o = valid(); o.state.actualBlueArtifact = false; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects unavailable advertised capability", () => { const o = valid(); o.state.queueBefore.steeringDisposition = "unsupported"; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects wrong human ownership", () => { const o = valid(); o.state.queueBefore.entries[0]!.comment.authorUserId = "other"; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects absent actual evidence", () => expect(gradeActiveSteering(undefined).passed).toBe(false));
it.each(["rgb(0, 0, 255)", "rgb(42, 90, 180)", "rgba(15, 30, 98, 1)"])("accepts actual blue computed colors %s", color => expect(isBlueColor(color)).toBe(true));
it.each(["rgb(255, 0, 0)", "rgb(240, 240, 240)", "rgb(100, 150, 100)", "transparent"])("rejects other computed colors %s", color => expect(isBlueColor(color)).toBe(false));

it.each(["rgba(0, 0, 255, 0)", "rgba(0, 0, 255, 0.01)"])("rejects transparent blue computed colors %s", color => expect(isBlueColor(color)).toBe(false));
it("rejects claiming the unobserved branch as qualified", () => { const o = valid(); o.state.steerObservedBranch = "provider-rejected-normal-continuation"; expect(gradeActiveSteering(o).passed).toBe(false); });

it("rejects a red page with only default blue links", () => expect(hasVisibleBlueDesign([{ tag: "BODY", color: "rgb(0, 0, 0)", background: "rgb(255, 0, 0)" }, { tag: "A", color: "rgb(0, 0, 238)", background: "rgba(0, 0, 0, 0)" }])).toBe(false));
it("accepts a natural blue heading accent on a white page", () => expect(hasVisibleBlueDesign([{ tag: "BODY", color: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)" }, { tag: "H1", color: "rgb(25, 70, 180)", background: "rgba(0, 0, 0, 0)" }])).toBe(true));
it("rejects transparent blue design elements", () => expect(hasVisibleBlueDesign([{ tag: "SECTION", color: "rgb(0, 0, 0)", background: "rgba(0, 0, 255, 0)" }])).toBe(false));
