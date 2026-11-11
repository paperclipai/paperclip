import { chatCatalogNativePhaseRemainingBudget, chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import type { Agent, AdapterEnvironmentTestResult } from "../../../packages/shared/src/types/agent.js";
import type { CompanyPortabilityAdapterOverride } from "../../../packages/shared/src/types/company-portability.js";
import type { CatalogTeam, CatalogTeamInstallResult } from "../../../packages/shared/src/types/teams-catalog.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { CompanySecretUsageBinding, SecretProposalView } from "../../../packages/shared/src/types/secrets.js";
import type { RequestConfirmationInteraction } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { codexSubscriptionAgentConfig } from "../codex-subscription-fixture.js";
import { definition, externalObservation, observeExternal, root, checks } from "./external-support.js";
import { catalogTeamMembers, observeTeamResources } from "./external-team-install.js";
import { waitForReply } from "./identity-support.js";
interface PrivateTeam { emptyHome: string; override: CompanyPortabilityAdapterOverride }
const fixtures = new WeakMap<ChatCatalogContext, PrivateTeam>();
function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value; }
const configHash = (agent: Agent) => createHash("sha256").update(JSON.stringify(stable({ adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig, defaultEnvironmentId: agent.defaultEnvironmentId }))).digest("hex");
interface Probe { agentId: string; status: string; testedAt: string; checks: Array<{code: string; level: string}> }
function missingAccountProbe(row: Probe, agentId: string) {
  return row.agentId === agentId && (row.status === "fail" && row.checks.some(check => check.level === "error" && /auth|credential|login/i.test(check.code))
    || row.status === "warn" && row.checks.some(check => check.code === "opencode_hello_probe_auth_required" && check.level === "warn")
      && row.checks.every(check => check.level === "info" || check.code === "opencode_hello_probe_auth_required" && check.level === "warn"));
}
function readyProbe(row: Probe, agentId: string) {
  return row.agentId === agentId && row.status === "pass" && row.checks.every(check => check.level === "info");
}
export function memberReadinessSummary(rows: readonly Probe[], members: ReadonlyArray<Pick<Agent, "id" | "name">>, missingId: string, workingId: string) {
  return rows.map(row => {
    const role = row.agentId === missingId ? "expected missing account" : row.agentId === workingId ? "expected ready" : "other member";
    const name = members.find(member => member.id === row.agentId)?.name ?? "unknown member";
    const problems = row.checks.filter(check => check.level !== "info").map(check => `${check.code}:${check.level}`);
    return `${name} (${role}): ${row.status}${problems.length ? ` [${problems.join(", ")}]` : ""}`;
  }).join("; ");
}
async function probe(ctx: ChatCatalogContext, agent: Agent): Promise<Probe> {
  const result = await ctx.input.api.postSensitive<AdapterEnvironmentTestResult>(`${root(ctx)}/adapters/${agent.adapterType}/test-environment`, { agentId: agent.id, environmentId: agent.defaultEnvironmentId, adapterConfig: agent.adapterConfig });
  return { agentId: agent.id, status: result.status, testedAt: result.testedAt, checks: result.checks.map(check => ({ code: /^[a-zA-Z0-9_.-]{1,100}$/.test(check.code) ? check.code : "unrecognized", level: check.level })) };
}
export interface EligibleTeamBinding { configPath: string; secretId: string }
export interface TeamBindingApproval { interactionId: string; proposalId: string; configPath: string; secretId: string; targetAgentId: string; payloadHash: string }
const payloadHash = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
export function eligibleTeamBindings(env: unknown): EligibleTeamBinding[] {
  return Object.entries(env && typeof env === "object" ? env as Record<string, unknown> : {}).flatMap(([key, value]) => {
    const ref = value as { type?: unknown; secretId?: unknown } | null;
    return ref && ref.type === "secret_ref" && typeof ref.secretId === "string" ? [{ configPath: `env.${key}`, secretId: ref.secretId }] : [];
  });
}
export function teamBindingCandidate(input: { interactions: readonly RequestConfirmationInteraction[]; proposals: readonly SecretProposalView[]; companyId: string; issueId: string;
  leadId: string; initialRunId: string; missingId: string; eligible: readonly EligibleTeamBinding[] }): TeamBindingApproval | undefined {
  for (const card of input.interactions) {
    const p = card.payload?.secretProposal, proposal = p && input.proposals.find(row => row.id === p.proposalId);
    if (!p || !proposal || card.kind !== "request_confirmation" || card.status !== "pending" || card.companyId !== input.companyId || card.issueId !== input.issueId
      || card.sourceRunId !== input.initialRunId || card.createdByAgentId !== input.leadId || card.createdByUserId || card.addresseeAgentId || card.resolvedByUserId || card.resolvedByAgentId
      || card.requestedResolverPolicy !== "human_only" || card.effectiveResolverPolicy !== "human_only" || card.idempotencyKey !== `secret-proposal:${proposal.id}`
      || p.targetAgentId !== input.missingId || p.configPath !== proposal.configPath || proposal.companyId !== input.companyId || proposal.kind !== "binding" || proposal.status !== "pending"
      || proposal.targetType !== "agent" || proposal.target?.id !== input.missingId || proposal.secretProposalId || proposal.originRunId !== input.initialRunId || proposal.proposedBy?.id !== input.leadId
      || !input.eligible.some(row => row.configPath === proposal.configPath && row.secretId === proposal.secretId)) continue;
    return { interactionId: card.id, proposalId: proposal.id, configPath: proposal.configPath!, secretId: proposal.secretId!, targetAgentId: input.missingId, payloadHash: payloadHash(card.payload) };
  }
}
const bindingKey = (row: Pick<CompanySecretUsageBinding, "targetType" | "targetId" | "configPath">) => `${row.targetType}:${row.targetId}:${row.configPath}`;
function humanApprovedBinding(o: NonNullable<ReturnType<typeof externalObservation>>) {
  const marker = o.state.bindingApproval as TeamBindingApproval | undefined, card = marker && o.interactions.find(row => row.id === marker.interactionId) as unknown as RequestConfirmationInteraction | undefined;
  const before = o.state.bindingsBefore as string[] | undefined, after = o.state.bindingsAfter as string[] | undefined, ref = o.state.missingBindingRef as { type?: string; secretId?: string } | undefined;
  return !!marker && !!card && marker.targetAgentId === o.state.missingId && card.status === "accepted" && card.createdByAgentId === o.leadId && card.sourceRunId === o.state.initialRunId
    && typeof o.state.currentUserId === "string" && card.resolvedByUserId === o.state.currentUserId && !card.resolvedByAgentId && payloadHash(card.payload) === marker.payloadHash
    && card.payload?.secretProposal?.targetAgentId === o.state.missingId && card.payload.secretProposal.configPath === marker.configPath
    && Array.isArray(before) && Array.isArray(after) && !before.includes(`agent:${o.state.missingId}:${marker.configPath}`)
    && JSON.stringify([...before, `agent:${o.state.missingId}:${marker.configPath}`].sort()) === JSON.stringify([...after].sort())
    && ref?.type === "secret_ref" && ref.secretId === marker.secretId;
}
function verificationReplies(o: NonNullable<ReturnType<typeof externalObservation>>) {
  const before = o.state.preVerificationRunIds;
  return Array.isArray(before) && before.includes(o.state.initialRunId) ? o.phaseReplies.filter(row => !before.includes(row.runId)) : [];
}
export function gradeTeamConfigure(value: unknown) {
  const c = checks(), o = externalObservation(value); c.add("complete-member-configuration-evidence", !!o, "Real installed members, missing versus ready account probes, scoped repair and fresh per-member tests are required."); if (!o) return c.result();
  const initial = o.state.initialProbes as Probe[] | undefined, after = o.state.afterProbes as Probe[] | undefined;
  c.add("actual-missing-and-working-member-prerequisite", o.state.installedFromCatalog === true && typeof o.state.missingId === "string" && typeof o.state.workingId === "string" && o.state.missingId !== o.state.workingId
    && Array.isArray(initial) && initial.some(row => missingAccountProbe(row, String(o.state.missingId)))
    && initial.some(row => readyProbe(row, String(o.state.workingId))),
    "The supported catalog installer creates the team; actual runtime tests prove one exact missing account and a distinct already working member before chat.");
  c.add("specific-member-diagnosis-and-supported-repair", o.state.initialHandoffSupported === true && o.state.repairConfirmed === true
    && ((o.state.repairChannel === "agent-configuration" && o.activity.some(row => row.entityId === o.state.missingId && row.action === "agent.updated" && row.actorType === "agent" && row.agentId === o.leadId))
      || (o.state.repairChannel === "human-board-configuration" && o.activity.some(row => row.entityId === o.state.missingId && row.action === "agent.updated" && row.actorType === "user"))
      || (o.state.repairChannel === "human-approved-binding" && humanApprovedBinding(o))),
    "Chat identifies the incomplete member by linking its own configuration page, proposing a governed binding of the eligible company account to that member, or repairing it itself; the repair changes only that member through actual agent or human authority.");
  c.add("already-working-member-preserved", typeof o.state.workingHashBefore === "string" && o.state.workingHashBefore === o.state.workingHashAfter && o.state.memberIdsPreserved === true,
    "The already working member's semantic configuration and the installed member identities remain unchanged.");
  c.add("working-configuration-revisions-preserved", Array.isArray(o.state.workingRevisionIdsBefore) && Array.isArray(o.state.workingRevisionIdsAfter)
    && JSON.stringify(o.state.workingRevisionIdsBefore) === JSON.stringify(o.state.workingRevisionIdsAfter),
    "Public immutable configuration revision identities also remain unchanged, so redacted environment placeholders cannot hide an account change.");
  c.add("fresh-readiness-for-every-member", Array.isArray(after) && after.length === o.state.expectedMembers
    && JSON.stringify(after.map(row => row.agentId).sort()) === JSON.stringify(o.state.memberIdsBefore)
    && new Set(after.map(row => row.agentId)).size === after.length && after.every(row => row.status === "pass" && row.checks.every(check => check.level !== "error")
    && Number.isFinite(Date.parse(row.testedAt)) && Date.parse(row.testedAt) >= Number(o.state.repairVerifiedAfter)),
    "After the real repair every member passes its own fresh saved-runtime test; one healthy member cannot stand for the whole team.");
  const continuation = verificationReplies(o);
  c.add("phase-bound-team-result", continuation.some(row => row.body.trim().length > 0 && o.runs.some(run => run.id === row.runId && run.status === "succeeded")),
    "A run started by the verification message posts its own reply; earlier initial or approval-continuation replies cannot stand in. Its wording is left to human reading against the fresh per-member probes.");
  return c.result();
}
export const teamConfigureExternalCases = [definition("teams.configure-team", async ctx => {
  if (!["CODEX_AUTH_JSON", "OPENROUTER_API_KEY"].includes(ctx.input.execution.profile.credential)) throw new Error("Setup blocker: this disposable team fixture requires the selected campaign account, not an inferred personal login");
  const team = (await ctx.input.api.get<CatalogTeam[]>("/api/teams/catalog")).find(row => row.slug === "product-engineering" && row.compatibility === "compatible");
  if (!team) throw new Error("Setup blocker: compatible real Product Engineering package is unavailable");
  const built = ctx.input.execution.profile.buildAgent({ environmentId: ctx.input.fixtures.environment.id, environmentFixtureId: ctx.input.execution.environment.id, workspacePath: ctx.input.workspacePath, secretRefs: ctx.input.fixtures.secretRefs, executionId: ctx.input.nonce });
  if (typeof built.adapterType !== "string") throw new Error("Setup blocker: selected profile does not declare a supported runtime adapter");
  const subscription = ctx.input.execution.profile.credential === "CODEX_AUTH_JSON";
  const configured = subscription ? codexSubscriptionAgentConfig(built, process.env, ctx.input.fixtures.company.id) : built;
  const override: CompanyPortabilityAdapterOverride = { adapterType: built.adapterType, adapterConfig: configured.adapterConfig as Record<string, unknown> };
  const emptyHome = await mkdtemp(path.join(tmpdir(), "paperclip-missing-team-login-")); fixtures.set(ctx, { emptyHome, override });
  try {
    const install = await ctx.input.api.postSensitive<CatalogTeamInstallResult>(`${root(ctx)}/teams/catalog/${encodeURIComponent(team.id)}/install`, { targetManagerAgentId: ctx.input.fixtures.agent.id, adapterOverrides: Object.fromEntries(team.agentSlugs.map(slug => [slug, override])) });
    const missingId = install.portabilityImport.agents.find(row => row.slug === "qa")?.id, workingId = install.portabilityImport.agents.find(row => row.slug === "senior-coder")?.id;
    if (!missingId || !workingId) throw new Error("Setup blocker: installer did not produce the exact QA and senior-coder members");
    await ctx.input.api.patchSensitive(`/api/agents/${missingId}`, { adapterConfig: { ...override.adapterConfig, env: { ...(override.adapterConfig?.env as Record<string, unknown> ?? {}), ...missingTeamAccountEnvironment(subscription, emptyHome) } } });
    const members = catalogTeamMembers(await observeTeamResources(ctx), team.id);
    const initialProbes = await Promise.all(members.map(member => probe(ctx, member)));
    await ctx.input.evidence("chat-catalog-team-initial-probes.json", { initialProbes });
    if (!initialProbes.some(row => missingAccountProbe(row, missingId)) || !initialProbes.some(row => readyProbe(row, workingId))) throw new Error(`Setup blocker: actual per-member runtime probes do not establish the required missing-versus-ready account split. Observed: ${memberReadinessSummary(initialProbes, members, missingId, workingId)}`);
    const session = await ctx.input.api.get<{ user?: { id?: string } }>("/api/auth/get-session");
    const working = await ctx.input.api.get<Agent>(`/api/agents/${workingId}`);
    const workingRevisionIdsBefore = (await ctx.input.api.get<Array<{ id: string }>>(`/api/agents/${workingId}/config-revisions`)).map(row => row.id).sort();
    await ctx.input.api.post(`${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`); await ctx.refreshIssue();
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `The website team is the installed ${team.name} package. Its QA member (${missingId}) has not selected the eligible company ${subscription ? "Codex subscription" : "OpenRouter"} account. The senior coder (${workingId}) is already configured. The existing company account is authorized for the QA member too; its value must not enter chat.` });
    return { teamId: team.id, installedFromCatalog: true, memberIdsBefore: members.map(row => row.id).sort(), expectedMembers: members.length, missingId, missingName: members.find(row => row.id === missingId)!.name,
      workingId, workingHashBefore: configHash(working), workingRevisionIdsBefore, initialProbes,
      eligibleBindings: eligibleTeamBindings((override.adapterConfig as { env?: unknown } | undefined)?.env), currentUserId: session.user?.id ?? null };
  } catch (error) { fixtures.delete(ctx); await rm(emptyHome, { recursive: true, force: true }); throw error; }
}, gradeTeamConfigure, {
  authentication: "human-session", oracleVersion: "paperclip.chat-catalog.team-configure.v6", expectedRunCount: 3, minimumRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 720_000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["missing-account-fixture", "working-account-fixture"] },
  async verifySetup(_ctx, state) { const c = checks(), rows = state.initialProbes as Probe[]; c.add("missing-account-fixture", rows.some(row => missingAccountProbe(row, String(state.missingId))), "Actual saved-runtime probe reports the required missing member account."); c.add("working-account-fixture", rows.some(row => readyProbe(row, String(state.workingId))), "A distinct installed member already passes its runtime probe."); return c.result(); },
  sourceFiles: ["chat-catalog-domains/external-team-configure.ts", "chat-catalog-domains/external-team-install.ts", "../../server/src/adapters/registry.ts", "../../packages/adapters/opencode-local/src/server/test.ts", "../../packages/adapters/opencode-local/src/server/parse.ts", "codex-subscription-fixture.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "chat-flow.ts", "chat-scenarios/teams.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); const initial = await observeExternal(ctx, state); state.initialRunId = initial.runs[0]?.id;
    const members = catalogTeamMembers(await observeTeamResources(ctx), String(state.teamId)), missing = members.find(row => row.id === state.missingId)!;
    const current = await probe(ctx, missing); const alreadyRepaired = current.status === "pass";
    const handoff = initial.links.find(href => { try { const url = new URL(href, initial.origin); return url.origin === initial.origin && url.pathname.split("/").some((part, i, parts) => part === "agents" && [missing.id, missing.urlKey].includes(parts[i + 1]!)); } catch { return false; } });
    const issueId = ctx.issue()!.id, eligible = state.eligibleBindings as EligibleTeamBinding[];
    const binding = alreadyRepaired ? undefined : teamBindingCandidate({ interactions: await ctx.input.api.get<RequestConfirmationInteraction[]>(`/api/issues/${issueId}/interactions`),
      proposals: await ctx.input.api.get<SecretProposalView[]>(`${root(ctx)}/secret-proposals`), companyId: ctx.input.fixtures.company.id, issueId, leadId: ctx.input.fixtures.agent.id,
      initialRunId: String(state.initialRunId), missingId: missing.id, eligible });
    state.initialHandoffSupported = alreadyRepaired || !!binding || !!handoff;
    if (binding) {
      state.bindingsBefore = await usageKeys(ctx, binding.secretId);
      await acceptTeamBinding(ctx, binding, missing.name, String(state.currentUserId));
      state.bindingApproval = binding; state.repairChannel = "human-approved-binding";
      await waitForBindingContinuation(ctx);
    } else if (!alreadyRepaired) {
      if (!handoff) throw new Error("The model provided neither a configuration link nor a governed binding proposal for the incomplete member");
      const source = ctx.input.page.url(); await ctx.input.page.goto(handoff, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("main")).toContainText(missing.name);
      const fixture = fixtures.get(ctx); if (!fixture) throw new Error("Eligible team account reference missing");
      await ctx.input.api.patchSensitive(`/api/agents/${missing.id}`, { adapterType: fixture.override.adapterType, adapterConfig: fixture.override.adapterConfig }); state.repairChannel = "human-board-configuration";
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    } else state.repairChannel = "agent-configuration";
    state.repairVerifiedAfter = Date.now(); state.repairConfirmed = (await probe(ctx, await ctx.input.api.get<Agent>(`/api/agents/${missing.id}`))).status === "pass";
    state.preVerificationRunIds = (await ctx.allRuns()).map(run => run.id);
    await sendChatMessage(ctx.input.page, "Please verify which installed team members are ready now, including QA, and preserve the already working member's configuration.", chatCatalogNativePhaseRemainingBudget(ctx));
  },
  async observe(ctx, state) {
    const members = catalogTeamMembers(await observeTeamResources(ctx), String(state.teamId)); state.afterProbes = await Promise.all(members.map(member => probe(ctx, member)));
    state.memberIdsPreserved = JSON.stringify(members.map(row => row.id).sort()) === JSON.stringify(state.memberIdsBefore);
    state.workingHashAfter = members.some(row => row.id === state.workingId) ? configHash(members.find(row => row.id === state.workingId)!) : null;
    state.workingRevisionIdsAfter = (await ctx.input.api.get<Array<{ id: string }>>(`/api/agents/${state.workingId}/config-revisions`)).map(row => row.id).sort();
    const marker = state.bindingApproval as TeamBindingApproval | undefined;
    if (marker) {
      state.bindingsAfter = await usageKeys(ctx, marker.secretId);
      const qa = await ctx.input.api.get<Agent>(`/api/agents/${String(state.missingId)}`), ref = (qa.adapterConfig as { env?: Record<string, unknown> }).env?.[marker.configPath.slice(4)] as { type?: string; secretId?: string } | undefined;
      state.missingBindingRef = ref ? { type: ref.type, secretId: ref.secretId } : null;
    }
    return observeExternal(ctx, state);
  },
  async verifyResult(ctx, _state, value) {
    const o = externalObservation(value), reply = o && verificationReplies(o).at(-1);
    if (!o || !reply?.commentId || !reply.body.trim()) throw new Error("No persisted reply from the verification run");
    await expect(ctx.input.page.locator(`[id=${JSON.stringify(`comment-${reply.commentId}`)}]`)).toBeVisible();
    await ctx.input.evidence("chat-catalog-external-visible-reply.json", { scenarioId: o.scenarioId, commentId: reply.commentId, runId: reply.runId });
  },
  async cleanup(ctx) { const fixture = fixtures.get(ctx); fixtures.delete(ctx); if (fixture) await rm(fixture.emptyHome, { recursive: true, force: true }); },
})];

