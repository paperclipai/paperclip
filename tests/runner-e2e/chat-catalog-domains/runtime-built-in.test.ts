import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { gradeBuiltInConfiguration } from "./runtime-built-in.js";
const ORIGINAL = "You are Summarizer, a built-in reporting agent.\n\n## Core responsibilities\n\n- Read the scope.\n- Open with 1-3 actions.\n- Follow with a paragraph or two of status prose.\n- Keep summaries short.";
const TUNED = ORIGINAL.replace("a paragraph or two of status prose", "one paragraph of status prose") + "\n\n## Length budget\n\n- Target 100 words; hard ceiling 150.";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
function valid() {
  const builtIn = { definition: { key: "summarizer" }, agentId: "summarizer" };
  const task = { id: "history", title: "Summary history", companyId: "company", assigneeAgentId: "summarizer", status: "backlog" };
  // Reads report a content token stamped with the reader, and history is empty (design change 14420).
  const token = { id: "token", companyId: "company", agentId: "summarizer", actorAgentId: null, sourceRunId: null, source: "api" };
  return { scenarioId: "agents.configure-required-agent", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { builtInBefore: builtIn, builtInAfter: { ...builtIn }, originalInstruction: { path: "AGENTS.md", content: ORIGINAL, revision: token }, agentCountBefore: 2, historicalTask: task },
    instruction: { path: "AGENTS.md", content: TUNED, revision: { ...token, id: "token-2" } },
    instructionHistory: { revisions: [] as unknown[] },
    agents: [{ id: "ceo", name: "CEO", companyId: "company" }, { id: "summarizer", name: "Summarizer", companyId: "company" }], tasks: [task],
    links: ["/RUN/agents/summarizer"], reply: "Updated the [Summarizer](/RUN/agents/summarizer) instructions with a hard length budget.",
    activity: [{ id: "write", companyId: "company", action: "agent.files_updated", entityType: "agent", entityId: "summarizer", actorType: "agent", actorId: "ceo",
      agentId: "ceo", runId: "run", details: { path: "AGENTS.md", source: "api", created: false, contentHash: hash(TUNED) } }],
    runs: [{ id: "run", companyId: "company", agentId: "ceo" }], humanQueries: [] };
}
const grade = (o: unknown) => gradeBuiltInConfiguration(o).passed;
it("accepts the run's saved, attributed tuning of the existing summarizer", () => expect(grade(valid())).toBe(true));
it("accepts a reworded reply that names the summarizer without a link", () => {
  const o = valid(); o.links = []; o.reply = "Done: Summarizer now has a tighter word ceiling, effective on its next run."; expect(grade(o)).toBe(true);
});
it("accepts a saved write through the dedicated instruction tool", () => {
  const o = valid(); o.activity[0].details.source = "tool"; expect(grade(o)).toBe(true);
});
it("rejects missing built-in evidence", () => expect(grade(undefined)).toBe(false));
it("rejects replacing the protected identity with an ordinary hire", () => {
  const o = valid(); o.state.builtInAfter.agentId = "replacement"; expect(grade(o)).toBe(false);
});
it("rejects an extra ordinary hire", () => {
  const o = valid(); o.agents.push({ id: "hire", name: "Short Summarizer", companyId: "company" }); expect(grade(o)).toBe(false);
});
it("rejects a reply that claims a change the product never saved", () => {
  const o = valid(); o.instruction.content = ORIGINAL; expect(grade(o)).toBe(false);
});
it("rejects instructions changed by someone other than the chat run", () => {
  const o = valid(); Object.assign(o.activity[0], { actorType: "user", actorId: "local-board", agentId: null, runId: null }); expect(grade(o)).toBe(false);
});
it("rejects an audit row for different bytes than the product now serves", () => {
  const o = valid(); o.activity[0].details.contentHash = hash(`${TUNED}\nlater edit`); expect(grade(o)).toBe(false);
});
it("rejects wholesale replacement of the bundled summarizer instructions", () => {
  const o = valid(); o.instruction.content = "Write two-sentence updates."; o.activity[0].details.contentHash = hash(o.instruction.content); expect(grade(o)).toBe(false);
});
it("rejects erasing the old attributed task", () => {
  const o = valid(); o.tasks = []; expect(grade(o)).toBe(false);
});
it("rejects a reply that does not identify the configured agent", () => {
  const o = valid(); o.links = []; o.reply = "Done."; expect(grade(o)).toBe(false);
});
