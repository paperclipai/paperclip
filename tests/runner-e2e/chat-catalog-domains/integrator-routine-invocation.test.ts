import { describe, expect, it } from "vitest";
import { gradeIntegratorRoutineInvocation } from "./integrator-routine-invocation.js";
function valid() {
  const task = { id: "task", identifier: "ACN-2", projectId: "project", assigneeAgentId: "ceo", status: "done", title: "Launch summary" };
  const invocation = { id: "invocation", routineId: "routine", source: "manual", status: "completed", linkedIssueId: "task", idempotencyKey: "delivery",
    completedAt: "2026-01-01T00:02:00.000Z", triggerPayload: { variables: { projectName: "Launch" } } };
  const chatRun = { id: "chat-run", agentId: "ceo", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "chat" } };
  const outputRun = { id: "output-run", agentId: "ceo", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "task" } };
  const followUpRun = { id: "follow-up-run", agentId: "ceo", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "chat" } };
  const base = { scenarioId: "routines.run-now", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { project: { id: "project" } },
    tasks: [task], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], links: ["/ACN/issues/ACN-2"],
    routine: { id: "routine" }, invocations: [invocation], outputComments: [{ id: "output", authorAgentId: "ceo", createdByRunId: "output-run", body: "Launch: payment approval is pending." }],
    runs: [chatRun, outputRun], reply: "Accepted the Launch summary invocation; its task is waiting.",
    toolReads: [
      { runId: "output-run", name: "paperclip_list_projects", at: "2026-01-01T00:01:30.000Z", output: '{"projects":[{"id":"project"}]}' },
      { runId: "follow-up-run", name: "paperclip_get_task", at: "2026-01-01T00:03:00.000Z", output: '{"data":{"id":"task","status":"done"}}' },
    ] };
  const first = structuredClone(base); first.invocations[0]!.status = "issue_created"; first.tasks[0]!.status = "todo";
  return { ...base, runs: [...base.runs, followUpRun], state: { ...base.state, replayRunId: "invocation", replayIssueId: "task", firstInvocation: first },
    reply: `${first.reply}\nThe summary completed: Launch is still waiting on payment approval. Here is its result task.` };
}
type Observation = ReturnType<typeof valid>;
const withLater = (o: Observation, later: string) => ({ ...o, reply: `${o.state.firstInvocation.reply}\n${later}` });
describe("real manual invocation and delivery distinction", () => {
  it("accepts substantive actual result and refuses missing receipts", () => {
    expect(gradeIntegratorRoutineInvocation(valid()).passed).toBe(true);
    expect(gradeIntegratorRoutineInvocation(undefined).passed).toBe(false);
    const o = valid(); o.outputComments = [];
    expect(gradeIntegratorRoutineInvocation(o).passed).toBe(false);
    const noReads = valid(); delete (noReads as Partial<Observation>).toolReads;
    expect(gradeIntegratorRoutineInvocation(noReads).passed).toBe(false);
  });
  it("does not depend on the wording of a correct later result", () => {
    expect(gradeIntegratorRoutineInvocation(withLater(valid(), "RUN-2 is closed and nothing failed. Per its saved comment, the payment sign-off has not come through yet.")).passed).toBe(true);
    expect(gradeIntegratorRoutineInvocation(withLater(valid(), "It's done — approval for payment is outstanding.")).passed).toBe(true);
  });
  it("rejects duplicate delivery, wrong input and unrelated native output", () => {
    const duplicate = valid(); duplicate.invocations.push({ ...duplicate.invocations[0]!, id: "another" });
    expect(gradeIntegratorRoutineInvocation(duplicate).passed).toBe(false);
    const wrongInput = valid(); wrongInput.invocations[0]!.triggerPayload.variables.projectName = "Research";
    expect(gradeIntegratorRoutineInvocation(wrongInput).passed).toBe(false);
    const wrongReplay = valid(); wrongReplay.state.replayIssueId = "other-task";
    expect(gradeIntegratorRoutineInvocation(wrongReplay).passed).toBe(false);
    const wrongRun = valid(); wrongRun.runs[1]!.contextSnapshot.issueId = "other-task";
    expect(gradeIntegratorRoutineInvocation(wrongRun).passed).toBe(false);
    const unread = valid(); unread.toolReads = unread.toolReads.filter(row => row.runId !== "output-run");
    expect(gradeIntegratorRoutineInvocation(unread).passed).toBe(false);
  });
  it("rejects false early completion and a later answer not grounded on the completed result", () => {
    const early = valid(); early.state.firstInvocation.reply = "The Launch summary completed successfully.";
    early.reply = `${early.state.firstInvocation.reply}\nThe summary completed; payment approval remains pending for Launch.`;
    expect(gradeIntegratorRoutineInvocation(early).passed).toBe(false);
    const future = valid(); future.state.firstInvocation.reply = "I started the routine; RUN-2 will be marked done once the summary is finished.";
    future.reply = `${future.state.firstInvocation.reply}\nThe summary completed; payment approval remains pending.`;
    expect(gradeIntegratorRoutineInvocation(future).passed).toBe(true);
    const recalled = valid(); recalled.toolReads = recalled.toolReads.filter(row => row.runId !== "follow-up-run");
    expect(gradeIntegratorRoutineInvocation(recalled).passed).toBe(false);
    const stale = valid(); stale.toolReads[1]!.at = "2026-01-01T00:01:00.000Z";
    expect(gradeIntegratorRoutineInvocation(stale).passed).toBe(false);
    const noFollowUp = valid(); noFollowUp.runs = noFollowUp.runs.filter(run => run.id !== "follow-up-run");
    expect(gradeIntegratorRoutineInvocation(noFollowUp).passed).toBe(false);
    const silent = valid(); silent.reply = silent.state.firstInvocation.reply;
    expect(gradeIntegratorRoutineInvocation(silent).passed).toBe(false);
    const unlinked = valid(); unlinked.links = [];
    expect(gradeIntegratorRoutineInvocation(unlinked).passed).toBe(false);
  });
});

