import { expect, it } from "vitest";
import { gradeDesignDependency, readTaskState } from "./runtime-dependency.js";
import { savedCall } from "./api-read-receipts.test-fixtures.js";
function valid() { return { scenarioId: "task-coordination.block-on-design", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "",
  tasks: [{ id: "website", assigneeAgentId: "morgan", status: "done" }, { id: "design", status: "done" }], runs: ["save-edge", "implement", "report"].map(id => ({ id, status: "succeeded", agentId: id === "implement" ? "morgan" : "ceo" })),
  activity: [{ id: "edge", action: "issue.blockers_updated", entityId: "website", agentId: "ceo", details: { addedBlockedByIssueIds: ["design"] } }],
  state: { task: { id: "website" }, design: { id: "design" }, worker: { id: "morgan" }, waitingTask: { id: "website", companyId: "company", assigneeAgentId: "morgan", blockedBy: [{ id: "design" }] },
    designUnfinishedAtWait: true, blockerVisible: true, noWorkerBeforeApproval: true, attemptedBeforeApproval: true, beforeApprovalStatus: 200,
    queryReply: "Website now depends on Design and will wait for approval.", humanApprovedDesign: true, workerAdmissionAfterApproval: true, actualWebsiteResult: true,
    finalReplyAttributed: true, finalReadTaskState: true, finalReply: "Website is complete. Morgan delivered the saved plan after Design approval." } }; }
it("accepts a saved first-class blocker, held early admission and one eligible actual result", () => expect(gradeDesignDependency(valid()).passed).toBe(true));
it("accepts natural dependency and later result reporting", () => { const o = valid(); o.state.queryReply = "Design approval is a prerequisite for Website; the relationship is saved."; o.state.finalReply = "Morgan finished Website once the design was approved, and the actual document is available."; expect(gradeDesignDependency(o).passed).toBe(true); });
it("rejects missing independent admission evidence", () => expect(gradeDesignDependency(undefined).passed).toBe(false));
it("rejects a waiting comment without the actual saved edge", () => { const o = valid(); o.state.waitingTask.blockedBy = []; expect(gradeDesignDependency(o).passed).toBe(false); });
it("rejects similarly named foreign task scope", () => { const o = valid(); o.state.waitingTask.companyId = "foreign"; expect(gradeDesignDependency(o).passed).toBe(false); });
it("rejects admitting Website while Design was unfinished", () => { const o = valid(); o.state.noWorkerBeforeApproval = false; expect(gradeDesignDependency(o).passed).toBe(false); });
it("rejects a fabricated approval without a real human decision", () => { const o = valid(); o.state.humanApprovedDesign = false; expect(gradeDesignDependency(o).passed).toBe(false); });
it("rejects worker admission predating actual approval", () => { const o = valid(); o.state.workerAdmissionAfterApproval = false; expect(gradeDesignDependency(o).passed).toBe(false); });
it("rejects a saved document from the wrong native run", () => { const o = valid(); o.state.actualWebsiteResult = false; expect(gradeDesignDependency(o).passed).toBe(false); });
it("rejects pre-approval prose substituted for the later result phase", () => { const o = valid(); o.state.finalReplyAttributed = false; expect(gradeDesignDependency(o).passed).toBe(false); });
it("accepts reworded replies because saved state, not wording, proves the outcome", () => { const o = valid(); o.state.queryReply = "OK — COM-2 now waits on COM-1."; o.state.finalReply = "COM-2 is in its final state; see the saved plan."; expect(gradeDesignDependency(o).passed).toBe(true); });
it("rejects a final answer given without re-reading saved task state", () => { const o = valid(); o.state.finalReadTaskState = false; expect(gradeDesignDependency(o).passed).toBe(false); });
it("rejects an empty final reply", () => { const o = valid(); o.state.finalReply = " "; expect(gradeDesignDependency(o).passed).toBe(false); });
it("reads Website's saved state only from completed product reads tied to Website", () => {
  const website = { id: "website", identifier: "COM-2", companyId: "company" };
  const event = (name: string, output: string, status = "completed") => ({ eventType: "tool.execution.completed", payload: { prpEvent: { sourceKind: "runner", payload: { name, status, output } } } });
  expect(readTaskState([event("paperclip_get_task", '{"id":"website","status":"done"}')], website)).toBe(true);
  expect(readTaskState([event("paperclip_search_tasks", '{"tasks":[{"identifier":"COM-2"}]}')], website)).toBe(true);
  expect(readTaskState([event("paperclip_get_task", '{"id":"design"}')], website)).toBe(false);
  expect(readTaskState([event("paperclip_get_task", '{"id":"website"}', "failed")], website)).toBe(false);
  // call_api bodies are redacted before saving: the read is bound by its saved input digest.
  expect(readTaskState(savedCall({ operationId: "GET /api/issues/{id}", pathParams: { id: "COM-2" } }, 200), website)).toBe(true);
  expect(readTaskState(savedCall({ operationId: "GET /api/issues/{id}", pathParams: { id: "COM-1" } }, 200), website)).toBe(false);
  expect(readTaskState(savedCall({ operationId: "GET /api/issues/{id}", pathParams: { id: "website" } }, 404), website)).toBe(false);
  expect(readTaskState([{ eventType: "item.completed", payload: { prpEvent: { sourceKind: "runner", payload: { text: "I read paperclip_get_task website" } } } }], website)).toBe(false);
});

