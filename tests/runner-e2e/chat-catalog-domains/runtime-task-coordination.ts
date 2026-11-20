import { checks, project, task, sameTask, type Entity } from "./internal-support.js";
import { runtimeDefinition, observeRuntime, runtimeObservation, type RuntimeObservation } from "./runtime-support.js";
import { expect } from "@playwright/test";
import { chatCatalogHumanQuestionPolicies, type ChatCatalogContext } from "../chat-catalog-contract.js";
import { askUserQuestionsPayloadSchema } from "../../../packages/shared/src/validators/issue.js";

interface DependencyTask extends Entity { blockedByIssueIds?: string[]; blockedBy?: Array<{ id: string }> }
interface DependencyObservation extends RuntimeObservation { dependencyTasks: DependencyTask[]; conversationInteractions?: Entity[] }
const words = (text: string, literal: string) => new RegExp(`(?<![A-Za-z0-9])${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(text);
/**
 * A pending question card from this run is a valid way to end the turn on the order decision
 * (the chat's reply is then empty). It must be the lead's own human-resolvable card, offer at
 * least two choices, and name both seeded tasks; the saved dependency sets prove the rejection.
 */
function orderDecisionCard(o: DependencyObservation, website: DependencyTask, design: DependencyTask) {
  const runIds = new Set(o.runs.map(run => run.id));
  return (o.conversationInteractions ?? []).some(row => {
    const card = row as Entity & Record<string, unknown>;
    if (card.kind !== "ask_user_questions" || card.status !== "pending" || card.companyId !== o.companyId
      || card.createdByAgentId !== o.leadId || !runIds.has(card.sourceRunId as string) || !chatCatalogHumanQuestionPolicies(card as { resolverPolicy?: unknown })) return false;
    const parsed = askUserQuestionsPayloadSchema.safeParse(card.payload);
    if (!parsed.success || !parsed.data.questions.some(question => question.options.length >= 2)) return false;
    const text = [card.title, card.summary, ...parsed.data.questions.flatMap(question => [question.prompt, ...question.options.map(option => option.label)])]
      .filter(value => typeof value === "string").join("\n");
    return [website, design].every(row => [row.title, row.identifier].some(name => typeof name === "string" && words(text, name)));
  });
}
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
  const replyDecision = /\bWebsite\b/i.test(o.reply) && /\bDesign\b/i.test(o.reply)
    && /cycl|circular|already.*depend|deadlock/i.test(o.reply) && /choose|which|instead|remove|order|first/i.test(o.reply);
  c.add("explains-actual-conflict-and-next-decision", replyDecision || orderDecisionCard(o, website, design),
    "The response explains the named dependency conflict and an actionable order decision, in the reply or in this run's pending question card.");

  return c.result();
}
async function observeDependencies(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<DependencyObservation> {
  const o = await observeRuntime(ctx, state);
  const dependencyTasks = await Promise.all([state.task as Entity, state.design as Entity].map(row => ctx.input.api.get<DependencyTask>(`/api/issues/${row.id}`)));
  const source = ctx.issue();
  const conversationInteractions = source ? await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/interactions`) : [];
  return { ...o, dependencyTasks, conversationInteractions };
}
export const runtimeTaskCoordinationCases = [runtimeDefinition("task-coordination.reject-dependency-cycle", async ctx => {
  const p = await project(ctx); const website = await task(ctx, "Website", p.id);
  const design = await task(ctx, "Design", p.id, { blockedByIssueIds: [website.id] });
  return { project: p, task: website, design };
}, gradeDependencyCycle, { oracleVersion: "paperclip.chat-catalog.runtime.v3", observe: observeDependencies, async verifyResult(ctx, state) {
  const source = ctx.input.page.url();
  for (const row of [state.task as Entity, state.design as Entity]) {
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${row.identifier ?? row.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: row.title!, exact: true }).first()).toBeVisible();
  }
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
} })];
