import type { AdapterModel } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_ENDPOINT, models as fallbackModels } from "../index.js";

interface OllamaTag {
  name?: string;
  model?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTag[];
}

/**
 * Best-effort discovery of locally-pulled Ollama models.
 *
 * Hits the default endpoint with a tight timeout. On any failure
 * (no Ollama running, timeout, parse error) we return the static
 * fallback list from the index module so the UI still has options.
 */
export async function listOllamaModels(endpoint = DEFAULT_OLLAMA_ENDPOINT): Promise<AdapterModel[]> {
  const url = `${endpoint.replace(/\/+$/, "")}/api/tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return fallbackModels;
    const payload = (await res.json()) as OllamaTagsResponse;
    const tags = Array.isArray(payload.models) ? payload.models : [];
    const discovered: AdapterModel[] = [];
    const seen = new Set<string>();
    for (const tag of tags) {
      const id =
        (typeof tag?.name === "string" && tag.name.trim()) ||
        (typeof tag?.model === "string" && tag.model.trim()) ||
        "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      discovered.push({ id, label: id });
    }
    return discovered.length > 0 ? discovered : fallbackModels;
  } catch {
    return fallbackModels;
  } finally {
    clearTimeout(timer);
  }
}
