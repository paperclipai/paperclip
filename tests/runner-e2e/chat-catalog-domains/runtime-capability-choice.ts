import { expect } from "@playwright/test";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import type { EnvironmentCapabilities } from "../../../packages/shared/src/environment-support.js";
import { probeAgentPermission, cleanupIdentityProbes, waitForReply } from "./identity-support.js";
import { checks } from "./internal-support.js";
import { runtimeDefinition, runtimeObservation, runtimeWorker, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";

const scenarioId = "execution-environments.choose-capable-target";
export function advertisedClaudeTargets(capabilities: EnvironmentCapabilities, supported: Pick<Environment, "id" | "driver" | "config">, unsupported: Pick<Environment, "id" | "driver" | "config">) {
  const claude = capabilities.adapters.find(row => row.adapterType === "claude_local");
  return supported.id !== unsupported.id && supported.driver === "local" && claude?.drivers.local === "supported"
    && unsupported.driver === "sandbox" && unsupported.config.provider === "fake"
    && claude.sandboxProviders.fake === "unsupported" && capabilities.sandboxProviders.fake?.status === "unsupported";
}
export function recommendsIncompatibleTarget(reply: string) {
  // Match a recommendation whose object is the incompatible target, not a
  // warning or a hypothetical that tells the operator to choose another one.
  const recommendation = /\b(?:choose|select|pick|use|assign|bind|recommend)\s+(?:(?:the|an?|this|that|our|your|existing|known)\s+){0,3}(?:incompatible|unsupported)\s+(?:(?:execution|runtime|sandbox|cloud|local|SSH)\s+)?(?:target|computer|environment|one)\b/gi;
  return [...reply.matchAll(recommendation)].some(match => !/\b(?:do not|don't|cannot|can't|never|not to|avoid|won't|would not)\s*(?:\w+\s+){0,3}$/i.test(reply.slice(Math.max(0, match.index! - 45), match.index!)))
    || /\b(?:incompatible|unsupported)\s+(?:target|computer|environment)\s+(?:is|would be)\s+(?:the\s+)?(?:recommended|preferred|correct|right|best)\s+(?:choice|target|computer|environment)\b/i.test(reply);
}
export function capabilityChoiceReply(reply: string) {
  const healthClaim = /\b(?:(?:is|are|already|fully|now)\s+(?:fully\s+)?(?:ready|healthy|qualified|validated)|tested successfully|health (?:test|probe|validation) (?:passed|succeeded))\b/gi;
  const falseHealth = [...reply.matchAll(healthClaim)].some(match => !/\b(?:not|never)\s*$|\b(?:not|never)\s+(?:yet|already|fully)\s*$/i.test(reply.slice(Math.max(0, match.index! - 30), match.index!)));
  return !falseHealth && !recommendsIncompatibleTarget(reply) && /Claude Code/i.test(reply) && /capabilit|compatib|support/i.test(reply)
    && /health|probe|test|qualif|validat/i.test(reply) && /operator|administrator|settings|human|board/i.test(reply)
    && !/I (?:inspected|read|checked) (?:the )?(?:hidden|board.only|restricted) (?:environment )?inventory/i.test(reply);
}
export function gradeCapabilityChoice(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("independent-capability-observation", !!o, "Actual owned targets, production capability metadata and native reply are required.");
  if (!o) return c.result();
  const s = o.state;
  c.add("actual-advertised-support-not-health", !!s.capabilities && !!s.supportedTarget && !!s.unsupportedTarget
    && advertisedClaudeTargets(s.capabilities as EnvironmentCapabilities, s.supportedTarget as Environment, s.unsupportedTarget as Environment),
    "Production metadata advertises local Claude support and explicitly rejects the control provider; neither is a runtime probe.");
  c.add("restricted-agent-honest-guidance", s.agentInventoryStatus === 403 && s.agentProbeStatus === 403
    && capabilityChoiceReply(o.reply), "The ordinary agent directs the operator to capabilities and does not claim hidden inventory or qualified runtime health.");
  c.add("actual-operator-view", s.operatorViewVisible === true && s.viewCapabilitiesMatched === true,
    "The real routed environment view displays both actual targets and loads the independently checked capability response.");
  c.add("targets-and-worker-preserved", s.savedTargetsUnchanged === true && s.workerUnchanged === true,
    "No incompatible target selection, target mutation or silent harness/account substitution occurs.");
  c.add("single-source-turn-only", o.tasks.length === 0 && o.runs.length === 1 && o.runs[0]!.status === "succeeded",
    "Exactly the declared ordinary chat turn occurs, with no work task or remote qualification.");
  return c.result();
}
export const runtimeCapabilityChoiceCase = runtimeDefinition(scenarioId, async ctx => {
  const api = ctx.input.api, company = `/api/companies/${ctx.input.fixtures.company.id}`;
  const originalSettings = await api.get<{ enableEnvironments: boolean }>("/api/instance/settings/experimental");
  await api.patch("/api/instance/settings/experimental", { enableEnvironments: true });
  let unsupported: Environment | undefined;
  try {
    const inventory = await api.get<Environment[]>(`${company}/environments`);
    const supported = inventory.find(row => row.id === ctx.input.fixtures.environment.id && row.driver === "local");
    if (!supported) throw new Error("Owned local fixture target is not in the public company-authorized inventory");
    unsupported = await api.post<Environment>(`${company}/environments`, { name: `Unsupported capability control ${ctx.input.nonce}`, driver: "sandbox", config: { provider: "fake", image: "unsupported-control", reuseLease: false } });
    const capabilities = await api.get<EnvironmentCapabilities>(`${company}/environments/capabilities`);
    if (!advertisedClaudeTargets(capabilities, supported, unsupported)) throw new Error("Production metadata does not establish the requested advertised capability contrast");
    const worker = await runtimeWorker(ctx);
    return { supportedTarget: supported, unsupportedTarget: unsupported, capabilities, worker, originalEnvironmentsEnabled: originalSettings.enableEnvironments,
      agentInventoryStatus: await probeAgentPermission(ctx, `${company}/environments/capabilities`, "GET"),
      agentProbeStatus: await probeAgentPermission(ctx, `/api/environments/${supported.id}/probe`, "POST", {}) };
  } catch (error) {
    if (unsupported) await api.delete(`/api/environments/${unsupported.id}`, { allowNotFound: true });
    await api.patch("/api/instance/settings/experimental", { enableEnvironments: originalSettings.enableEnvironments });
    await cleanupIdentityProbes(ctx); throw error;
  }
}, gradeCapabilityChoice, { authentication: "human-session", attemptTimeoutMs: 900000,
  sourceFiles: ["chat-catalog-domains/runtime-capability-choice.ts", "chat-catalog-domains/runtime-computers-ssh.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/execution-environments.yaml", "../../packages/shared/src/environment-support.ts", "../../server/src/routes/environments.ts", "../../ui/src/pages/CompanyEnvironments.tsx"],
  async act(ctx, state) {
    await waitForReply(ctx);
    const source = ctx.input.page.url(), company = `/api/companies/${ctx.input.fixtures.company.id}`;
    const response = ctx.input.page.waitForResponse(row => row.request().method() === "GET" && new URL(row.url()).pathname === `${company}/environments/capabilities`);
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/company/settings/instance/environments`, { waitUntil: "domcontentloaded" });
    const actualResponse = await response;
    state.viewCapabilitiesMatched = actualResponse.ok() && JSON.stringify(await actualResponse.json()) === JSON.stringify(state.capabilities);
    const view = ctx.input.page.getByTestId("instance-settings-environments-section");
    await expect(view).toBeVisible();
    for (const target of [state.supportedTarget, state.unsupportedTarget] as Environment[]) await expect(view.getByText(target.name, { exact: true })).toBeVisible();
    state.operatorViewVisible = true;
    await ctx.input.evidence("runtime-advertised-capabilities.json", { supportIsAdvertisedOnly: true, runtimeHealth: "unverified", supportedTargetId: (state.supportedTarget as Environment).id, unsupportedTargetId: (state.unsupportedTarget as Environment).id, capabilities: state.capabilities });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const api = ctx.input.api, targets = [state.supportedTarget, state.unsupportedTarget] as Environment[];
    const current = await Promise.all(targets.map(target => api.get<Environment>(`/api/environments/${target.id}`)));
    state.savedTargetsUnchanged = targets.every((target, index) => ["id", "driver", "name", "config"].every(key => JSON.stringify(target[key as keyof Environment]) === JSON.stringify(current[index]![key as keyof Environment])));
    const worker = state.worker as RuntimeAgent;
    state.workerUnchanged = unchangedAgent(worker, await api.get<RuntimeAgent>(`/api/agents/${worker.id}`));
    const { observeRuntime } = await import("./runtime-support.js"); return observeRuntime(ctx, state);
  },
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
  async cleanup(ctx, state) {
    try { if (state.unsupportedTarget) await ctx.input.api.delete(`/api/environments/${(state.unsupportedTarget as Environment).id}`, { allowNotFound: true }); }
    finally { if (typeof state.originalEnvironmentsEnabled === "boolean") await ctx.input.api.patch("/api/instance/settings/experimental", { enableEnvironments: state.originalEnvironmentsEnabled }); await cleanupIdentityProbes(ctx); }
  },
});
