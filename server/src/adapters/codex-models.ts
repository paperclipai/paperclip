import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AdapterModel } from "./types.js";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { readConfigFile } from "../config-file.js";

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;
let codexCache: { cachePath: string; expiresAt: number; models: AdapterModel[] } | null = null;

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

/**
 * Read the Codex CLI's own model catalog, `$CODEX_HOME/models_cache.json`
 * (default `~/.codex/models_cache.json`). The CLI refreshes this file from
 * the ChatGPT backend during normal use, so it is authoritative for exactly
 * the ChatGPT-authenticated installs that the OpenAI API-key path cannot
 * serve. Entries the CLI does not list in its picker (`visibility` other
 * than "list", e.g. internal slugs) stay out of the catalog.
 *
 * Returns an empty list when the file is missing, unreadable, malformed, or
 * lists nothing usable — the caller merges the static fallback either way.
 */
function readCodexModelsCache(options?: { forceRefresh?: boolean }): AdapterModel[] {
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const cachePath = path.join(codexHome, "models_cache.json");
    const now = Date.now();
    if (
      !options?.forceRefresh
      && codexCache
      && codexCache.cachePath === cachePath
      && codexCache.expiresAt > now
    ) {
      return codexCache.models;
    }
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const entries = (parsed as { models?: unknown }).models;
    if (!Array.isArray(entries)) return [];

    const models: AdapterModel[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { slug, display_name: displayName, visibility } = entry as {
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
      };
      if (visibility !== "list") continue;
      if (typeof slug !== "string" || slug.trim().length === 0) continue;
      const label =
        typeof displayName === "string" && displayName.trim().length > 0
          ? displayName.trim()
          : slug.trim();
      models.push({ id: slug.trim(), label });
    }
    const catalog = dedupeModels(models);
    codexCache = {
      cachePath,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: catalog,
    };
    return catalog;
  } catch {
    return [];
  }
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

async function fetchOpenAiModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
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
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) {
    // ChatGPT-authenticated installs have no API key. Their catalog lives in
    // the Codex CLI's own models_cache.json, merged over the static fallback
    // so no id that shipped in a release disappears. Keep the fallback's
    // original order (no sort) so a missing cache degrades to exactly the
    // pre-change result.
    return dedupeModels([
      ...readCodexModelsCache({ forceRefresh }),
      ...codexFallbackModels,
    ]);
  }
  const fallback = dedupeModels(codexFallbackModels);

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchOpenAiModels(apiKey);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
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

export async function listCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels();
}

export async function refreshCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels({ forceRefresh: true });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
  codexCache = null;
}
