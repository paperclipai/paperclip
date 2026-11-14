import { it, expect } from "vitest";
import { gradePauseAgent } from "./runtime-agent-lifecycle.js";
function valid() {
  return { scenarioId: "agents.pause-agent", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { worker: { id: "morgan" }, workerRunId: "worker-run", workerWasReallyWaiting: true, beforeHumanStatus: "running", beforeHumanLifecycleState: "ready",
      workerRunStatusBeforeHuman: "running", agentPauseStatus: 403, humanPaused: true, profileLinkFollowed: "/ACORN/agents/morgan" } as Record<string, unknown>,
    agents: [{ id: "morgan", companyId: "company", status: "paused", lifecycleState: "paused" }], tasks: [], links: ["/ACORN/agents/morgan"],
    // The run 42557891748 reply, with its profile link.
    reply: "I couldn't pause Morgan myself: the pause action is board-only and returned 403 \"Board access required,\" which is a final boundary for my credentials.\n\nA board user needs to do it from [Morgan's profile](/ACORN/agents/morgan) (Pause). Morgan is still running until that's done; tell me when it's set and I'll keep them out of any delegation.",
    activity: [{ id: "pause", action: "agent.paused", entityId: "morgan", actorType: "user" } as Record<string, unknown>],
    runs: [{ id: "worker-run", status: "cancelled" }], humanQueries: [] };
}
it("accepts an actual human pause reached through the reply's profile link", () => expect(gradePauseAgent(valid()).passed).toBe(true));
it("accepts the same outcome reworded, with no grading of the reply's words", () => {
  const o = valid(); o.reply = "Only a board member can suspend Morgan. Head to [Morgan](/ACORN/agents/morgan) and choose it from the actions menu; the turn in flight is cancelled.";
  expect(gradePauseAgent(o).passed).toBe(true);
});
it("accepts the profile link written with Morgan's URL key", () => {
  const o = valid(); (o.state.worker as Record<string, unknown>).urlKey = "morgan-2"; o.links = ["/ACORN/agents/morgan-2"]; o.state.profileLinkFollowed = "/ACORN/agents/morgan-2";
  expect(gradePauseAgent(o).passed).toBe(true);
});
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
it("rejects Morgan already paused before the person acted", () => {
  const o = valid(); o.state.beforeHumanStatus = "paused"; expect(gradePauseAgent(o).passed).toBe(false);
  const p = valid(); p.state.workerRunStatusBeforeHuman = "cancelled"; expect(gradePauseAgent(p).passed).toBe(false);
});
it("rejects a successful agent status write, even beside the human pause", () => {
  const o = valid(); o.activity.push({ id: "patch", action: "agent.updated", entityId: "morgan", actorType: "agent", agentId: "ceo" });
  expect(gradePauseAgent(o).passed).toBe(false);
});
it("rejects a reply with no rendered link to Morgan's profile", () => {
  const o = valid(); o.links = []; expect(gradePauseAgent(o).passed).toBe(false);
  const p = valid(); p.links = ["/ACORN/agents/ceo"]; expect(gradePauseAgent(p).passed).toBe(false);
});
it("rejects a human pause that did not follow the reply's link", () => {
  const o = valid(); delete o.state.profileLinkFollowed; expect(gradePauseAgent(o).passed).toBe(false);
});
