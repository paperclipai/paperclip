import { expect, it } from "vitest";
import { gradeDelegation, completeLaunchBrief, launchPageReflectsBrief, linksOpenTask, RETURN_DELIVERY_LATENCY_MS, type LaunchPageFacts } from "./runtime-delegation.js";
function valid() {
  const task = { id: "website", parentId: "launch", companyId: "company", assigneeAgentId: "morgan", status: "done", description: "Implement the approved design brief and report the completed result back." };
  return { scenarioId: "task-coordination.delegate-with-context", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "",
    tasks: [{ id: "launch" }, task], activity: [{ id: "created", action: "issue.created", entityId: "website", agentId: "ceo" }],
    runs: [{ id: "context", agentId: "ceo", status: "succeeded", contextSnapshot: { issueId: "chat" } }, { id: "delegate", agentId: "ceo", status: "succeeded", contextSnapshot: { issueId: "chat" } },
      { id: "implement", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "website" } }, { id: "report", agentId: "ceo", status: "succeeded", contextSnapshot: { issueId: "chat" } }],
    state: { parent: { id: "launch" }, task, worker: { id: "morgan" }, humanId: "human", briefCommentId: "human-brief", briefHash: "original-hash", briefDownloadedHash: "original-hash",
      briefAttachment: { id: "brief", issueId: "launch", companyId: "company", createdByAgentId: null, createdByUserId: "human", issueCommentId: "human-brief", sha256: "original-hash" },
      parentOwnedByCeo: true, parentContextRetained: true, createdFromSource: true, childHasBrief: true, linkedToLaunch: false, workerBriefReadStatus: 200, workerBriefHash: "original-hash", briefContextKind: "direct-attachment-reference", workerTaskReadStatus: 200, workerParentReadStatus: 200, parentLinkInspectable: true, durableBriefComplete: false,
      workerWasReallyWaiting: true, actualWebsiteArtifact: true, returnDeliveryLatencyMs: 40_000 as number,
      delivery: { checks: [{ id: "correlated", passed: true }], response: { body: "Morgan completed Website; the actual saved page is available on the child task." } } } };
}
it("accepts one genuinely contextual child and correlated actual result", () => expect(gradeDelegation(valid()).passed).toBe(true));
it("accepts natural correct-worker result reporting", () => { const o = valid(); o.state.delivery.response.body = "The page Morgan built is ready. Open Website for the delivered result from that implementation."; expect(gradeDelegation(o).passed).toBe(true); });
it("accepts an independently verified inspectable link as the supported alternative to a child edge", () => { const o = valid(); o.state.task.parentId = ""; o.state.linkedToLaunch = true; expect(gradeDelegation(o).passed).toBe(true); });
it("rejects missing actual delegation evidence", () => expect(gradeDelegation(undefined).passed).toBe(false));
it("rejects a delegated task unrelated to the original Launch work", () => { const o = valid(); o.state.task.parentId = "other"; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects a brief still available only in source chat", () => { const o = valid(); o.state.childHasBrief = false; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects a worker unable to fetch the actual brief", () => { const o = valid(); o.state.workerBriefReadStatus = 403; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects copying a similarly named brief with different bytes", () => { const o = valid(); o.state.workerBriefHash = "wrong"; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects completion with no real delivered page", () => { const o = valid(); o.state.actualWebsiteArtifact = false; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects a result reported on an uncorrelated source", () => { const o = valid(); o.state.delivery.checks[0]!.passed = false; expect(gradeDelegation(o).passed).toBe(false); });
it("does not grade the reply's wording: a terse correct correlated delivery passes", () => { const o = valid(); o.state.delivery.response.body = "Here it is: COM-3."; expect(gradeDelegation(o).passed).toBe(true); });
it("does not grade the child description's wording: the created-from-source return path is the completion request", () => { const o = valid(); o.state.task.description = "Build the landing page from the attached brief."; expect(gradeDelegation(o).passed).toBe(true); });
it("accepts delivery within one ordinary turn of Morgan finishing", () => { const o = valid(); o.state.returnDeliveryLatencyMs = RETURN_DELIVERY_LATENCY_MS; expect(gradeDelegation(o).passed).toBe(true); });
it.each([RETURN_DELIVERY_LATENCY_MS + 1, 300_000, Number.NaN, -1])("rejects a late, missing or pre-completion return delivery (%s ms)", latency => { const o = valid(); o.state.returnDeliveryLatencyMs = latency; expect(gradeDelegation(o).passed).toBe(false); });
it("accepts a bare Launch identifier the task page renders as a link", () => expect(linksOpenTask(["/COM/issues/COM-1"], "http://127.0.0.1:3100", { id: "launch-uuid", identifier: "COM-1" })).toBe(true));
it("accepts a Launch UUID link", () => expect(linksOpenTask(["[Launch](/COM/issues/launch-uuid)".slice(9, -1)], "http://127.0.0.1:3100", { id: "launch-uuid", identifier: "COM-1" })).toBe(true));
it.each([["/COM/issues/COM-2"], ["https://elsewhere.invalid/COM/issues/COM-1"], ["/COM/agents/COM-1"], []])("rejects links that do not open Launch here: %s", (...targets) => expect(linksOpenTask(targets.flat(), "http://127.0.0.1:3100", { id: "launch-uuid", identifier: "COM-1" })).toBe(false));
it("rejects a hidden actual parent execution", () => { const o = valid(); o.runs[2]!.contextSnapshot.issueId = "launch"; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects duplicate work tasks", () => { const o = valid(); o.tasks.push({ id: "duplicate" }); expect(gradeDelegation(o).passed).toBe(false); });

it("accepts an actual worker-readable parent reference and its exact human attachment", () => { const o = valid(); o.state.briefContextKind = "readable-parent-reference"; expect(gradeDelegation(o).passed).toBe(true); });
it("rejects an inaccessible parent even when the board can read its attachment", () => { const o = valid(); o.state.briefContextKind = "readable-parent-reference"; o.state.workerParentReadStatus = 403; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects a parent reference with the wrong brief bytes", () => { const o = valid(); o.state.briefContextKind = "readable-parent-reference"; o.state.workerBriefHash = "other-design"; expect(gradeDelegation(o).passed).toBe(false); });
it("accepts a complete durable brief with actual grounded delivery without copying its attachment", () => { const o = valid(); o.state.briefContextKind = "faithful-durable-copy"; o.state.durableBriefComplete = true; o.state.workerBriefReadStatus = 404; o.state.workerBriefHash = ""; expect(gradeDelegation(o).passed).toBe(true); });
it("rejects an incomplete durable brief", () => { const o = valid(); o.state.briefContextKind = "faithful-durable-copy"; expect(gradeDelegation(o).passed).toBe(false); });
it("rejects a durable copy without the worker's actual access to its task", () => { const o = valid(); o.state.briefContextKind = "faithful-durable-copy"; o.state.durableBriefComplete = true; o.state.workerTaskReadStatus = 403; expect(gradeDelegation(o).passed).toBe(false); });
it.each(["Notify the CEO in this conversation when the page is ready", "Implement the brief and let me know when done"])("accepts a clear natural completion request: %s", description => { const o = valid(); o.state.task.description = description; expect(gradeDelegation(o).passed).toBe(true); });
it("recognizes complete substantive durable brief content", () => expect(completeLaunchBrief("Reference: Launch brief nonce. Build semantic markup with accessible input labels, one primary join button, and the headline Research without the busywork.", "Launch brief nonce")).toBe(true));
it.each(["Unrelated headline; semantic HTML, accessible labels, one primary signup action. Launch brief nonce", "Research without the busywork. Launch brief nonce", "Research without the busywork; semantic HTML, accessible labels, one primary signup action. Other reference"])("rejects wrong or incomplete durable content", text => expect(completeLaunchBrief(text, "Launch brief nonce")).toBe(false));

const page: LaunchPageFacts = { headline: "Research without the busywork", landmarks: 4, unlabelledControls: 0, namedSignupActions: 1, signupForms: 1 };
it("accepts the rendered page facts of a brief-faithful page", () => expect(launchPageReflectsBrief(page)).toBe(true));
it("accepts a signup form whose button is not named with signup words", () => expect(launchPageReflectsBrief({ ...page, namedSignupActions: 0 })).toBe(true));
it("accepts a named signup link without a form", () => expect(launchPageReflectsBrief({ ...page, signupForms: 0 })).toBe(true));
it("accepts the headline split across inline markup and whitespace", () => expect(launchPageReflectsBrief({ ...page, headline: "\n  Research without the  busywork " })).toBe(true));
it.each<[string, Partial<LaunchPageFacts>]>([["wrong headline", { headline: "Unrelated result" }], ["no h1", { headline: null }], ["no semantic landmarks", { landmarks: 0 }],
  ["an unlabelled control", { unlabelledControls: 1 }], ["no signup action", { namedSignupActions: 0, signupForms: 0 }]])("rejects a page with %s", (_, change) => expect(launchPageReflectsBrief({ ...page, ...change })).toBe(false));
it("rejects a page that was never rendered", () => expect(launchPageReflectsBrief(undefined)).toBe(false));
