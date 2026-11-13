import { expect, it } from "vitest";
import { gradeMultipleHandoffs, promptCarriesComment } from "./runtime-multiple-handoffs.js";
function valid() {
  const logo = { id: "logo", identifier: "RUN-1", title: "Logo", companyId: "company", status: "done", assigneeAgentId: "riley" };
  const artifact = { contentVerified: true, attachmentId: "logo-file", sha256: "same", content: "<svg><text>Acorn real-marker</text></svg>" };
  return { scenarioId: "agent-chat.multiple-handoffs", companyId: "company", leadId: "ceo", agents: [], links: [], activity: [], humanQueries: [], reply: "",
    tasks: [logo, { id: "8ba8b5a2-066a-4bb2-b591-e396942ecdf5", assigneeAgentId: "morgan", status: "done" }],
    runs: [{ id: "logo-run", agentId: "riley", status: "succeeded" }, { id: "prior", agentId: "morgan", status: "succeeded" },
      { id: "setup", agentId: "ceo", status: "succeeded" }, { id: "canonical", agentId: "ceo", status: "succeeded" }, { id: "consumer", agentId: "morgan", status: "succeeded" }],
    state: { task: { id: "8ba8b5a2-066a-4bb2-b591-e396942ecdf5", identifier: "RUN-2" }, worker: { id: "morgan" }, logoWorker: { id: "riley" }, workerRunId: "prior", canonicalRunId: "canonical",
      queueAtReply: { issueId: "8ba8b5a2-066a-4bb2-b591-e396942ecdf5", targetRunId: "prior", state: "queued", entries: [{ comment: { id: "headline", authorAgentId: "ceo", createdByRunId: "canonical", body: "Change the headline to Launch sooner." } }] },
      sourceHistoryBound: true, workerRunningAtReply: true, nativeDeliveryBound: true, queueEmptyAfterDelivery: true, logoBefore: logo, logoAfter: structuredClone(logo),
      logoArtifactBefore: artifact, logoArtifactAfter: { ...artifact }, logoMarker: "real-marker", logoRevisionsUnchanged: true,
      queryReply: "I saved the headline feedback on [RUN-2](/RUN/issues/RUN-2) while Morgan is busy. The logo [RUN-1](/RUN/issues/RUN-1) remains unchanged.",
      finalHeadlineRevision: true, originalWebsiteRevisionRetained: true } };
}
it("accepts one Website delivery with real completed Logo preservation", () => expect(gradeMultipleHandoffs(valid()).passed).toBe(true));
it("accepts reworded replies that name the affected task by identifier or link", () => {
  for (const reply of ["RUN-2's new headline requirement will wait for Morgan's next turn; I left Riley's completed logo alone.",
    "Morgan will pick up \"Launch sooner\" when the current turn ends: [Website task](/RUN/issues/RUN-2#comment-headline).",
    "Queued for Morgan on RUN-2. Nothing changed on RUN-1."]) {
    const o = valid(); o.state.queryReply = reply; expect(gradeMultipleHandoffs(o).passed).toBe(true);
  }
});
it("rejects a reply that does not name the affected Website task", () => {
  for (const reply of ["I saved the headline change for the website.", "Saved on RUN-20 for Morgan.", "The logo RUN-1 is unchanged."]) {
    const o = valid(); o.state.queryReply = reply; expect(gradeMultipleHandoffs(o).passed).toBe(false);
  }
});
it("rejects missing independent two-task evidence", () => expect(gradeMultipleHandoffs(undefined).passed).toBe(false));
it("rejects routing headline feedback to Logo instead", () => { const o = valid(); o.state.queueAtReply.issueId = "logo"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects duplicate saved headline requirements", () => { const o = valid(); o.state.queueAtReply.entries.push({ ...o.state.queueAtReply.entries[0]! }); expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects feedback attributed to the earlier source setup turn", () => { const o = valid(); o.state.queueAtReply.entries[0]!.comment.createdByRunId = "setup"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects a consuming run without the exact saved comment", () => { const o = valid(); o.state.nativeDeliveryBound = false; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects changing the actual delivered Logo bytes", () => { const o = valid(); o.state.logoArtifactAfter.content = "<svg>new</svg>"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects retaining a Logo filename but replacing its artifact", () => { const o = valid(); o.state.logoArtifactAfter.attachmentId = "replacement"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects erasing an earlier Logo revision", () => { const o = valid(); o.state.logoRevisionsUnchanged = false; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects a reply written after the active worker stopped holding the saved instruction", () => { const o = valid(); o.state.workerRunningAtReply = false; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects redirection to a different worker", () => { const o = valid(); o.tasks[1]!.assigneeAgentId = "riley"; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("rejects losing the original Website work", () => { const o = valid(); o.state.originalWebsiteRevisionRetained = false; expect(gradeMultipleHandoffs(o).passed).toBe(false); });
it("finds a delivered comment in a native continuation that embeds it as JSON", () => {
  const comment = { id: "b9e3ab32-934e-4d07-a5cf-e06fc28d574a", body: 'The headline must be **"Launch sooner"** — nothing else.\nKeep the logo.' };
  const prompt = `## Paperclip Wake Payload\n${JSON.stringify({ messages: [{ id: comment.id, authorType: "agent", body: comment.body }] })}`;
  expect(promptCarriesComment(prompt, comment)).toBe(true);
  expect(promptCarriesComment(`plain ${comment.id}\n${comment.body}`, comment)).toBe(true);
  expect(promptCarriesComment(prompt.replace(comment.id, "other"), comment)).toBe(false);
  expect(promptCarriesComment(prompt.replace("Launch sooner", "Launch later"), comment)).toBe(false);
  expect(promptCarriesComment(undefined, comment)).toBe(false);
});
