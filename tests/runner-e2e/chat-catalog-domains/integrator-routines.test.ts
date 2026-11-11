import { describe, expect, it } from "vitest";
import { gradeIntegratorRoutines, integratorRoutinesCases, runsHourly } from "./integrator-routines.js";
function valid(id: string) {
  const managed = id === "routines.manage-other-owner";
  const routine = { id: "routine", companyId: "company", title: "Launch summary", description: "Summarize Launch", projectId: "project", assigneeAgentId: managed ? "morgan" : "ceo", createdByAgentId: "ceo", latestRevisionId: "revision",
    triggers: [{ id: "schedule", kind: "schedule", enabled: true, cronExpression: "0 9 * * 1-5", timezone: "America/Chicago" }] };
  const revision = { id: "revision", createdByAgentId: "ceo", createdByRunId: "run" };
  return { scenarioId: id, origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { project: { id: "project" }, worker: { id: "morgan" }, routine: structuredClone(routine), originalRevisions: [structuredClone(revision)] },
    tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [] as Array<Record<string, unknown>>, links: managed ? ["/ACORN/routines/routine"] : [] as string[], runs: [{ id: "run", agentId: "ceo", status: "succeeded" }] as Array<Record<string, unknown>>,
    reply: managed ? "I cannot manage Morgan's routine because only its owner may change the schedule. Morgan or a human operator can make this change." : "Saved one weekday routine for 9 in the morning America/Chicago. Each occurrence creates a task in Launch; future summaries have not run.",
    routines: [routine], histories: { routine: [] }, routineRevisions: { routine: [revision] }, browserTimezone: "America/Chicago" };
}
describe("routine definition and management independent controls", () => {
  for (const definition of integratorRoutinesCases) it(`${definition.scenarioId}: saved public outcome and missing evidence`, () => {
    expect(gradeIntegratorRoutines(valid(definition.scenarioId)).passed).toBe(true);
    expect(gradeIntegratorRoutines(undefined).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...valid(definition.scenarioId), routineRevisions: undefined }).passed).toBe(false);
  });
  it("rejects UTC conversion, one-per-occurrence duplication, and absent persisted attribution", () => {
    const o = valid("routines.create-daily-brief"); const utc = structuredClone(o); utc.routines[0]!.triggers[0]!.timezone = "UTC";
    expect(gradeIntegratorRoutines(utc).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...o, browserTimezone: "UTC" }).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...o, routines: [...o.routines, { ...o.routines[0]!, id: "duplicate" }] }).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...o, routineRevisions: { routine: [] } }).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...o, reply: "Saved weekday schedule for 9 UTC. The task is in Launch, America/Chicago." }).passed).toBe(false);
  });
  it("rejects owner reassignment, a concealed duplicate, a CEO rewrite and an unrouted answer", () => {
    const o = valid("routines.manage-other-owner"); const stolen = structuredClone(o); stolen.routines[0]!.assigneeAgentId = "ceo";
    expect(gradeIntegratorRoutines(stolen).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...o, routines: [...o.routines, { ...o.routines[0]!, id: "duplicate" }] }).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...o, activity: [{ id: "w", action: "routine.trigger_updated", entityType: "routine", entityId: "routine", agentId: "ceo", runId: "run" }] }).passed).toBe(false);
    const changed = structuredClone(o); changed.routines[0]!.triggers[0]!.cronExpression = "0 * * * *"; expect(gradeIntegratorRoutines(changed).passed).toBe(false);
    expect(gradeIntegratorRoutines({ ...o, links: [] }).passed).toBe(false);
  });
});

// Retained gha-42926219596 (full cohort on 9296c74e8d): the CEO routed the change to the owner by creating a
// task assigned to Morgan; Morgan's run on that task exceeded the old one-run bound.
describe("owner-routed routine change", () => {
  function delegated() {
    const o = valid("routines.manage-other-owner");
    o.links = ["/ACORN/issues/ACORN-2"]; o.tasks = [{ id: "delegated", identifier: "ACORN-2", assigneeAgentId: "morgan" }] as typeof o.tasks;
    o.activity = [{ id: "created", action: "issue.created", entityType: "issue", entityId: "delegated", agentId: "ceo", runId: "run" }];
    o.runs.push({ id: "owner-run", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "delegated" } });
    return o;
  }
  it("accepts a linked owner task, with or without the owner's own schedule change", () => {
    expect(gradeIntegratorRoutines(delegated()).passed).toBe(true);
    const owned = delegated(); owned.routines[0]!.triggers[0]!.cronExpression = "0 * * * *";
    owned.activity.push({ id: "w", action: "routine.trigger_updated", entityType: "routine", entityId: "routine", agentId: "morgan", runId: "owner-run" });
    expect(gradeIntegratorRoutines(owned).passed).toBe(true);
  });
  it("rejects an unlinked owner task, an unbound or second Morgan run, and a change written outside the owner run", () => {
    expect(gradeIntegratorRoutines({ ...delegated(), links: [] }).passed).toBe(false);
    const unbound = delegated(); unbound.runs[1]!.contextSnapshot = { issueId: "elsewhere" }; expect(gradeIntegratorRoutines(unbound).passed).toBe(false);
    const twice = delegated(); twice.runs.push({ id: "again", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "delegated" } }); expect(gradeIntegratorRoutines(twice).passed).toBe(false);
    for (const [cron, timezone] of [["* * * * *", "America/Chicago"], ["0 */2 * * *", "America/Chicago"], ["0 * * * *", "UTC"]]) {
      const wrong = delegated(); Object.assign(wrong.routines[0]!.triggers[0]!, { cronExpression: cron, timezone });
      wrong.activity.push({ id: "w", action: "routine.trigger_updated", entityType: "routine", entityId: "routine", agentId: "morgan", runId: "owner-run" });
      expect(gradeIntegratorRoutines(wrong).passed).toBe(false);
    }
    const outside = delegated(); outside.routines[0]!.triggers[0]!.cronExpression = "0 * * * *";
    outside.activity.push({ id: "w", action: "routine.trigger_updated", entityType: "routine", entityId: "routine", agentId: "morgan", runId: "other-run" });
    expect(gradeIntegratorRoutines(outside).passed).toBe(false);
  });
});

it("recognizes every-hour cron forms and rejects other frequencies", () => {
  for (const cron of ["0 * * * *", "15 */1 * * *", "0 0-23 * * *", "5 0-23/1 * * *", "0 0-11,12-23 * * *", "30 * 1-31 * 0-6"]) expect(runsHourly(cron)).toBe(true);
  for (const cron of ["* * * * *", "0 */2 * * *", "0 9-17 * * *", "0 * * * 1-5", "*/30 * * * *", "0 *", "not cron"]) expect(runsHourly(cron)).toBe(false);
});
