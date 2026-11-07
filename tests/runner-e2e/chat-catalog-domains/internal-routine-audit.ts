import { expect } from "@playwright/test";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { makeDefinition } from "./internal-definition.js";
import { checks, entity, observation, observeInternal, type Entity, type InternalObservation } from "./internal-support.js";
interface RoutineRun extends Entity { routineId?: string; triggeredAt?: string; completedAt?: string; linkedIssueId?: string | null }
interface RoutineAudit extends InternalObservation { routine: Entity; routineRuns: RoutineRun[]; routineRevisions: Entity[]; now: string; timezone: string }
export function localDay(instant: string, timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant)); }
export function routineHistoricalContext(routine: Entity, activity: Entity[], runs: RoutineRun[], now: string, timezone: string, tasks: Entity[] = []) {
  const today = localDay(now, timezone); const yesterday = new Date(`${today}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1); const priorDay = yesterday.toISOString().slice(0, 10);
  const morning = runs.filter(row => { const date = row.triggeredAt ?? row.createdAt; return date && localDay(date, timezone) === today && Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(date))) < 12; });
  return routine.companyId !== undefined && activity.some(row => row.entityId === routine.id && row.action === "routine.updated" && !!row.createdAt && localDay(row.createdAt, timezone) === priorDay)
    && !morning.some(row => row.status === "succeeded" || row.status === "completed")
    && morning.every(row => !row.linkedIssueId || tasks.some(task => task.id === row.linkedIssueId && task.status !== "done"));
}
export function gradeRoutineAudit(value: unknown) {
  const c = checks(); const o = observation(value) as RoutineAudit | undefined;
  c.add("actual-dated-routine-context", !!o && !!o.routine && Array.isArray(o.routineRuns) && Array.isArray(o.routineRevisions)
    && typeof o.now === "string" && typeof o.timezone === "string", "Saved routine definition, execution history, revisions, real evaluation time and browser timezone are required.");
  if (!o || !o.routine || !Array.isArray(o.routineRuns) || !Array.isArray(o.routineRevisions) || !o.now || !o.timezone) return c.result();
  c.add("yesterday-is-real-saved-history", o.routine.companyId === o.companyId && routineHistoricalContext(o.routine, o.activity, o.routineRuns, o.now, o.timezone, o.tasks),
    "An actual current-company routine edit occurred yesterday in the person's actual timezone; enabled status and today's fixture creation cannot substitute.");
  const original = entity(o.state, "routine");
  c.add("read-only-definition-and-execution", original.updatedAt === o.routine.updatedAt && original.description === o.routine.description
    && !o.activity.some(row => row.agentId === o.leadId && row.entityId === original.id && /^routine\.(?:updated|run|trigger|revision_restored)/.test(row.action ?? "")), "The audit neither manufactures a run nor edits its evidence.");
  const linked = o.links.some(href => { try { const u = new URL(href, o.origin); return u.origin === o.origin && u.pathname.split("/").includes(original.id) && u.pathname.includes("/routines/"); } catch { return false; } });
  c.add("routine-source-and-evidence-distinguished", linked && /\b(?:edit|definition|schedule|enabled)\b/i.test(o.reply)
    && /\b(?:not|no|missing|failed|didn't|did not|hasn't|has not)\b/i.test(o.reply) && /\b(?:run|execut|work|task)\b/i.test(o.reply)
    && !/\b(?:successfully ran|successfully executed|completed successfully)\b/i.test(o.reply), "The answer links the real routine and distinguishes its saved edit/schedule from absent or failed morning execution.");
  const morningTasks = o.routineRuns.map(row => row.linkedIssueId).filter(Boolean);
  c.add("resulting-task-readback", morningTasks.every(id => o.tasks.some(row => row.id === id)), "Any resulting task is independently read rather than inferred from definition history.");
  return c.result();
}
function routineAudit(): ChatCatalogCase {
  const base = makeDefinition("activity.routine-audit", async ctx => {
    const timezone = await ctx.input.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone); const now = new Date().toISOString();
    const root = `/api/companies/${ctx.input.fixtures.company.id}`; const list = await ctx.input.api.get<Entity[]>(`${root}/routines`); const activity = await ctx.input.api.get<Entity[]>(`${root}/activity?limit=1000`); const tasks = await ctx.input.api.get<Entity[]>(`${root}/issues?includeAgentCreatedTasks=true&limit=1000`);
    for (const routine of list.filter(row => /daily.*launch|launch.*daily/i.test(row.title ?? ""))) {
      const runs = await ctx.input.api.get<RoutineRun[]>(`/api/routines/${routine.id}/runs`);
      if (routineHistoricalContext(routine, activity, runs, now, timezone, tasks)) { await ctx.input.evidence("chat-catalog-owned-historical-routine-probe.json", { companyId: ctx.input.fixtures.company.id, routine, runs, activity: activity.filter(row => row.entityId === routine.id), now, timezone, qualified: true }); return { routine, now, timezone }; }
    }
    await ctx.input.evidence("chat-catalog-owned-historical-routine-probe.json", { companyId: ctx.input.fixtures.company.id, now, timezone, candidates: list.map(row => ({ id: row.id, companyId: row.companyId, updatedAt: row.updatedAt })), qualified: false,
      missingPrerequisite: "An owned current-company daily launch routine with a genuine yesterday routine.updated event and no successful morning execution. Public company import recreates routine revisions/events today; old IDs in another company and imported task/comment dates do not establish this context. A supported whole-instance restore preserving original company/activity ownership could qualify only with real prior-day provenance." });
    throw new Error("Historical routine fixture unavailable: no genuine yesterday routine.updated history in the actual isolated company; import of task dates does not preserve routine edit provenance. No canonical query or provider run was admitted.");
  }, gradeRoutineAudit);
  return { ...base, coverageGaps: ["supported-owned-prior-day-routine-history-restoration"], authentication: "human-session",
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-routine-audit.ts"],
    async observe(ctx, state): Promise<RoutineAudit> { const id = entity(state, "routine").id; return { ...await observeInternal(ctx, state), routine: await ctx.input.api.get(`/api/routines/${id}`), routineRuns: await ctx.input.api.get(`/api/routines/${id}/runs`), routineRevisions: await ctx.input.api.get(`/api/routines/${id}/revisions`), now: String(state.now), timezone: String(state.timezone) }; },
    async verifyResult(ctx, state, value) { const o = value as RoutineAudit; const href = o.links.find(link => { try { return new URL(link, o.origin).pathname.split("/").includes(entity(state, "routine").id); } catch { return false; } }); if (!href) throw new Error("Missing actual routine result link"); const source = ctx.input.page.url(); try { await ctx.input.page.goto(new URL(href, o.origin).href); await expect(ctx.input.page.getByRole("heading", { name: entity(state, "routine").title!, exact: true }).first()).toBeVisible(); } finally { await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); } },
  };
}
export const routineAuditCases: readonly ChatCatalogCase[] = [routineAudit()];
