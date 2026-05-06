import type { AdapterModel } from "../types.js";
import { asString, parseObject } from "../utils.js";
import { DEFAULT_OLLAMA_LOCAL_BASE_URL } from "./config.js";

const FALLBACK_MODELS = [
  "qwen3:latest",
  "qwen3:32b",
  "qwen3-coder:latest",
  "qwen2.5-coder:32b",
  "llama3.3:70b",
  "gemma3:27b",
].map((id) => ({ id, label: id } satisfies AdapterModel));

const discoveredModelsByBaseUrl = new Map<string, AdapterModel[]>();

function tagsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/api/tags`;
}

function uniqueModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const out: AdapterModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function parseModels(payload: Record<string, unknown>): AdapterModel[] {
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models
    .map((entry) => parseObject(entry))
    .map((entry) => {
      const name = asString(entry.model, asString(entry.name, "")).trim();
      if (!name) return null;
      return { id: name, label: name } satisfies AdapterModel;
    })
    .filter((value): value is AdapterModel => Boolean(value));
}

export function rememberOllamaLocalModels(baseUrl: string, modelIds: string[]) {
  discoveredModelsByBaseUrl.set(
    baseUrl,
    uniqueModels(modelIds.map((id) => ({ id, label: id }))),
  );
}

export async function discoverOllamaLocalModels(baseUrl: string): Promise<AdapterModel[]> {
  const response = await fetch(tagsUrl(baseUrl));
  if (!response.ok) {
    throw new Error(`OLLAMA_TAGS_HTTP_${response.status}`);
  }
  const payload = parseObject(await response.json());
  const models = parseModels(payload);
  if (models.length > 0) {
    discoveredModelsByBaseUrl.set(baseUrl, models);
  }
  return models;
}

export async function listOllamaLocalModels(): Promise<AdapterModel[]> {
  if (discoveredModelsByBaseUrl.size > 0) {
    return uniqueModels(Array.from(discoveredModelsByBaseUrl.values()).flat());
  }

  try {
    const models = await discoverOllamaLocalModels(DEFAULT_OLLAMA_LOCAL_BASE_URL);
    if (models.length > 0) return models;
  } catch {
    // fall back below
  }

  return FALLBACK_MODELS;
}

export async function refreshOllamaLocalModels(): Promise<AdapterModel[]> {
  try {
    const models = await discoverOllamaLocalModels(DEFAULT_OLLAMA_LOCAL_BASE_URL);
    if (models.length > 0) return models;
  } catch {
    // keep cached/fallback values if the refresh probe fails
  }
  return listOllamaLocalModels();
}
