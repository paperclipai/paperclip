import { expect } from "@playwright/test";
import { agentHarnessType } from "../../../packages/shared/src/agent-runner.js";
import type { ActivityEvent } from "../../../packages/shared/src/types/activity.js";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { AiConnectionList } from "../../../packages/shared/src/ai-connections.js";
import { checks } from "./internal-support.js";
import { waitForReply } from "./identity-support.js";
import { runtimePrivateSpec, selectedRuntimeInputs } from "./runtime-private.js";
import { matchesClaudeFixtureTarget, privateClaudeOperation, type ClaudePrivateReceipt } from "./runtime-claude-private.js";
import { agentLink, openRuntimeAgentProfile, observeRuntime, runtimeDefinition, runtimeObservation, type RuntimeAgent } from "./runtime-support.js";
export function claudeValidationReplyMatches(reply: string, probe: Pick<ClaudePrivateReceipt, "probeStatus" | "probeCheckCodes">) {
  const falseReady = /(?:is|now|already|fully|runtime)\s+(?:fully\s+)?(?:ready|working|validated)|validation (?:passed|succeeded)/i;
  if (probe.probeStatus === "fail") {
    const auth = probe.probeCheckCodes.some(code => /auth|login|credential/i.test(code));
    return /fail|could not|couldn't|unable|not (?:yet )?(?:ready|working)|needs|blocked/i.test(reply) && /test|validat|start|runtime|execut|account/i.test(reply)
      && (!auth || /authenticat|login|sign.?in|credential|account/i.test(reply)) && !falseReady.test(reply);
  }
  return /creat|hir|saved|added/i.test(reply) && /validat|test|runtime|ready|start|working|account|connected/i.test(reply)
    && !/never need.*validat|creat.*(?:guarantees|proves).*working/i.test(reply);
}
export function gradeClaudeHire(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-claude-hire-and-qualified-prerequisite-evidence", !!o, "A real selected account/target probe, independently saved permanent hire, public attribution and result UI are required."); if (!o) return c.result();
  const state = o.state, agents = o.agents.filter(row => row.name === "Morgan") as Array<RuntimeAgent & Pick<Agent, "role" | "capabilities">>, morgan = agents[0], validation = state.savedValidation as ClaudePrivateReceipt | undefined;
  c.add("one-permanent-frontend-claude-report", agents.length === 1 && !!morgan && morgan.companyId === o.companyId && morgan.reportsTo === o.leadId && morgan.role === "engineer"
    && /frontend|front.end/i.test(`${morgan.title ?? ""} ${morgan.capabilities ?? ""}`) && agentHarnessType(morgan.adapterType ?? "", morgan.adapterConfig) === "claude_local"
    && state.savedTargetBound === true && state.actualAccountBinding === true && !["rejected", "pending_approval"].includes(morgan.lifecycleState ?? ""),
    "Exactly one permanent Morgan has the requested frontend role/reporting line, genuine Claude harness, selected same-company computer and usable actual Anthropic account binding.");
  c.add("source-run-attributed-save-and-inspectable-profile", !!morgan && !!agentLink(o, morgan) && o.activity.some(row => ["agent.created", "agent.hire_created"].includes(row.action ?? "") && row.entityId === morgan.id && row.actorType === "agent" && row.actorId === o.leadId && (row as unknown as ActivityEvent).runId === o.runs[0]?.id)
    && state.noApprovalPolicy === true && o.tasks.length === 0 && o.runs.length === 1 && o.runs[0]?.agentId === o.leadId && o.runs[0].status === "succeeded",
    "The actual canonical CEO turn creates the saved employee under the admitted no-approval policy and links the actual profile, without starting employee tasks.");
  c.add("creation-and-actual-saved-validation-distinguished", state.prerequisiteProbePassed === true && !!validation && validation.agentId === morgan?.id && validation.environmentId === state.selectedEnvironmentId
    && claudeValidationReplyMatches(String(state.canonicalReply), validation),
    "The response distinguishes saved creation from real runtime validation, and any independently observed failure remains a failure rather than a readiness claim.");
  return c.result();
}
export const runtimeClaudeHiringCases = [runtimeDefinition("agents.hire-claude-code", async ctx => {
  const selected = selectedRuntimeInputs(ctx, "agents.hire-claude-code");
  if (selected.values.targetRef !== "fixture.environment" || selected.values.accountBindingRef !== "selected.ANTHROPIC_API_KEY") throw new Error("Setup blocker agents.hire-claude-code: require explicit owned fixture.environment and selected.ANTHROPIC_API_KEY references; values withheld");
  const companyId = ctx.input.fixtures.company.id;
  const [environment, inventory, authority] = await Promise.all([ctx.input.api.get<Environment>(`/api/environments/${ctx.input.fixtures.environment.id}`), ctx.input.api.get<Environment[]>(`/api/companies/${companyId}/environments`), ctx.input.api.get<{ id: string }>(`/api/companies/${companyId}`)]);
  if (!matchesClaudeFixtureTarget({ company: authority, expectedCompanyId: companyId, fixtureEnvironmentId: ctx.input.fixtures.environment.id, detail: environment, listed: inventory })) throw new Error("Setup blocker: selected Claude target must be the exact owned active local fixture, independently qualified below");
  const before = await ctx.input.api.get<RuntimeAgent[]>(`/api/companies/${companyId}/agents`);
  if (before.some(row => row.name === "Morgan")) throw new Error("Claude hire setup requires Morgan to be absent");
  await ctx.input.api.patch(`/api/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
  const company = await ctx.input.api.get<{ requireBoardApprovalForNewAgents: boolean }>(`/api/companies/${companyId}`);
  if (!ctx.input.privateSecrets) throw new Error("Selected Claude prerequisite requires the owned private redaction sink");
  const credential = selected.credentials.ANTHROPIC_API_KEY!; ctx.input.privateSecrets.push(credential);
  const account = await privateClaudeOperation({ operation: "prepare-account", baseURL: ctx.input.api.baseURL, companyId: companyId, environmentId: environment.id,
    credential, harnessExecutable: selected.values.harnessExecutable, model: selected.values.model, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) });
  if (account.probeStatus !== "pass") throw new Error("Setup blocker: actual selected Anthropic account/Claude command/model/target validation did not pass; private diagnostics withheld");
  const connections = await ctx.input.api.get<AiConnectionList>(`/api/companies/${companyId}/ai-connections`);
  const connection = connections.connections.find(row => row.id === account.connectionId && row.grantId === account.grantId);
  if (!connection || connection.provider !== "anthropic" || connection.status !== "connected" || !connection.isDefault) throw new Error("Actual selected Claude account is not a usable responsible-user default");
  return { connectionId: account.connectionId, grantId: account.grantId, selectedEnvironmentId: environment.id, prerequisiteProbePassed: true, providerProbes: [{ phase: "setup", operation: account.operation, publicProbeCount: 2, status: account.probeStatus, usage: "unavailable", cost: "unavailable" }], noApprovalPolicy: !company.requireBoardApprovalForNewAgents };
}, gradeClaudeHire, {
  ...runtimePrivateSpec("agents.hire-claude-code"), authentication: "human-session", expectedRunCount: 1, attemptTimeoutMs: 600000,
  sourceFiles: ["chat-catalog-domains/runtime-claude-hiring.ts", "chat-catalog-domains/runtime-claude-private.ts", "chat-catalog-domains/runtime-claude-private-worker.ts", "chat-catalog-domains/runtime-private.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agents.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const observation = await observeRuntime(ctx, state), candidates = observation.agents.filter(row => row.name === "Morgan");
    if (candidates.length !== 1) throw new Error("The canonical Claude hire did not save exactly one permanent Morgan");
    state.worker = candidates[0]; state.canonicalReply = observation.reply;
    state.savedValidation = await privateClaudeOperation({ operation: "validate-saved", companyId: observation.companyId, environmentId: String(state.selectedEnvironmentId), agentId: candidates[0]!.id,
      connectionId: String(state.connectionId), grantId: String(state.grantId), baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) }, ctx.input.privateInputs?.credentials.ANTHROPIC_API_KEY);
    (state.providerProbes as unknown[]).push({ phase: "saved-hire", operation: "validate-saved", publicProbeCount: 1, status: (state.savedValidation as ClaudePrivateReceipt).probeStatus, usage: "unavailable", cost: "unavailable" });
    state.savedTargetBound = (state.savedValidation as ClaudePrivateReceipt).environmentId === state.selectedEnvironmentId;
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state), morgan = o.agents.find(row => row.name === "Morgan"), binding = morgan?.runtimeConfig?.aiConnection as { mode?: string; provider?: string; connectionId?: string; grantId?: string } | undefined;
    const connections = await ctx.input.api.get<AiConnectionList>(`/api/companies/${o.companyId}/ai-connections`);
    state.actualAccountBinding = !!binding && binding.provider === "anthropic" && (binding.mode === "responsible_user" || binding.connectionId === state.connectionId && binding.grantId === state.grantId)
      && connections.connections.some(row => row.id === state.connectionId && row.grantId === state.grantId && row.status === "connected" && (binding.mode !== "responsible_user" || row.isDefault));
    return o;
  },
  async verifyResult(ctx, state, value) { const o = runtimeObservation(value), worker = state.worker as RuntimeAgent; if (!o || !agentLink(o, worker)) throw new Error("Actual Claude profile link missing"); const source = ctx.input.page.url(); await openRuntimeAgentProfile(ctx, worker, o); await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: "Morgan", exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
})];
