import { describe, expect, it } from "vitest";
import { gradeActiveSteering, isBlueColor, hasVisibleBlueDesign, steerDeliveryRevisionBound, steeringBranch } from "./runtime-active-steering.js";
function valid() {
  return { scenarioId: "steering.steer-active", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website" }], activity: [],
    runs: [{ id: "worker", status: "succeeded" }, { id: "source", status: "succeeded" }],
    state: { task: { id: "website" }, targetId: "blue", humanId: "human", workerRunId: "worker", workerWasReallyWaiting: true,
      queueBefore: { issueId: "website", targetRunId: "worker", protocol: "paperclip_runner_v1", steeringDisposition: "available", entries: [{ comment: { id: "blue", body: "Switch to a blue design while you are working.", authorUserId: "human", authorAgentId: null } }] },
      queueAfterAction: { entries: [] as Array<{ comment: { id: string; body: string } }> }, humanSteerSelected: true, humanSteerAttempted: false, agentSteerStatus: 403,
      steerControlEnabled: true, continuationControlVisible: false, unsupportedStateRetained: false, steeredActivityCount: 1,
      queryReply: "Use Steer beside your saved message to send this direction to Morgan's active turn; waiting in the queue is separate from delivery.",
      steerObservedBranch: "same-run-acknowledged", steerStatus: 200, acknowledgedSameRun: true, steerAuditBound: true, idempotentRetryStatus: 200, ordinaryConsumerCount: 0,
      actualBlueArtifact: true, deliveryRevisionBound: true, workerTaskDone: true, queueEmptyAtEnd: true,
      steerFailureCode: "" as string | undefined, providerFailureVisible: false, failureRetainedMessage: false, supportedContinuationVisible: false, continuationInputBound: false } };
}
it("accepts real explicit same-turn delivery and actual blue result", () => expect(gradeActiveSteering(valid()).passed).toBe(true));
it("accepts an actual visible provider rejection with retained one-time normal delivery", () => {
  const o = valid(); Object.assign(o.state, { steerObservedBranch: "provider-rejected-normal-continuation", steerStatus: 409, steerFailureCode: "steering_rejected", providerFailureVisible: true, failureRetainedMessage: true, supportedContinuationVisible: true, ordinaryConsumerCount: 1, continuationInputBound: true, acknowledgedSameRun: false, steerAuditBound: false });
  o.state.queueAfterAction.entries = [{ comment: { id: "blue", body: "Switch to a blue design while you are working." } }]; o.runs.push({ id: "ordinary", status: "succeeded" });
  expect(gradeActiveSteering(o).passed).toBe(true);
  o.state.failureRetainedMessage = false; expect(gradeActiveSteering(o).passed).toBe(false);
});
it("rejects queue admission without actual same-run acknowledgement", () => { const o = valid(); o.state.acknowledgedSameRun = false; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects hidden normal replay after accepted same-turn delivery", () => { const o = valid(); o.state.ordinaryConsumerCount = 1; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects steering a foreign run", () => { const o = valid(); o.state.queueBefore.targetRunId = "other"; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects a forged human steering action", () => { const o = valid(); o.state.agentSteerStatus = 200; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects saved blue prose without a rendered blue deliverable", () => { const o = valid(); o.state.actualBlueArtifact = false; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects wrong human ownership", () => { const o = valid(); o.state.queueBefore.entries[0]!.comment.authorUserId = "other"; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects absent actual evidence", () => expect(gradeActiveSteering(undefined).passed).toBe(false));
it.each(["rgb(0, 0, 255)", "rgb(42, 90, 180)", "rgba(15, 30, 98, 1)"])("accepts actual blue computed colors %s", color => expect(isBlueColor(color)).toBe(true));
it.each(["rgb(255, 0, 0)", "rgb(240, 240, 240)", "rgb(100, 150, 100)", "transparent"])("rejects other computed colors %s", color => expect(isBlueColor(color)).toBe(false));

it.each(["rgba(0, 0, 255, 0)", "rgba(0, 0, 255, 0.01)"])("rejects transparent blue computed colors %s", color => expect(isBlueColor(color)).toBe(false));
it("rejects claiming the unobserved branch as qualified", () => { const o = valid(); o.state.steerObservedBranch = "provider-rejected-normal-continuation"; expect(gradeActiveSteering(o).passed).toBe(false); });

it("rejects a red page with only default blue links", () => expect(hasVisibleBlueDesign([{ tag: "BODY", color: "rgb(0, 0, 0)", background: "rgb(255, 0, 0)" }, { tag: "A", color: "rgb(0, 0, 238)", background: "rgba(0, 0, 0, 0)" }])).toBe(false));
it("accepts a natural blue heading accent on a white page", () => expect(hasVisibleBlueDesign([{ tag: "BODY", color: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)" }, { tag: "H1", color: "rgb(25, 70, 180)", background: "rgba(0, 0, 0, 0)" }])).toBe(true));
it("rejects transparent blue design elements", () => expect(hasVisibleBlueDesign([{ tag: "SECTION", color: "rgb(0, 0, 0)", background: "rgba(0, 0, 255, 0)" }])).toBe(false));

/** A runtime that cannot steer (the OpenCode harness advertises steering: false): the message stays visibly queued and one normal turn consumes it. */
function unsupported() {
  const o = valid();
  Object.assign(o.state, { steerObservedBranch: "unsupported-queued-normal-continuation", steerStatus: 409, steerFailureCode: "steering_unsupported", humanSteerSelected: false, humanSteerAttempted: true,
    steerControlEnabled: false, continuationControlVisible: true, unsupportedStateRetained: true, steeredActivityCount: 0, acknowledgedSameRun: false, steerAuditBound: false, idempotentRetryStatus: 0,
    ordinaryConsumerCount: 1, continuationInputBound: true });
  o.state.queueBefore.steeringDisposition = "unsupported";
  o.state.queueAfterAction.entries = [{ comment: { id: "blue", body: "Switch to a blue design while you are working." } }]; o.runs.push({ id: "ordinary", status: "succeeded" });
  return o;
}
it("accepts an honestly unsupported runtime that keeps the message queued for one normal continuation", () => expect(gradeActiveSteering(unsupported()).passed).toBe(true));
it.each(["Your direction is saved. Select the Steer action in Morgan's task to apply it during this execution.", "I have implemented the blue design with Steer.", "Queued for Morgan's next turn."])(
  "verdict does not depend on reply wording: %s", reply => { for (const o of [valid(), unsupported()]) { o.state.queryReply = reply; expect(gradeActiveSteering(o).passed).toBe(true); } });
it.each([
  ["claims steering was recorded", (o: ReturnType<typeof unsupported>) => { o.state.steeredActivityCount = 1; }],
  ["offers an enabled Steer control it cannot honour", (o: ReturnType<typeof unsupported>) => { o.state.steerControlEnabled = true; }],
  ["hides the supported continuation control", (o: ReturnType<typeof unsupported>) => { o.state.continuationControlVisible = false; }],
  ["drops the queued message after the refused attempt", (o: ReturnType<typeof unsupported>) => { o.state.queueAfterAction.entries = []; }],
  ["stops reporting the capability after the attempt", (o: ReturnType<typeof unsupported>) => { o.state.unsupportedStateRetained = false; }],
  ["accepts the steer request without a runtime that can steer", (o: ReturnType<typeof unsupported>) => { o.state.steerStatus = 200; }],
  ["refuses with an unrelated conflict", (o: ReturnType<typeof unsupported>) => { o.state.steerFailureCode = "queued_comment_stale_queue"; }],
  ["never delivers the message", (o: ReturnType<typeof unsupported>) => { o.state.ordinaryConsumerCount = 0; o.runs.pop(); }],
  ["delivers it twice", (o: ReturnType<typeof unsupported>) => { o.state.ordinaryConsumerCount = 2; o.runs.push({ id: "again", status: "succeeded" }); }],
  ["continuation input lacks the message", (o: ReturnType<typeof unsupported>) => { o.state.continuationInputBound = false; }],
  ["lets the agent steer for the person", (o: ReturnType<typeof unsupported>) => { o.state.agentSteerStatus = 200; }],
  ["produces no rendered blue page", (o: ReturnType<typeof unsupported>) => { o.state.actualBlueArtifact = false; }],
])("rejects an unsupported runtime that %s", (_label, mutate) => { const o = unsupported(); mutate(o); expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects a queue that never states a definitive steering capability", () => { const o = valid(); o.state.queueBefore.steeringDisposition = "temporarily_unavailable"; expect(gradeActiveSteering(o).passed).toBe(false); });
it("rejects an advertised Steer control that the page does not enable", () => { const o = valid(); o.state.steerControlEnabled = false; expect(gradeActiveSteering(o).passed).toBe(false); });
it("accepts a delivery document that names the colour another way, since the rendered page proves it", () => { const o = valid(); o.state.deliveryRevisionBound = true; expect(gradeActiveSteering(o).passed).toBe(true); o.state.deliveryRevisionBound = false; expect(gradeActiveSteering(o).passed).toBe(false); });
it.each([["available", 200, "same-run-acknowledged"], ["available", 409, "provider-rejected-normal-continuation"], ["unsupported", 409, "unsupported-queued-normal-continuation"], ["temporarily_unavailable", 409, "not-advertised"]] as const)(
  "maps %s capability and status %s to its branch", (disposition, status, branch) => expect(steeringBranch(disposition, status)).toBe(branch));

it("binds only the requested website-delivery document written by the consuming run", async () => {
  const { deliveryRevisionBound } = await import("./runtime-interruption.js");
  const o = { documents: [{ id: "note", key: "notes", issueId: "website", latestRevisionId: "n1" }, { id: "d", key: "website-delivery", issueId: "website", latestRevisionId: "d1" }],
    revisions: [{ id: "n1", documentId: "note", createdByRunId: "ordinary", createdByAgentId: "morgan" }, { id: "d1", documentId: "d", createdByRunId: "ordinary", createdByAgentId: "morgan" }] };
  expect(deliveryRevisionBound(o, "website", "ordinary", "morgan")).toBe(true);
  o.documents = o.documents.filter(doc => doc.key !== "website-delivery");
  expect(deliveryRevisionBound(o, "website", "ordinary", "morgan")).toBe(false);
});

// Retained runner-opencode attempt (gha-43077703607): the CEO relayed the direction as its own comment on Morgan's task.
// It queues beside the person's message and reaches Morgan through normal admission; it is not the person's to steer.
it("accepts a same-turn steer when the chat lead's own relay stays queued for one normal continuation", () => {
  const o = valid(); Object.assign(o.state, { leadRelayCount: 1, ordinaryConsumerCount: 1 });
  o.state.queueAfterAction.entries = [{ comment: { id: "relay", body: "Use a blue palette.", authorAgentId: "ceo" } } as never]; o.runs.push({ id: "relay-consumer", status: "succeeded" });
  expect(gradeActiveSteering(o).passed).toBe(true);
  o.state.ordinaryConsumerCount = 0; expect(gradeActiveSteering(o).passed).toBe(false);
});
it("rejects a same-turn steer that left the person's message queued", () => {
  const o = valid(); o.state.queueAfterAction.entries = [{ comment: { id: "blue", body: "Switch to a blue design while you are working.", authorAgentId: null } } as never];
  expect(gradeActiveSteering(o).passed).toBe(false);
});
it("rejects an extra run after a same-turn steer when no relay was queued", () => {
  const o = valid(); o.runs.push({ id: "extra", status: "succeeded" }); expect(gradeActiveSteering(o).passed).toBe(false);
});
it("accepts an unsupported runtime whose continuation also consumes the chat lead's relay", () => {
  const o = unsupported(); Object.assign(o.state, { leadRelayCount: 1 });
  o.state.queueAfterAction.entries.push({ comment: { id: "relay", body: "Use a blue palette.", authorAgentId: "ceo" } } as never);
  expect(gradeActiveSteering(o).passed).toBe(true);
});

describe("website-delivery document after a same-turn steer with a queued relay", () => {
  const doc = (latest: string) => ({ documents: [{ id: "doc", key: "website-delivery", issueId: "website", latestRevisionId: latest }],
    revisions: [{ id: "r1", documentId: "doc", createdByRunId: "worker", createdByAgentId: "morgan" }, { id: "r2", documentId: "doc", createdByRunId: "relay-consumer", createdByAgentId: "morgan" },
      { id: "r3", documentId: "doc", createdByRunId: "other", createdByAgentId: "morgan" }] });
  it("accepts the steered turn's own revision", () => expect(steerDeliveryRevisionBound(doc("r1") as never, "website", "morgan", "worker")).toBe(true));
  it("accepts a later revision by the relay consumer", () => expect(steerDeliveryRevisionBound(doc("r2") as never, "website", "morgan", "worker", "relay-consumer")).toBe(true));
  it("rejects a later revision by the relay consumer when no relay was queued", () => expect(steerDeliveryRevisionBound(doc("r2") as never, "website", "morgan", "worker")).toBe(false));
  it("rejects a revision by any other run", () => expect(steerDeliveryRevisionBound(doc("r3") as never, "website", "morgan", "worker", "relay-consumer")).toBe(false));
});
