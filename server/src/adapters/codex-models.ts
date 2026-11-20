import type { AdapterModel } from "./types.js";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { readConfigFile } from "../config-file.js";

const OPENAI_MODELS_PATH = "/models";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

type CodexDiscoveryTarget = {
  baseUrl: string;
  apiKey: string | null;
};

let cached: { keyFingerprint: string; baseUrl: string; expiresAt: number; models: AdapterModel[] } | null =
  null;

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

/** Match Codex runtime: expand `{env:VAR}` from process.env; leave unresolved intact. */
function expandEnvPlaceholders(value: string): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const resolved = process.env[name];
    return resolved !== undefined && resolved.length > 0 ? resolved : match;
  });
}

function normalizeBaseUrl(raw: string): string {
  return expandEnvPlaceholders(raw.trim()).replace(/\/+$/, "");
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

function resolveNamedApiKey(envKeyName: string): string | null {
  const expandedName = expandEnvPlaceholders(envKeyName).trim();
  if (!expandedName) return null;
  const value = process.env[expandedName]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Resolve discovery base URL + credentials together so custom gateways use the
 * same account Codex would at runtime (`env_key` + expanded `base_url`).
 *
 * Prefer OPENAI_BASE_URL (+ OPENAI_API_KEY); else selected PAPERCLIP_CODEX_PROVIDERS
 * entry; else default OpenAI.
 */
function resolveCodexDiscoveryTarget(): CodexDiscoveryTarget {
  const envUrl = process.env.OPENAI_BASE_URL?.trim();
  if (envUrl) {
    return {
      baseUrl: normalizeBaseUrl(envUrl),
      apiKey: resolveOpenAiApiKey(),
    };
  }

  const fromProviders = resolveTargetFromCodexProviders();
  if (fromProviders) return fromProviders;

  return {
    baseUrl: DEFAULT_OPENAI_BASE_URL,
    apiKey: resolveOpenAiApiKey(),
  };
}

/** Prefer OPENAI_BASE_URL; else active PAPERCLIP_CODEX_PROVIDERS base_url; else OpenAI. */
function resolveOpenAiBaseUrl(): string {
  return resolveCodexDiscoveryTarget().baseUrl;
}

/**
 * True when Codex model discovery should call a non-default OpenAI-compatible
 * gateway. Default OpenAI discovery is skipped for the built-in adapter because
 * api.openai.com returns image/audio/embedding models Codex cannot run.
 */
export function hasCustomCodexModelsBaseUrl(): boolean {
  return resolveOpenAiBaseUrl() !== DEFAULT_OPENAI_BASE_URL;
}

function resolveTargetFromCodexProviders(): CodexDiscoveryTarget | null {
  const raw = process.env.PAPERCLIP_CODEX_PROVIDERS?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as { providers?: unknown; model_provider?: unknown };
    if (!record.providers || typeof record.providers !== "object" || Array.isArray(record.providers)) {
      return null;
    }
    const providers = record.providers as Record<string, unknown>;
    const selected =
      typeof record.model_provider === "string" && record.model_provider.trim().length > 0
        ? record.model_provider.trim()
        : null;
    if (!selected) return null;
    const entry = providers[selected];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const provider = entry as { base_url?: unknown; env_key?: unknown };
    const baseUrlRaw = provider.base_url;
    if (typeof baseUrlRaw !== "string" || baseUrlRaw.trim().length === 0) return null;

    const envKeyRaw = provider.env_key;
    const apiKey =
      typeof envKeyRaw === "string" && envKeyRaw.trim().length > 0
        ? resolveNamedApiKey(envKeyRaw)
        : resolveOpenAiApiKey();

    return {
      baseUrl: normalizeBaseUrl(baseUrlRaw),
      apiKey,
    };
  } catch {
    return null;
  }
}

async function fetchOpenAiModels(apiKey: string, baseUrl: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${OPENAI_MODELS_PATH}`, {
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

async function loadCodexModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const { baseUrl, apiKey } = resolveCodexDiscoveryTarget();
  const fallback = dedupeModels(codexFallbackModels);
  if (!apiKey) return fallback;

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (
    !forceRefresh &&
    cached &&
    cached.keyFingerprint === keyFingerprint &&
    cached.baseUrl === baseUrl &&
    cached.expiresAt > now
  ) {
    return cached.models;
  }

  const fetched = await fetchOpenAiModels(apiKey, baseUrl);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      baseUrl,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (
    cached &&
    cached.keyFingerprint === keyFingerprint &&
    cached.baseUrl === baseUrl &&
    cached.models.length > 0
  ) {
    return cached.models;
  }

  return fallback;
}

export async function listCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels();
}

export async function refreshCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels({ forceRefresh: true });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
}
