import { expect } from "@playwright/test";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { collectRunEvents } from "../run-observations.js";
import { fixtureWorker, makeDefinition } from "./internal-definition.js";
import { checks, companyPath, entity, hasLink, internalResultLink, observation, observeInternal, project, verifyInternalResult, type Entity, type InternalObservation } from "./internal-support.js";

interface RoutineRun extends Entity { routineId?: string; source?: string; triggeredAt?: string; completedAt?: string | null; linkedIssueId?: string | null; failureReason?: string | null }
interface RunEvent { seq?: number; eventType?: string; payload?: Record<string, unknown> | null }
interface RoutineAudit extends InternalObservation { routine: Entity; routineRuns: RoutineRun[]; executionTask?: Entity; leadEvents: RunEvent[]; observedAt: string }

export function localDay(instant: string, timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant)); }
export function localClock(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  return { hour: Number(parts.find(part => part.type === "hour")!.value), minute: Number(parts.find(part => part.type === "minute")!.value) };
}
/**
 * Real places spanning every whole-hour UTC offset. The person is placed where
 * the evaluation's real clock reads 08:xx, so "this morning" is literally true
 * for their browser and for the routine's own schedule timezone; no history is
 * backdated.
 */
export const MORNING_CANDIDATE_TIMEZONES = ["Pacific/Pago_Pago", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago",
  "America/New_York", "America/Halifax", "America/Sao_Paulo", "Atlantic/South_Georgia", "Atlantic/Cape_Verde", "Atlantic/Reykjavik", "Europe/London", "Europe/Paris",
  "Europe/Athens", "Europe/Moscow", "Asia/Dubai", "Asia/Karachi", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Australia/Brisbane", "Pacific/Noumea",
  "Pacific/Fiji", "Pacific/Tongatapu", "Pacific/Kiritimati"] as const;
export function morningTimezone(now: Date) {
  const zone = MORNING_CANDIDATE_TIMEZONES.find(candidate => localClock(now, candidate).hour === 8);
  if (!zone) throw new Error("No candidate timezone currently reads 08:xx");
  return zone;
}
function morning(instant: string | undefined, timezone: string, observedAt: string) {
  return !!instant && localDay(instant, timezone) === localDay(observedAt, timezone) && localClock(new Date(instant), timezone).hour < 12;
}
/** Product reads whose response carries the routine's run records (status and failure reason). */
export const ROUTINE_EXECUTION_OPERATIONS = ["GET /api/routines/{id}/runs", "GET /api/routines/{id}", "GET /api/companies/{companyId}/routines"] as const;
function prp(row: RunEvent) {
  const envelope = (row.payload?.prpEvent ?? {}) as Record<string, unknown>;
  return { envelope, payload: (envelope.payload ?? {}) as Record<string, unknown> };
}
/**
 * The chat run read the failed scheduled invocation through the product: a
 * successful read of the routine's run records (routine runs, routine detail
 * recent runs, or the routine list's last run), recorded by operation id
 * because call_api redacts payloads, or a tool output carrying the failed
 * routine-run id. The agent's own wording is never matched.
 */
