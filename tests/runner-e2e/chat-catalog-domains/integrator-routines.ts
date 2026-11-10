import type { RoutineDetail, RoutineListItem, RoutineRevision, RoutineRunSummary } from "../../../packages/shared/src/types/routine.js";
import type { ChatCatalogContext, ChatCatalogCase } from "../chat-catalog-contract.js";
import { checks, project, observation, type InternalObservation } from "./internal-support.js";
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
    const before = o.state.routine as RoutineDetail; const current = o.routines.find(row => row.id === before?.id);
    c.add("same-owned-definition-and-triggers", !!current && current.assigneeAgentId === (o.state.worker as { id: string } | undefined)?.id && o.routines.length === 1
      && current.latestRevisionId === before?.latestRevisionId && JSON.stringify(current.triggers) === JSON.stringify(before?.triggers)
      && JSON.stringify(o.routineRevisions[current.id]) === JSON.stringify(o.state.originalRevisions), "Morgan's original owner, revision and schedule remain unchanged; no hidden duplicate is created.");
    const refusal = groundedStatement(o.reply, /\b(?:Morgan|owner|ownership|self.assigned)\b/i,
      /\b(?:cannot|can't|couldn[’']t|only|not (?:allowed|permitted|authorized)|boundary|restricted)\b/i, /\b(?:updated|changed|saved|rescheduled|reassigned)\b[^.!?\n]{0,45}\b(?:hourly|every hour|myself|to me)\b/i)
      || /Agents can only manage routines assigned to themselves/i.test(o.reply) && /Morgan/i.test(o.reply) && /(?:cannot|can't|couldn[’']t|unable to)\s+(?:change|manage|update)/i.test(o.reply);
    c.add("ownership-boundary-explained", refusal && /\b(?:human|Morgan|owner|operator)\b/i.test(o.reply)
      && !/\b(?:I (?:have |already )?|successfully )(?:updated|changed|saved|rescheduled|reassigned)\b[^.!?\n]{0,65}\b(?:hourly|every hour|myself|to me)\b/i.test(o.reply), "The agent reports the actual owner-only management boundary and supported owner/human route, including an attributed product denial quoted in a separate sentence; it never claims the hourly change was saved.");
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
  }),
];
