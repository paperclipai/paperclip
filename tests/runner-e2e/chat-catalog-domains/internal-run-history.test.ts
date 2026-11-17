import { describe, expect, it } from "vitest";
import { gradeRunHistory, readTaskRunHistory } from "./internal-run-history.js";
import { savedCall } from "./api-read-receipts.test-fixtures.js";
function valid() {
  const task = { id: "task", title: "Website task", status: "done", assigneeAgentId: "morgan" };
  const interruptedRun = { id: "interrupted", companyId: "company", agentId: "morgan", status: "cancelled", contextSnapshot: { issueId: "task" } };
  const continuationRun = { id: "continuation", companyId: "company", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "task" } };
  return { scenarioId: "activity.find-runs", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task, worker: { id: "morgan" }, interruptedRun, continuationRun, interruptedTask: { ...task, status: "in_progress", executionRunId: "interrupted" }, gateCalls: [{ authorized: true, operation: "read_website_brief" }] },
    tasks: [task], projects: [], goals: [], comments: [], activity: [] as Array<{ entityId: string; agentId: string; action: string }>, documents: [], revisions: [], humanQueries: [],
    reply: "Morgan's interrupted attempt [cancelled](/RUN/agents/morgan/runs/interrupted).\nMorgan's continuation [succeeded](/RUN/agents/morgan/runs/continuation).", links: ["/RUN/issues/task", "/RUN/agents/morgan/runs/interrupted", "/RUN/agents/morgan/runs/continuation"],
    runs: [interruptedRun, continuationRun], agentRunReadStatuses: [200, 200], runHistoryRead: true, currentTask: task };
}
describe("actual interrupted and continued execution calibration", () => {
  it("accepts independently retained cancellation and successful continuation", () => expect(gradeRunHistory(valid()).passed).toBe(true));
  it("rejects exposing a run whose acting-agent detail read is denied", () => { const o = valid(); o.agentRunReadStatuses[0] = 403; expect(gradeRunHistory(o).passed).toBe(false); });
  it("rejects hiding the interrupted attempt", () => { const o = valid(); o.runs = o.runs.slice(1); expect(gradeRunHistory(o).passed).toBe(false); });
  it("rejects the wrong execution owner or task binding", () => { const o = valid(); o.runs[0]!.agentId = "riley"; expect(gradeRunHistory(o).passed).toBe(false); const wrong = valid(); wrong.runs[1]!.contextSnapshot.issueId = "another"; expect(gradeRunHistory(wrong).passed).toBe(false); });
  it("does not match reply wording", () => { const o = valid(); o.reply = `Attempt one [open](${o.links[1]}) stopped early.\nAttempt two [open](${o.links[2]}) finished the website task.`; expect(gradeRunHistory(o).passed).toBe(true); });
  it("rejects a reply that never read the task's run history", () => { const o = valid(); o.runHistoryRead = false; expect(gradeRunHistory(o).passed).toBe(false); });
  it("recognizes only a completed runner read of this task's runs or an exact run detail", () => {
    const event = (output: string, status = "completed") => ({ eventType: "tool.execution.completed", payload: { prpEvent: { sourceKind: "runner", payload: { status, output } } } });
    const issueRuns = JSON.stringify({ text: JSON.stringify({ result: { apiOperationId: "GET /api/issues/{id}/runs", data: [{ contextIssueId: "task", runId: "interrupted" }] } }) });
    const detail = JSON.stringify({ text: JSON.stringify({ result: { apiOperationId: "GET /api/heartbeat-runs/{runId}", data: { id: "continuation" } } }) });
    expect(readTaskRunHistory([event(issueRuns)], "task", ["interrupted", "continuation"])).toBe(true);
    expect(readTaskRunHistory([event(detail)], "task", ["interrupted", "continuation"])).toBe(true);
    expect(readTaskRunHistory([event(issueRuns)], "another", ["other"])).toBe(false);
    expect(readTaskRunHistory([event(issueRuns, "failed")], "task", ["interrupted"])).toBe(false);
    expect(readTaskRunHistory([event(JSON.stringify({ text: "GET /api/issues/{id}/runs task" }))], "task", ["interrupted"])).toBe(false);
    expect(readTaskRunHistory([event(detail.replace("{runId}", "{runId}/events"))], "task", ["continuation"])).toBe(false);
  });
  it("accepts a genuine call_api run-history read after the port redacts its response body", () => {
    const issueRuns = (id: string, status = 200) => savedCall({ operationId: "GET /api/issues/{id}/runs", pathParams: { id } }, status, "5", "run-1", [{ runId: "interrupted" }]);
    const detail = (runId: string) => savedCall({ operationId: "GET /api/heartbeat-runs/{runId}", pathParams: { runId } }, 200, "6");
    expect(readTaskRunHistory(issueRuns("task"), "task", ["interrupted", "continuation"], "RUN-1")).toBe(true);
    expect(readTaskRunHistory(issueRuns("RUN-1"), "task", ["interrupted", "continuation"], "RUN-1")).toBe(true);
    expect(readTaskRunHistory(detail("continuation"), "task", ["interrupted", "continuation"], "RUN-1")).toBe(true);
    expect(readTaskRunHistory(issueRuns("RUN-2"), "task", ["interrupted"], "RUN-1")).toBe(false);
    expect(readTaskRunHistory(issueRuns("task", 403), "task", ["interrupted"], "RUN-1")).toBe(false);
    expect(readTaskRunHistory(detail("unrelated"), "task", ["interrupted"], "RUN-1")).toBe(false);
  });
  it("rejects foreign or missing execution links", () => { const o = valid(); o.links[1] = "https://foreign.test/RUN/agents/morgan/runs/interrupted"; expect(gradeRunHistory(o).passed).toBe(false); });
  it("requires actual held checkout and authorized app call", () => { const o = valid(); o.state.interruptedTask.executionRunId = "other"; expect(gradeRunHistory(o).passed).toBe(false); const call = valid(); call.state.gateCalls = []; expect(gradeRunHistory(call).passed).toBe(false); });
  it("rejects changing task history or ownership while listing", () => { const o = valid(); o.activity.push({ entityId: "task", agentId: "ceo", action: "issue.updated" }); expect(gradeRunHistory(o).passed).toBe(false); });
});
