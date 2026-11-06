import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { checks } from "./internal-support.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { identityDefinition, identityObservation, observeIdentity, probeAgentPermission, waitForReply } from "./identity-support.js";

interface Session { user: { id: string; name: string; image?: string | null } }
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const observers = new WeakMap<ChatCatalogContext, Person>();
export function gradeProfile(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("real-person-profile-evidence", !!o && o.state.authenticated === true && typeof o.state.personId === "string" && o.state.personId !== "local-board",
    "The result belongs to a real authenticated person and an independently enrolled second user.");
  if (!o) return c.result();
  c.add("agent-guides-human-editor", o.state.beforeHumanName === "Alex Former" && o.state.agentWriteStatus === 403 && /\bprofile\b/i.test(o.reply)
    && !/\bI(?:'ve| have)?\s+(?:changed|updated|renamed)\b/i.test(o.reply), "The agent identifies the personal editor, remains unable to impersonate its user, and leaves the old name until the human acts.");
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
    return { authenticated: true, personId: session.user.id, originalName: session.user.name, observerId: observer.id,
      observerNameBefore: observer.name, companyName: company.name, agentName: ctx.input.fixtures.agent.name };
  } catch (error) { await observer.dispose(); observers.delete(ctx); throw error; }
}, gradeProfile, {
  authentication: "human-session",
  sourceFiles: ["chat-catalog-domains/identity-profile.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/navigation-preferences.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); state.beforeHumanName = (await ctx.input.api.get<Session>("/api/auth/get-session")).user.name;
    state.agentWriteStatus = await probeAgentPermission(ctx, "/api/auth/profile", "PATCH", { name: "Alex Chen" });
    const source = ctx.input.page.url();
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/company/settings/instance/profile`, { waitUntil: "domcontentloaded" });
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
    await expect(ctx.input.page.getByRole("heading", { name: "Alex Chen", exact: true })).toBeVisible();
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
