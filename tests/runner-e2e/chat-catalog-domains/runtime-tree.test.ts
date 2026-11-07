import { expect, it } from "vitest";
import { gradeTreePause } from "./runtime-tree.js";
function valid(scenarioId = "task-coordination.pause-tree") {
  const held = { id: "launch-hold", companyId: "company", rootIssueId: "launch", mode: "pause", status: "active", createdByActorType: "user", createdByUserId: "human",
    members: ["launch", "website", "design", "manual"].map(issueId => ({ issueId, companyId: "company", skipped: issueId === "manual", skipReason: issueId === "manual" ? "already_held" : null })) };
  return { scenarioId, companyId: "company", leadId: "ceo", reply: "", agents: [], tasks: [], links: [], activity: [], humanQueries: [],
    runs: [{ id: "worker1", status: "cancelled" }, { id: "worker2", status: "cancelled" }, { id: "guidance", status: "succeeded" }],
    state: { parent: { id: "launch" }, task: { id: "website" }, second: { task: { id: "design" }, workerRunId: "worker2" }, manualChild: { id: "manual" }, workerRunId: "worker1",
      humanId: "human", pausedHold: held, releasedHold: { ...held, status: "released", releasedByActorType: "user", releasedByUserId: "human" },
      agentPauseStatus: 403, parentUnpausedBeforeHuman: true, queryReply: "Open Launch and use the human Pause subtree control. A stopped turn alone is not a persistent pause; resume later through the supported control.",
      bothActuallyRunning: true, pauseVisible: true, confirmedNativeStops: true, pausePreventsNewAdmission: true, parentUnpausedAfterResume: true,
      independentChildHoldRetained: true, independentBudgetRetained: true, manualAgentStillPaused: true, resumeWakeDisabled: true } };
}
for (const id of ["task-coordination.pause-tree", "steering.stop-versus-pause"]) {
  it(`${id} accepts real human subtree pause, confirmed stops and isolated later resume`, () => expect(gradeTreePause(valid(id)).passed).toBe(true));
  it(`${id} accepts natural parent/control/persistent-pause guidance`, () => { const o = valid(id); o.state.queryReply = "For all Launch work, you need the task tree's Pause action in the human menu. It holds future admission as well as stopping the current executions. Use Resume when you decide to continue later."; expect(gradeTreePause(o).passed).toBe(true); });
}
it("rejects missing actual tree-control evidence", () => expect(gradeTreePause(undefined).passed).toBe(false));
it("rejects applying the human operation to a different parent", () => { const o = valid(); o.state.pausedHold.rootIssueId = "other"; expect(gradeTreePause(o).passed).toBe(false); });
it("rejects a skipped descendant", () => { const o = valid(); o.state.pausedHold.members[2]!.skipped = true; expect(gradeTreePause(o).passed).toBe(false); });
it("rejects agent-authored board controls", () => { const o = valid(); o.state.pausedHold.createdByActorType = "agent"; expect(gradeTreePause(o).passed).toBe(false); });
it("rejects terminal status without actual native stop acknowledgement", () => { const o = valid(); o.state.confirmedNativeStops = false; expect(gradeTreePause(o).passed).toBe(false); });
it("rejects a parent resume that clears the child's separate manual pause", () => { const o = valid(); o.state.independentChildHoldRetained = false; expect(gradeTreePause(o).passed).toBe(false); });
it("rejects erasing the child's effective budget hold", () => { const o = valid(); o.state.independentBudgetRetained = false; expect(gradeTreePause(o).passed).toBe(false); });
it("rejects invented automatic tomorrow resumption", () => { const o = valid("steering.stop-versus-pause"); o.state.queryReply += " It will automatically resume tomorrow."; expect(gradeTreePause(o).passed).toBe(false); });
it("rejects duplicate admission after a supposedly persistent pause", () => { const o = valid(); o.runs.push({ id: "extra", status: "succeeded" }); expect(gradeTreePause(o).passed).toBe(false); });
