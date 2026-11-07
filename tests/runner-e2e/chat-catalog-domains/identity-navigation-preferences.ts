import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { checks, entity, hasLink, project, task, verifyInternalResult } from "./internal-support.js";
import { identityDefinition, identityObservation, waitForReply, probeAgentPermission } from "./identity-support.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const searchObservers = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof createAuthenticatedPerson>>>();

export function gradeNavigation(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("complete-navigation-evidence", !!o, "Persisted records and observed browser navigation are required.");
  if (!o) return c.result();
  const p = entity(o.state, "project"); const t = entity(o.state, "task");
  c.add("scope-retained", o.projects.some(row => row.id === p.id && row.companyId === o.companyId)
    && o.tasks.some(row => row.id === t.id && row.projectId === p.id && row.status === "backlog"), "Navigation retains the real company project and open task.");
  c.add("navigation-is-read-only", !o.activity.some(row => row.agentId === o.leadId && [p.id, t.id].includes(row.entityId ?? "")), "The agent does not rewrite records to make the requested view appear correct.");
  if (o.scenarioId === "navigation-preferences.find-project-view") {
    c.add("actual-project-link", hasLink(o, "projects", p), "The rendered reply links the exact Launch project.");
    c.add("open-task-view", o.state.openTaskVisible === true && o.state.closedTaskVisible === false,
      "Following the project link shows the actual open task and excludes the completed task after selecting the supported open filter.");
    c.add("personal-preferences-not-agent-mutated", o.state.agentPreferenceReadStatus === 403 && o.state.preferencesBefore !== undefined
      && JSON.stringify(o.state.preferencesBefore) === JSON.stringify(o.state.preferencesAfterReply), "The actual agent cannot impersonate the person's preferences, and the response does not change saved order or browser favorites/recents.");
  } else if (o.scenarioId === "navigation-preferences.quick-search") {
    c.add("documented-palette-entry", /(?:command|cmd|ctrl|control|⌘).*k|quick\s+search|command\s+palette/i.test(o.reply), "The answer identifies the actual quick-search entry point.");
    c.add("browser-search-transition", o.state.paletteTaskVisible === true && o.state.searchTaskVisible === true
      && o.state.searchQuery === "Launch" && o.state.searchStatus === "backlog", "The human opens the palette, finds the fixture task, and carries its query and chosen status filter into full search.");
    c.add("independent-search-audience", o.state.observerPublicVisible === true && o.state.observerPrivatePaletteHidden === true && o.state.observerPrivateSearchHidden === true,
      "A separately authenticated company member finds the public Launch task but cannot discover its private counterpart in quick or full search.");
  } else c.add("known-navigation-case", false, "No oracle exists for this navigation request.");
  return c.result();
}
async function fixture(ctx: Parameters<typeof project>[0]) {
  const p = await project(ctx); const t = await task(ctx, "Launch open website", p.id);
  const closed = await task(ctx, "Launch completed website", p.id, { status: "done" });
  return { project: p, task: t, closed, preferencesBefore: await preferenceSnapshot(ctx) };
}
export const navigationIdentityCases = [
  identityDefinition("navigation-preferences.find-project-view", fixture, gradeNavigation, {
    async act(ctx, state) {
      await waitForReply(ctx); state.preferencesAfterReply = await preferenceSnapshot(ctx);
      state.agentPreferenceReadStatus = await probeAgentPermission(ctx, "/api/sidebar-preferences/me", "GET");
      const o = await ctx.input.api.get<Array<{ id: string; body: string; authorAgentId?: string }>>(`/api/issues/${ctx.issue()!.id}/comments`);
      const hrefs = await ctx.input.page.locator(`[id^="comment-"] a[href]`).evaluateAll(elements => elements.map(el => el.getAttribute("href")!));
      const p = entity(state, "project");
      const href = hrefs.find(link => hasLink({ links: [link], origin: ctx.input.api.baseURL } as Parameters<typeof hasLink>[0], "projects", p));
      if (!href || !o.some(row => row.authorAgentId === ctx.input.fixtures.agent.id)) throw new Error("No actual project reply link");
      const source = ctx.input.page.url();
      await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
      await expect(ctx.input.page.getByRole("heading", { name: "Launch", exact: true }).first()).toBeVisible();
      await ctx.input.page.getByRole("button", { name: /^Filter/ }).first().click();
      for (const status of ["Backlog", "Todo", "In Progress", "In Review", "Blocked"]) {
        const row = ctx.input.page.locator("label").filter({ has: ctx.input.page.getByText(status, { exact: true }) });
        await row.getByRole("checkbox").setChecked(true);
      }
      await ctx.input.page.keyboard.press("Escape");
      await expect(ctx.input.page.getByText(entity(state, "task").title!, { exact: true }).first()).toBeVisible();
      state.openTaskVisible = await ctx.input.page.getByText(entity(state, "task").title!, { exact: true }).first().isVisible();
      state.closedTaskVisible = await ctx.input.page.getByText(entity(state, "closed").title!, { exact: true }).first().isVisible();
      await ctx.input.evidence("identity-project-navigation.json", { projectId: p.id, openTaskId: entity(state, "task").id,
        openTaskVisible: state.openTaskVisible, closedTaskVisible: state.closedTaskVisible, url: ctx.input.page.url() });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    }, verifyResult: verifyInternalResult,
  }),
  identityDefinition("navigation-preferences.quick-search", async ctx => {
    const state = await fixture(ctx); const browser = ctx.input.page.context().browser();
    if (!browser || !ctx.input.privateSecrets) throw new Error("Quick search audience requires actual authenticated browser identities");
    const observer = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Riley" }); searchObservers.set(ctx, observer);
    try {
      await enrollPrerequisitePerson(ctx, observer, "viewer");
      const privateTask = await task(ctx, "Launch private acquisition", state.project.id, { visibility: "private", description: `Private launch note ${ctx.input.nonce}` });
      return { ...state, privateTask, observerId: observer.id };
    } catch (error) { await observer.dispose(); searchObservers.delete(ctx); throw error; }
  }, gradeNavigation, {
    authentication: "human-session",
    sourceFiles: ["chat-catalog-domains/identity-navigation-preferences.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/navigation-preferences.yaml"],
    async act(ctx, state) {
      await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); const source = ctx.input.page.url();
      await ctx.input.page.keyboard.press("ControlOrMeta+k");
      await ctx.input.page.getByPlaceholder("Search tasks, agents, projects...").fill("Launch status:backlog");
      await expect(ctx.input.page.getByRole("dialog").getByText(entity(state, "task").title!, { exact: true })).toBeVisible();
      state.paletteTaskVisible = true;
      await ctx.input.page.getByTestId("command-search-all").click();
      await expect(ctx.input.page.getByText(entity(state, "task").title!, { exact: true }).first()).toBeVisible();
      state.searchTaskVisible = true; state.searchQuery = new URL(ctx.input.page.url()).searchParams.get("q");
      state.searchStatus = new URL(ctx.input.page.url()).searchParams.get("status");
      const observer = searchObservers.get(ctx); if (!observer) throw new Error("Independent search observer missing");
      const page = await observer.context.newPage();
      try {
        await page.goto(`/${ctx.input.fixtures.company.issuePrefix}/projects/${entity(state, "project").id}`, { waitUntil: "domcontentloaded" });
        await page.keyboard.press("ControlOrMeta+k");
        await page.getByPlaceholder("Search tasks, agents, projects...").fill("Launch status:backlog");
        const palette = page.getByRole("dialog");
        await expect(palette.getByText(entity(state, "task").title!, { exact: true })).toBeVisible();
        await expect(palette.getByText(entity(state, "privateTask").title!, { exact: true })).toHaveCount(0); state.observerPrivatePaletteHidden = true;
        await page.getByTestId("command-search-all").click();
        await expect(page.getByText(entity(state, "task").title!, { exact: true }).first()).toBeVisible(); state.observerPublicVisible = true;
        await expect(page.getByText(entity(state, "privateTask").title!, { exact: true })).toHaveCount(0); state.observerPrivateSearchHidden = true;
        await ctx.input.evidence("identity-search-observer.json", { userId: observer.id, publicTaskId: entity(state, "task").id, privateTaskId: entity(state, "privateTask").id,
          publicVisible: state.observerPublicVisible, privatePaletteHidden: state.observerPrivatePaletteHidden, privateSearchHidden: state.observerPrivateSearchHidden });
      } finally { await page.close(); }
      await ctx.input.evidence("identity-quick-search.json", { taskId: entity(state, "task").id, query: state.searchQuery, status: state.searchStatus, url: ctx.input.page.url() });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    },
    async cleanup(ctx) { await searchObservers.get(ctx)?.dispose(); searchObservers.delete(ctx); },
  }),
] as const;
async function preferenceSnapshot(ctx: Parameters<typeof project>[0]) {
  const order = await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/sidebar-preferences/me`);
  const browserPreferences = await ctx.input.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
    .filter(([key]) => /favorite|recent[-:.]?(?:tasks|projects)/i.test(key)).sort(([a], [b]) => a.localeCompare(b))));
  return { order, browserPreferences };
}
