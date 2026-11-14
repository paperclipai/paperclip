import { expect } from "@playwright/test";
import { collectRunEvents } from "../run-observations.js";
import { checks } from "./internal-support.js";
import { readAgentResource } from "./identity-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";
import { openRouterCatalogScope, publicOpenRouterCatalogEndpoint, observedModelChoices, modelChoiceMatches, type DiscoveredModel as Model, type OpenRouterCatalogScope } from "./model-option-catalog.js";
export function gradeModelOptions(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("authorized-model-discovery-evidence", !!o, "Actual agent-authorized discovery and saved account/runtime scope are independently read."); if (!o) return c.result();
  const models = o.state.admittedModels as Model[] | undefined; const worker = o.state.worker as RuntimeAgent | undefined;
  const current = o.agents.find(row => row.id === worker?.id);
  // The agent's own run must read the authorized model discovery route. Which
  // options the reply names, and in what words, is read by a person; only
  // model IDs it does name are graded below.
  c.add("at-least-one-current-discovered-option", Array.isArray(models) && models.length > 0 && o.state.discoveryStatus === 200
    && Number(o.state.agentDiscoveryReads) > 0 && o.reply.trim().length > 0, "The answering run read the current authorized model discovery route.");
  const publicCatalog = o.state.publicOpenRouterCatalog as Model[] | undefined, savedScope = o.state.publicCatalogScope as OpenRouterCatalogScope | undefined;
  const lead = o.agents.find(row => row.id === o.leadId), currentScope = current && lead ? openRouterCatalogScope(o.companyId, o.leadId, current, lead) : undefined;
  const catalogBound = Array.isArray(publicCatalog) && publicCatalog.length > 0 && publicCatalog.every(model => typeof model.id === "string" && model.id.startsWith("openrouter/"))
    && o.state.publicCatalogStatus === 200 && !!savedScope && !!currentScope && JSON.stringify(savedScope) === JSON.stringify(currentScope);
  c.add("same-binding-public-catalog-provenance", publicCatalog === undefined || catalogBound,
    "Public catalog choices require the actual unchanged company/CEO/Morgan/environment/OpenCode/OpenRouter key-reference binding; metadata never proves entitlement.");
  const known = [...(models ?? []), ...(catalogBound ? publicCatalog! : [])], mentionedIds = observedModelChoices(o.reply);
  // Model IDs are product output copied into the reply, so they are graded
  // exactly. Whether the reply separates a listed model from a working account
  // binding is prose; a person reads it, and it is not graded by keywords.
  c.add("no-unqualified-model-inventory", !!models && mentionedIds.every(id => modelChoiceMatches(id, known)),
    "The answer does not add model IDs outside the current admitted list or the same-binding public catalog.");
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
  oracleVersion: "paperclip.chat-catalog.model-options.scoped-catalog.v5",
  sourceFiles: ["chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/runtime-runs-adapters.ts", "chat-scenarios/runs-adapters.yaml", "chat-catalog-domains/model-option-catalog.ts", "run-observations.ts"],
  async observe(ctx, state) {
    const { observeRuntime } = await import("./runtime-support.js");
    const o = await observeRuntime(ctx, state);
    const events: Record<string, unknown>[] = [];
    for (const run of o.runs) events.push(...await collectRunEvents<Record<string, unknown>>(afterSeq =>
      ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`)));
    state.agentDiscoveryReads = countModelDiscoveryReads(events, o.runs.map(run => run.id));
    // Credentials remain only in the private attempt closure. Never put them in
    // state, messages, diagnostic artifacts or calibration fixtures.
    state.secretScanComplete = Array.isArray(ctx.input.privateSecrets);
    state.secretLeaked = ctx.input.privateSecrets?.some(secret => secret.length > 8 && o.reply.includes(secret)) ?? true;
    return o;
  },
  async verifyResult(ctx, state, value) {
    const o = runtimeObservation(value); if (!o) throw new Error("Model options response is missing");
    await expect(ctx.input.page.getByTestId("task-chat-agent-bubble").last()).toBeVisible();
  },
})];

const MODEL_DISCOVERY_OPERATION = "GET /api/companies/{companyId}/adapters/{type}/models";
/** Successful model discovery results recorded in the answering runs' own tool events. */
export function countModelDiscoveryReads(events: Record<string, unknown>[], runIds: string[]) {
  const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return events.filter(event => {
    const prp = record(record(event.payload).prpEvent), item = record(record(prp.payload).item), result = record(item.result);
    return event.eventType === "item.completed" && item.type === "tool_result" && runIds.includes(String(prp.runId))
      && result.apiOperationId === MODEL_DISCOVERY_OPERATION && result.ok === true && result.status === 200;
  }).length;
}

export function modelDiscoveryEndpoint(companyId: string, worker: RuntimeAgent) {
  if (worker.adapterType !== "paperclip_runner" || !["codex", "opencode"].includes(String(worker.adapterConfig?.provider)) || !worker.defaultEnvironmentId)
    throw new Error("Model discovery requires the actually selected native provider and environment");
  return `/api/companies/${encodeURIComponent(companyId)}/adapters/paperclip_runner/models?provider=${worker.adapterConfig!.provider}&environmentId=${encodeURIComponent(worker.defaultEnvironmentId)}`;
}
