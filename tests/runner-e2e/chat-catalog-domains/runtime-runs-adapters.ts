import { expect } from "@playwright/test";
import { checks } from "./internal-support.js";
import { readAgentResource } from "./identity-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";
import { openRouterCatalogScope, publicOpenRouterCatalogEndpoint, observedModelChoices, modelChoiceMatches, publicCatalogCaveat, unsupportedModelReadinessClaim, type DiscoveredModel as Model, type OpenRouterCatalogScope } from "./model-option-catalog.js";
export function gradeModelOptions(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("authorized-model-discovery-evidence", !!o, "Actual agent-authorized discovery and saved account/runtime scope are independently read."); if (!o) return c.result();
  const models = o.state.admittedModels as Model[] | undefined; const worker = o.state.worker as RuntimeAgent | undefined;
  const current = o.agents.find(row => row.id === worker?.id);
  c.add("at-least-one-current-discovered-option", Array.isArray(models) && models.length > 0 && o.state.discoveryStatus === 200
    && models.some(model => o.reply.includes(model.id)), "At least one returned coding option comes from the current admitted model catalog.");
  const publicCatalog = o.state.publicOpenRouterCatalog as Model[] | undefined, savedScope = o.state.publicCatalogScope as OpenRouterCatalogScope | undefined;
  const lead = o.agents.find(row => row.id === o.leadId), currentScope = current && lead ? openRouterCatalogScope(o.companyId, o.leadId, current, lead) : undefined;
  const catalogBound = Array.isArray(publicCatalog) && publicCatalog.length > 0 && publicCatalog.every(model => typeof model.id === "string" && model.id.startsWith("openrouter/"))
    && o.state.publicCatalogStatus === 200 && !!savedScope && !!currentScope && JSON.stringify(savedScope) === JSON.stringify(currentScope);
  c.add("same-binding-public-catalog-provenance", publicCatalog === undefined || catalogBound,
    "Public catalog choices require the actual unchanged company/CEO/Morgan/environment/OpenCode/OpenRouter key-reference binding; metadata never proves entitlement.");
  const known = [...(models ?? []), ...(catalogBound ? publicCatalog! : [])], mentionedIds = observedModelChoices(o.reply);
  const publicChoiceUsed = catalogBound && mentionedIds.some(id => !modelChoiceMatches(id, models ?? []) && !modelChoiceMatches(id, [{ id: currentScope!.currentModel, label: "current" }]) && modelChoiceMatches(id, publicCatalog!));
  c.add("catalog-visibility-not-account-entitlement", !publicChoiceUsed || publicCatalogCaveat(o.reply),
    "A public catalog choice is conditional on the selected key/account/runtime and cannot be presented as universally tested, qualified or ready.");
  c.add("no-unqualified-model-inventory", !!models && mentionedIds.every(id => modelChoiceMatches(id, known))
    && !unsupportedModelReadinessClaim(o.reply),
    "The answer does not add unsupported vendor models or equate a public catalog with universal runtime readiness.");
  c.add("availability-not-account-qualification", /account|binding|connection|connected|configured/i.test(o.reply)
    && /available|option|catalog|model/i.test(o.reply) && /valid|qualif|restrict|depends|selected|configured|bound/i.test(o.reply),
    "The response distinguishes model choices from selected account and environment qualification.");
  c.add("restricted-runtime-read-denied", o.state.agentRuntimeInventoryStatus === 403,
    "The actual agent bearer cannot inspect board-only runtime inventory.");
  c.add("configuration-and-permissions-preserved", !!worker && !!current && unchangedAgent(worker, current) && o.tasks.length === 0,
    "Discovery does not mutate Morgan's model, account, authority or task assignment.");
  c.add("private-credential-scan-complete", o.state.secretScanComplete === true && o.state.secretLeaked === false,
    "The private redaction sink is scanned without recording its values.");
  return c.result();
}
export const runtimeRunsAdaptersCases = [runtimeDefinition("runs-adapters.list-model-options", async ctx => {
  const worker = await runtimeWorker(ctx);
  const endpoint = modelDiscoveryEndpoint(ctx.input.fixtures.company.id, worker);
  const discovered = await readAgentResource(ctx, endpoint);
  const restricted = await readAgentResource(ctx, `/api/agents/${worker.id}/runtime-state`);
  if (discovered.status !== 200 || !Array.isArray(discovered.data)) throw new Error("Scenario requires admitted real coding model discovery");
  let publicOpenRouterCatalog: Model[] | undefined, publicCatalogScope: OpenRouterCatalogScope | undefined, publicCatalogStatus: number | undefined;
  if (worker.adapterType === "paperclip_runner" && worker.adapterConfig?.provider === "opencode" && String(worker.adapterConfig.model).startsWith("openrouter/")) {
    const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    publicCatalogScope = openRouterCatalogScope(ctx.input.fixtures.company.id, ctx.input.fixtures.agent.id, worker, lead);
    if (!publicCatalogScope) throw new Error("Model catalog setup requires the actual same-company OpenRouter account reference and native environment binding");
    const catalog = await readAgentResource(ctx, publicOpenRouterCatalogEndpoint(ctx.input.fixtures.company.id));
    publicCatalogStatus = catalog.status;
    if (catalog.status !== 200 || !Array.isArray(catalog.data) || !catalog.data.length || !catalog.data.every((row: Model) => typeof row.id === "string" && row.id.startsWith("openrouter/") && typeof row.label === "string")) throw new Error("Official public OpenRouter model metadata unavailable; no model options were invented");
    publicOpenRouterCatalog = catalog.data;
  }
  return { worker, admittedModels: discovered.data, discoveryStatus: discovered.status, agentRuntimeInventoryStatus: restricted.status,
    ...(publicOpenRouterCatalog ? { publicOpenRouterCatalog, publicCatalogScope, publicCatalogStatus } : {}) };
}, gradeModelOptions, {
  oracleVersion: "paperclip.chat-catalog.model-options.scoped-catalog.v3",
  sourceFiles: ["chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/runtime-runs-adapters.ts", "chat-scenarios/runs-adapters.yaml", "chat-catalog-domains/model-option-catalog.ts"],
  async observe(ctx, state) {
    const { observeRuntime } = await import("./runtime-support.js");
    const o = await observeRuntime(ctx, state);
    // Credentials remain only in the private attempt closure. Never put them in
    // state, messages, diagnostic artifacts or calibration fixtures.
    state.secretScanComplete = Array.isArray(ctx.input.privateSecrets);
    state.secretLeaked = ctx.input.privateSecrets?.some(secret => secret.length > 8 && o.reply.includes(secret)) ?? true;
    return o;
  },
  async verifyResult(ctx, state, value) {
    const o = runtimeObservation(value); if (!o) throw new Error("Model options response is missing");
    const match = (state.admittedModels as Model[]).find(model => o.reply.includes(model.id));
    if (!match) throw new Error("No actual discovered option was rendered");
    await expect(ctx.input.page.getByTestId("task-chat-agent-bubble").filter({ hasText: match.id }).last()).toBeVisible();
  },
})];

export function modelDiscoveryEndpoint(companyId: string, worker: RuntimeAgent) {
  if (worker.adapterType !== "paperclip_runner" || !["codex", "opencode"].includes(String(worker.adapterConfig?.provider)) || !worker.defaultEnvironmentId)
    throw new Error("Model discovery requires the actually selected native provider and environment");
  return `/api/companies/${encodeURIComponent(companyId)}/adapters/paperclip_runner/models?provider=${worker.adapterConfig!.provider}&environmentId=${encodeURIComponent(worker.defaultEnvironmentId)}`;
}
