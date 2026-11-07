import { describe, expect, it } from "vitest";
import { gradeRunHistory } from "./internal-run-history.js";
function valid() {
  const task = { id: "task", title: "Website task", status: "done", assigneeAgentId: "morgan" };
  const interruptedRun = { id: "interrupted", companyId: "company", agentId: "morgan", status: "cancelled", contextSnapshot: { issueId: "task" } };
  const continuationRun = { id: "continuation", companyId: "company", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "task" } };
  return { scenarioId: "activity.find-runs", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task, worker: { id: "morgan" }, interruptedRun, continuationRun, interruptedTask: { ...task, status: "in_progress", executionRunId: "interrupted" }, gateCalls: [{ authorized: true, operation: "read_website_brief" }] },
    tasks: [task], projects: [], goals: [], comments: [], activity: [] as Array<{ entityId: string; agentId: string; action: string }>, documents: [], revisions: [], humanQueries: [],
    reply: "Morgan's interrupted attempt [cancelled](/RUN/agents/morgan/runs/interrupted).\nMorgan's continuation [succeeded](/RUN/agents/morgan/runs/continuation).", links: ["/RUN/issues/task", "/RUN/agents/morgan/runs/interrupted", "/RUN/agents/morgan/runs/continuation"],
    runs: [interruptedRun, continuationRun], agentRunReadStatuses: [200, 200], currentTask: task };
}
describe("actual interrupted and continued execution calibration", () => {
  it("accepts independently retained cancellation and successful continuation", () => expect(gradeRunHistory(valid()).passed).toBe(true));
  it("rejects exposing a run whose acting-agent detail read is denied", () => { const o = valid(); o.agentRunReadStatuses[0] = 403; expect(gradeRunHistory(o).passed).toBe(false); });
  it("rejects hiding the interrupted attempt", () => { const o = valid(); o.runs = o.runs.slice(1); expect(gradeRunHistory(o).passed).toBe(false); });
  it("rejects the wrong execution owner or task binding", () => { const o = valid(); o.runs[0]!.agentId = "riley"; expect(gradeRunHistory(o).passed).toBe(false); const wrong = valid(); wrong.runs[1]!.contextSnapshot.issueId = "another"; expect(gradeRunHistory(wrong).passed).toBe(false); });
  it("rejects swapped reply states despite both words elsewhere", () => { const o = valid(); o.reply = "Morgan interrupted succeeded.\nMorgan continuation cancelled."; expect(gradeRunHistory(o).passed).toBe(false); });
  it("rejects foreign or missing execution links", () => { const o = valid(); o.links[1] = "https://foreign.test/RUN/agents/morgan/runs/interrupted"; expect(gradeRunHistory(o).passed).toBe(false); });
  it("requires actual held checkout and authorized app call", () => { const o = valid(); o.state.interruptedTask.executionRunId = "other"; expect(gradeRunHistory(o).passed).toBe(false); const call = valid(); call.state.gateCalls = []; expect(gradeRunHistory(call).passed).toBe(false); });
  it("rejects changing task history or ownership while listing", () => { const o = valid(); o.activity.push({ entityId: "task", agentId: "ceo", action: "issue.updated" }); expect(gradeRunHistory(o).passed).toBe(false); });
});
