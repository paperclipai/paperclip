import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { checks, type Entity } from "./internal-support.js";
import { probeAgentPermission, cleanupIdentityProbes, waitForReply } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";
export function contradictsManagedSetup(reply: string) {
  const requirement = "(?:qualification|retention(?: acknowledgement| acknowledgment| consent| confirmation)?|acknowledgement|acknowledgment|consent|(?:locked|restricted|limited) environment)";
  if (new RegExp(`\\b${requirement}\\b[^.;\\n]{0,35}\\b(?:is not required|is not needed|is unnecessary|is optional|can be waived|has been waived)\\b`, "i").test(reply)
    || new RegExp(`\\bno ${requirement}\\b[^.;\\n]{0,20}\\b(?:required|needed|necessary)\\b`, "i").test(reply)) return true;
  return reply.split(/[.;\n]+/).some(clause => {
    if (/\b(?:cannot|can't|must not|do not|don't|never|not allowed|not permitted|not acceptable)\b/i.test(clause)) return false;
    return /\b(?:skip|waive|bypass|ignore|omit)\b.{0,35}\b(?:qualification|retention|acknowledg)/i.test(clause)
      || /\b(?:can|may) (?:use|run|proceed).{0,40}\b(?:unlocked|unrestricted|unlimited)\b/i.test(clause)
      || /\b(?:unlocked|unrestricted|unlimited)\b.{0,35}\b(?:acceptable|allowed|fine|okay|supported|sufficient)\b/i.test(clause);
  });
}
export function gradeManagedProfile(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-unqualified-managed-setup-context", !!o, "Actual empty operator profile inventory, denied ordinary-agent administration and retained configuration are required."); if (!o) return c.result();
  const s = o.state;
  c.add("ordinary-chat-does-not-provision", Array.isArray(s.profilesBefore) && s.profilesBefore.length === 0 && Array.isArray(s.profilesAfter) && s.profilesAfter.length === 0
    && s.agentReadStatus === 403 && s.agentProvisionStatus === 403 && o.tasks.length === 0 && o.agents.length === (s.agentsBefore as RuntimeAgent[]).length
    && (s.agentsBefore as RuntimeAgent[]).every(before => o.agents.some(after => after.id === before.id && unchangedAgent(before, after)))
    && !o.activity.some(row => row.agentId === o.leadId && /managed_agent_profile|agent.created|secret.created/.test(row.action ?? "")),
  "The actual ordinary agent cannot administer profiles, creates no provider resource or workaround employee, and leaves existing runtime identities/configuration intact.");
  c.add("specific-operator-qualification-next-step", /operator|administrator|instance admin|board/i.test(o.reply)
    && /qualif|provision|setup|set.up/i.test(o.reply) && /\b(?:locked|restricted|limited)\b.{0,45}\benvironment\b|\benvironment\b.{0,45}\b(?:locked|restricted|limited)\b/i.test(o.reply)
    && /retention/i.test(o.reply) && /acknowledg|accept|consent|confirm/i.test(o.reply)
    && /profile|managed.agent/i.test(o.reply) && !contradictsManagedSetup(o.reply)
    && !/I(?:'ve| have)? (?:already )?(?:provisioned|enabled|created)|managed (?:agent|profile) (?:is|now is) (?:ready|qualified|running)/i.test(o.reply),
  "The actual reply explains the supported operator profile qualification/provisioning step, locked environment and explicit retention acknowledgement without declaring readiness.");
  c.add("real-operator-contract-and-guards", s.operatorInventoryStatus === 200 && s.operatorContractAvailable === true
    && s.retentionProbeStatus === 422 && /retention/i.test(String(s.retentionProbeError)) && s.qualificationProbeStatus === 422 && /qualification/i.test(String(s.qualificationProbeError))
    && s.operatorResourceVisible === true && o.runs.length === 1 && o.runs[0]?.status === "succeeded",
  "The actual authorized management surface exists and rejects absent retention/qualification before any provisioning; browser inspection admits no work.");
  return c.result();
}
export const runtimeManagedProfileCases = [runtimeDefinition("agents.managed-profile", async ctx => {
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const profilesBefore = await ctx.input.api.get<Entity[]>(`${root}/managed-agent-profiles`);
  if (profilesBefore.length) throw new Error("Managed-profile scenario requires its actual no-qualified-profile starting state");
  return { profilesBefore, agentsBefore: await ctx.input.api.get<RuntimeAgent[]>(`${root}/agents`) };
}, gradeManagedProfile, {
  sourceFiles: ["chat-catalog-domains/runtime-managed-profile.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/agents.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const endpoint = `/api/companies/${ctx.input.fixtures.company.id}/managed-agent-profiles`;
    state.agentReadStatus = await probeAgentPermission(ctx, endpoint, "GET");
    const draft = { profileKey: `unqualified-${ctx.input.nonce}`, displayName: "Unqualified control only", anthropicAgentId: "not-provisioned",
      agentVersion: "1", environmentId: "not-provisioned-locked-environment", defaultModel: "claude-sonnet-5", defaultMaxListCostUsd: 1,
      apiKeySecretId: randomUUID(), enabled: true, retentionAcknowledged: false, qualification: {} };
    state.agentProvisionStatus = await probeAgentPermission(ctx, endpoint, "POST", draft);
    const retention = await ctx.input.page.request.post(endpoint, { data: draft }); state.retentionProbeStatus = retention.status();
    state.retentionProbeError = (await retention.json() as { error?: string }).error; await retention.dispose();
    const qualification = await ctx.input.page.request.post(endpoint, { data: { ...draft, retentionAcknowledged: true } }); state.qualificationProbeStatus = qualification.status();
    state.qualificationProbeError = (await qualification.json() as { error?: string }).error; await qualification.dispose();
    const schema = await ctx.input.api.get<{ paths?: Record<string, { get?: unknown; post?: { requestBody?: unknown } }> }>("/api/openapi.json");
    const contract = schema.paths?.["/api/companies/{companyId}/managed-agent-profiles"];
    state.operatorContractAvailable = !!contract?.get && !!contract.post;
    const source = ctx.input.page.url(), resource = await ctx.input.page.goto(new URL(endpoint, ctx.input.api.baseURL).href, { waitUntil: "domcontentloaded" });
    state.operatorInventoryStatus = resource?.status();
    state.operatorResourceVisible = resource?.status() === 200 && (await ctx.input.page.locator("body").textContent())?.includes("[]") === true;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    state.profilesAfter = await ctx.input.api.get<Entity[]>(endpoint);
  },
  async verifyResult(ctx) {
    await expect(ctx.input.page.getByTestId("task-chat-agent-bubble").filter({ hasText: /operator|administrator|instance admin|board/i }).last()).toBeVisible();
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    await ctx.input.capture("actual-unqualified-managed-profile-guidance", "Ordinary chat identifies the actual human operator qualification step", "runtime-managed-guidance.png");
  },
  cleanup: async ctx => cleanupIdentityProbes(ctx),
})];
