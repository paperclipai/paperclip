import type { AdapterModel } from "@paperclipai/adapter-utils";
import { DEFAULT_LM_STUDIO_BASE_URL } from "../index.js";

const LM_STUDIO_MODELS_TIMEOUT_MS = 5000;
const LM_STUDIO_MODELS_CACHE_TTL_MS = 60_000;

let cached: { baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;

async function fetchLmStudioModels(baseUrl: string): Promise<AdapterModel[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LM_STUDIO_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
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
    return models;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function listLmStudioModels(baseUrl?: string): Promise<AdapterModel[]> {
  const effectiveBaseUrl = baseUrl || DEFAULT_LM_STUDIO_BASE_URL;
  const now = Date.now();

  if (cached && cached.baseUrl === effectiveBaseUrl && cached.expiresAt > now) {
    return cached.models;
  }

  const models = await fetchLmStudioModels(effectiveBaseUrl);
  if (models.length > 0) {
    cached = {
      baseUrl: effectiveBaseUrl,
      expiresAt: now + LM_STUDIO_MODELS_CACHE_TTL_MS,
      models,
    };
  }
  return models;
}
