import { expect, it, vi } from "vitest";
import { gradePostStop, sameSourcePostStopChronology, releasePostStopGateAfterCleanup } from "./runtime-post-stop.js";
function chronology() {
  const old = { id: "old", nativeIssueId: "source", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "cancelled", finishedAt: "2026-10-26T12:00:02Z", resultJson: { nativeCancellation: { schema: "paperclip.native-cancellation.v1", intentId: "intent", intentAuditId: "audit-intent", acknowledgementAuditId: "audit-ack", issueId: "source", companyId: "company", runId: "old", scope: "run", recordedAt: "2026-10-26T12:00:00Z", acknowledgedAt: "2026-10-26T12:00:02Z", dispatchState: "acknowledged", dispatched: true } } };
  return { old, next: { id: "new", nativeIssueId: "source", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", startedAt: "2026-10-26T12:00:03Z" }, boundary: { runId: "old", issueId: "source", intentId: "intent", intentRecordedAt: "2026-10-26T12:00:00Z" }, human: { id: "canonical", body: "Now make the website a single page instead.", issueId: "source", companyId: "company", authorAgentId: null, authorUserId: "person", createdAt: "2026-10-26T12:00:01Z" }, query: "Now make the website a single page instead.", companyId: "company", agentId: "ceo", humanId: "person", prompt: "canonical\nNow make the website a single page instead.", wakeCommentIds: ["canonical"] } as unknown as Parameters<typeof sameSourcePostStopChronology>[0];
}
function valid() {
  return { companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: ["initial", "canonical"], reply: "", tasks: [], activity: [], runs: [{ id: "old", agentId: "ceo", status: "cancelled" }, { id: "new", agentId: "ceo", status: "succeeded" }], state: { stopStatus: 200, gateReleasedAfterCleanup: true, chronologyBound: true, providerExited: true, initialHumanRetained: true, singleSuccessor: true, sameCurrentAssignment: true, oldEvidenceRetained: true, actualSimplePage: true, artifactRunBound: true, canonicalReply: "The single-page website is built and saved here." } };
}
it("binds the real unchanged canonical human instruction between same-source Stop intent and cleanup ACK", () => expect(sameSourcePostStopChronology(chronology())).toBe(true));
it("rejects wrong-source, early, late, duplicate, resumed or unacknowledged deliveries", () => {
  for (const change of [(v: ReturnType<typeof chronology>) => { v.human.issueId = "other"; }, (v: ReturnType<typeof chronology>) => { v.old.nativeIssueId = "other"; }, (v: ReturnType<typeof chronology>) => { v.next.agentId = "other"; }, (v: ReturnType<typeof chronology>) => { v.human.createdAt = "2026-10-26T12:00:03Z" as never; }, (v: ReturnType<typeof chronology>) => { v.next.startedAt = "2026-10-26T12:00:01Z" as never; }, (v: ReturnType<typeof chronology>) => { v.wakeCommentIds.push("initial"); }, (v: ReturnType<typeof chronology>) => { v.prompt = "a different instruction"; }, (v: ReturnType<typeof chronology>) => { v.old.status = "succeeded"; }, (v: ReturnType<typeof chronology>) => { (v.old.resultJson!.nativeCancellation as Record<string, unknown>).dispatchState = "pending"; }]) { const v = chronology(); change(v); expect(sameSourcePostStopChronology(v)).toBe(false); }
});
it("accepts real post-cleanup delivery and a natural substantive result paraphrase", () => {
  expect(gradePostStop(valid()).passed).toBe(true); const o = valid(); o.state.canonicalReply = "Acorn Notes is ready, with its signup action and all the content together. The artifact is saved in this conversation."; expect(gradePostStop(o).passed).toBe(true);
});
it("rejects polite completion without actual same-source cleanup, delivery or rendered output", () => {
  for (const key of ["gateReleasedAfterCleanup", "chronologyBound", "providerExited", "initialHumanRetained", "singleSuccessor", "sameCurrentAssignment", "oldEvidenceRetained", "actualSimplePage", "artifactRunBound"] as const) { const o = valid(); o.state[key] = false; expect(gradePostStop(o).passed).toBe(false); }
  const o = valid(); o.state.canonicalReply = "The website is still queued and not built."; expect(gradePostStop(o).passed).toBe(false); expect(gradePostStop(undefined).passed).toBe(false);
});

it("releases the neutral command gate after real cleanup without waiting for successor success", async () => {
  const release = vi.fn(async () => {}), old = chronology().old;
  await expect(releasePostStopGateAfterCleanup(old, false, release)).rejects.toThrow("cleanup");
  await expect(releasePostStopGateAfterCleanup({ ...old, status: "running" }, true, release)).rejects.toThrow("cleanup");
  const pending = chronology().old; (pending.resultJson!.nativeCancellation as Record<string, unknown>).dispatchState = "pending";
  await expect(releasePostStopGateAfterCleanup(pending, true, release)).rejects.toThrow("cleanup"); expect(release).not.toHaveBeenCalled();
  // No successor outcome is an input: it may still be running and retrying the
  // legitimate initial command. Releasing only its neutral result avoids a cycle.
  await releasePostStopGateAfterCleanup(old, true, release); expect(release).toHaveBeenCalledOnce();
});
