import type { RoutineDetail, RoutineListItem, RoutineRevision, RoutineRunSummary } from "../../../packages/shared/src/types/routine.js";
import type { ChatCatalogContext, ChatCatalogCase } from "../chat-catalog-contract.js";
import { checks, hasLink, project, observation, type Entity, type InternalObservation } from "./internal-support.js";
import { runIssueId } from "./run-roles.js";
import { parseCron } from "../../../server/src/services/cron.js";
import { fixtureWorker } from "./internal-definition.js";
import { integratorDefinition, groundedStatement, inspectResult, observeInternal } from "./integrator-support.js";
interface RoutinesObservation extends InternalObservation {
  routines: RoutineDetail[]; histories: Record<string, RoutineRunSummary[]>; routineRevisions: Record<string, RoutineRevision[]>;
  browserTimezone: string;
}
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
async function observeRoutines(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<RoutinesObservation> {
  const base = await observeInternal(ctx, state); const api = ctx.input.api;
  const listed = await api.get<RoutineListItem[]>(`${root(ctx)}/routines`);
  const routines = await Promise.all(listed.map(row => api.get<RoutineDetail>(`/api/routines/${row.id}`)));
  const histories = Object.fromEntries(await Promise.all(routines.map(async row => [row.id, await api.get<RoutineRunSummary[]>(`/api/routines/${row.id}/runs`)])));
  const routineRevisions = Object.fromEntries(await Promise.all(routines.map(async row => [row.id, await api.get<RoutineRevision[]>(`/api/routines/${row.id}/revisions`)])));
  return { ...base, routines, histories, routineRevisions, browserTimezone: await ctx.input.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) };
}
function routineObservation(value: unknown): RoutinesObservation | undefined {
  const o = value as RoutinesObservation;
  return observation(value) && Array.isArray(o.routines) && !!o.histories && !!o.routineRevisions && typeof o.browserTimezone === "string" ? o : undefined;
}
type Activity = Entity & { runId?: string | null };
/** Fires once in every hour of every day, judged by the product's own cron parser rather than one spelling:
 * exactly one minute, all 24 hours, and unrestricted day of month, month and weekday. */
export function runsHourly(cron: string) {
  let parsed: ReturnType<typeof parseCron>;
  try { parsed = parseCron(cron); } catch { return false; }
  return parsed.minutes.length === 1 && parsed.hours.length === 24 && parsed.daysOfMonth.length === 31 && parsed.months.length === 12 && parsed.daysOfWeek.length === 7;
}
function linksTo(o: InternalObservation, href: string, segment: string, ids: Array<string | null | undefined>) {
  try { const url = new URL(href, o.origin), parts = url.pathname.split("/").map(decodeURIComponent), index = parts.indexOf(segment);
    return url.origin === new URL(o.origin).origin && index >= 0 && ids.filter(Boolean).includes(parts[index + 1]); } catch { return false; }
}
function routineWrite(event: Entity & { action?: string; entityType?: string; entityId?: string; details?: Record<string, unknown> | null }, routineId?: string) {
  return /^routine\.(?!run_|webhook_|document_)/.test(event.action ?? "") && (event.entityId === routineId || event.details?.routineId === routineId);
}
/** The owner path: tasks the CEO created and assigned to Morgan, and Morgan's runs. At most one such
 * task and one Morgan run bound to it; any other Morgan run is extra work. */
