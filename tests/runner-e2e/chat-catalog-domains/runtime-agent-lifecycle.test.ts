import { it, expect } from "vitest";
import { gradePauseAgent } from "./runtime-agent-lifecycle.js";
function valid() {
  return { scenarioId: "agents.pause-agent", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { worker: { id: "morgan" }, workerRunId: "worker-run", workerWasReallyWaiting: true, beforeHumanStatus: "running", agentPauseStatus: 403, humanPaused: true },
    agents: [{ id: "morgan", companyId: "company", status: "paused", lifecycleState: "paused" }], tasks: [], links: ["/ACORN/agents/morgan"],
    reply: "Open Morgan's profile and use the Pause control. Existing running work stops after cleanup; the pause remains until resumed.",
    activity: [{ id: "pause", action: "agent.paused", entityId: "morgan", actorType: "user" }],
    runs: [{ id: "worker-run", status: "cancelled" }], humanQueries: [] };
}
it("accepts an actual human pause with stopped worker evidence", () => expect(gradePauseAgent(valid()).passed).toBe(true));
it("accepts natural sustained-pause guidance", () => { const o = valid(); o.reply = "You can pause Morgan from the profile actions. Let the running turn finish its cleanup; Morgan then stays suspended until you resume."; expect(gradePauseAgent(o).passed).toBe(true); });
it("rejects missing pause evidence", () => expect(gradePauseAgent(undefined).passed).toBe(false));
it("rejects acknowledgement without a saved human pause", () => {
  const o = valid(); o.state.humanPaused = false; expect(gradePauseAgent(o).passed).toBe(false);
});
it("rejects a paused label while the old process still runs", () => {
  const o = valid(); o.runs[0]!.status = "running"; expect(gradePauseAgent(o).passed).toBe(false);
});
it("rejects an agent-authored pause attribution", () => {
  const o = valid(); o.activity[0]!.actorType = "agent"; expect(gradePauseAgent(o).passed).toBe(false);
});

it("accepts correct human pause guidance without requiring a profile hyperlink", () => {
  const o = valid(); o.links = []; expect(gradePauseAgent(o).passed).toBe(true);
});
