import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import { finishNativeNewCompany, type NewCompanyNativeReceipt } from "./identity-new-company-native.js";
import { NEW_COMPANY_NATIVE_MODEL } from "./identity-new-company-native-proof.js";
import { checks, type Entity } from "./internal-support.js";
import { replyOrCardLinks, replyOrCardText, turnResponseCards } from "./turn-response-card.js";
import { identityDefinition, identityObservation, observeIdentity, readAgentResource, remainingIdentityObservationBudget, waitForReply } from "./identity-support.js";

const companies = new WeakMap<ChatCatalogContext, string>();
const connections = new WeakMap<ChatCatalogContext, Array<{ companyId: string; connectionId: string; grantId: string }>>();
const originals = new WeakMap<ChatCatalogContext, { companyName: string; companyDescription: string | null; personName: string }>();
/** The person's existing company: an ordinary business unrelated to the website business they ask to set up. */
export const SOURCE_COMPANY_PROFILE = { name: "Harbor Analytics", description: "Data analytics consulting for regional retailers." };
export const SOURCE_PERSON_NAME = "Jordan Avery";
/** Put back the source company's and the person's own names; called on a failed setup and at cleanup. */
async function restoreOriginalNames(ctx: ChatCatalogContext) {
  const original = originals.get(ctx); if (!original) return;
  try {
    await ctx.input.api.patch(`/api/companies/${ctx.input.fixtures.company.id}`, { name: original.companyName, description: original.companyDescription });
    await ctx.input.page.context().request.patch(`${ctx.input.api.baseURL}/api/auth/profile`, { data: { name: original.personName }, headers: { Origin: ctx.input.api.baseURL } });
  } finally { originals.delete(ctx); }
}
/** The unprefixed onboarding route, which opens the new-organization wizard. */
export function isCompanyCreationFlow(href: string, origin: string) {
  try { const url = new URL(href, origin); return url.origin === new URL(origin).origin && url.pathname.replace(/\/+$/, "") === "/onboarding"; } catch { return false; }
}
interface MemberRow { id?: string; principalType?: string; principalId?: string; status?: string; membershipRole?: string; grants?: Array<{ permissionKey?: string; scope?: unknown }> }
const memberRows = (value: unknown): MemberRow[] | undefined => {
  const rows = (value as { members?: unknown } | undefined)?.members;
  return Array.isArray(rows) ? rows as MemberRow[] : undefined;
};
/** Who belongs to the company, in which role and status, with which grants; timestamps and profiles are ignored. */
export function sourceMembershipChanges(before: unknown, after: unknown): string[] {
  const old = memberRows(before), now = memberRows(after);
  if (!old || !now) return [!old ? "before-state missing" : "after-state missing"];
  const grants = (row: MemberRow) => (row.grants ?? []).map(grant => `${grant.permissionKey}:${JSON.stringify(grant.scope ?? null)}`).sort().join(",");
  const key = (row: MemberRow) => `${row.principalType}:${row.principalId}`;
  const changes: string[] = [];
  for (const row of old) {
    const match = now.find(next => key(next) === key(row));
    if (!match) { changes.push(`${key(row)} removed`); continue; }
    for (const field of ["id", "status", "membershipRole"] as const) if (match[field] !== row[field]) changes.push(`${key(row)} ${field} ${row[field]} -> ${match[field]}`);
    if (grants(match) !== grants(row)) changes.push(`${key(row)} grants ${grants(row)} -> ${grants(match)}`);
  }
  for (const row of now) if (!old.some(prior => key(prior) === key(row))) changes.push(`${key(row)} added as ${row.membershipRole}`);
  return changes;
}
export function gradeNewCompany(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-human-company-onboarding", !!o, "Actual human wizard, first-account readiness and separate company/agent authority are required."); if (!o) return c.result();
  const wizard = o.state.wizard as NewCompanyNativeReceipt | undefined; const agent = o.state.newAgent as Agent | undefined;
  // A question card the run ended its turn on is that turn's reply (decision after full cohort 4): its text and the
  // links it renders count. The guidance is graded structurally: the response links the board-only company-creation
  // flow (/onboarding, which opens the new-organization wizard; /<prefix>/onboarding only adds an agent to the
  // current company) and carries the requested business (setup literal from the query). Saved state, not wording,
  // proves the agent created no company: one company exists when it answered.
  const cards = turnResponseCards({ companyId: o.companyId, leadId: o.leadId, runs: o.runs, interactions: o.interactions });
  c.add("guidance-before-human-creation", o.state.companyCountAfterReply === 1 && /website|business/i.test(replyOrCardText(o.reply, cards))
    && replyOrCardLinks(o.links, cards).some(href => isCompanyCreationFlow(href, o.origin)),
    "The source agent preserves the website-business request and links the person to the company-creation flow, creating no company itself.");
  c.add("actual-ready-company-and-ceo", !!wizard && wizard.companyId !== o.companyId && agent?.id === wizard.firstAgentId && agent.companyId === wizard.companyId
    && agent.role === "ceo" && agent.lifecycleState === "ready" && wizard.firstAgentReady && wizard.hiredThroughPublicSetup && wizard.actualHarness === "opencode_local"
    && wizard.model === NEW_COMPANY_NATIVE_MODEL && wizard.noAgentBeforeRouteDeparture && wizard.savedSetupAgentId === agent.id
    && wizard.helloCount === 1 && wizard.hireCount === 1 && wizard.exactPublicGrantAndAgentInstall
    && wizard.hello.checks.some(check => check.code === "opencode_hello_probe_passed") && wizard.account.ownership === "personal"
    && wizard.account.ownerUserId === o.state.humanId && wizard.account.responsibleUserId === o.state.humanId && o.state.humanRoleConfigurationStatus === 200,
    "The human creates a real company and reuses its saved first-CEO setup through the public OpenCode1017 local native test and hire; account/grant, company and agent remain independently bound.");
  c.add("distinct-human-and-agent-authority", !!wizard && wizard.companyId !== wizard.firstAgentId && wizard.firstAgentId !== o.leadId
    && o.state.newCompanyOwnedByHuman === true && o.state.oldAgentForeignReadStatus === 403 && o.state.newAgentVisible === true && o.state.oldAgentStillSourceCompany === true,
    "The same real human owns the new company, its CEO is a separate actual agent, and the original agent retains only its source-company access.");
  c.add("no-duplicate-or-secret-leak", !!wizard && wizard.beforeCompanyIds.length === 1 && wizard.beforeCompanyIds[0] === o.companyId
    && wizard.afterCompanyIds.length === 2 && new Set(wizard.afterCompanyIds).size === 2 && wizard.afterAgentIds.length === 1
    && wizard.draftContainsCredential === false && wizard.publicAgentContainsCredential === false && wizard.heartbeatRunIds.length === 0
    && o.state.sourceAccountsUnchanged === true, "The human flow creates one company/first agent without duplicating source identities, dispatching nonexistent work or leaking credentials.");
  // Membership identity, role, status and permission grants are compared, not the whole response (which also
  // carries timestamps and the person's profile); the saved before/after and the listed changes say what moved.
  const membershipChanges = sourceMembershipChanges(o.state.sourceMembers, o.state.sourceMembersAfter);
  c.add("source-memberships-unchanged", membershipChanges.length === 0,
    `The original company's memberships, roles and grants are unchanged by the new company.${membershipChanges.length ? ` Changed: ${membershipChanges.join("; ")}` : ""}`);
  return c.result();
}
export const newCompanyIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("onboarding.new-company", async ctx => {
  if (!ctx.input.privateInputs?.credentials.OPENROUTER_API_KEY) throw new Error("Setup blocker: human company onboarding needs declared private OPENROUTER_API_KEY for the actual native1017 setup");
  const session = await ctx.input.api.get<{ user: { id: string; name: string } }>("/api/auth/get-session");
  // The shared fixture names read as generated ("Company <hex>", "Operations company", a sign-up named after the
  // harness), and in full cohort 4 the CEO reasoned from them that the request was a graded test. A person's
  // existing company and own name look like these instead; both are restored at cleanup.
  const companyPath = `/api/companies/${ctx.input.fixtures.company.id}`;
  const before = await ctx.input.api.get<{ name: string; description: string | null; issuePrefix: string }>(companyPath);
  originals.set(ctx, { companyName: before.name, companyDescription: before.description, personName: session.user.name });
  try {
    await ctx.input.api.patch(companyPath, SOURCE_COMPANY_PROFILE);
    if ((await ctx.input.api.get<{ issuePrefix: string }>(companyPath)).issuePrefix !== before.issuePrefix) throw new Error("Setup blocker: renaming the source company changed its task prefix");
    const renamed = await ctx.input.page.context().request.patch(`${ctx.input.api.baseURL}/api/auth/profile`, { data: { name: SOURCE_PERSON_NAME }, headers: { Origin: ctx.input.api.baseURL } });
    if (!renamed.ok()) throw new Error("Setup blocker: the person's profile name could not be set");
    return { sourceAccounts: await ctx.input.api.get(`${companyPath}/ai-connections`), humanId: session.user.id, sourceMembers: await ctx.input.api.get(`${companyPath}/members`) };
  } catch (error) { await restoreOriginalNames(ctx); throw error; }
}, gradeNewCompany, {
  authentication: "human-session", requiredCredentials: ["OPENROUTER_API_KEY"], attemptTimeoutMs: 600_000,
  // v2: the guidance is graded on the creation-flow link and saved company count (a response card counts as the
  // reply), memberships are compared by identity/role/grants with the after-state saved, and the source company and
  // person carry realistic names.
  oracleVersion: "paperclip.chat-catalog.identity.new-company.v2",
  sourceFiles: ["chat-catalog-domains/identity-new-company.ts", "chat-catalog-domains/turn-response-card.ts", "chat-rendered-links.ts", "chat-catalog-domains/identity-new-company-native.ts", "chat-catalog-domains/identity-new-company-native-proof.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/onboarding.yaml"],
  async act(ctx, state) {
    remainingIdentityObservationBudget(ctx);
    const originalDeadlineAt = ctx.observationDeadlineAt!;
    await waitForReply(ctx, originalDeadlineAt);
    remainingIdentityObservationBudget(ctx);
    state.companyCountAfterReply = (await ctx.input.api.get<unknown[]>("/api/companies")).length;
    if (state.companyCountAfterReply !== 1) throw new Error("The source agent changed company identities before the human wizard");
    remainingIdentityObservationBudget(ctx);
    const credential = ctx.input.privateInputs!.credentials.OPENROUTER_API_KEY!; ctx.input.privateSecrets!.push(credential); const source = ctx.input.page.url();
    const wizard = await finishNativeNewCompany({ page: ctx.input.page, origin: ctx.input.api.baseURL, companyName: `Acorn Website Business ${ctx.input.nonce}`, agentName: "Website business CEO", credential,
      deadlineAt: Math.min(originalDeadlineAt, Date.now() + 360_000), evidence: ctx.input.evidence, onCompany(id) { companies.set(ctx, id); },
      onConnection(companyId, connectionId, grantId) { connections.set(ctx, [...(connections.get(ctx) ?? []), { companyId, connectionId, grantId }]); } });
    state.wizard = wizard;
    // Retain the explicit authenticated human role configuration/readback.
    // The normal first-agent dialog already selected CEO for this empty company.
    const configured = await ctx.input.page.context().request.patch(`${ctx.input.api.baseURL}/api/agents/${wizard.firstAgentId}`, { data: { role: "ceo", title: "Website business CEO" }, headers: { Origin: ctx.input.api.baseURL } });
    state.humanRoleConfigurationStatus = configured.status(); if (!configured.ok()) throw new Error("Human public CEO configuration failed");
    state.newAgent = await ctx.input.api.get<Agent>(`/api/agents/${wizard.firstAgentId}`);
    const membership = await ctx.input.api.get<{ members: Array<{ principalId: string; membershipRole: string }> }>(`/api/companies/${wizard.companyId}/members`);
    state.newCompanyOwnedByHuman = membership.members.some(member => member.principalId === state.humanId && member.membershipRole === "owner");
    state.oldAgentForeignReadStatus = (await readAgentResource(ctx, `/api/companies/${wizard.companyId}/agents`)).status;
    const company = await ctx.input.api.get<Entity & { issuePrefix: string }>(`/api/companies/${wizard.companyId}`);
    await ctx.input.page.goto(`/${company.issuePrefix}/agents/${wizard.firstAgentId}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("Website business CEO", { exact: true }).first()).toBeVisible(); state.newAgentVisible = true;
    await ctx.input.evidence("identity-human-new-company-authority.json", { sourceCompanyId: ctx.input.fixtures.company.id, newCompanyId: wizard.companyId, newAgentId: wizard.firstAgentId,
      humanId: state.humanId, actualCeoRole: (state.newAgent as Agent).role, roleStep: "authenticated-human-public-configuration", originalAgentForeignReadStatus: state.oldAgentForeignReadStatus });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    state.oldAgentStillSourceCompany = (await ctx.input.api.get<Agent>(`/api/agents/${ctx.input.fixtures.agent.id}`)).companyId === ctx.input.fixtures.company.id;
    state.sourceAccountsUnchanged = JSON.stringify(state.sourceAccounts) === JSON.stringify(await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/ai-connections`));
    state.sourceMembersAfter = await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/members`);
    state.sourceMembershipChanges = sourceMembershipChanges(state.sourceMembers, state.sourceMembersAfter);
    return observeIdentity(ctx, state);
  },
  async cleanup(ctx) {
    const id = companies.get(ctx), owned = connections.get(ctx) ?? [];
    try { for (const connection of owned) if (connection.companyId === id) await ctx.input.api.delete(`/api/tool-connections/${connection.connectionId}`, { allowNotFound: true }); }
    finally { try { if (id) await ctx.input.api.delete(`/api/companies/${id}`, { allowNotFound: true }); } finally {
      try { await restoreOriginalNames(ctx); } finally { companies.delete(ctx); connections.delete(ctx); }
    } }
  },
})];
