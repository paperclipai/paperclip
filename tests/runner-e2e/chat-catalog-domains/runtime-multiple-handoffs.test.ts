import { expect, it } from "vitest";
import { gradeMultipleHandoffs } from "./runtime-multiple-handoffs.js";
function valid() {
  const logo = { id: "logo", title: "Logo", companyId: "company", status: "done", assigneeAgentId: "riley" };
  const artifact = { contentVerified: true, attachmentId: "logo-file", sha256: "same", content: "<svg><text>Acorn real-marker</text></svg>" };
  return { scenarioId: "agent-chat.multiple-handoffs", companyId: "company", leadId: "ceo", agents: [], links: [], activity: [], humanQueries: [], reply: "",
    tasks: [logo, { id: "website", assigneeAgentId: "morgan", status: "done" }],
    runs: [{ id: "logo-run", agentId: "riley", status: "succeeded" }, { id: "prior", agentId: "morgan", status: "succeeded" },
      { id: "setup", agentId: "ceo", status: "succeeded" }, { id: "canonical", agentId: "ceo", status: "succeeded" }, { id: "consumer", agentId: "morgan", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, logoWorker: { id: "riley" }, workerRunId: "prior", canonicalRunId: "canonical",
      queueAtReply: { issueId: "website", targetRunId: "prior", state: "queued", entries: [{ comment: { id: "headline", authorAgentId: "ceo", createdByRunId: "canonical", body: "Change the headline to Launch sooner." } }] },
      sourceHistoryBound: true, workerRunningAtReply: true, nativeDeliveryBound: true, queueEmptyAfterDelivery: true, logoBefore: logo, logoAfter: structuredClone(logo),
      logoArtifactBefore: artifact, logoArtifactAfter: { ...artifact }, logoMarker: "real-marker", logoRevisionsUnchanged: true,
      queryReply: "I saved the headline feedback in the existing Website queue while Morgan is busy. The logo remains unchanged.",
      finalHeadlineRevision: true, originalWebsiteRevisionRetained: true } };
}
it("accepts one Website delivery with real completed Logo preservation", () => expect(gradeMultipleHandoffs(valid()).passed).toBe(true));
it("accepts natural pending-delivery wording for the exact affected work", () => { const o = valid(); o.state.queryReply = "Website's new headline requirement will wait for Morgan's next turn; I left Riley's completed logo alone."; expect(gradeMultipleHandoffs(o).passed).toBe(true); });
it("rejects missing independent two-task evidence", () => expect(gradeMultipleHandoffs(undefined).passed).toBe(false));
it("rejects routing headline feedback to Logo instead", () => { const o = valid(); o.state.queueAtReply.issueId = "logo"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects duplicate saved headline requirements", () => { const o = valid(); o.state.queueAtReply.entries.push({ ...o.state.queueAtReply.entries[0]! }); expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects feedback attributed to the earlier source setup turn", () => { const o = valid(); o.state.queueAtReply.entries[0]!.comment.createdByRunId = "setup"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects a consuming run without the exact saved comment", () => { const o = valid(); o.state.nativeDeliveryBound = false; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects changing the actual delivered Logo bytes", () => { const o = valid(); o.state.logoArtifactAfter.content = "<svg>new</svg>"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects retaining a Logo filename but replacing its artifact", () => { const o = valid(); o.state.logoArtifactAfter.attachmentId = "replacement"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects erasing an earlier Logo revision", () => { const o = valid(); o.state.logoRevisionsUnchanged = false; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects claiming implementation before active-run consumption", () => { const o = valid(); o.state.queryReply = "The Website headline has been changed; the queued request is complete."; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects redirection to a different worker", () => { const o = valid(); o.tasks[1]!.assigneeAgentId = "riley"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects losing the original Website work", () => { const o = valid(); o.state.originalWebsiteRevisionRetained = false; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
