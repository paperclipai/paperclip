import { expect } from "@playwright/test";
import type { McpConnection } from "../../../packages/shared/src/public-mcp.js";
import { privateGrokOperator } from "./runtime-grok-operator.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { GrokConnection, GrokInvitation } from "../../../packages/shared/src/grok-bot.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { waitForReply } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
import { selectedRuntimeInputs, runtimePrivateSpec } from "./runtime-private.js";
import { privateBrowserEntry } from "./external-private-browser.js";
const confirmation = "I used the supported Grok Bot setup and sent the verification challenge. Check the saved connection and tell me whether it is ready and what capabilities are unavailable.";
const endpoint = (companyId: string, agentId: string) => `/api/companies/${companyId}/agents/${agentId}/grok-binding`;
export function genuineGrokRoundTrip(value: GrokConnection | undefined, bindingId: string, botName: string) {
  const b = value?.binding, r = b?.routine, e = r?.lastExchange;
  return value?.enabled === true && !!value.resourceUrl?.startsWith("https://") && value.agentLifecycleState === "ready" && !value.recoveryNeeded && b?.id === bindingId && b.providerKind === "grok_bot" && b.connected === true && b.wakeVerified === true
    && r?.bindingId === bindingId && r.botName === botName && r.configured === true && r.verified === true && !r.recoveryNeeded && !!r.verifiedAt && !!r.lastContactAt
    && e?.kind === "verify" && e.status === "acknowledged" && !!e.sentAt && !!e.acknowledgedAt && Date.parse(e.acknowledgedAt) >= Date.parse(e.sentAt);
}
export function truthfulGrokCapabilities(reply: string) {
  return /(?:usage|spending|cost|tokens?).*(?:not (?:available|reported|tracked)|unavailable|unknown|cannot|can't)|(?:cannot|can't|does not|doesn't|no).*(?:report|track).*(?:usage|spending|cost)/is.test(reply)
    && /(?:workspace|files?|filesystem).*(?:not|unavailable|unsupported|outside|external|cannot|can't|own)|(?:cannot|can't|no).*(?:access|inspect|browse).*(?:workspace|files?)/is.test(reply)
    && /(?:stop|termination|terminate|execution).*(?:not|cannot|can't|guarantee|inspect|external)|(?:cannot|can't).*(?:stop|terminate|termination)/is.test(reply)
    && !/(?:has|offers|provides) (?:the )?(?:full|same|identical) (?:parity|capabilities).*local|(?:and |it |Paperclip |Stop )(?:guarantees|ensures) remote termination|can guarantee remote termination|(?:usage|cost).*(?:is zero|\$0)/i.test(reply);
}
export function supportedGrokHumanHandoff(reply: string) {
  return /Grok|Bot/i.test(reply) && /Agents|New Agent|invite|runtime|profile|connection|setup|set up/i.test(reply) && /open|visit|go to|click|choose|select|use|you can|you.ll|you will|your browser|complete.*authori[sz]/i.test(reply)
    && !/I(?:['’]ve| have)\s+(?:authorized|connected)|(?:Bot|connection) is (?:already |now )?ready/i.test(reply);
}
export function gradeExistingGrok(value: unknown) {
  const c = checks(), o = runtimeObservation(value); c.add("actual-existing-bot-human-authorization", !!o, "Actual public HTTPS, human OAuth/one-use pairing and authenticated external Bot challenge receipts are required."); if (!o) return c.result();
  const s = o.state, worker = s.worker as Agent | undefined;
  c.add("canonical-guides-supported-authorization-before-ready", s.enabledPublicInstance === true && s.noExistingBotAuthorization === true && s.authorizationUiVisible === true && s.pairingSecretStayedPrivate === true
    && /Grok|Bot/i.test(String(s.initialReply)) && /authori[sz]|connect|setup|set up|MCP|human|browser/i.test(String(s.initialReply)) && !/(?:Bot|it|agent|connection)\s+(?:is\s+)?(?:already\s+|fully\s+|now\s+)?(?:connected|ready)\b(?!\s+(?:once|when|after|pending|only|subject)\b)|(?:already|fully|now)\s+(?:connected|ready)|I(?:['’]ve| have)\s+(?:authorized|connected)/i.test(String(s.initialReply)),
    "The canonical answer starts or points to the real signed-in human flow and does not label the previously unauthorized Bot ready.");
  c.add("real-pairing-and-authenticated-two-way-challenge", s.humanHandoffCompleted === true && s.publicPersonGrantBound === true && s.operatorAvailable === true && s.actualHumanPairingObserved === true && s.sameChosenCompanyAndBot === true && s.realRoundTrip === true && s.routineConfiguredSecurely === true && !!worker
    && o.agents.length === (s.beforeAgentIds as string[]).length + 1 && (s.beforeAgentIds as string[]).every(id => o.agents.some(row => row.id === id)) && worker.companyId === o.companyId && worker.adapterType === "paperclip_runner" && worker.adapterConfig.provider === "grok_bot" && worker.lifecycleState === "ready",
    "The exact chosen company/Bot is bound through genuine external Bot authorization; only its actual authenticated verify acknowledgement makes setup complete.");
  c.add("honest-phase-bound-ready-result-and-capability-limits", s.confirmationBound === true && /ready|connected|verified|round.?trip/i.test(String(s.resultReply)) && truthfulGrokCapabilities(String(s.resultReply))
    && o.runs.length === 2 && o.runs.every(row => row.agentId === o.leadId && row.status === "succeeded") && o.tasks.length === 0 && o.humanQueries.length === 2 && o.humanQueries[1] === confirmation,
    "The explicit factual follow-up's own native reply reports the verified state and unsupported workspace/usage/termination capabilities, without employee work or invented parity.");
  return c.result();
}
export const runtimeGrokCases = [runtimeDefinition("agents.existing-grok-bot", async ctx => {
  const selected = selectedRuntimeInputs(ctx, "agents.existing-grok-bot");
  if (!selected.values.botId.trim() || selected.values.botId.length > 100 || /[\r\n]/.test(selected.values.botId) || selected.values.credentialEnvName !== "PAPERCLIP_CHAT_EVAL_GROK_BOT_TOKEN" || selected.values.challengeMethod !== "authenticated-mcp-routine") throw new Error("Setup blocker: require the actual owned existing Grok desktop Bot name, selected routine key and supported authenticated-mcp-routine challenge");
  const webhook = new URL(selected.values.endpoint); if (webhook.protocol !== "https:" || webhook.username || webhook.password || webhook.hash) throw new Error("Existing Bot webhook must be its actual owned HTTPS routine endpoint");
  const key = selected.reference(selected.values.credentialEnvName); if (!ctx.input.privateSecrets) throw new Error("Grok routine requires the private value sink"); ctx.input.privateSecrets.push(key, selected.values.endpoint);
  await ctx.input.api.patch("/api/instance/settings/experimental", { enableGrokBot: true, enablePublicMcp: true, enableNativeRunner: true });
  await ctx.input.api.patch(`/api/companies/${ctx.input.fixtures.company.id}`, { requireBoardApprovalForNewAgents: false });
  const actual = await ctx.input.api.get<{ enableGrokBot?: boolean; enablePublicMcp?: boolean; enableNativeRunner?: boolean }>("/api/instance/settings/experimental");
  const metadata = await ctx.input.api.get<{ resource?: string; authorization_servers?: string[] }>("/.well-known/oauth-protected-resource/mcp/runner");
  if (!actual.enableGrokBot || !actual.enablePublicMcp || !actual.enableNativeRunner || !metadata.resource?.startsWith("https://") || !metadata.authorization_servers?.every(url => url.startsWith("https://"))) throw new Error("Concrete external prerequisite: actual authenticated publicly reachable HTTPS Runner/MCP instance is required for the owned existing Grok Bot; loopback HTTP or an imitation Bot cannot qualify");
  const publicMetadata = new URL(`/.well-known/oauth-protected-resource${new URL(metadata.resource).pathname}`, metadata.resource);
  const response = await fetch(publicMetadata, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok || (await response.json() as { resource?: string }).resource !== metadata.resource) throw new Error("Actual public HTTPS Bot authorization metadata is not reachable or does not identify this instance");
  const invitation = await ctx.input.api.get<GrokInvitation | null>(`/api/companies/${ctx.input.fixtures.company.id}/grok-invitations`);
  if (invitation) throw new Error("Existing-Bot context must start without any previously authorized Grok invitation/binding");
  const available = await privateGrokOperator(ctx, "availability");
  return { operatorAvailable: available.humanSelectedAuthorizedBot && available.publicPersonMatched, publicPersonId: available.personId, beforeGrantIds: (await ctx.input.api.get<McpConnection[]>("/api/mcp/connections")).map(row => row.id), beforeAgentIds: (await ctx.input.api.get<Agent[]>(`/api/companies/${ctx.input.fixtures.company.id}/agents`)).map(row => row.id), enabledPublicInstance: true, noExistingBotAuthorization: true, publicResourceMatches: true, providerProbes: [{ phase: "setup", operation: "public-mcp-resource-metadata", status: "reachable", usage: "unavailable", cost: "unavailable" }] };
}, gradeExistingGrok, {
  ...runtimePrivateSpec("agents.existing-grok-bot"), authentication: "human-session", coverageGaps: [], expectedRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 900000,
  sourceFiles: ["chat-catalog-domains/runtime-grok.ts", "chat-catalog-domains/runtime-grok-operator.ts", "chat-catalog-domains/runtime-grok-operator-worker.ts", "chat-catalog-domains/runtime-grok-operator-contract.ts", "chat-runtime-private-requirements.ts", "public-mcp-flow.ts", "chat-public-origin.ts", "chat-catalog-domains/external-public-signin.ts", "chat-catalog-domains/external-public-signin-worker.ts", "chat-catalog-domains/external-public-signin-contract.ts", "../../ui/src/pages/Auth.tsx", "../../ui/src/pages/McpConnect.tsx", "../../ui/src/components/AgentSetupPrompt.tsx", "../../ui/src/lib/grok-bot-setup-prompt.ts", "../../ui/src/components/new-agent/GrokBotSetup.tsx", "../../ui/src/components/NewAgentDialog.tsx", "../../ui/src/components/new-agent/AgentBasicsDialog.tsx", "chat-catalog-domains/runtime-private.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/external-private-browser.ts", "chat-catalog-domains/external-private-browser-worker.ts", "chat-catalog-domains/external-grok-private-contract.ts", "../../server/src/routes/grok-bot.ts", "../../server/src/services/grok-bot/routine.ts", "../../server/src/services/dot-runner-broker.ts", "../../server/src/modules/external-agents/dot.ts", "../../server/src/services/public-mcp/oauth.ts", "../../ui/src/components/AgentsToolbar.tsx", "../../ui/src/pages/Agents.tsx", "../../ui/src/components/new-agent/ExternalAgentInviteDialog.tsx", "../../ui/src/components/new-agent/ExternalAgentInviteContent.tsx", "../../ui/src/components/GrokBotConnection.tsx", "../../ui/src/components/new-agent/GrokBotSetupContent.tsx", "chat-scenarios/agents.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const initial = await observeRuntime(ctx, state), source = ctx.input.page.url(), selected = selectedRuntimeInputs(ctx, "agents.existing-grok-bot"); state.initialReply = initial.reply;
    if (!supportedGrokHumanHandoff(initial.reply)) throw new Error("Canonical reply did not direct a supported actual human Grok setup handoff; no UI/API rescue is permitted");
    const invitation = await ctx.input.api.get<GrokInvitation | null>(`/api/companies/${initial.companyId}/grok-invitations`);
    if (invitation && (invitation.agent.botName !== selected.values.botId || invitation.binding?.connected)) throw new Error("Canonical setup selected another Bot or claimed an already authorized target");
    if (!invitation && initial.agents.some(agent => !(state.beforeAgentIds as string[]).includes(agent.id))) throw new Error("Canonical chat created an untracked agent instead of the supported Grok handoff");
    const handoff = await privateGrokOperator(ctx, "setup", invitation?.agent.id), agentId = handoff.agentId!, route = endpoint(initial.companyId, agentId); state.grokAgentId = agentId; state.bindingId = handoff.bindingId;
    state.authorizationUiVisible = handoff.productInvitationUi === true; state.pairingSecretStayedPrivate = handoff.pairingCodeConfinedToPublicForm === true && handoff.privateStorageClean === true && handoff.clipboardClean === true;
    state.humanHandoffCompleted = handoff.accessInstructionsDelivered === true && handoff.routineInstructionsDelivered === true && handoff.publicPairingConsentSubmitted === true && handoff.publicCompanyAgentMatched === true && handoff.clientCallbackApproved === true;
    await ctx.input.evidence("grok-human-handoff.json", { ...handoff, claim: "Human delivery/selection and actual public form submission only; no Bot readiness or provider success is inferred." });
    (state.providerProbes as unknown[]).push({ phase: "actual-operator-handoff", operation: "real-existing-Bot-access-and-routine-instruction-delivery", instructionMessagesDelivered: 2, status: "human-acknowledged-only", usage: "unavailable", cost: "unavailable" });
    const connected = await pollUntil({ label: "Actual same-Bot human OAuth binding", deadlineAt: Date.now() + 60000, load: () => ctx.input.api.get<GrokConnection>(route), accept: row => !!row.binding && row.binding.id === state.bindingId && row.binding.connected,
      reject: row => row.binding && row.binding.id !== state.bindingId ? "Actual external authorization changed the original UI pairing identity" : undefined });
    state.actualHumanPairingObserved = connected.binding?.connected === true;
    const grants = await ctx.input.api.get<McpConnection[]>("/api/mcp/connections"), person = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session"), actual = grants.filter(g => !(state.beforeGrantIds as string[]).includes(g.id) && g.companyId === initial.companyId && g.agent?.id === agentId && g.agent.provider === "grok_bot" && g.scopes.includes("paperclip:agent") && !g.revokedAt);
    state.publicPersonGrantBound = person.user.id === state.publicPersonId && person.user.id === handoff.personId && actual.length === 1; state.actualGrantId = actual[0]?.id;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/agents/${agentId}/runtime`, { waitUntil: "domcontentloaded" });
    const section = ctx.input.page.getByRole("region", { name: "Grok Bot connection", exact: true }); await expect(section).toBeVisible();
    const receipt = await privateBrowserEntry({ mode: "grok-routine-configure", companyId: initial.companyId, grok: { agentId, bindingId: String(state.bindingId), expectedRevision: connected.binding?.routine?.revision ?? 0, botName: selected.values.botId, webhookUrl: selected.values.endpoint }, baseURL: ctx.input.api.baseURL, setupURL: ctx.input.page.url(), providerURL: ctx.input.api.baseURL, credential: selected.reference(selected.values.credentialEnvName), cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) });
    state.routineConfiguredSecurely = receipt.bindingId === state.bindingId && receipt.routineConfigured === true && receipt.routineUiVisible === true && receipt.humanSubmittedSecurely === true && receipt.storageClean === true;
    const configured = await ctx.input.api.get<GrokConnection>(route);
    if (!configured.binding || configured.binding.id !== state.bindingId || !configured.binding.connected || configured.binding.routine?.botName !== selected.values.botId || configured.binding.routine.verified || !configured.binding.routine.configured) throw new Error("The actual saved same-Bot routine configuration did not remain unverified before the real challenge");
    const priorExchangeId = configured.binding.routine.lastExchange?.id;
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await section.getByRole("button", { name: "Verify connection", exact: true }).click();
    const verified = await pollUntil({ label: "Actual authenticated external Bot two-way verification", deadlineAt: Date.now() + 120000, load: () => ctx.input.api.get<GrokConnection>(route), accept: row => genuineGrokRoundTrip(row, String(state.bindingId), selected.values.botId), reject: row => row.binding?.routine?.lastExchange?.status === "rejected" || row.recoveryNeeded || row.binding?.routine?.recoveryNeeded ? "Real Bot challenge rejected or became uncertain; setup is not complete" : undefined });
    state.realRoundTrip = genuineGrokRoundTrip(verified, String(state.bindingId), selected.values.botId) && verified.binding?.routine?.lastExchange?.id !== priorExchangeId; state.sameChosenCompanyAndBot = verified.binding?.routine?.botName === selected.values.botId && verified.binding.id === state.bindingId;
    (state.providerProbes as unknown[]).push({ phase: "actual-existing-bot", operation: "authenticated-routine-verify", status: verified.binding?.routine?.lastExchange?.status, usage: "unavailable", cost: "unavailable" });
    await expect(section.getByText("Routine round trip verified.", { exact: false })).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await sendChatMessage(ctx.input.page, confirmation);
    const result = await pollUntil({ label: "Native CEO explains real Bot readiness and limits", deadlineAt: Date.now() + 180000, load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.every(row => row.status === "succeeded") });
    const run = result.runs.find(row => row.id !== initial.runs[0]!.id)!;
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId && row.body === confirmation), wake = run.contextSnapshot?.wakeCommentIds;
    state.confirmationBound = human.length === 1 && Array.isArray(wake) && wake.length === 1 && wake[0] === human[0]!.id; state.resultReply = comments.filter(row => row.authorAgentId === initial.leadId && row.createdByRunId === run.id).map(row => row.body).join("\n");
    state.worker = await ctx.input.api.get<Agent>(`/api/agents/${agentId}`);
  },
  async cleanup(ctx, state) {
    const companyId = ctx.input.fixtures.company.id, before = state.beforeAgentIds as string[] | undefined;
    if (!before) return;
    const targets = (await ctx.input.api.get<Agent[]>(`/api/companies/${companyId}/agents`)).filter(agent => !before.includes(agent.id) && agent.companyId === companyId && agent.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "grok_bot");
    for (const agent of targets) await ctx.input.api.delete(endpoint(companyId, agent.id));
    const beforeGrants = state.beforeGrantIds as string[] | undefined, grants = await ctx.input.api.get<McpConnection[]>("/api/mcp/connections");
    for (const grant of grants) if (!beforeGrants?.includes(grant.id) && grant.companyId === companyId && targets.some(agent => agent.id === grant.agent?.id) && !grant.revokedAt) await ctx.input.api.delete(`/api/mcp/connections/${grant.id}`);
    const retained = await ctx.input.api.get<McpConnection[]>("/api/mcp/connections"); if (retained.some(grant => grant.companyId === companyId && targets.some(agent => agent.id === grant.agent?.id) && !grant.revokedAt)) throw new Error("Actual owned Grok authority revocation is not confirmed");
    await ctx.input.evidence("grok-owned-authority-cleanup.json", { agentIds: targets.map(agent => agent.id), activeOwnedGrants: 0, externalBotRetained: true, claim: "Only this attempt's Paperclip authority is revoked. The user-owned Bot, account-wide plugin and designated reusable routine are retained; remote global termination is not claimed." });
  },
})];
