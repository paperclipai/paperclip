import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gradeProjectDefaults, gradeProjectDefaultsSetup, projectReadCalls } from "./internal-project-defaults.js";
import { callApiInputDigest, gradeRoutineAudit, localClock, morningTimezone } from "./internal-routine-audit.js";
import { gradeWorkTimeline } from "./internal-work-timeline.js";
import { gradeArchivePartial } from "./internal-archive-partial.js";
function base(scenarioId: string) { return { scenarioId, origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: {} as Record<string, unknown>, tasks: [] as any[], projects: [] as any[], goals: [] as any[], comments: [] as any[], activity: [] as any[], documents: [], revisions: [], links: [] as string[], reply: "", humanQueries: [], runs: [] as any[] }; }
it("preserves the exact active prerequisite while independently proving ready canonical and future agents", () => {
  const ready = { id: "ceo", lifecycleState: "ready", status: "idle", adapterConfig: { timeoutSec: 0 } };
  const prepared = { lead: ready, future: { ...ready, id: "riley" }, held: { ...ready, id: "morgan", status: "running", adapterConfig: { timeoutSec: 0 } }, task: { id: "task", assigneeAgentId: "morgan", executionRunId: "held" }, runs: [{ id: "held", agentId: "morgan", status: "running" }], activeRunId: "held", gateCalls: [{ workerBound: true, workerId: "morgan" }] };
  expect(gradeProjectDefaultsSetup(prepared).passed).toBe(true);
  expect(gradeProjectDefaultsSetup({ ...prepared, lead: { ...prepared.lead, adapterConfig: { timeoutSec: 120 } } }).passed).toBe(false);
  expect(gradeProjectDefaultsSetup({ ...prepared, future: { ...prepared.future, adapterConfig: { timeoutSec: 120 } } }).passed).toBe(false);
  expect(gradeProjectDefaultsSetup({ ...prepared, held: { ...prepared.held, status: "idle" } }).passed).toBe(false);
  expect(gradeProjectDefaultsSetup({ ...prepared, future: { ...prepared.future, status: "error" } }).passed).toBe(false);
  expect(gradeProjectDefaultsSetup({ ...prepared, held: { ...prepared.held, adapterConfig: { timeoutSec: 120 } } }).passed).toBe(false);
  expect(gradeProjectDefaultsSetup({ ...prepared, gateCalls: [] }).passed).toBe(false);
  expect(gradeProjectDefaultsSetup({ ...prepared, gateCalls: [{ workerBound: true, workerId: "unrelated" }] }).passed).toBe(false);
});
function defaults() {
  const o = base("projects.project-defaults"); const task = { id: "active", status: "in_progress", projectId: "p", assigneeAgentId: "morgan", executionRunId: "prior" }; const future = { id: "future", status: "done", projectId: "p" }; const p = { id: "p", description: "Keyboard navigation; adequate contrast; labeled controls", goalIds: ["growth"], env: null };
  Object.assign(o.state, { project: { id: "p" }, goal: { id: "growth", title: "Growth" }, task, futureTask: future, futureWorker: { id: "riley" }, activeRunId: "prior", originalEnv: null, defaultsReply: "New work uses the saved defaults. Existing active work remains unchanged." });
  o.tasks = [task, future]; o.projects = [p]; o.runs = [{ id: "prior", status: "running", agentId: "morgan" }, { id: "new", status: "succeeded", agentId: "riley", contextSnapshot: { issueId: "future" } }]; o.activity = [{ action: "project.updated", entityId: "p", agentId: "ceo" }];
  return { ...o, futureContext: { project: structuredClone(p), goal: { id: "growth" } }, futureComments: [{ authorAgentId: "riley", createdByRunId: "new", body: "Growth applies; use keyboard navigation, contrast, and labeled controls." }] };
}
it("accepts genuine saved defaults reaching a new native task while active work stays fixed", () => expect(gradeProjectDefaults(defaults()).passed).toBe(true));
it("accepts natural future-default wording", () => { const o = defaults(); o.state.defaultsReply = "These defaults apply only to subsequent Launch tasks; your running work is not changed."; expect(gradeProjectDefaults(o).passed).toBe(true); });
it("leaves the canonical reply's future/active wording to a human reader", () => {
  const o = defaults(); o.state.defaultsReply = "Newly admitted work inherits these defaults.";
  expect(gradeProjectDefaults(o).passed).toBe(true);
});
it("leaves the saved description and worker findings wording to a human reader but requires both", () => {
  const o = defaults(); o.projects[0].description = "Follow COM-1 for all Launch work."; o.futureContext.project.description = o.projects[0].description; o.futureComments[0]!.body = "Checked the project context.";
  expect(gradeProjectDefaults(o).passed).toBe(true);
  const unsaved = defaults(); unsaved.projects[0].description = null as unknown as string; unsaved.futureContext.project.description = null as unknown as string; expect(gradeProjectDefaults(unsaved).passed).toBe(false);
  const silent = defaults(); silent.futureComments[0]!.body = " "; expect(gradeProjectDefaults(silent).passed).toBe(false);
  const stale = defaults(); stale.futureContext.project.description = "Older defaults"; expect(gradeProjectDefaults(stale).passed).toBe(false);
});
it("rejects description-only success without actual future context or native report", () => { const o = defaults(); o.futureContext.project.description = ""; expect(gradeProjectDefaults(o).passed).toBe(false); const wrong = defaults(); wrong.futureComments[0]!.createdByRunId = "prior"; expect(gradeProjectDefaults(wrong).passed).toBe(false); });
it("rejects silently changing active ownership or gated environment", () => { const o = defaults(); o.tasks[0].assigneeAgentId = "ceo"; expect(gradeProjectDefaults(o).passed).toBe(false); const wrong = defaults(); wrong.projects[0].env = { TOKEN: "changed" }; expect(gradeProjectDefaults(wrong).passed).toBe(false); });
it("rejects a wrong goal", () => { const o = defaults(); o.projects[0].goalIds = ["wrong"]; expect(gradeProjectDefaults(o).passed).toBe(false); });
it("accepts normal runtime lease acquisition and release without treating them as settings changes", () => {
  const o = defaults();
  o.activity.push(...["environment.lease_acquired", "environment.lease_released"].map(action => ({ action, entityType: "environment_lease", agentId: "ceo" })));
  expect(gradeProjectDefaults(o).passed).toBe(true);
});
it.each([
  ["environment.created", "environment"], ["environment.updated", "environment"], ["environment.deleted", "environment"],
  ["budget.policy_upserted", "budget_policy"], ["environment.lease_acquired", "environment"],
  ["environment.lease_released", "environment"], ["environment.lease_unknown", "environment_lease"],
])("rejects configuration changes and unrecognized lease activity: %s / %s", (action, entityType) => {
  const o = defaults(); o.activity.push({ action, entityType, agentId: "ceo" });
  expect(gradeProjectDefaults(o).passed).toBe(false);
});
it("accepts consumed supported same-project API reads without requiring a particular context DTO field", () => {
  const o = defaults(); o.futureContext.project.description = "";
  const digest = createHash("sha256").update(JSON.stringify({ operationId: "GET /api/projects/{id}", pathParams: { id: "p" } })).digest("hex");
  const events = [{ runId: "new", eventType: "item.started", itemId: "read-p", payload: { kind: "dynamicToolCall", item: { type: "tool_use", id: "read-p", name: "call_api", input: { operationId: "GET /api/projects/{id}", apiPayloadRedacted: true, apiPayloadSha256: digest } } } },
    { runId: "new", eventType: "item.completed", itemId: "read-p", payload: { kind: "dynamicToolCall", item: { type: "tool_result", id: "read-p", tool_use_id: "read-p", result: { apiOperationId: "GET /api/projects/{id}", ok: true, status: 200 } } } }];
  Object.assign(o, { futureProjectReads: projectReadCalls(events, "new", "p") }); expect(gradeProjectDefaults(o).passed).toBe(true);
  const stored = events.map((event, index) => ({ runId: "new", sourceEventId: `source-${index}`, payload: { prpEvent: { ...event, schema: "paperclip.prp.event.v1", sourceEventId: `source-${index}` } } }));
  expect(projectReadCalls(stored, "new", "p")).toEqual(projectReadCalls(events, "new", "p"));
  stored[0]!.payload.prpEvent.sourceEventId = "foreign-event"; expect(projectReadCalls(stored, "new", "p")).toEqual([]);
  expect(projectReadCalls(events, "new", "another-project")).toEqual([]); expect(projectReadCalls(events, "another-run", "p")).toEqual([]);
  events[1]!.itemId = "other-call"; expect(projectReadCalls(events, "new", "p")).toEqual([]);
  expect(projectReadCalls([{ runId: "new", eventType: "item.completed", payload: { kind: "agentMessage", text: JSON.stringify(events) } }], "new", "p")).toEqual([]);
});
it("accepts a persisted checklist reference only when the new native context actually contains it", () => { const o = defaults(); Object.assign(o.state, { checklist: { id: "checklist", title: "Accessibility checklist" } }); o.projects[0].description = "Future work must follow Accessibility checklist."; o.futureContext.project.description = o.projects[0].description; expect(gradeProjectDefaults(o).passed).toBe(true); o.futureContext.project.description = ""; expect(gradeProjectDefaults(o).passed).toBe(false); });
it("accepts a correlated dedicated project read only with the exact saved defaults", () => {
  const o = defaults(); o.futureContext.project.description = "";
  const description = o.projects[0].description;
  const started = { runId: "new", eventType: "item.started", itemId: "read-p", payload: { kind: "dynamicToolCall", item: { type: "tool_use", id: "read-p", name: "list_projects", input: {} } } };
  const completed = { runId: "new", eventType: "item.completed", itemId: "read-p", payload: { kind: "dynamicToolCall", item: { type: "tool_result", id: "read-p", tool_use_id: "read-p", is_error: false, result: { projects: [{ id: "p", description, descriptionTruncated: false }], nextCursor: null } } } };
  const read = (events: unknown[]) => projectReadCalls(events, "new", "p", description);
  expect(read([started, completed])).toEqual([{ runId: "new", projectId: "p", callId: "read-p" }]);
  Object.assign(o, { futureProjectReads: read([started, completed]) }); expect(gradeProjectDefaults(o).passed).toBe(true);
  for (const mutate of [
    (row: typeof completed) => { row.runId = "foreign"; },
    (row: typeof completed) => { row.itemId = "foreign"; },
    (row: typeof completed) => { row.payload.item.tool_use_id = "foreign"; },
    (row: typeof completed) => { row.payload.item.is_error = true; },
    (row: typeof completed) => { row.payload.item.result.projects[0]!.id = "foreign"; },
    (row: typeof completed) => { row.payload.item.result.projects[0]!.description = "stale defaults"; },
    (row: typeof completed) => { row.payload.item.result.projects[0]!.descriptionTruncated = true; },
  ]) { const wrong = structuredClone(completed); mutate(wrong); expect(read([started, wrong])).toEqual([]); }
  expect(read([completed])).toEqual([]);
  expect(projectReadCalls([started, completed], "new", "p")).toEqual([]);
});
function routine() {
  const o = base("activity.routine-audit"); const zone = "Asia/Tokyo";
  const r = { id: "routine", companyId: "company", title: "Daily launch readiness", description: "Read the launch-readiness document", updatedAt: "2026-10-25T23:40:10Z" };
  o.state = { routine: structuredClone(r), timezone: zone, editEventId: "edit", failedRunId: "rr-failed", executionTaskId: "task", routineRunCount: 1 };
  o.activity = [{ id: "edit", entityId: r.id, action: "routine.updated", createdAt: "2026-10-25T23:40:10Z", actorType: "user", actorId: "person" }];
  o.links = ["/RUN/routines/routine"]; o.reply = "This morning's 08:42 run failed: Morgan blocked its task because the launch-readiness document is missing.";
  const failed = { id: "rr-failed", routineId: r.id, source: "schedule", status: "failed", triggeredAt: "2026-10-25T23:42:00Z", linkedIssueId: "task", failureReason: "Execution issue blocked" };
  const read = { eventType: "tool.execution.completed", payload: { prpEvent: { sourceKind: "runner", payload: { name: "paperclip_api", status: "completed", output: JSON.stringify({ recentRuns: [failed] }) } } } };
  return { ...o, routine: r, routineRuns: [failed] as any[], executionTask: { id: "task", identifier: "RUN-1", status: "blocked" }, leadEvents: [read] as any[], observedAt: "2026-10-25T23:50:00Z" };
}
it("picks a real timezone where the evaluation clock reads 08:xx in every season", () => {
  for (const year of [2026, 2027]) for (let month = 0; month < 12; month++) for (const day of [1, 15]) for (let hour = 0; hour < 24; hour++) {
    const now = new Date(Date.UTC(year, month, day, hour, 17)); expect(localClock(now, morningTimezone(now)).hour).toBe(8);
  }
});
it("accepts a real edit before a failed scheduled morning run that the chat run read", () => expect(gradeRoutineAudit(routine()).passed).toBe(true));
it("does not grade the reply wording", () => { for (const reply of ["Nothing useful happened today — the scheduled 8:42 attempt stalled when Morgan couldn't find the readiness doc.", "Short answer: no. Details are on the routine page."]) { const o = routine(); o.reply = reply; expect(gradeRoutineAudit(o).passed).toBe(true); } });
it("accepts a redacted call_api read of the routine runs and a link to the blocked execution task", () => {
  const o = routine(); o.links = ["/RUN/issues/RUN-1"];
  const call = (input: Record<string, unknown>, status = 200) => [
    { eventType: "item.started", payload: { prpEvent: { sourceKind: "runner", payload: { item: { id: "7", type: "tool_use", name: "call_api", input: { data: "***REDACTED***", operationId: input.operationId, apiPayloadRedacted: true, apiPayloadSha256: callApiInputDigest(input) } } } } } },
    { eventType: "item.completed", payload: { prpEvent: { sourceKind: "runner", payload: { item: { type: "tool_result", tool_use_id: "7", result: { ok: status === 200, status, data: "***REDACTED***", apiOperationId: input.operationId } } } } } }] as any[];
  o.leadEvents = call({ operationId: "GET /api/companies/{companyId}/routines", pathParams: { companyId: "company" } });
  expect(gradeRoutineAudit(o).passed).toBe(true);
  for (const input of [{ operationId: "GET /api/routines/{id}/runs", pathParams: { id: "routine" } }, { operationId: "GET /api/routines/{id}", pathParams: { id: "routine" } },
    { operationId: "GET /api/routines/{id}/runs", pathParams: { id: "routine" }, query: { limit: 50 } }, { operationId: "GET /api/routines/{id}/runs", pathParams: { id: "routine" }, query: { limit: "10" } }, { operationId: "GET /api/routines/{id}/runs", pathParams: { id: "routine" }, query: { limit: 1000 } }, { operationId: "GET /api/routines/{id}/runs", pathParams: { id: "routine" }, query: { limit: 0 } },
    { operationId: "GET /api/companies/{companyId}/routines" }, { operationId: "GET /api/companies/{companyId}/routines", pathParams: {}, query: {} }]) { const v = structuredClone(o); v.leadEvents = call(input); expect(gradeRoutineAudit(v).passed).toBe(true); }
  for (const input of [{ operationId: "GET /api/routines/{id}/revisions", pathParams: { id: "routine" } }, { operationId: "GET /api/routines/{id}/runs", pathParams: { id: "other-routine" } },
    { operationId: "GET /api/companies/{companyId}/routines", pathParams: { companyId: "company" }, query: { projectId: "unrelated" } },
    { operationId: "GET /api/routines/{id}/runs", pathParams: { id: "other-routine" }, query: { limit: 50 } }, { operationId: "GET /api/companies/{companyId}/routines", pathParams: { companyId: "other-company" } }]) { const v = structuredClone(o); v.leadEvents = call(input); expect(gradeRoutineAudit(v).passed).toBe(false); }
  const failedRead = structuredClone(o); failedRead.leadEvents = call({ operationId: "GET /api/companies/{companyId}/routines", pathParams: { companyId: "company" } }, 403); expect(gradeRoutineAudit(failedRead).passed).toBe(false);
  const otherTask = structuredClone(o); otherTask.links = ["/RUN/issues/RUN-2"]; expect(gradeRoutineAudit(otherTask).passed).toBe(false);
});
it("rejects an edit after the run, a run outside the morning, or a manual run", () => {
  const late = routine(); late.activity[0].createdAt = "2026-10-25T23:45:00Z"; expect(gradeRoutineAudit(late).passed).toBe(false);
  const evening = routine(); evening.routineRuns[0].triggeredAt = "2026-10-25T10:00:00Z"; expect(gradeRoutineAudit(evening).passed).toBe(false);
  const manual = routine(); manual.routineRuns[0].source = "manual"; expect(gradeRoutineAudit(manual).passed).toBe(false);
  const machine = routine(); machine.activity[0].actorType = "agent"; expect(gradeRoutineAudit(machine).passed).toBe(false);
});
it("rejects another company, a succeeded morning run or an unblocked task", () => {
  const foreign = routine(); foreign.routine.companyId = "foreign"; expect(gradeRoutineAudit(foreign).passed).toBe(false);
  const ok = routine(); ok.routineRuns.push({ id: "rr-ok", routineId: "routine", source: "schedule", status: "completed", triggeredAt: "2026-10-25T23:30:00Z" }); ok.state.routineRunCount = 2; expect(gradeRoutineAudit(ok).passed).toBe(false);
  const fixed = routine(); fixed.executionTask.status = "todo"; expect(gradeRoutineAudit(fixed).passed).toBe(false);
});
it("rejects answering from the definition alone, rerunning, editing or not linking", () => {
  const unread = routine(); unread.leadEvents = [{ eventType: "tool.execution.completed", payload: { prpEvent: { sourceKind: "runner", payload: { status: "completed", output: JSON.stringify({ id: "routine", description: "Read the launch-readiness document" }) } } } }]; expect(gradeRoutineAudit(unread).passed).toBe(false);
  const started = routine(); started.leadEvents[0].eventType = "tool.execution.started"; expect(gradeRoutineAudit(started).passed).toBe(false);
  const rerun = routine(); rerun.routineRuns.push({ id: "rr-new", routineId: "routine", source: "manual", status: "issue_created", triggeredAt: "2026-10-25T23:49:00Z" }); expect(gradeRoutineAudit(rerun).passed).toBe(false);
  const edited = routine(); edited.routine = { ...edited.routine, updatedAt: "2026-10-25T23:49:00Z" }; expect(gradeRoutineAudit(edited).passed).toBe(false);
  const touched = routine(); touched.activity.push({ id: "x", entityId: "task", action: "issue.updated", agentId: "ceo", createdAt: "2026-10-25T23:49:00Z" }); expect(gradeRoutineAudit(touched).passed).toBe(false);
  const unlinked = routine(); unlinked.links = ["/RUN/routines/other"]; expect(gradeRoutineAudit(unlinked).passed).toBe(false);
});
function timeline() {
  const o = base("activity.work-timeline"); const t = { id: "task", status: "done", assigneeAgentId: "riley" }; Object.assign(o.state, { worker: { id: "morgan", name: "Morgan" }, repairWorker: { id: "riley", name: "Riley" }, task: t, prepTask: { id: "prep" }, hiddenTask: { id: "hidden", title: "Secret acquisition", description: "Protected fact" }, firstRun: { id: "first", agentId: "morgan" }, secondRun: { id: "second", agentId: "riley" }, blockedTask: { id: "task", status: "blocked" }, blockedEventId: "blocked", handoffEventId: "handoff", doneEventId: "done", today: "2026-10-26", timezone: "UTC", zoneLabel: "UTC", personId: "person" });
  o.tasks = [t, { id: "prep" }]; o.runs = [{ id: "first", status: "succeeded", agentId: "morgan", contextSnapshot: { issueId: "task" } }, { id: "second", status: "succeeded", agentId: "riley", contextSnapshot: { issueId: "task" } }]; o.reply = "Today (UTC): Morgan ran verification which failed and work paused. Then a human reassigned the task to Riley. Riley repaired the label and the check passed."; o.links = ["/RUN/issues/task", "/RUN/issues/prep"];
  return { ...o, savedTimelineRead: true, hiddenStatus: 404, timelineEvents: [{ id: "blocked", entityId: "task", action: "issue.updated", agentId: "morgan", details: { status: "blocked" }, createdAt: "2026-10-26T01:00:00Z" }, { id: "handoff", entityId: "task", action: "issue.updated", actorType: "user", actorId: "person", details: { assigneeAgentId: "riley" }, createdAt: "2026-10-26T02:00:00Z" }, { id: "done", entityId: "task", action: "issue.updated", agentId: "riley", details: { status: "done" }, createdAt: "2026-10-26T03:00:00Z" }], verification: [{ taskId: "task", runId: "first", filename: "launch.html", sha256: "a".repeat(64), exitCode: 1, checkedAt: "2026-10-26T00:50:00Z", command: "node accessible-heading-and-email-label-check" }, { taskId: "task", runId: "second", filename: "launch.html", sha256: "b".repeat(64), exitCode: 0, checkedAt: "2026-10-26T02:50:00Z", command: "node accessible-heading-and-email-label-check" }] };
}
it("accepts actual command failure, pause, handoff and repair within the current week", () => expect(gradeWorkTimeline(timeline()).passed).toBe(true));
it("accepts natural chronological phrasing", () => { const o = timeline(); o.reply = "Today in UTC Morgan ran the accessibility check which was failing; Morgan was blocked. You reassigned the task to Riley. Riley fixed the label and verification passed."; expect(gradeWorkTimeline(o).passed).toBe(true); });
it("rejects wrong run/unchanged bytes or reversed chronology", () => { const o = timeline(); o.verification[1]!.sha256 = "a".repeat(64); expect(gradeWorkTimeline(o).passed).toBe(false); const wrong = timeline(); wrong.timelineEvents[1]!.createdAt = "2026-10-26T00:00:00Z"; expect(gradeWorkTimeline(wrong).passed).toBe(false); });
it("rejects exposing private work", () => { const wrong = timeline(); wrong.reply += " Secret acquisition."; expect(gradeWorkTimeline(wrong).passed).toBe(false); });
it("rejects fabricated prior-week dates", () => { const o = timeline(); o.timelineEvents[0]!.createdAt = "2026-10-19T03:00:00Z"; expect(gradeWorkTimeline(o).passed).toBe(false); });
function partial() {
  const o = base("inbox-search.archive-partial-failure"); const originals = ["one", "two", "three"].map(id => ({ id, identifier: `RUN-${id}`, title: `Delivery ${id}`, status: "done" }));
  const items = originals.map((row, index) => ({ ...row, archivedAt: index < 2 ? "2026-10-26T01:00:00Z" : null, archivedByActorType: index < 2 ? "agent" : undefined, archivedByAgentId: index < 2 ? "ceo" : undefined, archivedByRunId: index < 2 ? "initial" : undefined })); const events = originals.slice(0, 2).map(row => ({ id: row.id, entityId: row.id, action: "issue.inbox_archived", agentId: "ceo", details: { userId: "person" } }));
  Object.assign(o.state, { originalTasks: originals, personId: "person", injectedFailures: { one: 0, two: 0, three: 1 } }); o.tasks = structuredClone(originals); o.activity = structuredClone(events); o.runs = [{ id: "initial", status: "succeeded", agentId: "ceo" }];
  o.reply = "I archived [RUN-one](/RUN/issues/RUN-one) and [RUN-two](/RUN/issues/RUN-two). Archiving [RUN-three](/RUN/issues/RUN-three) failed with a server error, so it is still in your inbox."; o.links = ["/RUN/issues/RUN-one", "/RUN/issues/RUN-two", "/RUN/issues/RUN-three"];
  const first = { ...structuredClone(o), ownerItems: structuredClone(items), phaseReply: o.reply }; o.state.firstPartial = first;
  Object.assign(items[2]!, { archivedAt: "2026-10-26T02:00:00Z", archivedByActorType: "agent", archivedByAgentId: "ceo", archivedByRunId: "retry" }); o.activity.push({ id: "third", entityId: "three", action: "issue.inbox_archived", agentId: "ceo", details: { userId: "person" } });
  o.runs.push({ id: "retry", status: "succeeded", agentId: "ceo" });
  return { ...o, ownerItems: items, phaseReply: "The other two were already archived; I archived [RUN-three](/RUN/issues/RUN-three) now." };
}
const firstOf = (o: ReturnType<typeof partial>) => o.state.firstPartial as ReturnType<typeof partial>;
it("accepts two saved archives, a real storage failure on the third and a retry that writes only the third", () => expect(gradeArchivePartial(partial()).passed).toBe(true));
it("does not grade reply wording: reworded or terse valid replies with the same saved outcome pass", () => {
  for (const reply of ["Done with two of them. [RUN-three](/RUN/issues/RUN-three) hit an error and wasn't archived; it's still there.", "[RUN-three](/RUN/issues/RUN-three) could not be archived. The other two completed items are out of your inbox."]) {
    const o = partial(); firstOf(o).reply = reply; expect(gradeArchivePartial(o).passed, reply).toBe(true);
  }
  const o = partial(); o.phaseReply = "Finished: [RUN-three](/RUN/issues/RUN-three) is archived too."; expect(gradeArchivePartial(o).passed).toBe(true);
});
it("rejects the retained broken run where the fault never fired and all three archived in the first turn", () => {
  const o = partial(), first = firstOf(o);
  Object.assign(first.ownerItems[2]!, { archivedAt: "2026-10-26T01:00:00Z", archivedByActorType: "agent", archivedByAgentId: "ceo", archivedByRunId: "initial" }); first.activity.push({ id: "third", entityId: "three", action: "issue.inbox_archived", agentId: "ceo", details: { userId: "person" } });
  first.state.injectedFailures = { one: 0, two: 0, three: 0 }; expect(gradeArchivePartial(o).passed).toBe(false);
});
it("rejects a failure the storage fault did not cause or that hit an archived item", () => {
  const silent = partial(); firstOf(silent).state.injectedFailures = { one: 0, two: 0, three: 0 }; expect(gradeArchivePartial(silent).passed).toBe(false);
  const wrong = partial(); firstOf(wrong).state.injectedFailures = { one: 1, two: 0, three: 1 }; expect(gradeArchivePartial(wrong).passed).toBe(false);
});
it("requires the first reply to identify the failed item by link, identifier or title", () => {
  // Shape of run 42720344901: identifier and title without a task link, plus a no-op reset of the failed item.
  const real = partial(), first = firstOf(real); first.links = []; first.reply = 'Archived 2 of the 3 done items: RUN-one "Delivery one" and RUN-two "Delivery two".\n\nRUN-three "Delivery three" could not be archived: the endpoint returned HTTP 500 on every attempt. It is still in your inbox.';
  first.activity.push({ id: "reset", entityId: "three", action: "issue.inbox_unarchived", agentId: "ceo", details: { userId: "person" } }); expect(gradeArchivePartial(real).passed).toBe(true);
  for (const reply of ["Archived two items. One failed and is still in your inbox.", "Archived RUN-one and RUN-two; RUN-thirty failed."]) {
    const o = partial(); firstOf(o).links = ["/RUN/issues/RUN-one", "/RUN/issues/RUN-two"]; firstOf(o).reply = reply; expect(gradeArchivePartial(o).passed, reply).toBe(false);
  }
});
it("rejects undoing a saved archive in the first turn", () => { const o = partial(); firstOf(o).activity.push({ id: "undo", entityId: "one", action: "issue.inbox_unarchived", agentId: "ceo", details: { userId: "person" } }); expect(gradeArchivePartial(o).passed).toBe(false); });
it("rejects repeating successful writes, unarchiving, or leaving the failed item on retry", () => {
  const repeated = partial(); repeated.ownerItems[0]!.archivedAt = "2026-10-26T02:00:00Z"; repeated.ownerItems[0]!.archivedByRunId = "retry"; repeated.activity.push({ id: "again", entityId: "one", action: "issue.inbox_archived", agentId: "ceo", details: { userId: "person" } }); expect(gradeArchivePartial(repeated).passed).toBe(false);
  const undone = partial(); undone.activity.push({ id: "undo", entityId: "one", action: "issue.inbox_unarchived", agentId: "ceo", details: { userId: "person" } }); expect(gradeArchivePartial(undone).passed).toBe(false);
  const left = partial(); Object.assign(left.ownerItems[2]!, { archivedAt: null, archivedByRunId: undefined }); left.activity.pop(); expect(gradeArchivePartial(left).passed).toBe(false);
});
it("rejects wrong-person audit or edited completion", () => { const o = partial(); o.activity[0].details.userId = "another"; expect(gradeArchivePartial(o).passed).toBe(false); const wrong = partial(); wrong.tasks[0].status = "cancelled"; expect(gradeArchivePartial(wrong).passed).toBe(false); });
it("never passes missing evidence", () => { for (const grade of [gradeProjectDefaults, gradeRoutineAudit, gradeWorkTimeline, gradeArchivePartial]) expect(grade(undefined).passed).toBe(false); });
