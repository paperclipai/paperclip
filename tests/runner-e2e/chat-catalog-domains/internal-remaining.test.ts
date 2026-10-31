import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gradeProjectDefaults, gradeProjectDefaultsSetup, projectReadCalls } from "./internal-project-defaults.js";
import { gradeRoutineAudit, routineHistoricalContext } from "./internal-routine-audit.js";
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
it("rejects description-only success without actual future context or native report", () => { const o = defaults(); o.futureContext.project.description = ""; expect(gradeProjectDefaults(o).passed).toBe(false); const wrong = defaults(); wrong.futureComments[0]!.createdByRunId = "prior"; expect(gradeProjectDefaults(wrong).passed).toBe(false); });
it("rejects silently changing active ownership or gated environment", () => { const o = defaults(); o.tasks[0].assigneeAgentId = "ceo"; expect(gradeProjectDefaults(o).passed).toBe(false); const wrong = defaults(); wrong.projects[0].env = { TOKEN: "changed" }; expect(gradeProjectDefaults(wrong).passed).toBe(false); });
it("rejects wrong goal and an unacknowledged future/active distinction", () => { const o = defaults(); o.projects[0].goalIds = ["wrong"]; expect(gradeProjectDefaults(o).passed).toBe(false); const wrong = defaults(); wrong.state.defaultsReply = "All work updated."; expect(gradeProjectDefaults(wrong).passed).toBe(false); });
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
function routine() { const o = base("activity.routine-audit"); const r = { id: "routine", companyId: "company", title: "Daily launch", description: "Launch audit", updatedAt: "2026-10-25T14:00:00Z" }; o.state.routine = structuredClone(r); o.activity = [{ id: "edit", entityId: r.id, action: "routine.updated", createdAt: r.updatedAt, actorType: "user" }]; o.links = ["/RUN/routines/routine"]; o.reply = "The definition was edited yesterday; there is no successful execution this morning and no resulting work. The enabled schedule alone is not proof of a run."; return { ...o, routine: r, routineRuns: [] as any[], routineRevisions: [{ id: "rev" }], now: "2026-10-26T15:00:00Z", timezone: "UTC" }; }
it("accepts real prior-day definition history with absent morning execution", () => expect(gradeRoutineAudit(routine()).passed).toBe(true));
it("accepts a natural evidence-grounded missing-run explanation", () => { const o = routine(); o.reply = "Yesterday's schedule edit is saved, but I found no completed task or successful execution this morning."; expect(gradeRoutineAudit(o).passed).toBe(true); });
it("rejects creating today's routine and relabeling it yesterday", () => { const o = routine(); o.activity[0].createdAt = "2026-10-26T01:00:00Z"; expect(gradeRoutineAudit(o).passed).toBe(false); expect(routineHistoricalContext(o.routine, o.activity, [], o.now, "UTC")).toBe(false); });
it("rejects another company or a real successful morning run", () => { const o = routine(); o.routine.companyId = "foreign"; expect(gradeRoutineAudit(o).passed).toBe(false); const wrong = routine(); wrong.routineRuns = [{ id: "morning", status: "succeeded", triggeredAt: "2026-10-26T08:00:00Z" }]; expect(gradeRoutineAudit(wrong).passed).toBe(false); });
it("rejects treating an edit as execution or losing a produced task", () => { const o = routine(); o.reply = "The enabled routine successfully ran."; expect(gradeRoutineAudit(o).passed).toBe(false); const wrong = routine(); wrong.routineRuns = [{ id: "failed", status: "failed", createdAt: "2026-10-26T08:00:00Z", linkedIssueId: "missing" }]; expect(gradeRoutineAudit(wrong).passed).toBe(false); });
function timeline() {
  const o = base("activity.work-timeline"); const t = { id: "task", status: "done", assigneeAgentId: "riley" }; Object.assign(o.state, { task: t, prepTask: { id: "prep" }, hiddenTask: { id: "hidden", title: "Secret acquisition", description: "Protected fact" }, firstRun: { id: "first", agentId: "morgan" }, secondRun: { id: "second", agentId: "riley" }, blockedTask: { id: "task", status: "blocked" }, blockedEventId: "blocked", handoffEventId: "handoff", doneEventId: "done", today: "2026-10-26", timezone: "UTC", zoneLabel: "UTC", personId: "person" });
  o.tasks = [t, { id: "prep" }]; o.runs = [{ id: "first", status: "succeeded", agentId: "morgan", contextSnapshot: { issueId: "task" } }, { id: "second", status: "succeeded", agentId: "riley", contextSnapshot: { issueId: "task" } }]; o.reply = "Today (UTC): verification failed and work paused. Then the handoff went to Riley. The label was repaired and the check passed."; o.links = ["/RUN/issues/task", "/RUN/issues/prep"];
  return { ...o, hiddenStatus: 404, timelineEvents: [{ id: "blocked", entityId: "task", action: "issue.updated", agentId: "morgan", details: { status: "blocked" }, createdAt: "2026-10-26T01:00:00Z" }, { id: "handoff", entityId: "task", action: "issue.updated", actorType: "user", actorId: "person", details: { assigneeAgentId: "riley" }, createdAt: "2026-10-26T02:00:00Z" }, { id: "done", entityId: "task", action: "issue.updated", agentId: "riley", details: { status: "done" }, createdAt: "2026-10-26T03:00:00Z" }], verification: [{ taskId: "task", runId: "first", filename: "launch.html", sha256: "before", exitCode: 1, checkedAt: "2026-10-26T00:50:00Z", command: "node check" }, { taskId: "task", runId: "second", filename: "launch.html", sha256: "after", exitCode: 0, checkedAt: "2026-10-26T02:50:00Z", command: "node check" }] };
}
it("accepts actual command failure, pause, handoff and repair within the current week", () => expect(gradeWorkTimeline(timeline()).passed).toBe(true));
it("accepts natural chronological phrasing", () => { const o = timeline(); o.reply = "Today in UTC the accessibility check was failing; Morgan was blocked. After reassignment Riley fixed the label and verification passed."; expect(gradeWorkTimeline(o).passed).toBe(true); });
it("rejects wrong run/unchanged bytes or reversed chronology", () => { const o = timeline(); o.verification[1]!.sha256 = "before"; expect(gradeWorkTimeline(o).passed).toBe(false); const wrong = timeline(); wrong.timelineEvents[1]!.createdAt = "2026-10-26T00:00:00Z"; expect(gradeWorkTimeline(wrong).passed).toBe(false); });
it("rejects conflating command failure with native failure or exposing private work", () => { const o = timeline(); o.reply += " The native run failed."; expect(gradeWorkTimeline(o).passed).toBe(false); const wrong = timeline(); wrong.reply += " Secret acquisition."; expect(gradeWorkTimeline(wrong).passed).toBe(false); });
it("rejects fabricated prior-week dates or wrong timezone", () => { const o = timeline(); o.timelineEvents[0]!.createdAt = "2026-10-19T03:00:00Z"; expect(gradeWorkTimeline(o).passed).toBe(false); const wrong = timeline(); wrong.reply = wrong.reply.replace("UTC", "Pacific"); expect(gradeWorkTimeline(wrong).passed).toBe(false); });
function partial() {
  const o = base("inbox-search.archive-partial-failure"); const originals = ["one", "two", "three"].map(id => ({ id, title: `Delivery ${id}`, status: "done" })); const transport = originals.map((row, index) => ({ requestId: row.id, sequence: index + 1, taskId: row.id, phase: "initial" as "initial" | "retry", requestSha256: "sha", runId: "initial", forwarded: index < 2, status: index < 2 ? 200 : undefined, completedAt: "2026-10-26T01:00:00Z" }));
  const items = originals.map((row, index) => ({ ...row, archivedAt: index < 2 ? "2026-10-26T01:00:00Z" : null, archivedByActorType: "agent", archivedByAgentId: "ceo", archivedByRunId: "initial" })); const events = originals.slice(0, 2).map(row => ({ id: row.id, entityId: row.id, action: "issue.inbox_archived", agentId: "ceo", details: { userId: "person" } }));
  Object.assign(o.state, { originalTasks: originals, personId: "person" }); o.tasks = structuredClone(originals); o.activity = structuredClone(events); o.runs = [{ id: "initial", status: "succeeded", agentId: "ceo" }]; o.reply = "Archived two items; Delivery three failed and remains in your inbox.";
  const first = { ...structuredClone(o), ownerItems: structuredClone(items), transport: structuredClone(transport), phaseReply: o.reply }; o.state.firstPartial = first;
  items[2]!.archivedAt = "2026-10-26T02:00:00Z"; items[2]!.archivedByRunId = "retry"; o.activity.push({ id: "third", entityId: "three", action: "issue.inbox_archived", agentId: "ceo", details: { userId: "person" } });
  transport.push({ ...transport[2]!, requestId: "retry", sequence: 4, phase: "retry", runId: "retry", forwarded: true, status: 200 }); o.runs.push({ id: "retry", status: "succeeded", agentId: "ceo" });
  return { ...o, ownerItems: items, transport, phaseReply: "The two previous items were already archived; I archived the remaining item now." };
}
it("accepts two actual archives, a real pre-admission drop and one reconciled retry", () => expect(gradeArchivePartial(partial()).passed).toBe(true));
it("accepts natural partial failure wording", () => { const o = partial(); (o.state.firstPartial as any).reply = "Two confirmed archives. Delivery three could not be archived; it remains outstanding."; expect(gradeArchivePartial(o).passed).toBe(true); });
it("rejects a forwarded fake failure or a drop before both successes", () => { const o = partial(); (o.state.firstPartial as any).transport[2].forwarded = true; expect(gradeArchivePartial(o).passed).toBe(false); const wrong = partial(); (wrong.state.firstPartial as any).transport[2].sequence = 1; expect(gradeArchivePartial(wrong).passed).toBe(false); });
it("rejects clearing all items in the first reply or repeating successful writes on retry", () => { const o = partial(); (o.state.firstPartial as any).reply += " Your inbox is clear."; expect(gradeArchivePartial(o).passed).toBe(false); const wrong = partial(); wrong.transport.push({ ...wrong.transport[3]!, taskId: "one" }); expect(gradeArchivePartial(wrong).passed).toBe(false); });
it("rejects wrong-person audit, edited completion, or refreshed first archive timestamps", () => { const o = partial(); o.activity[0].details.userId = "another"; expect(gradeArchivePartial(o).passed).toBe(false); const wrong = partial(); wrong.tasks[0].status = "cancelled"; expect(gradeArchivePartial(wrong).passed).toBe(false); const repeated = partial(); repeated.ownerItems[0]!.archivedAt = "2026-10-26T02:00:00Z"; expect(gradeArchivePartial(repeated).passed).toBe(false); });
it("never passes missing evidence", () => { for (const grade of [gradeProjectDefaults, gradeRoutineAudit, gradeWorkTimeline, gradeArchivePartial]) expect(grade(undefined).passed).toBe(false); });

