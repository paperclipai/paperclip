import { it, expect } from "vitest";
import { gradeSessionReset } from "./runtime-session.js";
function valid() {
  const worker = { id: "morgan", companyId: "company", name: "Morgan", adapterConfig: { model: "model" } };
  return { scenarioId: "runs-adapters.reset-session", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { worker, task: { id: "website" }, agentResetStatus: 403, sessionPresentBeforeHuman: true, humanReset: true,
      sessionsEmptyAfterHuman: true, futureRunFresh: true, explicitContinuationSaved: true, historyRetained: true,
      documentsRetained: true, artifactRetained: true, fileRetained: true,
      queryReply: "Open Morgan's profile reset session control. Runtime context starts fresh, but durable task history, comments and artifacts remain." },
    agents: [worker], tasks: [{ id: "website" }], links: [], reply: "", humanQueries: [],
    activity: [{ id: "reset", action: "agent.runtime_session_reset", entityId: "morgan", actorType: "user", agentId: null }],
    runs: [{ id: "prior", agentId: "morgan", status: "succeeded" }, { id: "query", agentId: "ceo", status: "succeeded" }, { id: "future", agentId: "morgan", status: "succeeded" }] };
}
it("accepts a real human reset with fresh future execution and durable history", () => expect(gradeSessionReset(valid()).passed).toBe(true));
it("accepts natural reset and retention guidance", () => { const o = valid(); o.state.queryReply = "In Morgan's profile, choose Reset Sessions to begin with fresh runtime context. Saved files and the task's comments remain in its history."; expect(gradeSessionReset(o).passed).toBe(true); });
it("rejects missing session evidence", () => expect(gradeSessionReset(undefined).passed).toBe(false));
it("rejects clearing history to simulate a reset", () => { const o = valid(); o.state.historyRetained = false; expect(gradeSessionReset(o).passed).toBe(false); });
it("rejects a future execution that resumed its old context", () => { const o = valid(); o.state.futureRunFresh = false; expect(gradeSessionReset(o).passed).toBe(false); });
it("rejects absent private artifact bytes", () => { const o = valid(); o.state.artifactRetained = false; expect(gradeSessionReset(o).passed).toBe(false); });
it("rejects an agent reset outside human authority", () => { const o = valid(); o.state.agentResetStatus = 200; expect(gradeSessionReset(o).passed).toBe(false); });
it("rejects guidance from a later phase instead of the canonical reply", () => { const o = valid(); o.reply = o.state.queryReply; o.state.queryReply = "Done."; expect(gradeSessionReset(o).passed).toBe(false); });
it("rejects loss of earlier document revisions", () => { const o = valid(); o.state.documentsRetained = false; expect(gradeSessionReset(o).passed).toBe(false); });
