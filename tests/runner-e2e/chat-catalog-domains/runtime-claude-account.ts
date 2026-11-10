import { expect } from "@playwright/test";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import type { ConnectionIntentSetupOptions } from "../../../packages/shared/src/types/connection-intent.js";
import type { ConnectionIntentInteraction } from "../../../packages/shared/src/types/issue.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { ActivityEvent } from "../../../packages/shared/src/types/activity.js";
import type { AiConnectionList } from "../../../packages/shared/src/ai-connections.js";
import { agentHarnessType } from "../../../packages/shared/src/agent-runner.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { waitForReply } from "./identity-support.js";
import { matchesClaudeFixtureTarget, privateClaudeOperation, type ClaudePrivateReceipt } from "./runtime-claude-private.js";
import { selectedRuntimeInputs, runtimePrivateSpec } from "./runtime-private.js";
import { clickInteractionAction, openRuntimeAgentProfile, observeRuntime, runtimeDefinition, runtimeObservation, type RuntimeAgent } from "./runtime-support.js";
const continueHire = "The Anthropic account is connected now. Continue the same Morgan frontend engineer hire using Claude Code.";
export function supportedClaudeSetupLink(href: string, origin: string, prefix: string) {
  try { const url = new URL(href, origin); return url.origin === origin && url.pathname.startsWith(`/${prefix}/`) && (url.pathname.endsWith("/company/settings/connections") || url.pathname.endsWith("/apps/connect") && ["anthropic", "claude"].includes(url.searchParams.get("source") ?? url.searchParams.get("provider") ?? "")); } catch { return false; }
}
export function completedClaudeSetupMatches(input: { request: ConnectionIntentInteraction | undefined; sourceId: string; sourceRunId: string; companyId: string; humanId: string; connectionId: string }) {
  const r = input.request;
  return !!r && r.kind === "connection_intent" && r.issueId === input.sourceId && r.companyId === input.companyId && r.sourceRunId === input.sourceRunId && r.addresseeUserId === input.humanId
    && r.payload.serviceSlug === "anthropic" && r.status === "accepted" && r.resolvedByUserId === input.humanId && !r.resolvedByAgentId && r.result?.outcome === "connected" && r.result.connectionId === input.connectionId;
}
export function gradeClaudeAccount(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("genuine-missing-account-and-human-resumption-evidence", !!o, "Installed Claude, an actually absent eligible account, exact canonical waiting reply, real human connection and separately attributed continuation are required."); if (!o) return c.result();
  const s = o.state, workers = o.agents.filter(row => row.name === "Morgan"), worker = workers[0] as (RuntimeAgent & Pick<Agent, "role" | "capabilities">) | undefined, first = String(s.waitingReply), validation = s.savedValidation as ClaudePrivateReceipt | undefined;
  c.add("truthful-account-setup-with-original-hire-details", s.initialAnthropicAccounts === 0 && s.actualInstalledClaude === true && s.supportedSetupVisible === true
    && /Morgan|frontend|this hire|requested (?:hire|engineer)/i.test(first) && /Claude|Anthropic|coding|provider|model/i.test(first) && /account|connect|sign.?in|authenticat/i.test(first) && /need|wait|setup|set up|missing|before|blocked|to (?:finish|continue|complete)|requires|until|once|when/i.test(first)
    && !/Morgan\s+(?:(?:is|now|already)\s+){1,2}(?:fully\s+)?ready\b(?!\s+(?:once|when|after|pending|only once|only after|subject to)\b)|\bI(?:['’]ve| have)?\s+(?:already\s+)?(?:connected|authorized|authenticated)\b/i.test(first) && s.noUsableMorganBeforeHuman === true && (!s.setupRequestId || s.setupRequestReconciled === true),
    "The first reply preserves the Morgan/Claude request and directs the responsible human to actual supported setup, without a ready hire or alternate harness before account access exists.");
  c.add("actual-human-account-followed-by-one-same-hire", s.accountOwnerIsHuman === true && s.humanAccountConnected === true && s.continuationMessageBound === true && workers.length === 1 && !!worker
    && worker.companyId === o.companyId && worker.lifecycleState === "ready" && ["idle", "active"].includes(worker.status ?? "") && worker.role === "engineer" && /frontend|front.end/i.test(`${worker.title ?? ""} ${worker.capabilities ?? ""}`)
    && agentHarnessType(worker.adapterType ?? "", worker.adapterConfig) === "claude_local" && (!s.beforeMorganId || s.beforeMorganId === worker.id) && (!s.autoMorganId || s.autoMorganId === worker.id)
    && s.actualAccountBinding === true && validation?.probeStatus === "pass" && validation.agentId === worker.id,
    "The signed-in human really connects the selected Anthropic account; the same preserved request then produces one usable permanent frontend Claude hire, preserving any initial pending identity.");
  c.add("phase-attributed-durable-reply-and-no-unrequested-work", /Morgan|frontend|engineer|hire/i.test(String(s.continuationReply)) && /creat|hir|saved|added|complete|ready|connected/i.test(String(s.continuationReply))
    && o.humanQueries.length === 2 && o.humanQueries[1] === continueHire && o.tasks.length === 0 && o.runs.length === (s.setupAutoWakeExpected ? 3 : 2) && (!s.setupAutoWakeExpected || s.setupAutoWakeBound === true) && o.runs.every(row => row.status === "succeeded" && row.agentId === o.leadId)
    && o.activity.some(row => ["agent.created", "agent.hire_created"].includes(row.action ?? "") && row.entityId === worker?.id && row.actorId === o.leadId && row.actorType === "agent" && [s.initialRunId, s.continuationRunId].includes((row as unknown as ActivityEvent).runId)),
    "Only the two declared real human turns run; the second turn's actual native reply reports the saved hire and no employee work or duplicate agent is introduced.");
  return c.result();
}
export const runtimeClaudeAccountCases = [runtimeDefinition("agents.hire-needs-account", async ctx => {
  const selected = selectedRuntimeInputs(ctx, "agents.hire-needs-account"), companyId = ctx.input.fixtures.company.id;
  if (selected.values.targetRef !== "fixture.environment" || selected.values.accountBindingRef !== "selected.ANTHROPIC_API_KEY" || !ctx.input.privateSecrets) throw new Error("Setup blocker: require qualified owned fixture.environment, selected Anthropic credential and private redaction sink");
  const [detail, listed, company, accounts, agents] = await Promise.all([ctx.input.api.get<Environment>(`/api/environments/${ctx.input.fixtures.environment.id}`), ctx.input.api.get<Environment[]>(`/api/companies/${companyId}/environments`), ctx.input.api.get<{ id: string }>(`/api/companies/${companyId}`), ctx.input.api.get<AiConnectionList>(`/api/companies/${companyId}/ai-connections`), ctx.input.api.get<RuntimeAgent[]>(`/api/companies/${companyId}/agents`)]);
  if (!matchesClaudeFixtureTarget({ company, expectedCompanyId: companyId, fixtureEnvironmentId: ctx.input.fixtures.environment.id, detail, listed }) || accounts.connections.some(row => row.provider === "anthropic" && row.status === "connected") || agents.some(row => row.name === "Morgan")) throw new Error("The missing-account context requires actual installed local Claude, absent Anthropic access and absent Morgan");
  const key = selected.credentials.ANTHROPIC_API_KEY!; ctx.input.privateSecrets.push(key);
  const available = await privateClaudeOperation({ operation: "check-harness", harnessExecutable: selected.values.harnessExecutable, companyId, environmentId: detail.id, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) }, key);
  await ctx.input.api.patch(`/api/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
  return { selectedEnvironmentId: detail.id, initialAnthropicAccounts: 0, actualInstalledClaude: available.probeStatus === "pass", providerProbes: [{ phase: "setup", operation: available.operation, publicProbeCount: 0, localProcessProbeCount: 1, status: available.probeStatus, usage: "unavailable", cost: "unavailable" }] };
}, gradeClaudeAccount, {
  ...runtimePrivateSpec("agents.hire-needs-account"), authentication: "human-session", expectedRunCount: 3, minimumRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 900000,
  sourceFiles: ["chat-catalog-domains/runtime-claude-account.ts", "chat-catalog-domains/runtime-claude-private.ts", "chat-catalog-domains/runtime-claude-private-worker.ts", "chat-catalog-domains/runtime-private.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/routes/connection-intents.ts", "../../server/src/services/connection-intent-delivery.ts", "chat-scenarios/agents.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const before = await observeRuntime(ctx, state), source = ctx.input.page.url(), firstRun = before.runs[0]!;
    state.initialRunId = firstRun.id;
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    state.waitingReply = comments.filter(row => row.authorAgentId === before.leadId && row.createdByRunId === firstRun.id).map(row => row.body).join("\n");
    const pending = before.agents.filter(row => row.name === "Morgan"); state.beforeMorganId = pending[0]?.id;
    state.noUsableMorganBeforeHuman = pending.length <= 1 && pending.every(row => row.lifecycleState !== "ready" && agentHarnessType(row.adapterType ?? "", row.adapterConfig) === "claude_local");
    const target = before.links.find(href => supportedClaudeSetupLink(href, before.origin, ctx.input.fixtures.company.issuePrefix!));
    const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
    const requests = await ctx.input.api.get<ConnectionIntentInteraction[]>(`/api/issues/${ctx.issue()!.id}/interactions`);
    const cards = requests.filter(row => row.kind === "connection_intent" && row.sourceRunId === firstRun.id && row.payload.serviceSlug === "anthropic");
    if (cards.length > 1 || cards.some(row => row.status !== "pending" || row.addresseeUserId !== session.user.id)) throw new Error("The actual source setup request is duplicated, unavailable or addressed to a different human");
    const request = cards[0]; state.setupRequestId = request?.id;
    if (target) await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(target)}]`).first().click();
    else {
      if (!request) throw new Error("The canonical waiting response exposed neither a supported account setup link nor an actual addressed Anthropic setup request");
      await clickInteractionAction(ctx.input.page, request, /Connect|Set up|Continue/i);
    }
    await expect(ctx.input.page.getByRole("heading", { name: /connections|Connect.*Anthropic|Connect a model provider/i }).first()).toBeVisible(); state.supportedSetupVisible = true;
    const selected = selectedRuntimeInputs(ctx, "agents.hire-needs-account");
    const account = await privateClaudeOperation({ operation: "prepare-account", companyId: before.companyId, environmentId: String(state.selectedEnvironmentId), credential: selected.credentials.ANTHROPIC_API_KEY!, harnessExecutable: selected.values.harnessExecutable, model: selected.values.model, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) });
    (state.providerProbes as unknown[]).push({ phase: "human-account", operation: account.operation, publicProbeCount: 2, status: account.probeStatus, usage: "unavailable", cost: "unavailable" });
    state.connectionId = account.connectionId; state.grantId = account.grantId;
    const accounts = await ctx.input.api.get<AiConnectionList>(`/api/companies/${before.companyId}/ai-connections`), saved = accounts.connections.find(row => row.id === account.connectionId && row.grantId === account.grantId);
    state.accountOwnerIsHuman = saved?.ownerUserId === session.user.id; state.humanAccountConnected = saved?.status === "connected" && saved.provider === "anthropic" && account.probeStatus === "pass";
    if (!state.humanAccountConnected || !state.accountOwnerIsHuman) throw new Error("The actual human account setup did not establish usable selected Anthropic access");
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/company/settings/connections`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByText(saved!.name, { exact: true }).first()).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    if (state.setupRequestId) {
      const options = await ctx.input.api.get<ConnectionIntentSetupOptions>(`/api/connection-intents/${state.setupRequestId}/setup-options`);
      if (options.interaction.id !== state.setupRequestId || options.interaction.issueId !== ctx.issue()!.id || options.interaction.companyId !== before.companyId || options.interaction.sourceRunId !== firstRun.id || options.interaction.addresseeUserId !== session.user.id) throw new Error("Account setup completion changed the addressed human/source request");
      const completion = options.aiConnectionRequiresAdoption
        ? `/api/agents/${options.requestedAgentId}/connection-intents/${state.setupRequestId}/adopt?companyId=${encodeURIComponent(before.companyId)}`
        : `/api/connection-intents/${state.setupRequestId}/complete`;
      await ctx.input.api.post(completion, { connectionId: state.connectionId });
      const requests = await ctx.input.api.get<ConnectionIntentInteraction[]>(`/api/issues/${ctx.issue()!.id}/interactions`), resolved = requests.find(row => row.id === state.setupRequestId);
      state.setupRequestReconciled = completedClaudeSetupMatches({ request: resolved, sourceId: ctx.issue()!.id, sourceRunId: firstRun.id, companyId: before.companyId, humanId: session.user.id, connectionId: String(state.connectionId) });
      if (!state.setupRequestReconciled) throw new Error("The actual addressed Anthropic setup request did not reconcile against established human account access");
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.locator(`[id=${JSON.stringify(`interaction-${String(state.setupRequestId)}`)}]`)).toContainText(/connected|ready|complete/i);
      await ctx.refreshIssue();
      state.setupAutoWakeExpected = ["in_progress", "in_review"].includes(ctx.issue()!.status) && ctx.issue()!.assigneeAgentId === resolved!.payload.requestingAgentId;
      if (state.setupAutoWakeExpected) {
        const automatic = await pollUntil({ label: "Actual accepted setup request delivers its declared automatic native continuation", deadlineAt: Date.now() + 180000,
          load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
          accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.every(row => row.status === "succeeded"),
          reject: v => v.runs.length > 2 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "The actual setup-resolution automatic continuation failed or duplicated" : undefined });
        const run = automatic.runs.find(row => row.id !== firstRun.id)!;
        state.setupAutoWakeBound = run.contextSnapshot?.source === "connection_intent.resolved" && run.contextSnapshot.interactionId === state.setupRequestId && run.contextSnapshot.interactionStatus === "accepted" && run.contextSnapshot.issueId === ctx.issue()!.id;
        const agents = await ctx.input.api.get<RuntimeAgent[]>(`/api/companies/${before.companyId}/agents`); state.autoMorganId = agents.find(row => row.name === "Morgan")?.id;
      } else if ((await ctx.allRuns()).length !== 1) throw new Error("An ineligible setup completion admitted undeclared native work");
    }
    const priorConfirmationIds = (await ctx.allRuns()).map(row => row.id);
    await sendChatMessage(ctx.input.page, continueHire);
    const settled = await pollUntil({ label: "Actual explicit human account confirmation resumes the preserved Claude hire", deadlineAt: Date.now() + 240000,
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), agents: await ctx.input.api.get<RuntimeAgent[]>(`/api/companies/${before.companyId}/agents`) }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === priorConfirmationIds.length + 1 && v.runs.every(row => row.status === "succeeded") && v.agents.filter(row => row.name === "Morgan").length === 1 && v.agents.find(row => row.name === "Morgan")?.lifecycleState === "ready",
      reject: v => v.runs.length > priorConfirmationIds.length + 1 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Account resumption failed or admitted undeclared duplicate work" : undefined });
    const run = settled.runs.find(row => !priorConfirmationIds.includes(row.id))!, next = await ctx.input.api.get<{ contextSnapshot?: { wakeCommentIds?: string[] }; runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`);
    const after = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = after.filter(row => !row.authorAgentId && row.body === continueHire);
    state.continuationMessageBound = human.length === 1 && human[0]?.authorUserId === session.user.id && next.contextSnapshot?.wakeCommentIds?.length === 1 && next.contextSnapshot.wakeCommentIds[0] === human[0]?.id && next.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(continueHire) === true;
    state.continuationRunId = run.id; state.continuationReply = after.filter(row => row.authorAgentId === before.leadId && row.createdByRunId === run.id).map(row => row.body).join("\n");
    const worker = settled.agents.find(row => row.name === "Morgan")!; state.worker = worker;
    state.savedValidation = await privateClaudeOperation({ operation: "validate-saved", companyId: before.companyId, environmentId: String(state.selectedEnvironmentId), agentId: worker.id, connectionId: String(state.connectionId), grantId: String(state.grantId), baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) }, selected.credentials.ANTHROPIC_API_KEY);
    (state.providerProbes as unknown[]).push({ phase: "saved-hire", operation: "validate-saved", publicProbeCount: 1, status: (state.savedValidation as ClaudePrivateReceipt).probeStatus, usage: "unavailable", cost: "unavailable" });
  },
  async observe(ctx, state) { const o = await observeRuntime(ctx, state), worker = o.agents.find(row => row.name === "Morgan"), binding = worker?.runtimeConfig?.aiConnection as { provider?: string; mode?: string; connectionId?: string; grantId?: string } | undefined;
    const accounts = await ctx.input.api.get<AiConnectionList>(`/api/companies/${o.companyId}/ai-connections`);
    state.actualAccountBinding = binding?.provider === "anthropic" && accounts.connections.some(row => row.id === state.connectionId && row.grantId === state.grantId && row.status === "connected" && (binding.mode === "responsible_user" ? row.isDefault : binding.connectionId === row.id && binding.grantId === row.grantId)); return o; },
  async verifyResult(ctx, state, value) { const o = runtimeObservation(value); if (!o) throw new Error("Missing account-resumption result"); const source = ctx.input.page.url(); await openRuntimeAgentProfile(ctx, state.worker as RuntimeAgent, o); await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: "Morgan", exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
})];