import { callApiInputDigest } from "./api-read-receipts.js";
describe("call_api reads whose bodies the port redacts", () => {
  const apiRead = (runId: string, at: string, input: Record<string, unknown>, status = 200) =>
    ({ runId, name: "call_api", at, output: "", apiRead: { inputSha256: callApiInputDigest(input), operationId: String(input.operationId), ok: status === 200, status } });
  const redacted = (task: Record<string, unknown>, project: Record<string, unknown>, status = 200) => {
    const o = valid(); o.toolReads = [apiRead("output-run", "2026-01-01T00:01:30.000Z", project), apiRead("follow-up-run", "2026-01-01T00:03:00.000Z", task, status)] as typeof o.toolReads; return o;
  };
  const project = { operationId: "GET /api/projects/{id}", pathParams: { id: "project" } };
  it("accepts reads of the project and the result task bound by their saved input digests", () => {
    expect(gradeIntegratorRoutineInvocation(redacted({ operationId: "GET /api/issues/{id}", pathParams: { id: "ACN-2" } }, project)).passed).toBe(true);
    expect(gradeIntegratorRoutineInvocation(redacted({ operationId: "GET /api/issues/{id}", pathParams: { id: "task" } }, project)).passed).toBe(true);
  });
  it("rejects reads of another record or a failed read", () => {
    expect(gradeIntegratorRoutineInvocation(redacted({ operationId: "GET /api/issues/{id}", pathParams: { id: "ACN-1" } }, project)).passed).toBe(false);
    expect(gradeIntegratorRoutineInvocation(redacted({ operationId: "GET /api/issues/{id}", pathParams: { id: "task" } }, { ...project, pathParams: { id: "other" } })).passed).toBe(false);
    expect(gradeIntegratorRoutineInvocation(redacted({ operationId: "GET /api/issues/{id}", pathParams: { id: "task" } }, project, 404)).passed).toBe(false);
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
