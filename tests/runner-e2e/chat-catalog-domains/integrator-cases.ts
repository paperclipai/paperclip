import type { IssueThreadInteraction } from "../../../packages/shared/src/types/issue.js";
import type { cases } from "../../../packages/db/src/schema/cases.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { checks, observation, project, task, type InternalObservation } from "./internal-support.js";
import { groundedStatement, integratorDefinition, inspectResult, resultHref, observeInternal } from "./integrator-support.js";
type CaseRecord = typeof cases.$inferSelect;
interface CasesObservation extends InternalObservation { cases: CaseRecord[]; casesEnabled: boolean; casesReadStatus: number; casesReadError?: string; interactions?: IssueThreadInteraction[] }
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
async function observeCases(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<CasesObservation> {
  const base = await observeInternal(ctx, state);
  const settings = await ctx.input.api.get<{ enableCases: boolean }>("/api/instance/settings/experimental");
  const response = await ctx.input.page.request.get(`${root(ctx)}/cases?limit=200`);
  const interactions = ctx.issue() ? await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${ctx.issue()!.id}/interactions`) : [];
  return { ...base, interactions, casesEnabled: settings.enableCases, casesReadStatus: response.status(), cases: response.ok() ? await response.json() : [], casesReadError: response.ok() ? undefined : (await response.json() as { error?: string }).error };
}
function caseObservation(value: unknown): CasesObservation | undefined {
  const o = value as CasesObservation;
  return observation(value) && Array.isArray(o.cases) && typeof o.casesEnabled === "boolean" && typeof o.casesReadStatus === "number" ? o : undefined;
}
export function gradeIntegratorCases(value: unknown) {
  const c = checks(); const o = caseObservation(value);
  c.add("public-case-and-task-evidence", !!o, "Requires public case response/status, actual experiment state, task and audit evidence.");
  if (!o) return c.result();
  if (o.scenarioId === "cases.cases-disabled") {
    c.add("disabled-route-remains-disabled", !o.casesEnabled && o.casesReadStatus === 403 && o.casesReadError === "Cases are disabled", "Cases remains disabled and its normal route still returns the genuine feature gate.");
    c.add("no-silent-case-or-task-creation", !o.activity.some(event => event.agentId === o.leadId && /^(?:case\.|issue\.created)/.test(event.action ?? "")) && o.tasks.length === 0, "No case or task is created before the person makes the consequential choice.");
    const choice = (text: string, hasOptions = false) => groundedStatement(text, /\bCases?\b/i, /\b(?:disabled|unavailable|not enabled|isn't enabled|not available|isn't available)\b/i,
      /\b(?:created|opened|enabled)\s+(?:a |the |your )?(?:customer |new )?case\b|\b(?:Cases is enabled|Cases are enabled)\b/i)
      && /\b(?:enable|settings|ordinary task|regular task|normal task)\b/i.test(text)
      && (hasOptions || /\b(?:would you|do you|want|choose|prefer|can (?:enable|create)|could (?:enable|create))\b/i.test(text));
    const pendingChoice = o.interactions?.some(card => card.kind === "ask_user_questions" && card.status === "pending"
      && choice(JSON.stringify({ title: card.title, summary: card.summary, payload: card.payload }), card.payload.questions?.some(question => (question.options?.length ?? 0) >= 2)));
    c.add("truthful-availability-and-choice", (choice(o.reply) || pendingChoice === true) && !/\b(?:created|opened|enabled)\s+(?:a |the |your )?(?:customer |new )?case\b|\b(?:Cases is enabled|Cases are enabled)\b/i.test(o.reply), "The actual reply or supported pending human-choice interaction explains Cases availability and offers enablement/task alternatives without claiming an action already happened.");
  } else if (o.scenarioId === "cases.browse-cases") {
    const expected = o.state.openCases as CaseRecord[] | undefined; const excluded = o.state.excludedCases as CaseRecord[] | undefined;
    c.add("original-filter-fixtures", Array.isArray(expected) && Array.isArray(excluded) && new Set([...expected, ...excluded].map(row => row.id)).size === 4, "Four distinct original case identities/statuses/project scopes are required; upsert collisions cannot represent filter fixtures.");
    if (!Array.isArray(expected) || !Array.isArray(excluded)) return c.result();
    c.add("real-project-and-case-status", o.casesEnabled && o.casesReadStatus === 200 && expected.length === 2
      && expected.every(before => o.cases.some(now => now.id === before.id && now.status === before.status && now.projectId === before.projectId))
      && o.tasks.some(row => row.id === (o.state.finishedTask as { id: string } | undefined)?.id && row.status === "done"), "Two actual open Launch cases remain open even when related task work is done.");
    c.add("exact-filtered-case-results", expected.every(row => !!caseHref(o, row)) && excluded.every(row => !caseHref(o, row)
      && !o.reply.includes(row.title) && !o.reply.includes(row.identifier)), "Rendered results include the real open Launch cases and exclude the closed case and other project's open case.");
    c.add("read-does-not-mutate-cases-or-columns", !o.activity.some(event => event.agentId === o.leadId && /^case\./.test(event.action ?? ""))
      && !/\b(?:changed|saved|updated|reordered)\b[^.!?\n]{0,45}\b(?:columns?|board layout)\b/i.test(o.reply), "Browsing does not mutate case records or claim browser-only presentation changes.");
  } else c.add("owned-case-oracle", false, "No independent oracle exists for this case scenario.");
  return c.result();
}
function caseHref(o: InternalObservation, row: Pick<CaseRecord, "id" | "identifier">) { return resultHref(o, row.id, "cases") ?? resultHref(o, row.identifier, "cases"); }
async function verifyCases(ctx: ChatCatalogContext, _state: Record<string, unknown>, value: unknown) {
  const o = caseObservation(value); if (!o) throw new Error("Missing case UI observation");
  if (!o.casesEnabled) {
    if (!o.reply && o.interactions?.length) {
      const choices = o.interactions.filter(card => card.kind === "ask_user_questions" && card.status === "pending" && /Cases/i.test(JSON.stringify(card.payload)));
      if (choices.length !== 1) throw new Error("Missing unambiguous Cases availability choice in real UI");
      const request = ctx.input.page.locator(`[id=${JSON.stringify(`interaction-${choices[0]!.id}`)}]`);
      await expect(request).toBeVisible(); await request.click();
      await expect(ctx.input.page.getByText(/Cases (?:is |are )?(?:disabled|unavailable|not enabled|not available)/i).first()).toBeVisible();
      await expect(ctx.input.page.getByText(/ordinary task|regular task|normal task|enable Cases/i).first()).toBeVisible();
    }
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); return;
  }
  for (const row of o.state.openCases as CaseRecord[]) {
    const href = caseHref(o, row); if (!href) throw new Error("No actual open case link");
    const pathname = new URL(href, o.origin).pathname;
    await inspectResult(ctx, pathname, row.title, href);
  }
}
const previousExperiments = new WeakMap<ChatCatalogContext, boolean>();
function define(id: string, enabled: boolean, setup: ChatCatalogCase["setup"]): ChatCatalogCase {
  return integratorDefinition("cases", id, async ctx => {
    const previous = await ctx.input.api.get<{ enableCases: boolean }>("/api/instance/settings/experimental");
    previousExperiments.set(ctx, previous.enableCases);
    try { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: enabled }); return await setup(ctx); }
    catch (error) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: previous.enableCases }); previousExperiments.delete(ctx); throw error; }
  }, observeCases, gradeIntegratorCases, verifyCases, { async cleanup(ctx) {
    const previous = previousExperiments.get(ctx); if (previous !== undefined) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: previous }); previousExperiments.delete(ctx); }
  } });
}
export const integratorCasesCases: readonly ChatCatalogCase[] = [
  define("cases.cases-disabled", false, async ctx => {
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/chats/${ctx.input.fixtures.agent.id}`);
    await ctx.refreshIssue();
    if (!ctx.issue()) throw new Error("Customer bug context requires its actual standing conversation");
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: "Customer bug: the checkout button stops responding on mobile Safari after a trial item and a test address are entered. The person is asking about this bug." });
    return {};
  }),
  define("cases.browse-cases", true, async ctx => {
    const launch = await project(ctx, "Launch"); const other = await project(ctx, "Research");
    const create = (title: string, projectId: string, status: string) => ctx.input.api.post<CaseRecord>(`${root(ctx)}/cases`, { caseType: "customer", key: `browse-${ctx.input.nonce}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title, projectId, status });
    const open = await create("Mobile checkout failure", launch.id, "in_progress"); const second = await create("Keyboard focus loss", launch.id, "in_review");
    const closed = await create("Resolved image clipping", launch.id, "done"); const elsewhere = await create("Research signup failure", other.id, "in_progress");
    const finishedTask = await task(ctx, "Initial customer diagnosis", launch.id, { status: "done" });
    await ctx.input.api.post(`/api/cases/${open.id}/links`, { issueId: finishedTask.id, role: "work" });
    const saved = await ctx.input.api.get<CaseRecord[]>(`${root(ctx)}/cases?limit=200`);
    if (new Set([open, second, closed, elsewhere].map(row => row.id)).size !== 4 || ![open, second, closed, elsewhere].every(row => saved.some(now => now.id === row.id && now.status === row.status && now.projectId === row.projectId))) throw new Error("Case browsing setup did not retain four distinct scoped status records");
    return { project: launch, openCases: [open, second], excludedCases: [closed, elsewhere], finishedTask };
  }),
];
