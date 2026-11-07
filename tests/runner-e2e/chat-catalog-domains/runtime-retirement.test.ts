import { it, expect } from "vitest";
import { gradeRetirement } from "./runtime-retirement.js";
function valid() {
  const worker = { id: "morgan", companyId: "company", name: "Morgan", role: "engineer", adapterConfig: { model: "model" } };
  const historicalTask = { id: "history", title: "Historical launch notes", status: "done", assigneeAgentId: worker.id };
  return { scenarioId: "agents.retire-agent", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { worker, task: { id: "active" }, historicalTask, retiredWorker: { ...worker, status: "terminated", lifecycleState: "terminated" },
      workerRunId: "worker", workerWasReallyWaiting: true, agentTerminateStatus: 403, humanRetired: true,
      historicalDocumentRetained: true, historicalAttributionRetained: true,
      queryReply: "Open Morgan's profile and use the human Terminate control. Current work stops; historical tasks and attribution remain inspectable." },
    agents: [], tasks: [{ id: "active" }, historicalTask], links: [], humanQueries: [], reply: "",
    activity: [{ id: "human-action", action: "agent.terminated", entityId: worker.id, actorType: "user", agentId: null }],
    runs: [{ id: "worker", agentId: "morgan", status: "cancelled" }, { id: "guidance", agentId: "ceo", status: "succeeded" }] };
}
it("accepts human retirement with confirmed stop and retained historical work", () => expect(gradeRetirement(valid()).passed).toBe(true));
it("accepts natural retirement guidance", () => { const o = valid(); o.state.queryReply = "You can retire Morgan with Terminate in the profile actions. The active assignment stops after cleanup; earlier task history remains attributable to Morgan."; expect(gradeRetirement(o).passed).toBe(true); });
it("rejects absent retirement evidence", () => expect(gradeRetirement(undefined).passed).toBe(false));
it("rejects merely renaming the employee", () => { const o = valid(); o.state.retiredWorker.name = "Retired Morgan"; expect(gradeRetirement(o).passed).toBe(false); });
it("rejects deleting historical work", () => { const o = valid(); o.tasks = o.tasks.filter(row => row.id !== "history"); expect(gradeRetirement(o).passed).toBe(false); });
it("rejects retirement while the old process remains active", () => { const o = valid(); o.runs[0]!.status = "running"; expect(gradeRetirement(o).passed).toBe(false); });
it("rejects forged historical attribution", () => { const o = valid(); o.state.historicalAttributionRetained = false; expect(gradeRetirement(o).passed).toBe(false); });
it("rejects an ordinary agent's unauthorized termination", () => { const o = valid(); o.state.agentTerminateStatus = 200; expect(gradeRetirement(o).passed).toBe(false); });
