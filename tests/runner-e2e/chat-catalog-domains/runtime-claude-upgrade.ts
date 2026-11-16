import { expect } from "@playwright/test";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import { agentHarnessType } from "../../../packages/shared/src/agent-runner.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { waitForReply } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type InstructionFile } from "./runtime-support.js";
import { runtimePrivateSpec, selectedRuntimeInputs } from "./runtime-private.js";
import { matchesClaudeFixtureTarget, privateClaudeOperation } from "./runtime-claude-private.js";
const confirmation = "I used the supported human Upgrade runner control for Morgan. Please check the saved configuration and explain what the conversion proves, and what still requires an actual run. Do not start any work.";
/** A finite compatible legacy fixture, not an arbitrary private configuration loader. */
export function compatibleLegacyClaudeSettings(text: string, model: string): Record<string, unknown> {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("Legacy settings reference must contain qualified compatible JSON; contents withheld"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy settings fixture");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !["command", "model", "engine", "mode", "nonInteractivePermissions", "dangerouslySkipPermissions", "modelReasoningEffort"].includes(key))
    || config.model !== model || config.command !== undefined && config.command !== "claude" || config.mode !== undefined && config.mode !== "persistent"
    || config.engine !== undefined && !["auto", "cli", "acp"].includes(String(config.engine)) || config.nonInteractivePermissions !== undefined && config.nonInteractivePermissions !== "deny"
    || config.dangerouslySkipPermissions === false || config.modelReasoningEffort !== undefined && typeof config.modelReasoningEffort !== "string") throw new Error("Legacy settings require actual compatible Claude settings and the qualified selected model; no private environment bindings");
  return config;
}
export function upgradeReplyMatches(reply: string, phase: "guidance" | "saved") {
  if (/I(?:['’]ve| have)?\s+(?:already\s+)?(?:upgraded|converted)|(?:conversion|upgrade)\s+(?:proves|guarantees).*success|(?:live run|execution)\s+(?:has\s+)?(?:passed|succeeded)/i.test(reply)) return false;
  return phase === "guidance" ? /upgrade|configuration|runtime settings/i.test(reply) && /human|you|person|operator|control|button/i.test(reply) && /Claude|model|instructions/i.test(reply)
    : /saved|converted|upgraded|Paperclip Runner/i.test(reply) && /run|execution|session/i.test(reply) && /still|not|until|separate|need|verify|test|first|yet/i.test(reply);
}
export function gradeClaudeUpgrade(value: unknown) {
  const c = checks(), o = runtimeObservation(value); c.add("actual-legacy-conversion-evidence", !!o, "Actual saved legacy state, supported human upgrade and post-conversion native work are required."); if (!o) return c.result();
  const s = o.state, before = s.worker as Agent, after = o.agents.find(row => row.id === before?.id), config = after?.adapterConfig;
  c.add("unsupported-setting-atomically-rejected", s.legacyUnchangedBeforeHuman === true && s.unsupportedHttpStatus === 422 && s.unsupportedActionable === true && s.failedConversionUnchanged === true, "A real human upgrade with extraArgs fails actionably without any partial saved conversion.");
  c.add("compatible-human-conversion-preserves-identity-and-bindings", !!after && after.companyId === o.companyId && after.adapterType === "paperclip_runner" && agentHarnessType(after.adapterType, config) === "claude_local"
    && config?.model === before.adapterConfig.model && config?.provider === "acpx" && config?.acpxAgent === "claude" && s.supportedHumanUpgrade === true && s.bindingsRetained === true && s.instructionsRetained === true && s.historyRetained === true,
    "Supported conversion preserves Morgan, Claude, model, computer/account, exact instructions and genuine human task history.");
  c.add("fresh-first-actual-native-session", s.noPriorWorkerSession === true && s.futureRunFresh === true && s.futureHistoryRead === true && s.savedValidationPassed === true
    && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded") && o.runs.filter(run => run.agentId === before.id).length === 1,
    "The first actual worker run starts without a prior session, uses the converted supported Claude runtime and reads both retained instruction/history references.");
  c.add("phase-specific-honest-result", upgradeReplyMatches(String(s.guidanceReply), "guidance") && upgradeReplyMatches(String(s.savedReply), "saved") && s.confirmationBound === true && o.humanQueries.length === 2 && o.humanQueries[1] === confirmation,
    "Canonical guidance reaches the human control; its separately attributed factual follow-up distinguishes conversion from subsequent actual execution.");
  return c.result();
}
export const runtimeClaudeUpgradeCases = [runtimeDefinition("runs-adapters.upgrade-runner", async ctx => {
  const selected = selectedRuntimeInputs(ctx, "runs-adapters.upgrade-runner"), companyId = ctx.input.fixtures.company.id, environmentId = ctx.input.fixtures.environment.id;
  if (selected.values.targetRef !== "fixture.environment" || selected.values.accountBindingRef !== "selected.ANTHROPIC_API_KEY" || !ctx.input.privateSecrets) throw new Error("Setup blocker: require qualified owned Claude target, selected account and private sink");
  const config = compatibleLegacyClaudeSettings(selected.values.legacySettingsRef, selected.values.model);
  const [company, detail, listed] = await Promise.all([ctx.input.api.get<{ id: string }>(`/api/companies/${companyId}`), ctx.input.api.get<Environment>(`/api/environments/${environmentId}`), ctx.input.api.get<Environment[]>(`/api/companies/${companyId}/environments`)]);
  if (!matchesClaudeFixtureTarget({ company, expectedCompanyId: companyId, fixtureEnvironmentId: environmentId, detail, listed })) throw new Error("The selected legacy Claude target is not the exact owned active local fixture");
  const credential = selected.credentials.ANTHROPIC_API_KEY!; ctx.input.privateSecrets.push(credential);
  const account = await privateClaudeOperation({ operation: "prepare-account", companyId, environmentId, credential, harnessExecutable: selected.values.harnessExecutable, model: selected.values.model, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) });
  if (account.probeStatus !== "pass") throw new Error("Actual legacy Claude prerequisites failed independent qualification");
  const instructionMarker = `Retained instruction reference ${ctx.input.nonce}`, historyMarker = `Retained human history ${ctx.input.nonce}`;
  const worker = await ctx.input.api.post<Agent>(`/api/companies/${companyId}/agents`, { name: "Morgan", role: "engineer", title: "Frontend engineer", reportsTo: ctx.input.fixtures.agent.id, adapterType: "claude_local", runner: "legacy", adapterConfig: config, defaultEnvironmentId: environmentId,
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 }, aiConnection: { mode: "delegated", provider: "anthropic", method: "api_key", connectionId: account.connectionId, grantId: account.grantId } },
    instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": `Follow normal task lifecycle. ${instructionMarker}. When asked to inspect retained history, report this exact instruction reference in a task comment.` } } });
  const ready = await pollUntil({ label: "Real saved legacy Claude readiness", deadlineAt: Date.now() + 60000, load: () => ctx.input.api.get<Agent>(`/api/agents/${worker.id}`), accept: row => row.lifecycleState === "ready" });
  const probe = await privateClaudeOperation({ operation: "validate-saved", companyId, environmentId, agentId: worker.id, connectionId: account.connectionId!, grantId: account.grantId!, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) }, credential);
  if (ready.adapterType !== "claude_local" || probe.probeStatus !== "pass" || (await ctx.input.api.get<unknown[]>(`/api/agents/${worker.id}/task-sessions`)).length) throw new Error("Legacy setup must actually validate, remain legacy, and contain no fabricated prior provider session");
  const task = await ctx.input.api.post<Entity>(`/api/companies/${companyId}/issues`, { title: "Website task", status: "backlog", assigneeAgentId: worker.id, description: "When this task is activated, read its prior human comments and your retained AGENTS instructions, quote both reference strings in a task comment, and finish. Do not create another task or change instructions." });
  const history = await ctx.input.api.post<Entity>(`/api/issues/${task.id}/comments`, { body: historyMarker });
  const instruction = await ctx.input.api.get<InstructionFile>(`/api/agents/${worker.id}/instructions-bundle/file?path=AGENTS.md`);
  return { worker: ready, task, history, instruction, instructionMarker, historyMarker, noPriorWorkerSession: true, connectionId: account.connectionId, grantId: account.grantId,
    providerProbes: [{ phase: "setup", operation: account.operation, publicProbeCount: 2, status: account.probeStatus, usage: "unavailable", cost: "unavailable" }, { phase: "saved-legacy", operation: probe.operation, publicProbeCount: 1, status: probe.probeStatus, usage: "unavailable", cost: "unavailable" }] };
}, gradeClaudeUpgrade, {
  ...runtimePrivateSpec("runs-adapters.upgrade-runner"), authentication: "human-session", expectedRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 900000,
  sourceFiles: ["chat-catalog-domains/runtime-claude-upgrade.ts", "chat-catalog-domains/runtime-claude-private.ts", "chat-catalog-domains/runtime-claude-private-worker.ts", "chat-catalog-domains/runtime-private.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/services/agent-runner-selection.ts", "../../ui/src/components/AgentConfigForm.tsx", "chat-scenarios/runs-adapters.yaml"],
  async observe(ctx, s) {
    const before = s.instruction as InstructionFile, instruction = await ctx.input.api.get<InstructionFile>(`/api/agents/${(s.worker as Agent).id}/instructions-bundle/file?path=AGENTS.md`);
    const history = s.history as Entity, comments = await ctx.input.api.get<Entity[]>(`/api/issues/${(s.task as Entity).id}/comments?order=asc`);
    s.instructionsRetained = instruction.revision.id === before.revision.id && instruction.content === before.content;
    s.historyRetained = comments.some(row => row.id === history.id && row.body === history.body && row.authorUserId === history.authorUserId && !row.authorAgentId);
    const result = await observeRuntime(ctx, s), actual = result.agents.find(row => row.id === (s.worker as Agent).id), original = s.worker as Agent;
    s.bindingsRetained = actual?.defaultEnvironmentId === original.defaultEnvironmentId && JSON.stringify(actual?.runtimeConfig?.aiConnection) === JSON.stringify(original.runtimeConfig.aiConnection);
    return result;
  },
  async act(ctx, s) {
    await waitForReply(ctx); const first = await observeRuntime(ctx, s), source = ctx.input.page.url(), worker = s.worker as Agent; s.guidanceReply = first.reply;
    const actualBefore = await ctx.input.api.get<Agent>(`/api/agents/${worker.id}`);
    s.legacyUnchangedBeforeHuman = actualBefore.adapterType === "claude_local" && JSON.stringify(actualBefore.adapterConfig) === JSON.stringify(worker.adapterConfig) && JSON.stringify(actualBefore.runtimeConfig) === JSON.stringify(worker.runtimeConfig);
    if (!s.legacyUnchangedBeforeHuman) throw new Error("Canonical guidance changed the human-owned legacy configuration before the supported human action");
    const route = `/${ctx.input.fixtures.company.issuePrefix}/agents/${worker.id}/runtime`;
    await ctx.input.page.goto(route, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("button", { name: "Upgrade runner", exact: true })).toBeVisible();
    const badConfig = { ...worker.adapterConfig, extraArgs: ["--max-turns", "1"] };
    await ctx.input.api.patch(`/api/agents/${worker.id}`, { adapterConfig: badConfig });
    const badBefore = await ctx.input.api.get<Agent>(`/api/agents/${worker.id}`); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    const rejected = ctx.input.page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/agents/${worker.id}`);
    await ctx.input.page.getByRole("button", { name: "Upgrade runner", exact: true }).click(); s.unsupportedHttpStatus = (await rejected).status();
    const alert = ctx.input.page.getByRole("alert").filter({ hasText: /extraArgs|extra args/i }).first(); await expect(alert).toBeVisible(); s.unsupportedActionable = /compatible|remove|unsupported|incompatible|cannot|can't/i.test(await alert.innerText());
    const badAfter = await ctx.input.api.get<Agent>(`/api/agents/${worker.id}`);
    s.failedConversionUnchanged = badAfter.adapterType === "claude_local" && JSON.stringify(badAfter.adapterConfig) === JSON.stringify(badBefore.adapterConfig) && JSON.stringify(badAfter.runtimeConfig) === JSON.stringify(badBefore.runtimeConfig) && badAfter.defaultEnvironmentId === badBefore.defaultEnvironmentId;
    await ctx.input.api.patch(`/api/agents/${worker.id}`, { adapterConfig: worker.adapterConfig }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await ctx.input.page.getByRole("button", { name: "Upgrade runner", exact: true }).click();
    const converted = await pollUntil({ label: "Actual supported human Claude conversion", deadlineAt: Date.now() + 60000, load: () => ctx.input.api.get<Agent>(`/api/agents/${worker.id}`), accept: row => row.adapterType === "paperclip_runner" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("button", { name: "Upgrade runner", exact: true })).toHaveCount(0); s.supportedHumanUpgrade = true;
    s.bindingsRetained = converted.defaultEnvironmentId === worker.defaultEnvironmentId && JSON.stringify(converted.runtimeConfig.aiConnection) === JSON.stringify(worker.runtimeConfig.aiConnection);
    const instruction = await ctx.input.api.get<InstructionFile>(`/api/agents/${worker.id}/instructions-bundle/file?path=AGENTS.md`), prior = s.instruction as InstructionFile;
    s.instructionsRetained = instruction.content === prior.content && instruction.revision.id === prior.revision.id;
    const history = await ctx.input.api.get<Entity[]>(`/api/issues/${(s.task as Entity).id}/comments?order=asc`), saved = s.history as Entity;
    s.historyRetained = history.some(row => row.id === saved.id && row.body === saved.body && row.authorUserId === saved.authorUserId && !row.authorAgentId);
    const selected = selectedRuntimeInputs(ctx, "runs-adapters.upgrade-runner");
    const validation = await privateClaudeOperation({ operation: "validate-saved", companyId: first.companyId, environmentId: ctx.input.fixtures.environment.id, agentId: worker.id, connectionId: String(s.connectionId), grantId: String(s.grantId), baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) }, selected.credentials.ANTHROPIC_API_KEY);
    s.savedValidationPassed = validation.probeStatus === "pass"; (s.providerProbes as unknown[]).push({ phase: "converted", operation: validation.operation, publicProbeCount: 1, status: validation.probeStatus, usage: "unavailable", cost: "unavailable" });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await sendChatMessage(ctx.input.page, confirmation);
    const second = await pollUntil({ label: "Factual conversion confirmation native reply", deadlineAt: Date.now() + 180000, load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => v.issue?.conversationState === "waiting" && v.runs.length === 2 && v.runs.every(row => row.status === "succeeded") });
    const next = second.runs.find(row => row.id !== first.runs[0]!.id)!;
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId && row.body === confirmation);
    s.confirmationBound = human.length === 1 && Array.isArray(next.contextSnapshot?.wakeCommentIds) && next.contextSnapshot.wakeCommentIds.length === 1 && next.contextSnapshot.wakeCommentIds[0] === human[0]!.id; s.savedReply = comments.filter(row => row.createdByRunId === next.id && row.authorAgentId === first.leadId).map(row => row.body).join("\n");
    await ctx.input.api.patch(`/api/issues/${(s.task as Entity).id}`, { status: "todo" });
    const future = await pollUntil({ label: "First actual post-conversion Claude session", deadlineAt: Date.now() + 300000, load: async () => ({ task: await ctx.input.api.get<Entity>(`/api/issues/${(s.task as Entity).id}`), runs: await ctx.allRuns() }), accept: v => v.task.status === "done" && v.runs.length === 3 && v.runs.every(row => row.status === "succeeded"), reject: v => v.runs.length > 3 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Actual converted Claude execution failed or admitted extra work" : undefined });
    const run = future.runs.find(row => row.agentId === worker.id)!;
    const actual = await ctx.input.api.get<{ companyId: string; agentId: string; nativeIssueId?: string; contextSnapshot?: { issueId?: string; taskId?: string }; runnerProfileJson?: { nativeExecutionInput?: { provider?: { kind?: string; agent?: string; model?: string } } } }>(`/api/heartbeat-runs/${run.id}`);
    const provider = actual.runnerProfileJson?.nativeExecutionInput?.provider;
    s.futureRunFresh = !!run && !run.sessionIdBefore && !!run.sessionIdAfter && run.runtimeMode === "native" && actual.companyId === first.companyId && actual.agentId === worker.id
      && [actual.nativeIssueId, actual.contextSnapshot?.issueId, actual.contextSnapshot?.taskId].includes((s.task as Entity).id) && provider?.kind === "acpx" && provider.agent === "claude" && provider.model === worker.adapterConfig.model;
    const result = await ctx.input.api.get<Entity[]>(`/api/issues/${(s.task as Entity).id}/comments?order=asc`);
    s.futureHistoryRead = result.some(row => row.createdByRunId === run.id && row.authorAgentId === worker.id && row.body?.includes(String(s.instructionMarker)) && row.body.includes(String(s.historyMarker)));
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${(s.task as Entity).identifier ?? (s.task as Entity).id}`, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByText(String(s.historyMarker), { exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
})];
