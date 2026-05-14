import type { AdapterModel } from "./types.js";
import { models as kilocodeFallbackModels } from "@paperclipai/adapter-kilocode-gateway";

export const KILO_MODELS_ENDPOINT = "https://api.kilo.ai/api/gateway/models";
const KILO_MODELS_TIMEOUT_MS = 5000;
const KILO_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

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
    ...kilocodeFallbackModels,
  ]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

async function fetchKilocodeModels(): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KILO_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(KILO_MODELS_ENDPOINT, {
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      const name = (item as { name?: unknown }).name;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      const label = typeof name === "string" && name.trim() ? name.trim() : id;
      models.push({ id, label });
    }
    return dedupeModels(models);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadKilocodeModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const fallback = dedupeModels(kilocodeFallbackModels);

  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchKilocodeModels();
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = { expiresAt: now + KILO_MODELS_CACHE_TTL_MS, models: merged };
    return merged;
  }

  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

export async function listKilocodeModels(): Promise<AdapterModel[]> {
  return loadKilocodeModels();
}

export async function refreshKilocodeModels(): Promise<AdapterModel[]> {
  return loadKilocodeModels({ forceRefresh: true });
}

export function resetKilocodeModelsCacheForTests() {
  cached = null;
}
