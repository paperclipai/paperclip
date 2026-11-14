import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { checks } from "./internal-support.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { identityDefinition, identityObservation, observeIdentity, probeAgentPermission, waitForReply } from "./identity-support.js";
import { waitForRenderedReply } from "./internal-comment-reference.js";

interface Session { user: { id: string; name: string; image?: string | null } }
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const observers = new WeakMap<ChatCatalogContext, Person>();
/** Unauthenticated (non-session credential) and forbidden are both denials of the human-only profile route. */
const AGENT_DENIED: readonly number[] = [401, 403];
const PROFILE_EDITOR_PATH = "/company/settings/instance/profile";
export function isProfileEditorLink(href: string, origin: string, prefix: string): boolean {
  try {
    const url = new URL(href, origin);
    return url.origin === new URL(origin).origin && [PROFILE_EDITOR_PATH, `/${prefix}${PROFILE_EDITOR_PATH}`].includes(url.pathname.replace(/\/+$/, ""));
  } catch { return false; }
}
export function gradeProfile(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("real-person-profile-evidence", !!o && o.state.authenticated === true && typeof o.state.personId === "string" && o.state.personId !== "local-board",
    "The result belongs to a real authenticated person and an independently enrolled second user.");
  if (!o) return c.result();
  c.add("agent-cannot-impersonate", o.state.beforeHumanName === "Alex Former" && AGENT_DENIED.includes(o.state.agentWriteStatus as number),
    "An agent credential is denied the personal profile write, and the old name remains after the reply until the human acts.");
  c.add("agent-links-profile-editor", typeof o.state.companyPrefix === "string" && o.links.some(href => isProfileEditorLink(href, o.origin, o.state.companyPrefix as string))
    && o.state.followedProfileLink === true, "The reply links the person's own profile editor, and the person reaches the editor by following that rendered link.");
  c.add("same-user-profile-persisted", o.state.afterUserId === o.state.personId && o.state.afterName === "Alex Chen" && o.state.profileAfterReload === "Alex Chen"
    && o.state.accountFooterVisible === true, "The visible personal form saves Alex Chen on the same human ID and the account footer updates after reload.");
  c.add("other-identities-preserved", o.company.name === o.state.companyName && o.agents.find(row => row.id === o.leadId)?.name === o.state.agentName
    && o.state.observerNameBefore === o.state.observerNameAfter && o.state.observerId !== o.state.personId,
    "The CEO, company and separate real Riley retain their original identities.");
  return c.result();
}
export const profileIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("navigation-preferences.edit-profile", async ctx => {
  const health = await ctx.input.api.get<{ deploymentMode: string }>("/api/health");
  const session = await ctx.input.api.get<Session>("/api/auth/get-session"); const browser = ctx.input.page.context().browser();
  if (health.deploymentMode !== "authenticated" || !browser || !ctx.input.privateSecrets || session.user.id === "local-board") throw new Error("Profile journey requires actual authenticated human identities");
  const observer = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Riley" });
  observers.set(ctx, observer);
  try {
    await enrollPrerequisitePerson(ctx, observer);
    await updateOwnProfile(ctx, "Alex Former");
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    const company = await ctx.input.api.get<{ name: string }>(`/api/companies/${ctx.input.fixtures.company.id}`);
    return { authenticated: true, companyPrefix: ctx.input.fixtures.company.issuePrefix, personId: session.user.id, originalName: session.user.name, observerId: observer.id,
      observerNameBefore: observer.name, companyName: company.name, agentName: ctx.input.fixtures.agent.name };
  } catch (error) { await observer.dispose(); observers.delete(ctx); throw error; }
}, gradeProfile, {
  authentication: "human-session",
  oracleVersion: "paperclip.chat-catalog.identity-profile.v3",
  sourceFiles: ["chat-catalog-domains/identity-profile.ts", "chat-catalog-domains/internal-comment-reference.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/navigation-preferences.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx));
    // Run settle precedes the reply's render; look for the rendered link only once the saved reply is on the page.
    await waitForRenderedReply(ctx, { leadId: ctx.input.fixtures.agent.id, runs: await ctx.allRuns() });
    state.beforeHumanName = (await ctx.input.api.get<Session>("/api/auth/get-session")).user.name;
    state.agentWriteStatus = await probeAgentPermission(ctx, "/api/auth/profile", "PATCH", { name: "Alex Chen" });
    const source = ctx.input.page.url();
    // The person follows the agent's rendered link when there is one; otherwise the journey still saves the name so the remaining checks report.
    const rendered = ctx.input.page.locator(`[id^="comment-"] a[href$="${PROFILE_EDITOR_PATH}"]`).first();
    state.followedProfileLink = await rendered.count() > 0;
    if (state.followedProfileLink) await rendered.click();
    else await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}${PROFILE_EDITOR_PATH}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page).toHaveURL(new RegExp(`${PROFILE_EDITOR_PATH}$`));
    await expect(ctx.input.page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await ctx.input.page.getByLabel("Display name", { exact: true }).fill("Alex Chen");
    await ctx.input.page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect.poll(async () => (await ctx.input.api.get<Session>("/api/auth/get-session")).user.name).toBe("Alex Chen");
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    state.profileAfterReload = await ctx.input.page.getByLabel("Display name", { exact: true }).inputValue();
    const account = ctx.input.page.getByRole("button", { name: "Open account menu", exact: true });
    await expect(account).toBeVisible();
    state.accountFooterVisible = await account.getByText("Alex Chen", { exact: true }).count() === 1;
    await account.click();
    // The profile page has its own "Alex Chen" heading; check the one inside the opened account popover.
    await expect(ctx.input.page.locator("[data-radix-popper-content-wrapper]").getByRole("heading", { name: "Alex Chen", exact: true })).toBeVisible();
    await ctx.input.page.keyboard.press("Escape");
    await ctx.input.evidence("identity-personal-profile-browser.json", { userId: state.personId, savedName: state.profileAfterReload, accountFooterVisible: state.accountFooterVisible });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const observer = observers.get(ctx); if (!observer) throw new Error("Independent person missing");
    const current = await ctx.input.api.get<Session>("/api/auth/get-session");
    const response = await observer.request("/api/auth/get-session"); if (!response.ok) throw new Error("Independent observer session failed");
    const other = await response.json() as Session;
    state.afterUserId = current.user.id; state.afterName = current.user.name; state.observerNameAfter = other.user.name;
    return observeIdentity(ctx, state);
  },
  async cleanup(ctx, state) {
    try { await updateOwnProfile(ctx, String(state.originalName)); }
    finally { await observers.get(ctx)?.dispose(); observers.delete(ctx); }
  },
})];
async function updateOwnProfile(ctx: ChatCatalogContext, name: string) {
  const response = await ctx.input.page.context().request.patch(`${ctx.input.api.baseURL}/api/auth/profile`, { data: { name }, headers: { Origin: ctx.input.api.baseURL } });
  if (!response.ok()) throw new Error(`Fixture personal profile returned HTTP ${response.status()}`);
}