export function readFailedExecution(events: readonly RunEvent[], failedRunId: string) {
  return !!failedRunId && events.some(row => {
    const { envelope, payload } = prp(row);
    const item = (payload.item ?? {}) as Record<string, unknown>; const result = (item.result ?? {}) as Record<string, unknown>;
    if (item.type === "tool_result" && result.ok === true && result.status === 200
      && (ROUTINE_EXECUTION_OPERATIONS as readonly unknown[]).includes(result.apiOperationId)) return true;
    return row.eventType === "tool.execution.completed" && envelope.sourceKind === "runner" && payload.status === "completed"
      && typeof payload.output === "string" && payload.output.includes(failedRunId);
  });
}
function routineLinks(o: InternalObservation, routineId: string) {
  return o.links.filter(href => { try { const u = new URL(href, o.origin); return u.origin === new URL(o.origin).origin && u.pathname.split("/").includes(routineId) && u.pathname.includes("/routines/"); } catch { return false; } });
}
export function gradeRoutineAudit(value: unknown) {
  const c = checks(); const o = observation(value) as RoutineAudit | undefined;
  c.add("actual-routine-context", !!o && !!o.routine && Array.isArray(o.routineRuns) && Array.isArray(o.leadEvents) && typeof o.observedAt === "string"
    && typeof o.state.timezone === "string" && typeof o.state.failedRunId === "string", "Saved routine definition, execution history, the chat run's tool events and the person's timezone are required.");
  if (!o || !o.routine || !Array.isArray(o.routineRuns) || !Array.isArray(o.leadEvents) || typeof o.state.timezone !== "string" || typeof o.state.failedRunId !== "string") return c.result();
  const zone = o.state.timezone; const original = entity(o.state, "routine"); const failed = o.routineRuns.find(row => row.id === o.state.failedRunId);
  const edit = o.activity.find(row => row.id === o.state.editEventId);
  c.add("real-edit-then-failed-morning-run", o.routine.companyId === o.companyId && !!failed && failed.routineId === original.id && failed.source === "schedule" && failed.status === "failed"
    && morning(failed.triggeredAt, zone, o.observedAt) && !!failed.linkedIssueId && o.executionTask?.id === failed.linkedIssueId && o.executionTask.status === "blocked"
    && !!edit && edit.entityId === original.id && edit.action === "routine.updated" && edit.actorType === "user" && !!edit.createdAt && Date.parse(edit.createdAt) < Date.parse(failed.triggeredAt!)
    && !o.routineRuns.some(row => (row.status === "completed" || row.status === "succeeded") && morning(row.triggeredAt ?? row.createdAt, zone, o.observedAt)),
  "A person edited the current-company routine before its real scheduled run this morning (person's timezone); that run failed because its execution task was blocked, and no morning run succeeded.");
  c.add("read-only-definition-and-execution", original.updatedAt === o.routine.updatedAt && original.description === o.routine.description
    && o.routineRuns.length === Number(o.state.routineRunCount) && o.executionTask?.status === "blocked"
    && !o.activity.some(row => row.agentId === o.leadId && (row.entityId === original.id || row.entityId === failed?.linkedIssueId)),
  "The audit neither manufactures a run, edits the routine, nor changes the failed execution's task.");
  c.add("read-actual-execution-record", readFailedExecution(o.leadEvents, o.state.failedRunId),
    "The chat run read the routine's run records (runs, detail recent runs or list last run), not only the definition or edit history.");
  c.add("routine-or-execution-linked", routineLinks(o, original.id).length > 0 || (!!o.executionTask && hasLink(o, "issues", o.executionTask)),
    "The answer links the real routine or the failed run's execution task, so the person can inspect the evidence.");
  return c.result();
}
const ORIGINAL_DESCRIPTION = "Post a three-line launch readiness summary as a comment on this task, then mark this task done.";
const EDITED_DESCRIPTION = "Read this task's launch-readiness document and post a three-line launch readiness summary from it as a comment on this task, then mark this task done. "
  + "If this task has no launch-readiness document, do not write or guess a summary and do not create the document: comment that the launch-readiness document is missing and set this task to blocked. Do not create other tasks or change the routine.";
