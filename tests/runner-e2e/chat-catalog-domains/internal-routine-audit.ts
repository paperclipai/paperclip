import { createHash } from "node:crypto";
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
 * Real places without daylight saving time, one for every whole-hour UTC
 * offset from -11 to +14, so one of them always reads 08:xx. The person is
 * placed there, so "this morning" is literally true for their browser and for
 * the routine's own schedule timezone; no history is backdated.
 */
export const MORNING_CANDIDATE_TIMEZONES = ["Pacific/Pago_Pago", "Pacific/Honolulu", "Pacific/Gambier", "Pacific/Pitcairn", "America/Phoenix", "America/Guatemala",
  "America/Panama", "America/Puerto_Rico", "America/Argentina/Buenos_Aires", "Atlantic/South_Georgia", "Atlantic/Cape_Verde", "Africa/Abidjan", "Africa/Lagos",
  "Africa/Johannesburg", "Africa/Nairobi", "Asia/Dubai", "Asia/Karachi", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Australia/Brisbane",
  "Pacific/Noumea", "Pacific/Tarawa", "Pacific/Tongatapu", "Pacific/Kiritimati"] as const;
export function morningTimezone(now: Date) {
  const zone = MORNING_CANDIDATE_TIMEZONES.find(candidate => localClock(now, candidate).hour === 8);
  if (!zone) throw new Error("No candidate timezone currently reads 08:xx");
  return zone;
}
function morning(instant: string | undefined, timezone: string, observedAt: string) {
  return !!instant && localDay(instant, timezone) === localDay(observedAt, timezone) && localClock(new Date(instant), timezone).hour < 12;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Same digest the server stores for a redacted call_api input (canonical JSON, sha256). */
export function callApiInputDigest(input: Record<string, unknown>) { return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex"); }
/**
 * call_api inputs whose response carries this routine's run records (status and failure reason): its runs
 * (the server clamps any limit to 1..200 and the fixture has one run, so every integer limit up to 10000,
 * as a number or string, counts), its detail (recent runs), or the company routine list
 * (last run), unfiltered or filtered to the routine's project. The company path parameter may be omitted;
 * the server fills it from the caller's company. Empty query/path objects are equivalent to omitted ones.
 */
const readCache = new Map<string, ReadonlySet<string>>();
export function routineExecutionReads(companyId: string, routineId: string, projectId?: string): ReadonlySet<string> {
  const key = JSON.stringify([companyId, routineId, projectId ?? null]); const cached = readCache.get(key); if (cached) return cached;
  const list = "GET /api/companies/{companyId}/routines"; const runs = "GET /api/routines/{id}/runs"; const detail = "GET /api/routines/{id}";
  const variants = (operationId: string, paths: Array<Record<string, unknown> | undefined>, queries: Array<Record<string, unknown> | undefined>) =>
    paths.flatMap(pathParams => queries.map(query => ({ operationId, ...(pathParams ? { pathParams } : {}), ...(query ? { query } : {}) })));
  const limits = Array.from({ length: 10_001 }, (_, index) => index).flatMap(limit => [{ limit }, { limit: String(limit) }]);
  const routinePath = [{ id: routineId }];
  const reads = new Set([
    ...variants(runs, routinePath, [undefined, {}, ...limits]),
    ...variants(detail, routinePath, [undefined, {}]),
    ...variants(list, [{ companyId }, undefined, {}], [undefined, {}, ...(projectId ? [{ projectId }] : [])]),
  ].map(callApiInputDigest));
  readCache.set(key, reads); return reads;
}
function prp(row: RunEvent) {
  const envelope = (row.payload?.prpEvent ?? {}) as Record<string, unknown>;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  return { envelope, payload, item: (payload.item ?? {}) as Record<string, unknown> };
}
/**
 * The chat run read this routine's run records through the product. call_api
 * redacts payloads but keeps the input digest, so a call counts only when its
 * input digest is one of this routine's execution reads and its paired result
 * succeeded. A dedicated tool's unredacted output must carry the failed
 * routine-run id. The agent's own wording is never matched.
 */
export function readFailedExecution(events: readonly RunEvent[], failedRunId: string, expectedReads: ReadonlySet<string>) {
  if (!failedRunId) return false;
  const uses = new Set(events.map(prp).filter(({ item }) => item.type === "tool_use" && item.name === "call_api"
    && expectedReads.has(String((item.input as Record<string, unknown> | undefined)?.apiPayloadSha256))).map(({ item }) => String(item.id)));
  return events.some(row => {
    const { envelope, payload, item } = prp(row); const result = (item.result ?? {}) as Record<string, unknown>;
    if (item.type === "tool_result" && uses.has(String(item.tool_use_id)) && result.ok === true && result.status === 200) return true;
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
  // The reply's claims are read by a person, not matched by wording: the checks above and below prove the
  // saved outcome, that the chat run read it, and that the person can open the evidence from the answer.
  c.add("read-actual-execution-record", readFailedExecution(o.leadEvents, o.state.failedRunId, routineExecutionReads(o.companyId, original.id, (o.state.project as Entity | undefined)?.id)),
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
    const invocation = await pollUntil({ label: "real scheduled morning routine invocation", deadlineAt: Date.now() + 240_000, intervalMs: 2000,
      load: () => api.get<RoutineRun[]>(`/api/routines/${routine.id}/runs`), accept: rows => rows.some(row => row.source === "schedule" && !!row.linkedIssueId),
      reject: rows => rows.some(row => row.source === "schedule" && row.status === "failed" && !row.linkedIssueId) ? "Scheduled dispatch failed before creating its execution task" : undefined });
    const scheduled = invocation.find(row => row.source === "schedule" && !!row.linkedIssueId)!;
    const outcome = await pollUntil({ label: "worker blocks the edited routine's execution task and the invocation fails", deadlineAt: Date.now() + 180_000, intervalMs: 2000,
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
  return { ...base, oracleVersion: "paperclip.chat-catalog.internal.routine-audit.v6", authentication: "human-session", expectedRunCount: 2, minimumRunCount: 2, attemptTimeoutMs: 720_000,
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
