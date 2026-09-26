import { createHash } from "node:crypto";
import type { AdapterModel, AdapterModelDiscoveryContext } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" },
  { id: "us.anthropic.claude-opus-5-5", label: "Bedrock Opus 5.5" },
  { id: "us.anthropic.claude-opus-5", label: "Bedrock Opus 5" },
  { id: "us.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5" },
  // Fable 5.1's documented geo inference ID carries no -v1 suffix, unlike earlier entries.
  { id: "us.anthropic.claude-fable-5-1", label: "Bedrock Fable 5.1" },
  { id: "us.anthropic.claude-fable-5", label: "Bedrock Fable 5" },
  { id: "us.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
  { id: "us.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

/**
 * Cap on distinct endpoint/credential pairs held at once. A Paperclip instance
 * runs far fewer gateways than this, so the bound only ever trims entries left
 * behind by a gateway change or a credential rotation.
 */
const MODELS_CACHE_MAX_ENTRIES = 32;

const cache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

/**
 * Record a catalog, dropping entries that are expired or oldest-first over the
 * bound. Without this the map keeps one array per historical base-URL and
 * credential pair for the lifetime of the process.
 */
function cacheModels(key: string, expiresAt: number, models: AdapterModel[], now: number): void {
  for (const [existingKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(existingKey);
  }
  // Re-inserting moves the key to the end, so the iteration order stays
  // least-recently-written first and the eviction below takes the right entry.
  cache.delete(key);
  cache.set(key, { expiresAt, models });
  while (cache.size > MODELS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Environment seen by discovery.
 *
 * An agent context replaces `process.env` outright rather than layering over
 * it. Merging would let an agent that sets only `ANTHROPIC_BASE_URL` pair its
 * own endpoint with the server's ambient `ANTHROPIC_API_KEY`, which sends a
 * first-party Anthropic credential to a third-party gateway. The endpoint and
 * the credential must come from one scope.
 */
function discoveryEnv(ctx?: AdapterModelDiscoveryContext): Record<string, string | undefined> {
  return ctx?.env && Object.keys(ctx.env).length > 0 ? ctx.env : process.env;
}

function isBedrockEnv(env: Record<string, string | undefined>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof env.ANTHROPIC_BEDROCK_BASE_URL === "string" && env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

function fingerprint(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
  return `${apiKey.length}:${digest}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...DIRECT_MODELS,
  ]);
}

/**
 * Credential for the models endpoint. `ANTHROPIC_AUTH_TOKEN` is what Claude Code
 * uses for bearer-auth gateways, so discovery has to accept it too — otherwise
 * gateway users fall back to the hardcoded list despite being fully configured.
 */
function resolveAnthropicApiKey(env: Record<string, string | undefined>): string | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey && apiKey.length > 0) return apiKey;
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  return authToken && authToken.length > 0 ? authToken : null;
}

function resolveAnthropicBaseUrl(env: Record<string, string | undefined>): string {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, "") : DEFAULT_ANTHROPIC_BASE_URL;
}

/** True when the agent talks to something other than Anthropic's first-party API. */
function isCustomGateway(baseUrl: string): boolean {
  return baseUrl !== DEFAULT_ANTHROPIC_BASE_URL;
}

/** True when the endpoint came from an agent's config rather than the server's own environment. */
function isAgentScoped(ctx?: AdapterModelDiscoveryContext): boolean {
  return ctx?.env !== undefined && Object.keys(ctx.env).length > 0;
}

/**
 * Reject an endpoint the discovery request must never carry a credential to.
 *
 * Only the two checks that hold no matter who configured the endpoint: the
 * request has to be plain HTTP or HTTPS, and it must not smuggle credentials in
 * the authority. Destination policy — private ranges, instance metadata, DNS
 * pinning — is deliberately not repeated here, because the server owns it and
 * an operator may allowlist a LAN origin that this file cannot see.
 */
function isAddressableEndpoint(baseUrl: string): boolean {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    return false;
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return false;
  return endpoint.username === "" && endpoint.password === "";
}

/**
 * Scheme and host only. One reason an endpoint is rejected is userinfo in the
 * authority, so the raw string is exactly the thing that must stay out of logs.
 */
function redactEndpoint(baseUrl: string): string {
  try {
    const endpoint = new URL(baseUrl);
    return `${endpoint.protocol}//${endpoint.host}`;
  } catch {
    return "<unparseable>";
  }
}

function readModelEntries(payload: unknown): AdapterModel[] {
  const data = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: unknown[] }).data : [];
  const models: AdapterModel[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { id?: unknown; display_name?: unknown; owned_by?: unknown };
    if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
    const displayName =
      typeof record.display_name === "string" && record.display_name.trim().length > 0
        ? record.display_name
        : record.id;
    // OpenAI-shaped listings have no display_name but do carry the upstream
    // provider, which is the useful disambiguator on a multi-provider gateway.
    const label =
      displayName === record.id && typeof record.owned_by === "string" && record.owned_by.trim().length > 0
        ? `${record.id} (${record.owned_by.trim()})`
        : displayName;
    models.push({ id: record.id, label });
  }
  return dedupeModels(models);
}

async function fetchModelList(
  url: string,
  headers: Record<string, string>,
  httpFetch: typeof fetch,
): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const response = await httpFetch(url, { headers, signal: controller.signal });
    if (!response.ok) return [];
    return readModelEntries(await response.json());
  } catch (error) {
    console.warn("[paperclip] Claude model discovery failed", {
      endpoint: redactEndpoint(url),
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Enumerate models from `${baseUrl}/v1/models`.
 *
 * Gateways commonly key the response shape off the auth header: CLIProxyAPI
 * answers `x-api-key` with an Anthropic-dialect listing and `Authorization:
 * Bearer` with an OpenAI-dialect one. Probing only the Anthropic header hides
 * every non-Claude upstream behind mangled alias IDs, because the Anthropic
 * dialect has to re-encode foreign model names into Claude-looking ones for
 * clients that validate the `claude-` prefix (CLIProxyAPI emits e.g.
 * `claude-fable-5-dd-3k-imik` for `kimi-k3`).
 *
 * So for a custom gateway we ask for the OpenAI-dialect catalog first: it names
 * every upstream canonically, and those canonical IDs are what the Anthropic
 * messages endpoint accepts. The Anthropic-dialect listing is the fallback for
 * gateways that only speak that dialect. Unioning the two is deliberately
 * avoided — it duplicates the whole catalog under unreadable alias IDs.
 */
async function fetchGatewayModels(
  apiKey: string,
  baseUrl: string,
  httpFetch: typeof fetch,
): Promise<AdapterModel[]> {
  const url = `${baseUrl}${ANTHROPIC_MODELS_ENDPOINT}`;
  const fetchAnthropicDialect = () =>
    fetchModelList(url, { "anthropic-version": ANTHROPIC_API_VERSION, "x-api-key": apiKey }, httpFetch);
  if (!isCustomGateway(baseUrl)) return fetchAnthropicDialect();

  const openaiDialect = await fetchModelList(url, { authorization: `Bearer ${apiKey}` }, httpFetch);
  return openaiDialect.length > 0 ? openaiDialect : await fetchAnthropicDialect();
}

async function loadClaudeModels(
  ctx?: AdapterModelDiscoveryContext,
  options?: { forceRefresh?: boolean },
): Promise<AdapterModel[]> {
  const env = discoveryEnv(ctx);
  if (isBedrockEnv(env)) return dedupeModels(BEDROCK_MODELS);

  const fallback = dedupeModels(DIRECT_MODELS);
  const apiKey = resolveAnthropicApiKey(env);
  if (!apiKey) return fallback;

  const now = Date.now();
  const baseUrl = resolveAnthropicBaseUrl(env);
  if (!isAddressableEndpoint(baseUrl)) {
    console.warn("[paperclip] Claude model discovery skipped an unusable endpoint", {
      endpoint: redactEndpoint(baseUrl),
    });
    return fallback;
  }
  // An agent-configured gateway is caller-controlled, so it is only reachable
  // through the egress-guarded transport the server supplies. Declining here
  // keeps the credential off plain `fetch` if this adapter is ever driven
  // without that transport; the server always pairs the two.
  if (isAgentScoped(ctx) && isCustomGateway(baseUrl) && ctx?.fetch === undefined) {
    console.warn("[paperclip] Claude model discovery needs a guarded fetch for an agent endpoint", {
      endpoint: redactEndpoint(baseUrl),
    });
    return fallback;
  }

  const cacheKey = `${baseUrl}|${fingerprint(apiKey)}`;
  const cached = cache.get(cacheKey);
  if (options?.forceRefresh !== true && cached && cached.expiresAt > now) {
    return cached.models;
  }

  // Plain `fetch` is only reached for the server's own `process.env`, which is
  // operator-controlled; the check above keeps every agent-scoped gateway on
  // the guarded transport.
  const httpFetch = ctx?.fetch ?? fetch;
  const fetched = await fetchGatewayModels(apiKey, baseUrl, httpFetch);
  if (fetched.length > 0) {
    // A gateway's catalog is authoritative: appending Anthropic's first-party
    // model IDs there would offer models the gateway cannot route.
    const models = isCustomGateway(baseUrl) ? fetched : mergedWithFallback(fetched);
    cacheModels(cacheKey, now + ANTHROPIC_MODELS_CACHE_TTL_MS, models, now);
    return models;
  }

  if (cached && cached.models.length > 0) return cached.models;

  return fallback;
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns the models the configured endpoint advertises, falling back
 * to the built-in Anthropic list when discovery is unavailable.
 */
export async function listClaudeModels(ctx?: AdapterModelDiscoveryContext): Promise<AdapterModel[]> {
  return loadClaudeModels(ctx);
}

export async function refreshClaudeModels(ctx?: AdapterModelDiscoveryContext): Promise<AdapterModel[]> {
  return loadClaudeModels(ctx, { forceRefresh: true });
}

export function resetClaudeModelsCacheForTests() {
  cache.clear();
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
