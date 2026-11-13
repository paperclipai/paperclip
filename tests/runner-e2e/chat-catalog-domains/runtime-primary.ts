import { expect } from "@playwright/test";
import { checks, type Entity } from "./internal-support.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { probeAgentPermission, waitForReply, waitForTurnReplyLinks, remainingIdentityObservationBudget } from "./identity-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, observeRuntime, openRuntimeAgentProfile, verifyRuntimeResult, agentLink, type RuntimeAgent } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
interface Primary { companyId: string; userId: string; primaryAgentId: string | null }
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const people = new WeakMap<ChatCatalogContext, Person>();
const endpoint = (companyId: string) => `/api/companies/${companyId}/primary-agent/me`;
async function personPrimary(person: Person, companyId: string): Promise<Primary> {
  const response = await person.request(endpoint(companyId));
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Secondary primary read returned ${response.status}`); }
  return response.json() as Promise<Primary>;
}
export function gradePrimary(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("complete-human-primary-evidence", !!o, "Real user-scoped saved preferences and human replacement control are required."); if (!o) return c.result();
  const worker = o.state.worker as RuntimeAgent; const before = o.state.primaryBefore as Primary;
  const after = o.state.primaryAfter as Primary | undefined; const otherBefore = o.state.otherPersonBefore as Primary;
  const otherAfter = o.state.otherPersonAfter as Primary | undefined;
  c.add("only-human-replaces-existing-primary", !!before && before.primaryAgentId === o.leadId
    && o.state.beforeHumanPrimary === o.leadId && o.state.replacementConfirmed === true
    && after?.primaryAgentId === worker.id && after.companyId === o.companyId && after.userId === before.userId,
    "The original primary survives the chat response and is replaced only after the visible human confirmation.");
  c.add("agent-preference-write-denied", o.state.agentWriteStatus === 403, "The preference endpoint rejects the real CEO agent bearer.");
  c.add("other-person-company-unaffected", !!otherAfter && !!otherBefore && otherAfter.userId !== before.userId
    && JSON.stringify(otherAfter) === JSON.stringify(otherBefore)
    && JSON.stringify(o.state.otherCompanyAfter) === JSON.stringify(o.state.otherCompanyBefore),
    "Independent authenticated person and company preference readbacks do not change.");
  c.add("recent-chat-precedence-without-work", o.state.reopenedRecentAgent === o.leadId
    && o.state.runsAfterNavigation === 1 && o.state.chatCountBeforeNavigation === o.state.chatCountAfterNavigation,
    "Opening Chat may reopen this valid recent source conversation and creates no duplicate chat or execution.");
  // The reply's wording is not graded: the person must reach the control
  // through the exact profile link the reply rendered, and saved state proves
  // the agent wrote nothing before that human confirmation.
  const href = agentLink(o, worker);
  c.add("reply-links-chosen-profile", !!href && o.state.profileLinkFollowed === href,
    "The reply links Morgan's profile, and the person reaches the primary control by clicking that rendered link.");
  return c.result();
}
export async function verifyReadyPrimaryChat(ctx: ChatCatalogContext, state: Record<string, unknown>, value: unknown) {
  const o = runtimeObservation(value); const before = state.primaryBefore as Primary; const worker = state.worker as RuntimeAgent;
  const sourceId = state.sourceBeforeNavigation; const nativeIds = state.nativeIdsBeforeNavigation;
  if (!o || o.companyId !== ctx.input.fixtures.company.id || o.leadId !== ctx.input.fixtures.agent.id
    || typeof sourceId !== "string" || !sourceId || !Array.isArray(nativeIds) || nativeIds.length !== 1 || typeof nativeIds[0] !== "string")
    throw new Error("Primary Chat readiness requires its exact original conversation and native run");
  const budget = () => remainingIdentityObservationBudget(ctx);
  const lead = o.agents.find(row => row.id === o.leadId); if (!lead) throw new Error("Primary Chat lead is missing");
  await expect(ctx.input.page).toHaveURL(url => {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length === 3 && parts[0] === ctx.input.fixtures.company.issuePrefix && parts[1] === "chats" && [lead.id, lead.urlKey].includes(parts[2]);
  }, { timeout: budget() }); budget();
  const composer = ctx.input.page.getByTestId("task-chat-composer-input");
  await expect(composer).toBeVisible({ timeout: budget() }); budget();
  await expect(composer.locator('[contenteditable="true"], textarea').first()).toBeEditable({ timeout: budget() }); budget();
  const chat = await ctx.input.api.get<Entity & { conversationAgentId?: string; conversationUserId?: string }>(`/api/companies/${o.companyId}/chats/${o.leadId}`, { timeout: budget() }); budget();
  if (chat.id !== sourceId || chat.companyId !== o.companyId || chat.conversationAgentId !== o.leadId || chat.conversationUserId !== before.userId)
    throw new Error("Ready Chat reopened a different conversation or person");
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${sourceId}/comments?order=asc`, { timeout: budget() }); budget();
  const humans = comments.filter(row => !row.authorAgentId);
  const reply = comments.find(row => row.authorAgentId === o.leadId && row.createdByRunId === nativeIds[0] && !!row.body?.trim());
  if (humans.length !== 1 || humans[0]!.authorUserId !== before.userId || humans[0]!.body?.trim() !== ctx.scenario.query.trim() || !reply)
    throw new Error("Ready Chat lacks its original human request and native response");
  for (const comment of [humans[0]!, reply]) {
    await expect(ctx.input.page.locator(`[id=${JSON.stringify(`comment-${comment.id}`)}]`)).toBeVisible({ timeout: budget() }); budget();
  }
  await ctx.refreshIssue(); budget();
  const primary = await ctx.input.api.get<Primary>(endpoint(o.companyId), { timeout: budget() }); budget();
  const chats = await ctx.input.api.get<Entity[]>(`/api/companies/${o.companyId}/chats`, { timeout: budget() }); budget();
  const runs = await ctx.allRuns(); budget();
  if (ctx.issue()?.id !== sourceId || primary.companyId !== o.companyId || primary.userId !== before.userId || primary.primaryAgentId !== worker.id
    || chats.length !== state.chatCountBeforeNavigation || chats.filter(row => row.id === sourceId).length !== 1
    || runs.length !== 1 || runs[0]?.id !== nativeIds[0] || runs[0].agentId !== o.leadId || runs[0].status !== "succeeded")
    throw new Error("Settled Chat changed the primary preference, conversation or native work");
  state.reopenedRecentAgent = o.leadId; state.runsAfterNavigation = runs.length; state.chatCountAfterNavigation = chats.length;
  await ctx.input.evidence("chat-primary-ready-conversation.json", { companyId: o.companyId, agentId: o.leadId, sourceId, userId: before.userId,
    primaryAgentId: primary.primaryAgentId, originalNativeIds: nativeIds, chatCount: chats.length, composerReady: true, originalConversationVisible: true, noExtraWork: true }); budget();
}
export const runtimePrimaryCases = [runtimeDefinition("agents.choose-primary", async ctx => {
  const secrets = ctx.input.privateSecrets; if (!secrets) throw new Error("Primary fixture requires private credential sink");
  const browser = ctx.input.page.context().browser(); if (!browser) throw new Error("Real browser required");
  const primaryBefore = await ctx.input.api.get<Primary>(endpoint(ctx.input.fixtures.company.id));
  if (primaryBefore.primaryAgentId !== ctx.input.fixtures.agent.id) throw new Error("Catalog requires an existing primary agent");
  const worker = await runtimeWorker(ctx);
  const person = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets, name: "Second primary reader" }); people.set(ctx, person);
  await enrollPrerequisitePerson(ctx, person, "operator");
  const otherCompany = await ctx.input.api.post<Entity>("/api/companies", { name: `Other primary company ${ctx.input.nonce}` });
  return { worker, primaryBefore, otherCompany, otherPersonBefore: await personPrimary(person, ctx.input.fixtures.company.id),
    otherCompanyBefore: await ctx.input.api.get<Primary>(endpoint(otherCompany.id)) };
}, gradePrimary, {
  authentication: "human-session", oracleVersion: "paperclip.chat-catalog.runtime-primary.v4",
  sourceFiles: ["chat-catalog-domains/runtime-primary.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/agents.yaml"],
  async act(ctx, state) {
    remainingIdentityObservationBudget(ctx);
    await waitForReply(ctx, ctx.observationDeadlineAt);
    remainingIdentityObservationBudget(ctx);
    const worker = state.worker as RuntimeAgent;
    state.beforeHumanPrimary = (await ctx.input.api.get<Primary>(endpoint(ctx.input.fixtures.company.id))).primaryAgentId;
    state.agentWriteStatus = await probeAgentPermission(ctx, endpoint(ctx.input.fixtures.company.id), "PUT", { primaryAgentId: worker.id });
    // The run is recorded finished before its reply is saved and rendered; read the reply's links only once it is on the page.
    await waitForTurnReplyLinks(ctx);
    const o = await observeRuntime(ctx, state);
    const source = ctx.input.page.url();
    const href = agentLink(o, worker);
    if (!href) throw new Error("The reply rendered no link to Morgan's profile for the person to follow");
    await openRuntimeAgentProfile(ctx, worker, o);
    state.profileLinkFollowed = href;
    await ctx.input.page.getByRole("button", { name: "Set as my primary", exact: true }).click();
    const dialog = ctx.input.page.getByRole("alertdialog");
    await expect(dialog).toContainText("Change your primary agent?"); await expect(dialog).toContainText("Morgan");
    await dialog.getByRole("button", { name: "Set as my primary", exact: true }).click();
    await expect(ctx.input.page.getByRole("img", { name: "My primary agent", exact: true }).first()).toBeVisible();
    state.replacementConfirmed = true;
    // Revisit the valid recent source before opening the normal Chat landing.
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    const chats = `/api/companies/${ctx.input.fixtures.company.id}/chats`;
    state.chatCountBeforeNavigation = (await ctx.input.api.get<Entity[]>(chats)).length;
    state.sourceBeforeNavigation = ctx.issue()?.id;
    state.nativeIdsBeforeNavigation = (await ctx.allRuns()).map(run => run.id);
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/chats`, { waitUntil: "domcontentloaded" });
    const lead = o.agents.find(row => row.id === ctx.input.fixtures.agent.id)!;
    await ctx.input.page.waitForURL(url => [lead.id, lead.urlKey].includes(decodeURIComponent(url.pathname.split("/").at(-1)!)));
    await verifyReadyPrimaryChat(ctx, state, o);
  },
  async observe(ctx, state) {
    const person = people.get(ctx); if (!person) throw new Error("Secondary authenticated person missing");
    state.primaryAfter = await ctx.input.api.get<Primary>(endpoint(ctx.input.fixtures.company.id));
    state.otherPersonAfter = await personPrimary(person, ctx.input.fixtures.company.id);
    state.otherCompanyAfter = await ctx.input.api.get<Primary>(endpoint((state.otherCompany as Entity).id));
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state, value) {
    remainingIdentityObservationBudget(ctx);
    await verifyRuntimeResult(ctx, state, value);
    remainingIdentityObservationBudget(ctx);
    await verifyReadyPrimaryChat(ctx, state, value);
  },
  async cleanup(ctx, state) {
    const person = people.get(ctx); people.delete(ctx); await person?.dispose();
    await ctx.input.api.delete(`/api/companies/${(state.otherCompany as Entity).id}`, { allowNotFound: true });
  },
})];
