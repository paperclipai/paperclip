import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { gradePreserveDraft } from "./runtime-steering.js";
function valid() {
  const briefBody = "# Real website brief\n"; const hash = createHash("sha256").update(briefBody).digest("hex");
  const attachment = { id: "upload", issueId: "source", companyId: "company", createdByUserId: "person", createdByAgentId: null, sha256: hash };
  const otherTask = { id: "other", title: "Other task", status: "backlog" };
  return { scenarioId: "steering.preserve-draft", companyId: "company", leadId: "ceo",
    state: { originalQuery: "Build the page from this brief, but keep the copy short.", restoredDraft: "Build the page from this brief, but keep the copy short.",
      restoredAttachmentVisible: true, beforeSendHumanCount: 0, otherTaskDraftIsolated: true, otherTaskAttachmentsEmpty: true,
      briefAttachment: attachment, savedAttachment: { ...attachment, issueCommentId: "comment" }, sourceIssueId: "source", briefHash: hash,
      briefBody, downloadedBrief: briefBody, transport: { commentId: "comment", replayedCommentId: "comment", clientRequestId: "request" },
      sourceComments: [{ id: "comment", clientRequestId: "request", authorUserId: "person" }], persistedCommentReviewedBeforeReplay: true, otherTask },
    agents: [], tasks: [otherTask], links: [], reply: "", activity: [], runs: [{ id: "run", contextSnapshot: { wakeCommentId: "comment" } }], humanQueries: [] };
}
it("accepts retained draft, real source-bound upload and one reconciled send", () => expect(gradePreserveDraft(valid()).passed).toBe(true));
it("rejects missing draft evidence", () => expect(gradePreserveDraft(undefined).passed).toBe(false));
it("rejects leaking the unsent draft into the other task", () => {
  const o = valid(); o.state.otherTaskDraftIsolated = false; expect(gradePreserveDraft(o).passed).toBe(false);
});
it("rejects an upload attached to a different human comment", () => {
  const o = valid(); o.state.savedAttachment.issueCommentId = "other-comment"; expect(gradePreserveDraft(o).passed).toBe(false);
});
it("rejects duplicate native admission after lost acknowledgement replay", () => {
  const o = valid(); o.runs.push({ id: "duplicate", contextSnapshot: { wakeCommentId: "comment" } }); expect(gradePreserveDraft(o).passed).toBe(false);
});
it("rejects a receipt whose actual downloaded bytes changed", () => {
  const o = valid(); o.state.downloadedBrief = "Different brief"; expect(gradePreserveDraft(o).passed).toBe(false);
});