async function usageKeys(ctx: ChatCatalogContext, secretId: string) {
  return (await ctx.input.api.get<{ bindings: CompanySecretUsageBinding[] }>(`/api/secrets/${secretId}/usage`)).bindings.map(bindingKey).sort();
}
async function acceptTeamBinding(ctx: ChatCatalogContext, marker: TeamBindingApproval, memberName: string, userId: string) {
  const page = ctx.input.page, budget = chatCatalogNativePhaseRemainingBudget(ctx), remaining = () => Math.max(1_000, budget ? budget() : 120_000), issueId = ctx.issue()!.id;
  const card = page.locator(`[data-testid="task-chat-interaction"][id=${JSON.stringify(`interaction-${marker.interactionId}`)}]`);
  await expect(card).toBeVisible({ timeout: remaining() });
  for (const text of [memberName, marker.configPath]) await expect(card).toContainText(text, { timeout: remaining() });
  const response = page.waitForResponse(res => new URL(res.url()).origin === new URL(page.url()).origin && new URL(res.url()).pathname === `/api/issues/${issueId}/interactions/${marker.interactionId}/accept` && res.request().method() === "POST", { timeout: remaining() });
  await card.getByRole("button", { name: "Create binding", exact: true }).click({ timeout: remaining() });
  const submitted = await response; if (!submitted.ok()) throw new Error("The binding approval did not persist");
  const receipt = await submitted.json() as RequestConfirmationInteraction;
  if (receipt.id !== marker.interactionId || receipt.status !== "accepted" || receipt.resolvedByUserId !== userId || receipt.resolvedByAgentId || receipt.issueId !== issueId || payloadHash(receipt.payload) !== marker.payloadHash)
    throw new Error("The binding approval receipt differs from the displayed proposal accepted by the current person");
}
async function waitForBindingContinuation(ctx: ChatCatalogContext) {
  const startedAt = Date.now(), budget = chatCatalogNativePhaseRemainingBudget(ctx), deadlineAt = startedAt + Math.min(budget ? budget() : 300_000, 300_000);
  await pollUntil({ label: "binding approval continuation", deadlineAt, intervalMs: 1_000,
    load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: ({ issue, runs }) => runs.every(run => run.status === "succeeded") && issue?.conversationState === "waiting" && (runs.length >= 2 || Date.now() - startedAt >= 15_000),
    reject: ({ runs }) => runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "The binding approval continuation failed" : undefined });
}
export function missingTeamAccountEnvironment(subscription: boolean, emptyHome: string) {
  return subscription ? { CODEX_HOME: emptyHome, OPENAI_API_KEY: "", CODEX_API_KEY: "" } : { OPENROUTER_API_KEY: "" };
}