function routineAudit(): ChatCatalogCase {
  const base = makeDefinition("activity.routine-audit", async ctx => {
    const { api, page } = ctx.input;
    const timezone = morningTimezone(new Date());
    // The person's browser lives in the routine's timezone, where it is now morning.
    const cdp = await page.context().newCDPSession(page); await cdp.send("Emulation.setTimezoneOverride", { timezoneId: timezone });
    const browserTimezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (browserTimezone !== timezone) throw new Error(`Browser timezone override did not apply (${browserTimezone})`);
    const p = await project(ctx, "Launch"); const worker = await fixtureWorker(ctx);
    // The harness funds the company and lead before setup; fund the routine's worker the same way so its
    // unpriced setup turn does not budget-pause it before the query.
    await api.post(`${companyPath(ctx)}/budgets/policies`, { scopeType: "agent", scopeId: worker.id, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const routine = await api.post<Entity>(`${companyPath(ctx)}/routines`, { title: "Daily launch readiness", projectId: p.id, assigneeAgentId: worker.id, description: ORIGINAL_DESCRIPTION });
    // A daily schedule in the person's timezone, firing at the next real minute that leaves room for the edit.
    const fireAt = new Date(Date.now() + (new Date().getUTCSeconds() >= 45 ? 180_000 : 120_000)); const fire = localClock(fireAt, timezone);
    if (fire.hour >= 12) throw new Error("Scheduled morning run would fall after noon");
    const trigger = await api.post<Entity & { nextRunAt?: string }>(`/api/routines/${routine.id}/triggers`, { kind: "schedule", cronExpression: `${fire.minute} ${fire.hour} * * *`, timezone, enabled: true });
    await api.patch(`/api/routines/${routine.id}`, { description: EDITED_DESCRIPTION });
    const edit = (await api.get<Entity[]>(`${companyPath(ctx)}/activity?limit=1000`)).find(row => row.entityId === routine.id && row.action === "routine.updated" && row.actorType === "user");
    if (!edit) throw new Error("Real routine edit was not recorded");
    const invocation = await pollUntil({ label: "real scheduled morning routine invocation", deadlineAt: Date.now() + 300_000, intervalMs: 2000,
      load: () => api.get<RoutineRun[]>(`/api/routines/${routine.id}/runs`), accept: rows => rows.some(row => row.source === "schedule" && !!row.linkedIssueId),
      reject: rows => rows.some(row => row.source === "schedule" && row.status === "failed" && !row.linkedIssueId) ? "Scheduled dispatch failed before creating its execution task" : undefined });
    const scheduled = invocation.find(row => row.source === "schedule" && !!row.linkedIssueId)!;
    const outcome = await pollUntil({ label: "worker blocks the edited routine's execution task and the invocation fails", deadlineAt: Date.now() + 240_000, intervalMs: 2000,
      load: async () => ({ runs: await api.get<RoutineRun[]>(`/api/routines/${routine.id}/runs`), task: await api.get<Entity>(`/api/issues/${scheduled.linkedIssueId}`), native: await ctx.allRuns() }),
      accept: v => v.task.status === "blocked" && v.runs.some(row => row.id === scheduled.id && row.status === "failed")
        && v.native.length === 1 && v.native[0]!.agentId === worker.id && v.native[0]!.status === "succeeded",
      reject: v => v.task.status === "done" ? "Worker completed the task without its required document"
        : v.native.some(run => run.agentId !== worker.id) ? "Setup woke an agent other than the routine's worker"
        : v.native.length > 1 ? "Worker needed more than one execution"
        : v.native.some(run => ["failed", "cancelled", "timed_out"].includes(run.status ?? "")) ? "Worker execution did not finish normally" : undefined });
    const now = new Date().toISOString(); const failed = outcome.runs.find(row => row.id === scheduled.id)!;
    if (!morning(failed.triggeredAt, timezone, now) || Date.parse(edit.createdAt!) >= Date.parse(failed.triggeredAt!)) throw new Error("Scheduled run is not a real morning run after the edit");
    const saved = await api.get<Entity>(`/api/routines/${routine.id}`);
    await ctx.input.evidence("chat-catalog-routine-audit-setup.json", { companyId: ctx.input.fixtures.company.id, timezone, trigger, edit, runs: outcome.runs, task: outcome.task, now });
    return { project: p, worker: { id: worker.id }, routine: saved, timezone, editEventId: edit.id, failedRunId: failed.id, executionTaskId: failed.linkedIssueId, routineRunCount: outcome.runs.length, now };
  }, gradeRoutineAudit);
  return { ...base, oracleVersion: "paperclip.chat-catalog.internal.routine-audit.v3", authentication: "human-session", expectedRunCount: 2, minimumRunCount: 2, attemptTimeoutMs: 720_000,
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-routine-audit.ts", "run-observations.ts"],
    async observe(ctx, state): Promise<RoutineAudit> {
      const id = entity(state, "routine").id; const o = await observeInternal(ctx, state); const leadEvents: RunEvent[] = [];
      for (const run of o.runs.filter(row => row.agentId === o.leadId)) leadEvents.push(...await collectRunEvents<RunEvent>((afterSeq, limit) =>
        ctx.input.api.getRunObservation(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`)));
      return { ...o, routine: await ctx.input.api.get(`/api/routines/${id}`), routineRuns: await ctx.input.api.get(`/api/routines/${id}/runs`),
        executionTask: await ctx.input.api.get<Entity>(`/api/issues/${String(state.executionTaskId)}`), leadEvents, observedAt: new Date().toISOString() };
    },
    async verifyResult(ctx, state, value) {
      const o = value as RoutineAudit; const routine = entity(state, "routine"); const source = ctx.input.page.url();
      for (const href of routineLinks(o, routine.id)) {
        await internalResultLink(ctx, o, href).first().click();
        await ctx.input.page.waitForURL(url => url.pathname.split("/").includes(routine.id));
        await expect(ctx.input.page.getByRole("heading", { name: routine.title!, exact: true }).first()).toBeVisible();
        await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
      }
      if (o.executionTask && hasLink(o, "issues", o.executionTask)) await verifyInternalResult(ctx, state, { ...o, tasks: o.tasks.filter(row => row.id === o.executionTask!.id) });
      else if (!routineLinks(o, routine.id).length) throw new Error("Missing actual routine or execution task result link");
    },
  };
}
export const routineAuditCases: readonly ChatCatalogCase[] = [routineAudit()];
