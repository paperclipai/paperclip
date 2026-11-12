import { describe, expect, it } from "vitest";
import { unmetPriorDeliveryReview } from "./internal-task-completion.js";

describe("completion gate setup readiness", () => {
  const review = { status: "pending", currentStageId: "stage", currentStageType: "review", currentParticipant: { type: "user", userId: "riley" } };
  const ready = () => ({ task: { id: "task", status: "in_review", executionState: structuredClone(review) },
    runs: [{ id: "run", agentId: "morgan", status: "succeeded" }],
    attachments: [{ id: "html", sha256: "a", createdByAgentId: "morgan", originatingRunId: "run" }] });
  it("accepts the configured review pending after a delivered implementation", () => {
    expect(unmetPriorDeliveryReview(ready(), "morgan", "riley")).toEqual([]);
    const continued = ready(); continued.runs.push({ id: "next", agentId: "morgan", status: "succeeded" });
    expect(unmetPriorDeliveryReview(continued, "morgan", "riley")).toEqual([]);
  });
  it("names each unmet field of a review requested outside the configured stage", () => {
    const generic = ready(); Object.assign(generic.task, { executionState: null });
    expect(unmetPriorDeliveryReview(generic, "morgan", "riley")).toEqual([
      "executionState.status=null (want pending)", "executionState.currentParticipant=null (want the configured reviewer)"]);
  });
  it("names a bypassed review, an active run and a missing delivery", () => {
    const bypassed = ready(); Object.assign(bypassed.task, { status: "done", executionState: null });
    bypassed.runs.push({ id: "live", agentId: "morgan", status: "running" }); bypassed.attachments = [];
    expect(unmetPriorDeliveryReview(bypassed, "morgan", "riley")).toEqual([
      "task.status=done (want in_review)", "executionState.status=null (want pending)",
      "executionState.currentParticipant=null (want the configured reviewer)", "active worker runs=1 (want 0)",
      "worker deliveries from a succeeded worker run=0 of 0 attachments (want at least 1)"]);
    const failedBeside = ready(); failedBeside.runs.push({ id: "lost", agentId: "morgan", status: "failed" });
    expect(unmetPriorDeliveryReview(failedBeside, "morgan", "riley")).toEqual(["failed worker runs=1 (want 0)"]);
    const other = ready(); other.task.executionState.currentParticipant.userId = "someone";
    expect(unmetPriorDeliveryReview(other, "morgan", "riley")).toEqual(["executionState.currentParticipant=user:other (want the configured reviewer)"]);
  });
});
