import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_PAGE_LIMIT = 1000;
const ANTHROPIC_MODELS_COMPLETE_PAGE_LIMIT = 10_000;
const ANTHROPIC_MODELS_MAX_PAGES = 20;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-8-v1", label: "Bedrock Opus 4.8" },
  // Fable 5.1's documented geo inference ID carries no -v1 suffix, unlike earlier entries.
  { id: "us.anthropic.claude-fable-5-1", label: "Bedrock Fable 5.1" },
  { id: "us.anthropic.claude-fable-5-v1", label: "Bedrock Fable 5" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

let cached: { keyFingerprint: string; baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
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

type AnthropicCredential = {
  kind: "api-key" | "auth-token";
  value: string;
};

function resolveAnthropicCredential(env: Record<string, unknown> = process.env): AnthropicCredential | null {
  const apiKey = typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.trim() : "";
  if (apiKey) return { kind: "api-key", value: apiKey };

  const authToken = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN.trim() : "";
  return authToken ? { kind: "auth-token", value: authToken } : null;
}

function resolveAnthropicBaseUrl(env: Record<string, unknown> = process.env): string {
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
  return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, "") : "https://api.anthropic.com";
}

type AnthropicModelsResult = {
  models: AdapterModel[];
  reachable: boolean;
  complete: boolean;
};

type AnthropicModelsPage = {
  models: AdapterModel[];
  hasMore: boolean;
  lastId: string | null;
};

async function fetchAnthropicModels(
  credential: AnthropicCredential,
  baseUrl: string,
): Promise<AnthropicModelsResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  const models: AdapterModel[] = [];
  let afterId: string | null = null;
  const seenCursors = new Set<string>();
  try {
    const requestPage = async (limit: number, cursor: string | null): Promise<AnthropicModelsPage | null> => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("after_id", cursor);
      const response = await fetch(`${baseUrl}${ANTHROPIC_MODELS_ENDPOINT}?${query}`, {
        headers: {
          "anthropic-version": ANTHROPIC_API_VERSION,
          ...(credential.kind === "api-key" ? { "x-api-key": credential.value } : {}),
          Authorization: `Bearer ${credential.value}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;

      const payload = (await response.json()) as { data?: unknown; has_more?: unknown; last_id?: unknown };
      const pageModels: AdapterModel[] = [];
      const data = Array.isArray(payload.data) ? payload.data : [];
      for (const item of data) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as { id?: unknown; display_name?: unknown };
        if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
        const displayName =
          typeof record.display_name === "string" && record.display_name.trim().length > 0
            ? record.display_name
            : record.id;
        pageModels.push({
          id: record.id,
          label: displayName,
        });
      }
      return {
        models: pageModels,
        hasMore: payload.has_more === true,
        lastId: typeof payload.last_id === "string" ? payload.last_id.trim() || null : null,
      };
    };

    for (let page = 0; page < ANTHROPIC_MODELS_MAX_PAGES; page += 1) {
      const pageResult = await requestPage(ANTHROPIC_MODELS_PAGE_LIMIT, afterId);
      if (!pageResult) return { models: dedupeModels(models), reachable: false, complete: false };
      models.push(...pageResult.models);

      if (!pageResult.hasMore) {
        return { models: dedupeModels(models), reachable: true, complete: true };
      }

      const nextAfterId = pageResult.lastId;
      if (!nextAfterId || seenCursors.has(nextAfterId)) {
        const completePage = await requestPage(ANTHROPIC_MODELS_COMPLETE_PAGE_LIMIT, null);
        if (completePage && !completePage.hasMore) {
          return {
            models: dedupeModels([...models, ...completePage.models]),
            reachable: true,
            complete: true,
          };
        }
        return { models: dedupeModels(models), reachable: true, complete: false };
      }
      seenCursors.add(nextAfterId);
      afterId = nextAfterId;
    }
    return { models: dedupeModels(models), reachable: true, complete: false };
  } catch (error) {
    console.warn("[paperclip] Claude model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { models: dedupeModels(models), reachable: false, complete: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadClaudeModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  if (isBedrockEnv()) return dedupeModels(BEDROCK_MODELS);

  const fallback = dedupeModels(DIRECT_MODELS);
  const credential = resolveAnthropicCredential();
  if (!credential) return fallback;

  const now = Date.now();
  const baseUrl = resolveAnthropicBaseUrl();
  const keyFingerprint = fingerprint(`${credential.kind}:${credential.value}`);
  if (
    options?.forceRefresh !== true &&
    cached &&
    cached.keyFingerprint === keyFingerprint &&
    cached.baseUrl === baseUrl &&
    cached.expiresAt > now
  ) {
    return cached.models;
  }

  const fetched = await fetchAnthropicModels(credential, baseUrl);
  if (fetched.complete && fetched.models.length > 0) {
    const merged = mergedWithFallback(fetched.models);
    cached = {
      keyFingerprint,
      baseUrl,
      expiresAt: now + ANTHROPIC_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.baseUrl === baseUrl && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels();
}

export async function refreshClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels({ forceRefresh: true });
}

export type ClaudeModelRouteStatus =
  | "available"
  | "unavailable"
  | "fallback-only"
  | "credentials-missing"
  | "provider-unavailable";

/** Read-only provider catalog check for custom Anthropic-compatible gateways. */
export async function probeClaudeModelRoute(
  model: string,
  env: Record<string, unknown>,
): Promise<ClaudeModelRouteStatus | null> {
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
  if (!baseUrl) return null;

  const credential = resolveAnthropicCredential(env);
  if (!credential) return "credentials-missing";

  const fetched = await fetchAnthropicModels(credential, resolveAnthropicBaseUrl(env));
  if (!fetched.complete) {
    if (fetched.models.some((entry) => entry.id === model)) return "available";
    if (!fetched.reachable && fetched.models.length === 0 && DIRECT_MODELS.some((entry) => entry.id === model)) {
      return "fallback-only";
    }
    return "provider-unavailable";
  }
  if (fetched.models.length === 0) {
    if (!fetched.reachable) {
      return DIRECT_MODELS.some((entry) => entry.id === model) ? "fallback-only" : "provider-unavailable";
    }
    return DIRECT_MODELS.some((entry) => entry.id === model) ? "fallback-only" : "unavailable";
  }
  return fetched.models.some((entry) => entry.id === model) ? "available" : "unavailable";
}

export function resetClaudeModelsCacheForTests() {
  cached = null;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
