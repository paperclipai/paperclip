import { describe, expect, it } from "vitest";
import { gradeIntegratorRoutineInvocation } from "./integrator-routine-invocation.js";
function valid() {
  const task = { id: "task", identifier: "ACN-2", projectId: "project", assigneeAgentId: "ceo", status: "done", title: "Launch summary" };
  const invocation = { id: "invocation", routineId: "routine", source: "manual", status: "completed", linkedIssueId: "task", idempotencyKey: "delivery", triggerPayload: { variables: { projectName: "Launch" } } };
  const base = { scenarioId: "routines.run-now", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { project: { id: "project" } },
    tasks: [task], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], links: ["/ACN/issues/ACN-2"],
    routine: { id: "routine" }, invocations: [invocation], outputComments: [{ id: "output", authorAgentId: "ceo", createdByRunId: "output-run", body: "Launch: payment approval is pending." }],
    runs: [{ id: "output-run", agentId: "ceo", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "task" } }], reply: "Accepted the Launch summary invocation; its task is waiting." };
  const first = structuredClone(base); first.invocations[0]!.status = "issue_created"; first.tasks[0]!.status = "todo";
  return { ...base, state: { ...base.state, replayRunId: "invocation", replayIssueId: "task", firstInvocation: first },
    reply: `${first.reply}\nThe summary completed: Launch is still waiting on payment approval. Here is its result task.` };
}
describe("real manual invocation and delivery distinction", () => {
  it("accepts substantive actual result and refuses missing receipts", () => {
    expect(gradeIntegratorRoutineInvocation(valid()).passed).toBe(true);
    expect(gradeIntegratorRoutineInvocation(undefined).passed).toBe(false);
    const o = valid(); o.outputComments = [];
    expect(gradeIntegratorRoutineInvocation(o).passed).toBe(false);
  });
  it("rejects duplicate delivery, wrong input and unrelated native output", () => {
    const duplicate = valid(); duplicate.invocations.push({ ...duplicate.invocations[0]!, id: "another" });
    expect(gradeIntegratorRoutineInvocation(duplicate).passed).toBe(false);
    const wrongInput = valid(); wrongInput.invocations[0]!.triggerPayload.variables.projectName = "Research";
    expect(gradeIntegratorRoutineInvocation(wrongInput).passed).toBe(false);
    const wrongReplay = valid(); wrongReplay.state.replayIssueId = "other-task";
    expect(gradeIntegratorRoutineInvocation(wrongReplay).passed).toBe(false);
    const wrongRun = valid(); wrongRun.runs[0]!.contextSnapshot.issueId = "other-task";
    expect(gradeIntegratorRoutineInvocation(wrongRun).passed).toBe(false);
  });
  it("rejects false early completion, later acceptance-only and invented approved outcome", () => {
    const early = valid(); early.state.firstInvocation.reply = "The Launch summary completed successfully.";
    early.reply = `${early.state.firstInvocation.reply}\nThe summary completed; payment approval remains pending for Launch.`;
    expect(gradeIntegratorRoutineInvocation(early).passed).toBe(false);
    const o = valid();
    expect(gradeIntegratorRoutineInvocation({ ...o, reply: `${o.state.firstInvocation.reply}\nI accepted the Launch summary, waiting for payment approval.` }).passed).toBe(false);
    expect(gradeIntegratorRoutineInvocation({ ...o, reply: `${o.state.firstInvocation.reply}\nThe Launch summary completed. Payment is approved.` }).passed).toBe(false);
  });
});

import { launchSummaryRoutineInput } from "./integrator-routine-invocation.js";
import { createRoutineSchema } from "../../../packages/shared/src/validators/routine.js";
it("validates the real project-name prerequisite as required public text, not unsupported string", () => {
  const input = launchSummaryRoutineInput("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  expect(input.variables).toEqual([{ name: "projectName", type: "text", required: true, options: [] }]);
  expect(input.assigneeAgentId).toBe("22222222-2222-4222-8222-222222222222");
  expect(createRoutineSchema.safeParse({ ...input, variables: [{ name: "projectName", type: "string", required: true }] }).success).toBe(false);
  expect(() => launchSummaryRoutineInput("not-a-project-id", input.assigneeAgentId!)).toThrow();
});