function ownerRoute(o: InternalObservation, worker: Entity) {
  const delegated = o.tasks.filter(task => task.assigneeAgentId === worker?.id && o.activity.some(event => event.action === "issue.created"
    && event.entityId === task.id && event.agentId === o.leadId && o.runs.some(run => run.id === (event as Activity).runId && run.agentId === o.leadId)));
  const workerRuns = o.runs.filter(run => run.agentId === worker?.id);
  const ownerRun = workerRuns.length === 1 && delegated.length === 1 && runIssueId(workerRuns[0]!) === delegated[0]!.id ? workerRuns[0] : undefined;
  return { delegated, ownerRun, valid: delegated.length <= 1 && (workerRuns.length === 0 || !!ownerRun) };
}
export function gradeIntegratorRoutines(value: unknown) {
  const c = checks(); const o = routineObservation(value);
  c.add("public-routine-definition-and-history", !!o, "Requires actual routine detail, revision history, execution history and browser timezone.");
  if (!o) return c.result();
  if (o.scenarioId === "routines.create-daily-brief") {
    const routine = o.routines[0]; const p = o.state.project as { id: string };
    c.add("one-owned-launch-definition", o.routines.length === 1 && !!routine && routine.companyId === o.companyId && routine.assigneeAgentId === o.leadId && routine.projectId === p?.id
      && /summar(?:y|ize|ise)/i.test(`${routine.title} ${routine.description}`) && routine.createdByAgentId === o.leadId, "Exactly one self-assigned routine saves the summary purpose and actual Launch project.");
    const schedule = routine?.triggers.filter(row => row.kind === "schedule");
    c.add("weekday-nine-person-timezone", o.browserTimezone === "America/Chicago" && schedule?.length === 1 && schedule[0]?.enabled === true
      && /^0\s+9\s+\*\s+\*\s+(?:1-5|MON-FRI|1,2,3,4,5)$/i.test(schedule[0]?.cronExpression ?? "") && schedule[0]?.timezone === "America/Chicago", "One enabled 09:00 weekday schedule uses the genuine browser person's Chicago timezone, never UTC.");
    c.add("saved-agent-revision", !!routine && !!o.routineRevisions[routine.id]?.some(row => row.id === routine.latestRevisionId && row.createdByAgentId === o.leadId
      && row.createdByRunId != null && o.runs.some(run => run.id === row.createdByRunId)), "The current saved revision is independently attributed to a measured agent run.");
    c.add("schedule-and-work-location-explained", groundedStatement(o.reply, /\b(?:weekday|monday|mon.fri)\b/i, /\b(?:9|nine|09:00)\b/i, /\b(?:9|nine|09:00)\s*(?:a\.?m\.?\s*)?UTC\b/i)
      && /(?:America\/Chicago|Chicago|Central (?:time|timezone))/i.test(o.reply) && /\b(?:task|routine|work)\b/i.test(o.reply)
      && !/\b(?:summary (?:is )?(?:complete|ready)|already summarized|all future summaries (?:are )?(?:complete|ready))\b/i.test(o.reply), "The response describes the real saved local schedule and resulting work without claiming future summaries already ran.");
  } else if (o.scenarioId === "routines.manage-other-owner") {
    const before = o.state.routine as RoutineDetail; const current = o.routines.find(row => row.id === before?.id); const worker = o.state.worker as Entity;
    const route = ownerRoute(o, worker);
    const unchanged = !!current && current.latestRevisionId === before?.latestRevisionId && JSON.stringify(current.triggers) === JSON.stringify(before?.triggers)
      && JSON.stringify(o.routineRevisions[current.id]) === JSON.stringify(o.state.originalRevisions);
    // Agent routine writes: only the owner's own run on the delegated task may make them.
    const agentWrites = o.activity.filter(event => routineWrite(event, before?.id) && !!event.agentId);
    const ownerWrites = agentWrites.filter(event => event.agentId === worker.id && !!route.ownerRun && (event as Activity).runId === route.ownerRun.id);
    // When the owner does change it, the saved result must be the requested one: one enabled hourly schedule
    // in the original timezone (minute fixed, every hour).
    const schedules = current?.triggers.filter(row => row.kind === "schedule") ?? [];
    const hourly = schedules.length === 1 && schedules[0]!.enabled === true && runsHourly(schedules[0]!.cronExpression ?? "")
      && schedules[0]!.timezone === before?.triggers.find(row => row.kind === "schedule")?.timezone;
    c.add("same-owned-definition-and-triggers", !!current && current.assigneeAgentId === worker?.id && o.routines.length === 1
      && agentWrites.length === ownerWrites.length && (unchanged || ownerWrites.length > 0 && hourly),
      "Morgan remains the owner and no hidden duplicate exists. The definition and schedule are unchanged, or Morgan's own write from the run on the routed task saved one enabled hourly schedule in the original timezone.");
    c.add("ownership-boundary-explained", route.valid && (route.delegated.length === 1 ? hasLink(o, "issues", route.delegated[0]!)
      : o.links.some(href => linksTo(o, href, "routines", [before?.id]) || linksTo(o, href, "agents", [worker?.id, worker?.urlKey]))),
      "The change is routed structurally: one task assigned to owner Morgan, created by the CEO and linked in the reply, with at most one Morgan run bound to it; or a reply link to the routine or Morgan's page where an authorized person acts. The reply's wording is left to a human reader.");
    c.add("no-ceo-management-mutation", !o.activity.some(event => event.agentId === o.leadId && /^routine\.(?:created|updated|trigger_|revision_created)/.test(event.action ?? "")), "No responding-agent routine mutation bypasses the self-assigned management rule.");
  } else c.add("owned-routine-oracle", false, "No independent oracle exists for this routine scenario.");
  return c.result();
}
async function verifyRoutine(ctx: ChatCatalogContext, _state: Record<string, unknown>, value: unknown) {
  const o = routineObservation(value); const routine = o?.routines[0];
  if (!routine) throw new Error("No saved routine available for browser inspection");
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/routines/${routine.id}`, routine.title);
}
const define = (id: string, setup: ChatCatalogCase["setup"], extra: Partial<ChatCatalogCase> = {}) => integratorDefinition("routines", id, setup, observeRoutines, gradeIntegratorRoutines, verifyRoutine, extra);
export const integratorRoutinesCases: readonly ChatCatalogCase[] = [
  define("routines.create-daily-brief", async ctx => ({ project: await project(ctx, "Launch") }), { browserTimezone: "America/Chicago" }),
  define("routines.manage-other-owner", async ctx => {
    const p = await project(ctx, "Launch"); const worker = await fixtureWorker(ctx);
    const created = await ctx.input.api.post<RoutineDetail>(`${root(ctx)}/routines`, { title: "Morgan's launch summary", description: "Summarize Launch without changing project tasks.", projectId: p.id, assigneeAgentId: worker.id });
    await ctx.input.api.post(`/api/routines/${created.id}/triggers`, { kind: "schedule", enabled: true, cronExpression: "0 9 * * 1-5", timezone: "America/Chicago" });
    return { project: p, worker, routine: await ctx.input.api.get<RoutineDetail>(`/api/routines/${created.id}`), originalRevisions: await ctx.input.api.get<RoutineRevision[]>(`/api/routines/${created.id}/revisions`) };
  }, { oracleVersion: "paperclip.chat-catalog.integrator.manage-other-owner.v5", expectedRunCount: 2, minimumRunCount: 1, attemptTimeoutMs: 480_000,
    sourceFiles: ["chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-routines.ts", "chat-catalog-domains/run-roles.ts", "../../server/src/services/cron.ts", "chat-scenarios/routines.yaml"] }),
];
