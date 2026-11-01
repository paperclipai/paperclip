import { describe, expect, it } from "vitest";
import { liveRunResultFeedback } from "./run-result-feedback.js";
const result = {
  reportedWorkDisposition: "done", summary: "Reported completion",
  completionClaim: { contractRevision: "revision-1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
  evidence: [], verification: [], attentionRequests: [], artifacts: [],
};
describe("live run-result feedback", () => {
  it("acknowledges a valid native run report without pretending to mutate the task", () => {
    expect(liveRunResultFeedback("paperclip_finish", result, "revision-1")).toEqual({ ok: true, result: { reportedWorkDisposition: "done", accepted: true, taskStateChanged: false } });
  });
  it.each([null, {}, { ...result, completionClaim: {} }, { ...result, completionClaim: { ...result.completionClaim, criteria: [] } }])("rejects missing or malformed evidence", value => {
    expect(liveRunResultFeedback("paperclip_finish", value, "revision-1")?.ok).toBe(false);
  });
  it("rejects stale revisions and mismatched terminal operations", () => {
    expect(liveRunResultFeedback("paperclip_finish", result, "revision-2")?.ok).toBe(false);
    expect(liveRunResultFeedback("paperclip_block", result, "revision-1")?.ok).toBe(false);
    expect(liveRunResultFeedback("finish_task", result, "revision-1")).toBeNull();
  });
});
