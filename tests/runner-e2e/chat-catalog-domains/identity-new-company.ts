import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import { finishNativeNewCompany, type NewCompanyNativeReceipt } from "./identity-new-company-native.js";
import { NEW_COMPANY_NATIVE_MODEL } from "./identity-new-company-native-proof.js";
import { checks, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity, readAgentResource, remainingIdentityObservationBudget, waitForReply } from "./identity-support.js";

const companies = new WeakMap<ChatCatalogContext, string>();
const connections = new WeakMap<ChatCatalogContext, Array<{ companyId: string; connectionId: string; grantId: string }>>();
export function gradeNewCompany(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-human-company-onboarding", !!o, "Actual human wizard, first-account readiness and separate company/agent authority are required."); if (!o) return c.result();
  const wizard = o.state.wizard as NewCompanyNativeReceipt | undefined; const agent = o.state.newAgent as Agent | undefined;
  c.add("guidance-before-human-creation", o.state.companyCountAfterReply === 1 && /website|business/i.test(o.reply) && /onboarding|creat.*(?:company|organization)|company.*(?:flow|wizard|switcher)|organization.*(?:wizard|switcher)/i.test(o.reply)
    && !/\bI(?:'ve| have)?\s+(?:created|set up)\s+(?:a |the |your )?(?:new )?(?:company|organization)/i.test(o.reply), "The source agent preserves the website-business request and guides the actual person without claiming it created another company.");
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
    && o.state.sourceMembershipsUnchanged === true && o.state.sourceAccountsUnchanged === true, "The human flow creates one company/first agent without duplicating source identities, dispatching nonexistent work, leaking credentials or changing original memberships.");
  return c.result();
}
export const newCompanyIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("onboarding.new-company", async ctx => {
  if (!ctx.input.privateInputs?.credentials.OPENROUTER_API_KEY) throw new Error("Setup blocker: human company onboarding needs declared private OPENROUTER_API_KEY for the actual native1017 setup");
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  return { sourceAccounts: await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/ai-connections`), humanId: session.user.id, sourceMembers: await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/members`) };
}, gradeNewCompany, {
  authentication: "human-session", requiredCredentials: ["OPENROUTER_API_KEY"], attemptTimeoutMs: 600_000,
  sourceFiles: ["chat-catalog-domains/identity-new-company.ts", "chat-catalog-domains/identity-new-company-native.ts", "chat-catalog-domains/identity-new-company-native-proof.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/onboarding.yaml"],
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
    state.sourceMembershipsUnchanged = JSON.stringify(state.sourceMembers) === JSON.stringify(await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/members`));
    return observeIdentity(ctx, state);
  },
  async cleanup(ctx) {
    const id = companies.get(ctx), owned = connections.get(ctx) ?? [];
    try { for (const connection of owned) if (connection.companyId === id) await ctx.input.api.delete(`/api/tool-connections/${connection.connectionId}`, { allowNotFound: true }); }
    finally { try { if (id) await ctx.input.api.delete(`/api/companies/${id}`, { allowNotFound: true }); } finally { companies.delete(ctx); connections.delete(ctx); } }
  },
})];
