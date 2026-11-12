import { describe, expect, it } from "vitest";
import { gradeIntegratorRoutinePause } from "./integrator-routine-pause.js";
function valid() {
  const routine = { id: "routine", assigneeAgentId: "ceo", projectId: "project", description: "Daily launch summary", status: "active", triggers: [{ id: "schedule", kind: "schedule", enabled: true, cronExpression: "0 9 * * *", timezone: "America/Chicago" }] };
  const prior = { id: "prior", status: "completed", linkedIssueId: "prior-task" }; const active = { id: "active", status: "completed", linkedIssueId: "active-task" };
  const base = { scenarioId: "routines.pause-owned", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { routine: structuredClone(routine), worker: { id: "morgan" }, priorInvocation: prior, activeInvocation: active, activeNativeRunId: "busy" },
    routine: { ...routine, status: "paused" }, invocations: [prior, active], tasks: [{ id: "prior-task", status: "done" }, { id: "active-task", status: "done" }],
    projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], links: [], runs: [{ id: "busy", agentId: "morgan", status: "succeeded" }],
    reply: "Paused future daily summaries. The already running task is separate and continues; its history remains available." };
  const checkpoint = structuredClone(base); checkpoint.runs[0]!.status = "running"; checkpoint.tasks[1]!.status = "in_progress";
  return { ...base, state: { ...base.state, pauseCheckpoint: checkpoint } };
}
describe("routine schedule pause versus actual in-flight work", () => {
  it("accepts persisted pause with genuine retained history and a separately running task", () => {
    expect(gradeIntegratorRoutinePause(valid()).passed).toBe(true);
    expect(gradeIntegratorRoutinePause(undefined).passed).toBe(false);
    const paraphrase = valid(); paraphrase.state.pauseCheckpoint.reply = "Future schedules are disabled. The in-flight execution continues normally.";
    expect(gradeIntegratorRoutinePause(paraphrase).passed).toBe(true);
    const finishing = valid(); finishing.state.pauseCheckpoint.reply = "Paused the routine. COM-2 had already started and is still finishing under Morgan.";
    expect(gradeIntegratorRoutinePause(finishing).passed).toBe(true);
    // Full cohort 4: a correct reply offering how to stop the run is not a cancellation claim.
    const offer = valid(); offer.state.pauseCheckpoint.reply = "Paused Daily launch summaries. COM-2 is still running under Morgan. If you want that one stopped too, use Pause on its task page.";
    expect(gradeIntegratorRoutinePause(offer).passed).toBe(true);
    const empty = valid(); empty.state.pauseCheckpoint.reply = " ";
    expect(gradeIntegratorRoutinePause(empty).passed).toBe(false);
  });
  it("rejects an active schedule, discarded history, changed owner, or fabricated busy checkpoint", () => {
    const active = valid(); active.routine.status = "active";
    expect(gradeIntegratorRoutinePause(active).passed).toBe(false);
    expect(gradeIntegratorRoutinePause({ ...valid(), invocations: [] }).passed).toBe(false);
    const stolen = valid(); stolen.routine.assigneeAgentId = "morgan";
    expect(gradeIntegratorRoutinePause(stolen).passed).toBe(false);
    const fake = valid(); fake.state.pauseCheckpoint.runs[0]!.status = "succeeded";
    expect(gradeIntegratorRoutinePause(fake).passed).toBe(false);
  });
  it("rejects actual cancellation instead of normal completion", () => {
    const cancelled = valid(); cancelled.runs[0]!.status = "cancelled";
    expect(gradeIntegratorRoutinePause(cancelled).passed).toBe(false);
    const cancelledTask = valid(); cancelledTask.tasks[1]!.status = "cancelled";
    expect(gradeIntegratorRoutinePause(cancelledTask).passed).toBe(false);
    const stoppedAtResponse = valid(); stoppedAtResponse.state.pauseCheckpoint.runs[0]!.status = "cancelled";
    expect(gradeIntegratorRoutinePause(stoppedAtResponse).passed).toBe(false);
  });
});
