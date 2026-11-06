import { checks, project, task, sameTask, type Entity } from "./internal-support.js";
import { runtimeDefinition, observeRuntime, runtimeObservation, type RuntimeObservation } from "./runtime-support.js";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";

interface DependencyTask extends Entity { blockedByIssueIds?: string[]; blockedBy?: Array<{ id: string }> }
interface DependencyObservation extends RuntimeObservation { dependencyTasks: DependencyTask[] }
export function gradeDependencyCycle(value: unknown) {
  const c = checks(); const o = runtimeObservation(value) as DependencyObservation | undefined;
  c.add("complete-dependency-observation", !!o && Array.isArray(o.dependencyTasks), "Both dependency sets are read from their actual persisted detail endpoints.");
  if (!o || !Array.isArray(o.dependencyTasks)) return c.result();
  const website = o.state.task as DependencyTask; const design = o.state.design as DependencyTask;
  const currentWebsite = o.dependencyTasks.find(row => row.id === website.id);
  const currentDesign = o.dependencyTasks.find(row => row.id === design.id);
  const blockers = (row: DependencyTask | undefined) => row?.blockedBy?.map(edge => edge.id) ?? row?.blockedByIssueIds;
  c.add("original-edge-retained-reverse-edge-absent", !!currentWebsite && !!currentDesign
    && blockers(currentWebsite)?.length === 0 && blockers(currentDesign)?.length === 1 && blockers(currentDesign)?.[0] === website.id,
    "Design still waits for Website; the requested reverse edge is rejected without removing the original prerequisite.");
  c.add("same-company-unchanged-task-records", !!currentWebsite && !!currentDesign && sameTask(website, currentWebsite)
    && sameTask(design, currentDesign) && [currentWebsite, currentDesign].every(row => row.companyId === o.companyId) && o.tasks.length === 2,
    "Cycle rejection preserves the two task identities, ownership and ordinary properties.");
  c.add("explains-actual-conflict-and-next-decision", /\bWebsite\b/i.test(o.reply) && /\bDesign\b/i.test(o.reply)
    && /cycl|circular|already.*depend|deadlock/i.test(o.reply) && /choose|which|instead|remove|order|first/i.test(o.reply),
    "The response explains the named dependency conflict and an actionable order decision.");

  return c.result();
}
async function observeDependencies(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<DependencyObservation> {
  const o = await observeRuntime(ctx, state);
  const dependencyTasks = await Promise.all([state.task as Entity, state.design as Entity].map(row => ctx.input.api.get<DependencyTask>(`/api/issues/${row.id}`)));
  return { ...o, dependencyTasks };
}
export const runtimeTaskCoordinationCases = [runtimeDefinition("task-coordination.reject-dependency-cycle", async ctx => {
  const p = await project(ctx); const website = await task(ctx, "Website", p.id);
  const design = await task(ctx, "Design", p.id, { blockedByIssueIds: [website.id] });
  return { project: p, task: website, design };
}, gradeDependencyCycle, { observe: observeDependencies, async verifyResult(ctx, state) {
  const source = ctx.input.page.url();
  for (const row of [state.task as Entity, state.design as Entity]) {
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${row.identifier ?? row.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: row.title!, exact: true }).first()).toBeVisible();
  }
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
} })];
