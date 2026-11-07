import { it, expect } from "vitest";
import { gradeBuiltInConfiguration } from "./runtime-built-in.js";
function valid() {
  const builtIn = { definition: { key: "summarizer" }, agentId: "summarizer" };
  const task = { id: "history", title: "Summary history", companyId: "company", assigneeAgentId: "summarizer", status: "backlog" };
  return { scenarioId: "agents.configure-required-agent", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { builtInBefore: builtIn, builtInAfter: { ...builtIn }, originalInstruction: { content: "Summarize work", revision: { id: "old" } }, agentCountBefore: 1, historicalTask: task },
    instruction: { content: "Summarize work; keep updates brief, under 40 words.", revision: { id: "new", actorAgentId: "ceo", sourceRunId: "run" } },
    instructionHistory: { revisions: [{ id: "old" }, { id: "new" }] }, agents: [{ id: "summarizer", name: "Summarizer", companyId: "company" }], tasks: [task],
    links: ["/ACORN/agents/summarizer"], reply: "The summarizer now writes shorter updates.", activity: [], runs: [{ id: "run" }], humanQueries: [] };
}
it("accepts a durable protected-agent configuration revision", () => expect(gradeBuiltInConfiguration(valid()).passed).toBe(true));
it("accepts natural saved protected-agent guidance", () => { const o = valid(); o.reply = "I saved briefer update guidance on the existing Summarizer, preserving its identity and history."; expect(gradeBuiltInConfiguration(o).passed).toBe(true); });
it("rejects missing built-in evidence", () => expect(gradeBuiltInConfiguration(undefined).passed).toBe(false));
it("rejects replacing the protected identity with an ordinary hire", () => {
  const o = valid(); o.state.builtInAfter.agentId = "replacement"; expect(gradeBuiltInConfiguration(o).passed).toBe(false);
});
it("rejects changing only prose without a saved instruction revision", () => {
  const o = valid(); o.instruction.content = "Summarize work"; expect(gradeBuiltInConfiguration(o).passed).toBe(false);
});
it("rejects erasing the old attributed task", () => {
  const o = valid(); o.tasks = []; expect(gradeBuiltInConfiguration(o).passed).toBe(false);
});

it("accepts a real built-in configuration change with textual guidance and no mandatory href", () => {
  const o = valid(); o.links = []; expect(gradeBuiltInConfiguration(o).passed).toBe(true);
});