it("rejects reversed or contradictory partial counts even when the failed item is named", () => {
  for (const reply of ["One archived; two failed, including Delivery three.", "Two archived, but only one was archived; Delivery three failed.", "Two archived; I could not archive two items, including Delivery three."]) {
    const o = partial(); (o.state.firstPartial as any).reply = reply; expect(gradeArchivePartial(o).passed, reply).toBe(false);
  }
});
it("accepts grounded natural two-success wording and locally negated inbox-clear claims", () => {
  for (const reply of ["Two are archived; Delivery three failed, so I cannot say the inbox is clear.", "Archived Delivery one and Delivery two. Delivery three failed and remains outstanding.", "Two of the three tasks were successfully archived; Delivery three could not be archived.", "Two archive calls succeeded; Delivery three failed. Not all three tasks were archived."]) {
    const o = partial(); (o.state.firstPartial as any).reply = reply; expect(gradeArchivePartial(o).passed, reply).toBe(true);
  }
  const o = partial(), first = o.state.firstPartial as any;
  for (const row of [o.state.originalTasks, o.tasks, first.state.originalTasks, first.tasks]) (row as any[])[2].title = "Delivered launch checklist";
  first.reply = "Two are archived; the checklist failed, so I cannot say the inbox is clear.";
  expect(gradeArchivePartial(o).passed).toBe(true);
});
it("rejects invented additional retry counts while accepting truthful total-three states", () => {
  for (const reply of ["I archived two more items on retry.", "Three additional items were archived now.", "I newly archived all three items now.", "I archived three remaining items now.", "I archived two items in total; the remaining task is archived now."]) {
    const o = partial(); o.phaseReply = reply; expect(gradeArchivePartial(o).passed, reply).toBe(false);
  }
  for (const reply of ["The remaining item is now archived. All three are now archived.", "Three tasks are archived in total; the previously failed item was archived on retry.", "I archived one remaining item; two were already archived.", "I archived all three in total; the retry added only the remaining one."]) {
    const o = partial(); o.phaseReply = reply; expect(gradeArchivePartial(o).passed, reply).toBe(true);
  }
});
