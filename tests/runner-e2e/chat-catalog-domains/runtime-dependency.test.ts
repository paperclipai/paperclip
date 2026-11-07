import { expect, it } from "vitest";
import { gradeDesignDependency } from "./runtime-dependency.js";
function valid() { return { scenarioId: "task-coordination.block-on-design", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "",
  tasks: [{ id: "website", assigneeAgentId: "morgan", status: "done" }, { id: "design", status: "done" }], runs: ["save-edge", "implement", "report"].map(id => ({ id, status: "succeeded", agentId: id === "implement" ? "morgan" : "ceo" })),
  activity: [{ id: "edge", action: "issue.blockers_updated", entityId: "website", agentId: "ceo", details: { addedBlockedByIssueIds: ["design"] } }],
  state: { task: { id: "website" }, design: { id: "design" }, worker: { id: "morgan" }, waitingTask: { id: "website", companyId: "company", assigneeAgentId: "morgan", blockedBy: [{ id: "design" }] },
    designUnfinishedAtWait: true, blockerVisible: true, noWorkerBeforeApproval: true, attemptedBeforeApproval: true, beforeApprovalStatus: 200,
    queryReply: "Website now depends on Design and will wait for approval.", humanApprovedDesign: true, workerAdmissionAfterApproval: true, actualWebsiteResult: true,
    finalReplyAttributed: true, finalReply: "Website is complete. Morgan delivered the saved plan after Design approval." } }; }
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
