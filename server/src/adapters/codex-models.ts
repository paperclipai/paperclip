import type { AdapterModel } from "./types.js";

// Fallback declarations for the IDE (unbuilt workspace)
declare var process: { env: Record<string, string | undefined> };

// @ts-ignore
import { resolveZaiModelsEndpoint } from "@paperclipai/shared";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { readConfigFile } from "../config-file.js";

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
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
    ...codexFallbackModels,
  ]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

function resolveLlmDetails(): {
  apiKey: string | null;
  endpoint: string | null;
  provider: "claude" | "openai" | "zai" | string;
} {
  const config = readConfigFile();
  const provider = config?.llm?.provider || "openai";

  if (provider === "zai") {
    const envKey = process.env.ZAI_API_KEY?.trim();
    const envEndpoint = resolveZaiModelsEndpoint(process.env.ZAI_BASE_URL);

    if (envKey) {
      return { apiKey: envKey, endpoint: envEndpoint, provider: "zai" };
    }

    const configKey = config?.llm?.apiKey?.trim();
    return {
      apiKey: configKey && configKey.length > 0 ? configKey : null,
      endpoint: envEndpoint,
      provider: "zai",
    };
  }

  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return { apiKey: envKey, endpoint: OPENAI_MODELS_ENDPOINT, provider };

  const configKey = config?.llm?.apiKey?.trim();
  return {
    apiKey: configKey && configKey.length > 0 ? configKey : null,
    endpoint: OPENAI_MODELS_ENDPOINT,
    provider,
  };
}

async function fetchModelsFromEndpoint(apiKey: string, endpoint: string | null): Promise<AdapterModel[]> {
  if (!endpoint) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({ id, label: id });
    }
    return dedupeModels(models);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function listCodexModels(): Promise<AdapterModel[]> {
  const { apiKey, endpoint, provider } = resolveLlmDetails();
  const fallback = dedupeModels(codexFallbackModels);
  if (!apiKey) return fallback;

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchModelsFromEndpoint(apiKey, endpoint);
  if (fetched.length > 0) {
    const merged = provider === "zai" ? dedupeModels(fetched) : mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

export function resetCodexModelsCacheForTests() {
  cached = null;
}
