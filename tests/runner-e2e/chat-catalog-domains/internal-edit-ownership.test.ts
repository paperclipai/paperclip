import { describe, expect, it } from "vitest";
import { gradeEditOwnership, expectedEditReassignmentCancellation, assignmentDenials } from "./internal-edit-ownership.js";
import { grade_tasks } from "./internal-tasks.js";
import type { InternalObservation, Entity } from "./internal-support.js";
import type { ChatRun } from "../chat-flow.js";
function valid() {
  const initial = { id: "task", companyId: "company", title: "Landing page", status: "backlog", priority: "medium", assigneeAgentId: null };
  const first: InternalObservation = { scenarioId: "tasks.edit-properties", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task: initial, worker: { id: "morgan" } }, tasks: [{ ...initial, priority: "high", assigneeAgentId: "morgan" }], projects: [], goals: [], comments: [], activity: [{ id: "first-edit", entityId: "task", action: "issue.updated", agentId: "ceo", details: { priority: "high" } }], documents: [], revisions: [], links: ["/RUN/issues/task"], humanQueries: [], reply: "Saved High priority and Morgan assignment.", runs: [{ id: "first", companyId: "company", agentId: "ceo", status: "succeeded" }] };
  const held = { ...initial, assigneeAgentId: "riley", status: "in_progress", executionRunId: "riley-run", checkoutRunId: "riley-run" };
  return { ...structuredClone(first), state: { ...first.state, firstEdit: first, riley: { id: "riley" }, heldTask: structuredClone(held), heldRun: { id: "riley-run" }, gateCalls: [{ authorized: true }] }, tasks: [held], currentTask: held,
    assignmentDenials: [{ runId: "second", taskId: "task", assigneeId: "morgan", callId: "denied", reason: "Cannot stop the owned checkout safely" }],
    phaseReply: "Riley holds the running execution checkout. I cannot change priority or reassign to Morgan until that ownership is released.",
    runs: [...first.runs, { id: "riley-run", companyId: "company", agentId: "riley", status: "running" }, { id: "second", companyId: "company", agentId: "ceo", status: "succeeded" }] };
}
const grade = (o: unknown) => gradeEditOwnership(o, grade_tasks);
function graceful() {
  const o = valid(); o.currentTask.priority = "high"; o.currentTask.assigneeAgentId = "morgan"; o.currentTask.executionRunId = ""; o.currentTask.checkoutRunId = "";
  const query = "Make it high priority and assign Morgan."; Object.assign(o.state, { canonicalEditQuery: query });
  const comments = [{ id: "q1", body: query, createdAt: "2026-10-27T08:00:00Z" }, { id: "q2", body: query, createdAt: "2026-10-27T08:02:00Z" }];
  Object.assign(o.runs[1]!, { status: "cancelled", errorCode: "issue_reassigned", contextSnapshot: { issueId: "task" }, resultJson: { reassignmentStopConfirmed: true, nativeCancellation: { schema: "paperclip.native-cancellation.v1", dispatchState: "acknowledged", runId: "riley-run", issueId: "task", companyId: "company", acknowledgedAt: "2026-10-27T08:02:02Z" } } });
  Object.assign(o.runs[2]!, { contextSnapshot: { issueId: "source", wakeCommentId: "q2" } });
  o.activity.push({ id: "reassigned", companyId: "company", actorType: "agent", actorId: "ceo", action: "issue.reassigned", entityId: "task", agentId: "ceo", runId: "second", createdAt: "2026-10-27T08:02:03Z", details: { changed: true, previousAssigneeAgentId: "riley", assigneeAgentId: "morgan" } } as Entity,
    { id: "final-priority", companyId: "company", actorType: "agent", actorId: "ceo", action: "issue.updated", entityId: "task", agentId: "ceo", runId: "second", createdAt: "2026-10-27T08:02:04Z", details: { priority: "high" } } as Entity);
  o.phaseReply = "Priority is high and the task is assigned to Morgan. New execution is pending the accounting boundary; the assignment is saved.";
  return { ...o, sourceComments: comments };
}
describe("property edit execution-boundary conditional calibration", () => {
  it("accepts actual primary success and truthful later denial of both changes", () => expect(grade(valid()).passed).toBe(true));
  it("accepts an independently saved priority with denied reassignment", () => { const o = valid(); o.currentTask.priority = "high"; o.phaseReply = "Priority is now high. Riley holds the running checkout; I cannot assign Morgan until that execution ends."; o.activity.push({ id: "final-edit", entityId: "task", action: "issue.updated", agentId: "ceo", details: { priority: "high" }, runId: "second" } as Entity); expect(grade(o).passed).toBe(true); });
  it("rejects a false saved priority or assignment claim", () => { const o = valid(); o.phaseReply = "Priority is now high. Riley has a running checkout; I cannot verify it, but I assigned Morgan."; expect(grade(o).passed).toBe(false); });
  it("rejects repairing a wrong initial edit in the later phase", () => { const o = valid(); o.state.firstEdit.tasks[0]!.assigneeAgentId = "other"; expect(grade(o).passed).toBe(false); });
  it("rejects stealing the real checkout or admitting Morgan concurrently", () => { const o = valid(); o.currentTask.executionRunId = "other"; expect(grade(o).passed).toBe(false); const extra = valid(); extra.runs.push({ id: "morgan-run", companyId: "company", agentId: "morgan", status: "running" }); expect(grade(extra).passed).toBe(false); });
  it("does not credit a prior phase's priority audit as the conditional save", () => { const o = valid(); o.currentTask.priority = "high"; o.phaseReply = "Priority is now high. Riley holds the running checkout; I cannot assign Morgan until it ends."; expect(grade(o).passed).toBe(false); });
  it("rejects a wrong-phase-only explanation", () => { const o = valid(); o.reply += o.phaseReply; o.phaseReply = "Done."; expect(grade(o).passed).toBe(false); });
  it("accepts exact acknowledged graceful reassignment with truthful saved state and pending new admission", () => { const o = graceful(); expect(grade(o).passed).toBe(true); expect(expectedEditReassignmentCancellation(o)).toEqual({ runId: "riley-run", taskId: "task", workerId: "riley", sourceRunId: "second" }); });
  it("accepts actual task-bound Morgan admission where it occurs", () => { const o = graceful(); o.runs.push({ id: "morgan-run", companyId: "company", agentId: "morgan", status: "running", contextSnapshot: { issueId: "task" } } as ChatRun); o.currentTask.executionRunId = "morgan-run"; o.phaseReply = "High priority saved; assigned to Morgan, who is running the task now."; expect(grade(o).passed).toBe(true); });
  it("rejects wrong cancelled run/reason/task/actor rather than allowing any expected cancellation", () => {
    for (const patch of [{ errorCode: "cancelled" }, { id: "unrelated" }, { agentId: "other" }, { contextSnapshot: { issueId: "wrong-task" } }]) { const o = graceful(); Object.assign(o.runs[1]!, patch); expect(expectedEditReassignmentCancellation(o)).toBeUndefined(); expect(grade(o).passed).toBe(false); }
    const wrong = graceful(); wrong.activity[1]!.agentId = "other"; expect(grade(wrong).passed).toBe(false);
  });
  it("rejects cancellation before the actual second human request and an unacknowledged stop", () => {
    const o = graceful(); const result = (o.runs[1] as ChatRun).resultJson!; (result.nativeCancellation as Record<string, unknown>).acknowledgedAt = "2026-10-27T08:01:00Z"; expect(grade(o).passed).toBe(false);
    const wrong = graceful(); ((wrong.runs[1] as ChatRun).resultJson!.nativeCancellation as Record<string, unknown>).dispatchState = "pending"; expect(grade(wrong).passed).toBe(false);
  });
  it("rejects missing final priority/assignment, prior phase audit and invented Morgan execution", () => {
    const o = graceful(); o.currentTask.priority = "medium"; expect(grade(o).passed).toBe(false);
    const wrong = graceful(); wrong.currentTask.assigneeAgentId = "riley"; expect(grade(wrong).passed).toBe(false);
    const earlier = graceful(); (earlier.activity[2] as Entity & { runId?: string }).runId = "first"; expect(grade(earlier).passed).toBe(false);
    const invented = graceful(); invented.phaseReply = "High priority saved; assigned Morgan, who is running now."; expect(grade(invented).passed).toBe(false);
  });
  it("requires a real denial receipt instead of inferring denial from a stoppable checkout", () => { const o = valid(); o.assignmentDenials = []; expect(grade(o).passed).toBe(false); });
  it("binds genuine ownership-conflict results to exact native task/assignee/call and rejects postcommit accounting errors", () => {
    const outer = (id: string, eventType: string, item: Record<string, unknown>) => ({ runId: "second", sourceEventId: id, payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceEventId: id, runId: "second", eventType, itemId: "call", payload: { kind: "dynamicToolCall", item } } } });
    const events = [outer("input", "item.started", { id: "call", type: "tool_use", name: "reassign_task", input: { taskId: "task", assigneeActorId: "morgan" } }), outer("result", "item.completed", { id: "call", tool_use_id: "call", type: "tool_result", is_error: true, error: "Cannot stop the owned checkout safely" })];
    expect(assignmentDenials(events, "second", "task", "morgan")).toHaveLength(1); expect(assignmentDenials(events, "second", "wrong", "morgan")).toEqual([]);
    events[1]!.payload.prpEvent.payload.item.error = "New work must wait while a native run recovers its unfinished accounting."; expect(assignmentDenials(events, "second", "task", "morgan")).toEqual([]);
  });
});
