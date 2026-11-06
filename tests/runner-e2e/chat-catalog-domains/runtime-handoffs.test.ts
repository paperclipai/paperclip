import { it, expect } from "vitest";
import { gradeTrackDelegatedWork } from "./runtime-handoffs.js";
function valid() {
  const task = { id: "website", identifier: "ACORN-1", assigneeAgentId: "morgan", status: "done" };
  return { scenarioId: "agent-chat.track-delegated-work", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { task, worker: { id: "morgan" }, createdFromSource: true, workerWasReallyWaiting: true, originalSourceRetained: true,
      workerStatusAtQueryReply: "running", queryReply: "Morgan is still working on Website and waiting for the brief.", queryLinks: ["/ACORN/issues/ACORN-1"],
      marker: "actual delivery marker", completionDelivered: true, workerRunId: "worker", sourceAssigneePreserved: true,
      delivery: { checks: [{ id: "actual-delivery", passed: true }], response: { body: "Morgan finished Website. The actual result is ready." } } },
    agents: [], tasks: [task], links: [], humanQueries: [], reply: "", activity: [], documents: [{ id: "delivery", body: "actual delivery marker" }],
    runs: [{ id: "handoff", agentId: "ceo", status: "succeeded" }, { id: "worker", agentId: "morgan", status: "succeeded" },
      { id: "query", agentId: "ceo", status: "succeeded" }, { id: "completion", agentId: "ceo", status: "succeeded" }] };
}
it("accepts actual prior native delegation, accurate busy status and automatic result delivery", () => expect(gradeTrackDelegatedWork(valid()).passed).toBe(true));
it("accepts natural attributed pending and completion reports", () => { const o = valid(); o.state.queryReply = "The Website task remains with Morgan, who is waiting on the brief and has not finished this turn."; o.state.delivery.response.body = "Morgan completed the Website task; its saved result is available."; expect(gradeTrackDelegatedWork(o).passed).toBe(true); });
it("rejects missing handoff evidence", () => expect(gradeTrackDelegatedWork(undefined).passed).toBe(false));
it("rejects a task manually seeded instead of created by that conversation", () => { const o = valid(); o.state.createdFromSource = false; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects completion language from the wrong query phase", () => { const o = valid(); o.state.queryReply = "The website has finished."; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects linking a similarly named task", () => { const o = valid(); o.state.queryLinks = ["/ACORN/issues/ACORN-2"]; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects duplicate delegated work", () => { const o = valid(); o.tasks.push({ ...o.tasks[0]!, id: "duplicate" }); expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects an uncorrelated completion update", () => { const o = valid(); o.state.delivery.checks[0]!.passed = false; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects invented external publication", () => { const o = valid(); o.state.delivery.response.body = "Morgan finished and deployed it."; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
