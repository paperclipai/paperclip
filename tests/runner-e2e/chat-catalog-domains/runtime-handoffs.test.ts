import { it, expect } from "vitest";
import { apiReadDigests, apiReadStatuses } from "./api-read-receipts.js";
import { savedCall } from "./api-read-receipts.test-fixtures.js";
import { delegatedWorkReads, gradeTrackDelegatedWork } from "./runtime-handoffs.js";
function valid() {
  const task = { id: "website", identifier: "ACORN-1", assigneeAgentId: "morgan", status: "done" };
  return { scenarioId: "agent-chat.track-delegated-work", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { task, worker: { id: "morgan" }, createdFromSource: true, workerWasReallyWaiting: true, originalSourceRetained: true,
      workerStatusAtQueryReply: "running", queryToolReads: [{ runId: "query", name: "call_api", mentionsTask: true }] as Array<{ runId: string; name: string; mentionsTask: boolean }>, queryReply: "Morgan is still working on Website and waiting for the brief.", queryLinks: ["/ACORN/issues/ACORN-1"],
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
it("does not grade the status answer's wording", () => { const o = valid(); o.state.queryReply = "RUN-2 is with Morgan; the run is live and the brief has not arrived, so there is no result yet."; o.state.delivery.response.body = "Here is the Website result Morgan saved."; expect(gradeTrackDelegatedWork(o).passed).toBe(true); });
it("rejects a status answer given after the worker run already ended", () => { const o = valid(); o.state.workerStatusAtQueryReply = "succeeded"; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects a status answer that never read the task or its runs", () => { const o = valid(); o.state.queryToolReads = [{ runId: "query", name: "paperclip_list_agents", mentionsTask: false }]; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects a read tied to neither the delegated task nor its run, whatever the tool name", () => { for (const name of ["paperclip_call_api", "paperclip_get_task_history", "paperclip_get_task"]) { const o = valid(); o.state.queryToolReads = [{ runId: "query", name, mentionsTask: false }]; expect(gradeTrackDelegatedWork(o).passed).toBe(false); } });
it("binds call_api reads to the delegated task or Morgan's run by their saved input digest", () => {
  const digests = apiReadDigests(delegatedWorkReads({ id: "website", identifier: "ACORN-1" }, "morgan-run"));
  const ok = (input: Record<string, unknown>) => apiReadStatuses(savedCall(input, 200), digests).length === 1;
  expect(ok({ operationId: "GET /api/issues/{id}", pathParams: { id: "ACORN-1" } })).toBe(true);
  expect(ok({ operationId: "GET /api/issues/{id}/runs", pathParams: { id: "website" } })).toBe(true);
  expect(ok({ operationId: "GET /api/heartbeat-runs/{runId}", pathParams: { runId: "morgan-run" } })).toBe(true);
  expect(ok({ operationId: "GET /api/issues/{id}", pathParams: { id: "ACORN-2" } })).toBe(false);
  expect(ok({ operationId: "GET /api/companies/{companyId}/issues", pathParams: { companyId: "company" } })).toBe(false);
});
it("accepts a read whose output names the task even under another tool", () => { const o = valid(); o.state.queryToolReads = [{ runId: "query", name: "bash", mentionsTask: true }]; expect(gradeTrackDelegatedWork(o).passed).toBe(true); });
it("rejects an empty status answer", () => { const o = valid(); o.state.queryReply = ""; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects linking a similarly named task", () => { const o = valid(); o.state.queryLinks = ["/ACORN/issues/ACORN-2"]; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects duplicate delegated work", () => { const o = valid(); o.tasks.push({ ...o.tasks[0]!, id: "duplicate" }); expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects an uncorrelated completion update", () => { const o = valid(); o.state.delivery.checks[0]!.passed = false; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects a completion update without access to the saved result", () => { const o = valid(); o.state.delivery.checks.push({ id: "completion-result-access", passed: false }); expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects a missing saved deliverable", () => { const o = valid(); o.documents = []; expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
it("rejects a second Morgan execution", () => { const o = valid(); o.runs.push({ id: "worker-2", agentId: "morgan", status: "succeeded" }); expect(gradeTrackDelegatedWork(o).passed).toBe(false); });
