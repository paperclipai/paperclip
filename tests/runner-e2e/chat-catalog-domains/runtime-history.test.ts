import { it, expect } from "vitest";
import { gradeRememberPreview, gradeBrowserReconnect } from "./runtime-history.js";
function preview() {
  const artifact = { contentVerified: true, attachmentId: "blue", sha256: "hash", content: "<h1>Blue Selected Orchid</h1>", workProductId: "product" };
  return { scenarioId: "agent-chat.remember-and-follow-up", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { previewBefore: artifact, previewAfter: { ...artifact }, designMarker: "Selected Orchid", filename: "blue-preview.html", reloaded: true, historyRetained: true,
      choiceEstablished: true, canonicalRunIds: ["query"], queryReply: "Here is the blue preview we selected.", queryLinks: ["/api/attachments/blue/content?download=1"],
      linkedPreviews: [{ attachmentId: "blue", issueId: "source", originalFilename: "blue-preview.html", sha256: "hash", contentVerified: true }],
      unknownDesignPhase: { attributed: true, answeredTurn: true, runIds: ["unknown"], reply: "Which green design?", questionIds: [] as string[], createdArtifacts: [] as string[], createdRevisions: [] as string[] } },
    agents: [], tasks: [] as Array<{ id: string; description?: string }>, links: ["/api/attachments/blue/content?download=1"], activity: [], reply: "Blue preview", humanQueries: [],
    runs: [{ id: "prior", agentId: "ceo", status: "succeeded" }, { id: "query", agentId: "ceo", status: "succeeded" }, { id: "unknown", agentId: "ceo", status: "succeeded" }] };
}
it("accepts the same real blue preview after reload", () => expect(gradeRememberPreview(preview()).passed).toBe(true));
it("does not grade reply wording in either phase", () => { const o = preview(); o.state.queryReply = "Sure, opening it again."; o.state.unknownDesignPhase.reply = "Hmm, I only have one design on record."; expect(gradeRememberPreview(o).passed).toBe(true); });
it("accepts a byte-identical re-registration of the selected preview", () => { const o = preview(); o.state.queryLinks = ["/api/attachments/copy/content?download=1"]; o.state.linkedPreviews = [{ ...o.state.linkedPreviews[0]!, attachmentId: "copy" }]; expect(gradeRememberPreview(o).passed).toBe(true); });
it("accepts a clarification asked as a pending question card", () => { const o = preview(); Object.assign(o.state.unknownDesignPhase, { attributed: false, reply: "", questionIds: ["card"] }); expect(gradeRememberPreview(o).passed).toBe(true); });
it("rejects absent history evidence", () => expect(gradeRememberPreview(undefined).passed).toBe(false));
it("rejects an inaccessible or substituted preview", () => { const o = preview(); o.state.previewAfter.attachmentId = "other"; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects linking a regenerated preview with different bytes", () => { const o = preview(); o.state.linkedPreviews = [{ ...o.state.linkedPreviews[0]!, sha256: "regenerated" }]; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects a linked preview whose download does not match its record", () => { const o = preview(); o.state.linkedPreviews = [{ ...o.state.linkedPreviews[0]!, contentVerified: false }]; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects a preview link only present in an earlier phase", () => { const o = preview(); o.state.queryLinks = []; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects asking which design instead of returning the preview", () => { const o = preview(); o.state.queryReply = "Which design did you mean?"; o.state.queryLinks = []; o.state.linkedPreviews = []; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects inventing blue agreement without established history", () => { const o = preview(); o.state.choiceEstablished = false; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects unrequested follow-up work", () => { const o = preview(); o.tasks = [{ id: "followup", description: "Use the blue design" }]; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects fabricating the unestablished alternate preview", () => { const o = preview(); o.state.unknownDesignPhase.createdArtifacts = ["green-preview"]; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects changing saved documents before the clarification is answered", () => { const o = preview(); o.state.unknownDesignPhase.createdRevisions = ["green-selection"]; expect(gradeRememberPreview(o).passed).toBe(false); });
it("rejects clarification from the wrong execution phase", () => { const o = preview(); o.state.unknownDesignPhase.answeredTurn = false; expect(gradeRememberPreview(o).passed).toBe(false); });
function reconnect() {
  return { scenarioId: "recovery.browser-reconnect", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { task: { id: "website", identifier: "ACORN-1" }, worker: { id: "morgan" }, workerRunId: "worker",
      workerWasReallyWaiting: true, offlineObserved: true, workerStatusBeforeDisconnect: "running", workerStatusWhileOffline: "succeeded",
      taskStatusWhileOffline: "done", serverAdvancedWhileOffline: true, reconnected: true, historyRetained: true,
      offlineCommentsRetained: true, queryReply: "The website ACORN-1 finished while you were away.",
      remainingPhase: { attributed: true, reply: "That follow-up is still running and waiting for the brief.", taskId: "followup", runId: "remaining", offlineObserved: true, runningWhileOffline: true, reconnected: true, runStatusAtReply: "running", taskStatusAtReply: "in_progress" },
      failedReconnectPhase: { attributed: true, reply: "Riley's attempt failed with a provider model configuration error.", runId: "real-failure", taskId: "failed-task", offlineObserved: true, failedWhileOffline: true, reconnected: true } },
    agents: [], tasks: [{ id: "website", status: "done" }, { id: "followup", status: "done" }, { id: "failed-task", status: "blocked" }], documents: [{ id: "delivery", title: "Website delivery", latestRevisionId: "saved" }],
    revisions: [{ id: "saved", documentId: "delivery", createdByRunId: "worker", createdByAgentId: "morgan" }],
    links: [], activity: [], reply: "", humanQueries: ["Track this", "Did you finish while I was disconnected?", "Is the follow-up finished?", "Did Riley finish?"],
    runs: [{ id: "worker", agentId: "morgan", status: "succeeded" }, { id: "prior", agentId: "ceo", status: "succeeded" }, { id: "query", agentId: "ceo", status: "succeeded" }, { id: "remaining", agentId: "morgan", status: "succeeded" }, { id: "status", agentId: "ceo", status: "succeeded" },
      { id: "real-failure", agentId: "riley", status: "failed", runtimeMode: "native", errorCode: "native_provider_model_rejected" }, { id: "failed-status", agentId: "ceo", status: "succeeded" }] };
}
it("accepts natural independently attributed completed, remaining and failed reconnect reports", () => { const o = reconnect(); o.state.queryReply = "Website completed on the server while your browser was offline."; o.state.remainingPhase.reply = "The follow-up remains in progress and needs the human brief."; o.state.failedReconnectPhase.reply = "Riley could not finish: the provider rejected the configured model."; expect(gradeBrowserReconnect(o).passed).toBe(true); });
it("accepts actual server completion through a real browser disconnect", () => expect(gradeBrowserReconnect(reconnect()).passed).toBe(true));
it("rejects missing disconnect evidence", () => expect(gradeBrowserReconnect(undefined).passed).toBe(false));
it("rejects apparent success when the persisted worker failed", () => { const o = reconnect(); o.runs[0]!.status = "failed"; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects progress that happened before disconnection", () => { const o = reconnect(); o.state.workerStatusBeforeDisconnect = "succeeded"; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects a duplicate worker after reconnect", () => { const o = reconnect(); o.runs.push({ id: "duplicate", agentId: "morgan", status: "succeeded" }); expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects losing messages whose live stream events were missed", () => { const o = reconnect(); o.state.offlineCommentsRetained = false; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects a status claim only present in the old phase", () => { const o = reconnect(); o.reply = o.state.queryReply; o.state.queryReply = "Hello."; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects a completion claim for genuinely remaining work", () => { const o = reconnect(); o.state.remainingPhase.reply = "It has finished."; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects another disconnect without independent server activity", () => { const o = reconnect(); o.state.remainingPhase.runningWhileOffline = false; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects document title matches without actual latest-revision run provenance", () => { const o = reconnect(); o.revisions[0]!.createdByRunId = "other-run"; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects reporting a genuinely failed offline attempt as completed", () => { const o = reconnect(); o.state.failedReconnectPhase.reply = "That attempt has finished successfully."; expect(gradeBrowserReconnect(o).passed).toBe(false); });
it("rejects cancellation substituted for a genuine native failed phase", () => { const o = reconnect(); o.runs.find(run => run.id === "real-failure")!.status = "cancelled"; expect(gradeBrowserReconnect(o).passed).toBe(false); });
