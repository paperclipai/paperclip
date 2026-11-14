import { readSkillVersionHistory } from "./integrator-skill-versions.js";
import type { CompanySkillDetail, CompanySkillVersion } from "../../../packages/shared/src/types/company-skill.js";
import type { AgentSkillSnapshot } from "../../../packages/shared/src/types/adapter-skills.js";
import { SKILL_POLICY_ACTIONS, type EffectiveSkillPolicy } from "../../../packages/shared/src/validators/skill-policy.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, task, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { probeAgentPermission, cleanupIdentityProbes } from "./identity-support.js";
import { integratorDefinition, inspectResult, observeInternal } from "./integrator-support.js";
interface EnableObservation extends InternalObservation { skill: CompanySkillDetail; assignment: AgentSkillSnapshot; effectivePolicy: unknown; versions: CompanySkillVersion[] }
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
async function observeEnable(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<EnableObservation> {
  const base = await observeInternal(ctx, state);
  return { ...base, skill: await ctx.input.api.get<CompanySkillDetail>(`${root(ctx)}/skills/${(state.skill as CompanySkillDetail).id}`),
    assignment: await ctx.input.api.get<AgentSkillSnapshot>(`/api/agents/${(state.worker as Entity).id}/skills`), effectivePolicy: await ctx.input.api.get(`${root(ctx)}/skill-policy`),
    versions: await readSkillVersionHistory(ctx.input.api, ctx.input.fixtures.company.id, (state.skill as CompanySkillDetail).id) };
}
export interface SkillEnableAuthorityProof {
  companyId: string; principalId: string; targetId: string; targetCompanyId: string; status: number;
  membership?: { companyId: string; principalType: string; principalId: string; status: string } | null;
  grants: Array<{ permissionKey: string; scope?: unknown }>;
  before: AgentSkillSnapshot; after: AgentSkillSnapshot;
}
export function skillEnableAuthorityReady(proof: SkillEnableAuthorityProof | undefined, companyId: string, principalId: string, targetId: string, skillKey: string) {
  return !!proof && proof.status === 200 && proof.companyId === companyId && proof.principalId === principalId && proof.targetId === targetId && proof.targetCompanyId === companyId
    && proof.membership?.companyId === companyId && proof.membership.principalType === "agent" && proof.membership.principalId === principalId && proof.membership.status === "active"
    && Array.isArray(proof.grants) && proof.grants.some(grant => grant.permissionKey === "agents:configure")
    && proof.before?.supported === true && proof.after?.supported === true && Array.isArray(proof.before.desiredSkills) && Array.isArray(proof.after.desiredSkills)
    && !proof.before.desiredSkills.includes(skillKey) && !proof.after.desiredSkills.includes(skillKey)
    && JSON.stringify(proof.before.desiredSkills) === JSON.stringify(proof.after.desiredSkills)
    && JSON.stringify(proof.before.desiredSkillEntries ?? []) === JSON.stringify(proof.after.desiredSkillEntries ?? []);
}
function enableObservation(value: unknown): EnableObservation | undefined { const o = value as EnableObservation; return observation(value) && !!o.skill && Array.isArray(o.assignment?.desiredSkills) && !!o.effectivePolicy && Array.isArray(o.versions) ? o : undefined; }
export function gradeIntegratorSkillEnable(value: unknown) {
  const c = checks(); const o = enableObservation(value); c.add("real-assignment-policy-and-future-admission", !!o, "Requires actual permitted assignment, unchanged installed revision/policy and a real subsequent native admission."); if (!o) return c.result();
  const original = o.state.skill as CompanySkillDetail; const worker = o.state.worker as Entity;
  c.add("actual-ceo-target-configuration-and-no-op-readback", skillEnableAuthorityReady(o.state.configurationAuthority as SkillEnableAuthorityProof | undefined, o.companyId, o.leadId, worker.id, original.key),
    "The actual same-company CEO membership/default configuration grant and its successful target-specific agent-bearer no-op are read back without assigning the requested skill during setup.");
  c.add("actual-configuration-grant-prerequisite", o.state.agentConfigurationStatus === 200, "The actual CEO bearer successfully exercised a no-op public skill configuration probe; title/legacy hire authority is not a configuration grant.");
  const future = o.runs.find(run => run.agentId === worker.id && run.companyId === o.companyId && run.contextSnapshot?.issueId === (o.state.futureTask as Entity | undefined)?.id);
  const selectedId = (future?.contextSnapshot?.skillVersions as Record<string, unknown> | undefined)?.[original.key];
  const delivered = o.versions.find(row => row.id === selectedId && row.companyId === o.companyId && row.companySkillId === original.id);
  const exactBytes = !!delivered && delivered.fileInventory.length === 1 && delivered.fileInventory[0]?.path === "SKILL.md"
    && delivered.fileInventory[0].encoding !== "base64" && delivered.fileInventory[0].content === original.markdown;
  c.add("saved-intended-morgan-assignment", o.assignment.supported && o.assignment.desiredSkills.includes(original.key)
    && o.assignment.desiredSkillEntries?.some(entry => entry.key === original.key && (entry.versionId === null || entry.versionId === original.currentVersionId || exactBytes && entry.versionId === selectedId)) === true
    && o.activity.some(event => event.action === "agent.skills_synced" && event.agentId === o.leadId && event.entityId === worker.id
      && Array.isArray(o.state.beforeActivityIds) && !o.state.beforeActivityIds.includes(event.id)
      && o.runs.some(run => run.id === (event as Entity & { runId?: string }).runId && run.agentId === o.leadId)),
  "The requested existing skill is durably assigned to the actual Morgan through the normal agent skill configuration path.");
  c.add("installation-and-policy-not-self-elevated", o.skill.id === original.id && o.skill.markdown === original.markdown && (o.skill.currentVersionId === original.currentVersionId || exactBytes && o.skill.currentVersionId === selectedId)
    && JSON.stringify(o.effectivePolicy) === JSON.stringify(o.state.effectivePolicy)
    && !o.activity.some(event => event.agentId === o.leadId && /skill_policy\.|company\.skill_(?:created|file_updated|forked)/.test(event.action ?? "")),
  "Assignment preserves the already installed revision and effective policy rather than installing again or rewriting policy to gain authority.");
  c.add("future-execution-receives-intended-version", future?.runtimeMode === "native" && future.status === "succeeded"
    && exactBytes && (!original.currentVersionId || selectedId === original.currentVersionId),
  "A separately admitted actual Morgan task receives the selected immutable skill revision in its saved native skill selection snapshot.");
  // The reply's wording is not matched: the saved assignment, the unchanged
  // policy and the future run's delivered revision prove the work. This check
  // proves the chat run configured only Morgan, and that it answered.
  c.add("assignment-scoped-to-morgan-and-reported", o.reply.trim().length > 0
    && !o.activity.some(event => event.action === "agent.skills_synced" && event.agentId === o.leadId && event.entityId !== worker.id
      && Array.isArray(o.state.beforeActivityIds) && !o.state.beforeActivityIds.includes(event.id)),
  "The chat run changes skill configuration for Morgan alone (no other agent and no global policy) and replies to the person.");
  return c.result();
}
export function unsupportedUsePrerequisite(value: { useStatus: number; decisions: Array<{ action: string; allowed: boolean }>; assignmentRetained: boolean }) {
  return !(SKILL_POLICY_ACTIONS as readonly string[]).includes("skills.use") && value.useStatus === 400
    && value.decisions.length === SKILL_POLICY_ACTIONS.length
    && SKILL_POLICY_ACTIONS.every(action => value.decisions.some(decision => decision.action === action && !decision.allowed))
    && value.assignmentRetained;
}
export const integratorSkillEnableCases = [integratorDefinition("skills", "skills.enable-for-agent", async ctx => {
  try {
    const p = await project(ctx, "Launch"); const worker = await fixtureWorker(ctx);
    const created = await ctx.input.api.post<CompanySkillDetail>(`${root(ctx)}/skills`, { name: "Accessibility review", slug: "accessibility-review", markdown: "---\nname: accessibility-review\ndescription: Check synthetic HTML form labels.\n---\n\nFor supplied synthetic HTML, identify every form input without a visible label. Save concrete evidence in the task comment and finish the task. Do not browse other pages or claim global qualification." });
    const effectivePolicy = await ctx.input.api.get<EffectiveSkillPolicy>(`${root(ctx)}/skill-policy`);
    const access = await ctx.input.api.get<{ access?: { membership?: SkillEnableAuthorityProof["membership"]; grants?: SkillEnableAuthorityProof["grants"] } }>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const before = await ctx.input.api.get<AgentSkillSnapshot>(`/api/agents/${worker.id}/skills`);
    const agentConfigurationStatus = await probeAgentPermission(ctx, `/api/agents/${worker.id}/skills/sync`, "POST", { mode: "add", desiredSkills: [] });
    const after = await ctx.input.api.get<AgentSkillSnapshot>(`/api/agents/${worker.id}/skills`);
    const configurationAuthority: SkillEnableAuthorityProof = { companyId: ctx.input.fixtures.company.id, principalId: ctx.input.fixtures.agent.id,
      targetId: worker.id, targetCompanyId: worker.companyId!, status: agentConfigurationStatus,
      membership: access.access?.membership, grants: access.access?.grants ?? [], before, after };
    const policyAfterProbe = await ctx.input.api.get<EffectiveSkillPolicy>(`${root(ctx)}/skill-policy`);
    await ctx.input.evidence("chat-skill-configuration-prerequisite.json", { configurationAuthority, querySent: false, grantMutationAttempted: false,
      requestedSkillAssignedBySetup: after.desiredSkills.includes(created.key), effectiveUseDenialExperimentRun: false, deniedUseCoverageClaimed: false,
      conditionalCoverageNote: "This installed-skill/allowed-assignment positive context does not claim conditional effective-use-denial coverage. No lifecycle denial or unsupported skills.use action substitutes for a supported actual use denial.",
      originalPolicyRetained: JSON.stringify(effectivePolicy) === JSON.stringify(policyAfterProbe) });
    if (!skillEnableAuthorityReady(configurationAuthority, ctx.input.fixtures.company.id, ctx.input.fixtures.agent.id, worker.id, created.key)
      || JSON.stringify(effectivePolicy) !== JSON.stringify(policyAfterProbe)) throw new Error(`Setup blocker: actual CEO target configuration authority/no-op readback was not established (HTTP ${agentConfigurationStatus}); no grant or requested assignment was substituted.`);
    return { project: p, worker: { id: worker.id }, skill: await ctx.input.api.get<CompanySkillDetail>(`${root(ctx)}/skills/${created.id}`), effectivePolicy, agentConfigurationStatus, configurationAuthority,
      beforeActivityIds: (await ctx.input.api.get<Entity[]>(`${root(ctx)}/activity?limit=1000`)).map(event => event.id) };
  } catch (error) { await cleanupIdentityProbes(ctx); throw error; }
}, observeEnable, gradeIntegratorSkillEnable, async (ctx, state) => {
  const skill = state.skill as CompanySkillDetail; await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/skills/studio/${skill.id}`, skill.name);
}, { sourceFiles: ["chat-catalog-domains/integrator-skill-versions.ts", "chat-catalog-domains/integrator-skill-enable.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "chat-scenarios/skills.yaml", "../../server/src/routes/agents.ts", "../../server/src/routes/company-skill-policy.ts", "../../server/src/services/company-skills.ts", "../../packages/shared/src/validators/skill-policy.ts"],
  expectedRunCount: 2, attemptTimeoutMs: 540_000, oracleVersion: "paperclip.chat-catalog.skill-enable.standard-config.v3",
  async act(ctx, state) {
    const first = await pollUntil({ label: "actual Morgan assignment before future admission", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: () => observeEnable(ctx, state), accept: o => o.runs.length === 1 && o.runs[0]?.status === "succeeded" && ctx.issue()?.conversationState === "waiting" });
    const skill = state.skill as CompanySkillDetail;
    if (!first.assignment.desiredSkills.includes(skill.key)) throw new Error("Canonical request did not save the intended assignment; no fixture assignment will repair it");
    state.assignmentCheckpoint = { ...first, state: structuredClone(state) };
    state.futureTask = await task(ctx, "Verify assigned accessibility skill on synthetic HTML", (state.project as Entity).id, { status: "todo", assigneeAgentId: (state.worker as Entity).id,
      description: 'Use the assigned accessibility-review skill on this synthetic input only: <form><input id="sample-email" type="email"><button>Join</button></form>. Save the actual form-label finding in a comment and complete this task. Do not change assignments, policy or other work.' });
  }, async cleanup(ctx) { await cleanupIdentityProbes(ctx); },
})];
