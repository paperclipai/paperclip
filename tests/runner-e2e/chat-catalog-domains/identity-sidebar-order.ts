import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { checks, entity, project } from "./internal-support.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { identityDefinition, identityObservation, probeAgentPermission, waitForReply } from "./identity-support.js";
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const observers = new WeakMap<ChatCatalogContext, Person>();
interface Order { orderedIds: string[] }
export function gradeSidebarOrder(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("actual-supported-classic-context", !!o && o.state.shell === "classic" && o.state.humanSelectedShell === true,
    "The person explicitly selected the supported classic shell before the original query; this does not claim streamlined-shell ordering support."); if (!o) return c.result();
  const launch = entity(o.state, "project");
  c.add("agent-keeps-personal-boundary", o.state.agentPreferenceWriteStatus === 403 && JSON.stringify(o.state.orderBefore) === JSON.stringify(o.state.orderAfterReply)
    && /drag|reorder|sidebar|sort/i.test(o.reply) && !/\bI(?:'ve| have)?\s+(?:reordered|moved|collapsed)\b/i.test(o.reply),
    "The answer explains the human controls and does not impersonate their board preference identity.");
  c.add("human-order-persisted", (o.state.orderAfterDrag as Order | undefined)?.orderedIds?.[0] === launch.id
    && (o.state.orderAfterReload as Order | undefined)?.orderedIds?.[0] === launch.id && o.state.launchFirstInBrowser === true,
    "The actual mouse reorder writes the person's company-scoped project order and the visible first position survives reload.");
  c.add("collapse-has-session-scope", o.state.agentsCollapsed === true && o.state.collapseRetainedDuringNavigation === true && o.state.collapseResetAfterReload === true,
    "The actual Agents section collapses, stays collapsed through client navigation and resets on full reload according to its component-session contract.");
  c.add("other-person-unchanged", o.state.observerId !== o.state.humanId && typeof o.state.observerId === "string"
    && JSON.stringify(o.state.observerBefore) === JSON.stringify(o.state.observerAfter) && o.state.observerAgentsExpanded === true,
    "A separately authenticated Riley retains their own saved order and expanded local section.");
  return c.result();
}
export const sidebarOrderIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("navigation-preferences.sidebar-order", async ctx => {
  const browser = ctx.input.page.context().browser(); if (!browser || !ctx.input.privateSecrets) throw new Error("Sidebar scope requires real human browser identities");
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (!session.user?.id || session.user.id === "local-board") throw new Error("Personal sidebar order requires actual human authentication");
  const settings = await ctx.input.api.get<{ enableStreamlinedUi: boolean }>("/api/instance/settings/experimental");
  try {
  const source = ctx.input.page.url();
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/company/settings/instance/experimental`, { waitUntil: "domcontentloaded" });
  const toggle = ctx.input.page.getByRole("switch", { name: "Toggle Streamlined UI experimental setting", exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.isChecked()) await toggle.click();
  await expect.poll(async () => (await ctx.input.api.get<{ enableStreamlinedUi: boolean }>("/api/instance/settings/experimental")).enableStreamlinedUi).toBe(false);
  const first = await project(ctx, "Archive"); const launch = await project(ctx);
  const endpoint = `/api/companies/${ctx.input.fixtures.company.id}/sidebar-preferences/me`;
  await ctx.input.api.putSensitive(endpoint, { orderedIds: [first.id, launch.id] });
  const observer = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Riley" }); observers.set(ctx, observer);
    await enrollPrerequisitePerson(ctx, observer);
    const saved = await observer.request(endpoint, "PUT", { orderedIds: [first.id, launch.id] }); if (!saved.ok) throw new Error("Riley's public sidebar fixture failed"); await saved.body?.cancel();
    const before = await observer.request(endpoint); if (!before.ok) throw new Error("Riley sidebar read failed");
    const observerBefore = (await before.json() as Order).orderedIds;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await ctx.input.evidence("identity-sidebar-deployment.json", { shell: "classic", selectedThroughHumanExperimentalControl: true, streamlinedOrderingQualified: false });
    return { project: launch, otherProject: first, humanId: session.user.id, observerId: observer.id, observerBefore,
      orderBefore: await ctx.input.api.get<Order>(endpoint), shell: "classic", humanSelectedShell: true, originalStreamlined: settings.enableStreamlinedUi };
  } catch (error) { await observers.get(ctx)?.dispose(); observers.delete(ctx); await ctx.input.api.patch("/api/instance/settings/experimental", { enableStreamlinedUi: settings.enableStreamlinedUi }); throw error; }
}, gradeSidebarOrder, {
  authentication: "human-session",
  sourceFiles: ["chat-catalog-domains/identity-sidebar-order.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/navigation-preferences.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const endpoint = `/api/companies/${ctx.input.fixtures.company.id}/sidebar-preferences/me`;
    state.orderAfterReply = await ctx.input.api.get<Order>(endpoint);
    state.agentPreferenceWriteStatus = await probeAgentPermission(ctx, endpoint, "PUT", { orderedIds: [entity(state, "project").id, entity(state, "otherProject").id] });
    const page = ctx.input.page; const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "Projects section actions", exact: true }) }).first();
    await sidebar.getByRole("button", { name: "Projects section actions", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Top", exact: true }).click();
    const from = await sidebar.getByRole("link", { name: "Launch", exact: true }).boundingBox();
    const to = await sidebar.getByRole("link", { name: "Archive", exact: true }).boundingBox();
    if (!from || !to) throw new Error("Supported desktop project drag targets are absent");
    await page.mouse.move(from.x + 30, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y - 10, { steps: 5 }); await page.mouse.move(to.x + 30, to.y + 2, { steps: 10 }); await page.mouse.up();
    await expect.poll(async () => (await ctx.input.api.get<Order>(endpoint)).orderedIds[0]).toBe(entity(state, "project").id);
    state.orderAfterDrag = await ctx.input.api.get<Order>(endpoint);
    await sidebar.getByRole("button", { name: "Collapse Agents", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "Expand Agents", exact: true })).toBeVisible(); state.agentsCollapsed = true;
    await sidebar.getByRole("link", { name: "Launch", exact: true }).click();
    state.collapseRetainedDuringNavigation = await sidebar.getByRole("button", { name: "Expand Agents", exact: true }).isVisible();
    await page.reload({ waitUntil: "domcontentloaded" }); state.orderAfterReload = await ctx.input.api.get<Order>(endpoint);
    await expect(sidebar.getByRole("link", { name: "Launch", exact: true })).toBeVisible();
    state.launchFirstInBrowser = await sidebar.getByRole("link", { name: /^(Launch|Archive)$/ }).allTextContents().then(names => names[0]?.trim() === "Launch");
    state.collapseResetAfterReload = await sidebar.getByRole("button", { name: "Collapse Agents", exact: true }).isVisible();
    const observer = observers.get(ctx); if (!observer) throw new Error("Independent sidebar person missing");
    const other = await observer.context.newPage();
    try {
      await other.goto(`/${ctx.input.fixtures.company.issuePrefix}/projects/${entity(state, "project").id}`, { waitUntil: "domcontentloaded" });
      await expect(other.getByRole("button", { name: "Collapse Agents", exact: true })).toBeVisible(); state.observerAgentsExpanded = true;
      const after = await observer.request(endpoint); if (!after.ok) throw new Error("Independent sidebar persistence read failed"); state.observerAfter = (await after.json() as Order).orderedIds;
    } finally { await other.close(); }
    await ctx.input.evidence("identity-sidebar-person-scope.json", { humanId: state.humanId, observerId: state.observerId, orderAfterDrag: state.orderAfterDrag,
      orderAfterReload: state.orderAfterReload, observerBefore: state.observerBefore, observerAfter: state.observerAfter,
      agentsCollapsed: state.agentsCollapsed, collapseRetainedDuringNavigation: state.collapseRetainedDuringNavigation, collapseResetAfterReload: state.collapseResetAfterReload });
    await page.goto(`/${ctx.input.fixtures.company.issuePrefix}/chats/${ctx.input.fixtures.agent.id}`, { waitUntil: "domcontentloaded" });
  },
  async cleanup(ctx, state) {
    try { await ctx.input.api.patch("/api/instance/settings/experimental", { enableStreamlinedUi: state.originalStreamlined }); }
    finally { await observers.get(ctx)?.dispose(); observers.delete(ctx); }
  },
})];
