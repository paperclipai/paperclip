import { createHash } from "node:crypto";
import type { RuntimeAgent } from "./runtime-support.js";
export interface DiscoveredModel { id: string; label: string }
export interface OpenRouterCatalogScope { companyId: string; leadId: string; workerId: string; environmentId: string; currentModel: string; credentialReferenceSha256: string }
function credentialReference(agent: RuntimeAgent) {
  const env = agent.adapterConfig?.env as Record<string, unknown> | undefined;
  const value = env?.OPENROUTER_API_KEY as { type?: unknown; secretId?: unknown; version?: unknown; projectionClass?: unknown; projectionAllowlistKey?: unknown } | undefined;
  if (!value || value.type !== "secret_ref" || typeof value.secretId !== "string" || !value.secretId
    || !(value.version === "latest" || Number.isSafeInteger(value.version) && Number(value.version) > 0)) return;
  if (Object.keys(value).some(key => !["type", "secretId", "version", "projectionClass", "projectionAllowlistKey"].includes(key))
    || [value.projectionClass, value.projectionAllowlistKey].some(field => field !== undefined && field !== null && typeof field !== "string")) return;
  return { type: value.type, secretId: value.secretId, version: value.version,
    ...(value.projectionClass !== undefined ? { projectionClass: value.projectionClass } : {}),
    ...(value.projectionAllowlistKey !== undefined ? { projectionAllowlistKey: value.projectionAllowlistKey } : {}) };
}
export function openRouterCatalogScope(companyId: string, leadId: string, worker: RuntimeAgent, lead: RuntimeAgent): OpenRouterCatalogScope | undefined {
  const a = credentialReference(worker), b = credentialReference(lead), environmentId = worker.defaultEnvironmentId;
  if (worker.companyId !== companyId || lead.companyId !== companyId || lead.id !== leadId || worker.id === leadId
    || worker.adapterType !== "paperclip_runner" || lead.adapterType !== "paperclip_runner" || worker.adapterConfig?.provider !== "opencode" || lead.adapterConfig?.provider !== "opencode"
    || !environmentId || environmentId !== lead.defaultEnvironmentId || typeof worker.adapterConfig.model !== "string" || !worker.adapterConfig.model.startsWith("openrouter/")
    || worker.adapterConfig.model !== lead.adapterConfig.model || !a || !b || JSON.stringify(a) !== JSON.stringify(b)) return;
  return { companyId, leadId, workerId: worker.id, environmentId, currentModel: worker.adapterConfig.model,
    credentialReferenceSha256: createHash("sha256").update(JSON.stringify(a)).digest("hex") };
}
export function publicOpenRouterCatalogEndpoint(companyId: string) {
  return `/api/companies/${encodeURIComponent(companyId)}/adapters/opencode_local/models?provider=openrouter`;
}
function normalized(id: string) { return id.toLowerCase().replace(/^openrouter\//, ""); }
export function observedModelChoices(reply: string) {
  const vendor = [...reply.matchAll(/\b(?:gpt-\d[\w.-]*|o[134](?:-[\w.-]+)?|claude-(?:sonnet|opus|haiku)-[\w.-]+)/gi)].map(m => m[0].replace(/[.,;:!?]+$/, ""));
  const code = [...reply.matchAll(/`([^`\n]+)`/g)].map(m => m[1]!).filter(s => /^[\w.-]+\/[\w./:+-]+$/.test(s) && !s.includes("://"));
  const plainOpenRouter = [...reply.matchAll(/(?<![\w/:])openrouter\/[a-z0-9][\w.-]*\/[a-z0-9][\w./:+-]*/gi)].map(m => m[0].replace(/[.,;:!?]+$/, ""));
  return [...new Set([...vendor, ...code, ...plainOpenRouter])];
}
export function modelChoiceMatches(id: string, models: DiscoveredModel[]) {
  const wanted = normalized(id), exact = models.some(m => normalized(m.id) === wanted);
  if (exact) return true;
  if (wanted.includes("/")) return false;
  const candidates = new Set(models.filter(m => normalized(m.id).endsWith("/" + wanted)).map(m => normalized(m.id)));
  if (/^(?:gpt-|o[134](?:-|$))/.test(wanted)) return candidates.size === 1 && [...candidates][0]!.startsWith("openai/");
  if (/^claude-/.test(wanted)) return candidates.size === 1 && [...candidates][0]!.startsWith("anthropic/");
  return candidates.size === 1;
}
export function unsupportedModelReadinessClaim(reply: string) {
  return reply.split(/[.!?;\n]|,|:\s|\bbut\b|\bhowever\b/i).some(clause => /\b(?:all|every)\b/i.test(clause)
    && /\b(?:ready|qualified|tested|guaranteed|installed|available|usable|will work)\b/i.test(clause)
    && !/\b(?:not|no|cannot|can't|aren't|are not|unverified|untested)\b/i.test(clause));
}
export function publicCatalogCaveat(reply: string) {
  return /\b(?:account|key|credential|entitlement|credit|plan)\b/i.test(reply)
    && /\b(?:depends?|restricted?|subject to|unverified|not (?:all |yet )?(?:tested|qualified|guaranteed|ready))\b/i.test(reply)
    && !unsupportedModelReadinessClaim(reply);
}
