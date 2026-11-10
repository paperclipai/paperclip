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
import { sendChatMessage } from "../chat-flow.js";
import { codexSubscriptionAgentConfig } from "../codex-subscription-fixture.js";
import { definition, externalObservation, observeExternal, root, checks, verifyRenderedReply } from "./external-support.js";
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
async function probe(ctx: ChatCatalogContext, agent: Agent): Promise<Probe> {
  const result = await ctx.input.api.postSensitive<AdapterEnvironmentTestResult>(`${root(ctx)}/adapters/${agent.adapterType}/test-environment`, { agentId: agent.id, environmentId: agent.defaultEnvironmentId, adapterConfig: agent.adapterConfig });
  return { agentId: agent.id, status: result.status, testedAt: result.testedAt, checks: result.checks.map(check => ({ code: /^[a-zA-Z0-9_.-]{1,100}$/.test(check.code) ? check.code : "unrecognized", level: check.level })) };
}
export function gradeTeamConfigure(value: unknown) {
  const c = checks(), o = externalObservation(value); c.add("complete-member-configuration-evidence", !!o, "Real installed members, missing versus ready account probes, scoped repair and fresh per-member tests are required."); if (!o) return c.result();
  const initial = o.state.initialProbes as Probe[] | undefined, after = o.state.afterProbes as Probe[] | undefined;
  c.add("actual-missing-and-working-member-prerequisite", o.state.installedFromCatalog === true && typeof o.state.missingId === "string" && typeof o.state.workingId === "string" && o.state.missingId !== o.state.workingId
    && Array.isArray(initial) && initial.some(row => missingAccountProbe(row, String(o.state.missingId)))
    && initial.some(row => readyProbe(row, String(o.state.workingId))),
    "The supported catalog installer creates the team; actual runtime tests prove one exact missing account and a distinct already working member before chat.");
  c.add("specific-member-diagnosis-and-supported-repair", o.state.initialMemberNamed === true && o.state.initialHandoffSupported === true && o.state.repairConfirmed === true
    && ((o.state.repairChannel === "agent-configuration" && o.activity.some(row => row.entityId === o.state.missingId && row.action === "agent.updated" && row.actorType === "agent" && row.agentId === o.leadId))
      || (o.state.repairChannel === "human-board-configuration" && o.activity.some(row => row.entityId === o.state.missingId && row.action === "agent.updated" && row.actorType === "user"))),
    "Chat identifies the incomplete member and the supported step; repair changes that member through actual agent or human configuration authority.");
  c.add("already-working-member-preserved", typeof o.state.workingHashBefore === "string" && o.state.workingHashBefore === o.state.workingHashAfter && o.state.memberIdsPreserved === true,
    "The already working member's semantic configuration and the installed member identities remain unchanged.");
  c.add("working-configuration-revisions-preserved", Array.isArray(o.state.workingRevisionIdsBefore) && o.state.workingRevisionIdsBefore.length > 0
    && JSON.stringify(o.state.workingRevisionIdsBefore) === JSON.stringify(o.state.workingRevisionIdsAfter),
    "Public immutable configuration revision identities also remain unchanged, so redacted environment placeholders cannot hide an account change.");
  c.add("fresh-readiness-for-every-member", Array.isArray(after) && after.length === o.state.expectedMembers
    && JSON.stringify(after.map(row => row.agentId).sort()) === JSON.stringify(o.state.memberIdsBefore)
    && new Set(after.map(row => row.agentId)).size === after.length && after.every(row => row.status === "pass" && row.checks.every(check => check.level !== "error")
    && Number.isFinite(Date.parse(row.testedAt)) && Date.parse(row.testedAt) >= Number(o.state.repairVerifiedAfter)),
    "After the real repair every member passes its own fresh saved-runtime test; one healthy member cannot stand for the whole team.");
  const continuation = o.phaseReplies.filter(row => row.runId !== o.state.initialRunId);
  c.add("phase-bound-truthful-team-result", continuation.some(row => o.runs.some(run => run.id === row.runId && run.status === "succeeded"))
    && /ready|configured|verified|account/i.test(continuation.map(row => row.body).join("\n")) && o.state.noPrematureWholeTeamClaim === true,
    "The final claim belongs to the actual verification followup, and the initial reply did not call an unconfigured team ready.");
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
    if (!initialProbes.some(row => missingAccountProbe(row, missingId)) || !initialProbes.some(row => readyProbe(row, workingId))) throw new Error("Setup blocker: actual per-member runtime probes do not establish the required missing-versus-ready account split");
    const working = await ctx.input.api.get<Agent>(`/api/agents/${workingId}`);
    const workingRevisionIdsBefore = (await ctx.input.api.get<Array<{ id: string }>>(`/api/agents/${workingId}/config-revisions`)).map(row => row.id).sort();
    await ctx.input.api.post(`${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`); await ctx.refreshIssue();
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `The website team is the installed ${team.name} package. Its QA member (${missingId}) has not selected the eligible company ${subscription ? "Codex subscription" : "OpenRouter"} account. The senior coder (${workingId}) is already configured. The existing company account is authorized for the QA member too; its value must not enter chat.` });
    return { teamId: team.id, installedFromCatalog: true, memberIdsBefore: members.map(row => row.id).sort(), expectedMembers: members.length, missingId, missingName: members.find(row => row.id === missingId)!.name,
      workingId, workingHashBefore: configHash(working), workingRevisionIdsBefore, initialProbes };
  } catch (error) { fixtures.delete(ctx); await rm(emptyHome, { recursive: true, force: true }); throw error; }
}, gradeTeamConfigure, {
  authentication: "human-session", oracleVersion: "paperclip.chat-catalog.team-configure.v2", expectedRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 600_000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["missing-account-fixture", "working-account-fixture"] },
  async verifySetup(_ctx, state) { const c = checks(), rows = state.initialProbes as Probe[]; c.add("missing-account-fixture", rows.some(row => missingAccountProbe(row, String(state.missingId))), "Actual saved-runtime probe reports the required missing member account."); c.add("working-account-fixture", rows.some(row => readyProbe(row, String(state.workingId))), "A distinct installed member already passes its runtime probe."); return c.result(); },
  sourceFiles: ["chat-catalog-domains/external-team-configure.ts", "chat-catalog-domains/external-team-install.ts", "../../server/src/adapters/registry.ts", "../../packages/adapters/opencode-local/src/server/test.ts", "codex-subscription-fixture.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "chat-flow.ts", "chat-scenarios/teams.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); const initial = await observeExternal(ctx, state); state.initialRunId = initial.runs[0]?.id;
    state.initialMemberNamed = initial.reply.toLowerCase().includes(String(state.missingName).toLowerCase());
    const members = catalogTeamMembers(await observeTeamResources(ctx), String(state.teamId)), missing = members.find(row => row.id === state.missingId)!;
    const current = await probe(ctx, missing); const alreadyRepaired = current.status === "pass";
    const handoff = initial.links.find(href => { try { const url = new URL(href, initial.origin); return url.origin === initial.origin && url.pathname.split("/").some((part, i, parts) => part === "agents" && [missing.id, missing.urlKey].includes(parts[i + 1]!)); } catch { return false; } });
    state.initialHandoffSupported = alreadyRepaired || !!handoff;
    state.noPrematureWholeTeamClaim = alreadyRepaired || !/\b(?:team|product engineering)\s+(?:is|are|looks)\s+(?:now\s+)?(?:fully\s+)?ready/i.test(initial.reply);
    if (!alreadyRepaired) {
      if (!handoff) throw new Error("The model did not provide a supported configuration handoff for the incomplete member");
      const source = ctx.input.page.url(); await ctx.input.page.goto(handoff, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("main")).toContainText(missing.name);
      const fixture = fixtures.get(ctx); if (!fixture) throw new Error("Eligible team account reference missing");
      await ctx.input.api.patchSensitive(`/api/agents/${missing.id}`, { adapterType: fixture.override.adapterType, adapterConfig: fixture.override.adapterConfig }); state.repairChannel = "human-board-configuration";
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    } else state.repairChannel = "agent-configuration";
    state.repairVerifiedAfter = Date.now(); state.repairConfirmed = (await probe(ctx, await ctx.input.api.get<Agent>(`/api/agents/${missing.id}`))).status === "pass";
    await sendChatMessage(ctx.input.page, "Please verify which installed team members are ready now, including QA, and preserve the already working member's configuration.", chatCatalogNativePhaseRemainingBudget(ctx));
  },
  async observe(ctx, state) {
    const members = catalogTeamMembers(await observeTeamResources(ctx), String(state.teamId)); state.afterProbes = await Promise.all(members.map(member => probe(ctx, member)));
    state.memberIdsPreserved = JSON.stringify(members.map(row => row.id).sort()) === JSON.stringify(state.memberIdsBefore);
    state.workingHashAfter = members.some(row => row.id === state.workingId) ? configHash(members.find(row => row.id === state.workingId)!) : null;
    state.workingRevisionIdsAfter = (await ctx.input.api.get<Array<{ id: string }>>(`/api/agents/${state.workingId}/config-revisions`)).map(row => row.id).sort();
    return observeExternal(ctx, state);
  },
  async verifyResult(ctx, state, value) { await verifyRenderedReply(ctx, value, String(state.initialRunId)); },
  async cleanup(ctx) { const fixture = fixtures.get(ctx); fixtures.delete(ctx); if (fixture) await rm(fixture.emptyHome, { recursive: true, force: true }); },
})];

export function missingTeamAccountEnvironment(subscription: boolean, emptyHome: string) {
  return subscription ? { CODEX_HOME: emptyHome, OPENAI_API_KEY: "", CODEX_API_KEY: "" } : { OPENROUTER_API_KEY: "" };
}
