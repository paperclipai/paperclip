import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { isValidQwenModelId } from "../index.js";

const MODELS_DISCOVERY_TIMEOUT_MS = 15_000;

export function requireQwenModelId(input: unknown): string {
  const model = asString(input, "").trim();
  if (!isValidQwenModelId(model)) {
    throw new Error("qwen_local requires `adapterConfig.model` (non-empty model id served by vLLM).");
  }
  return model;
}

// Hits vLLM's OpenAI-compatible `GET /v1/models`. Used by the UI dropdown's
// refresh button — not auto-called per render, so a lightweight fetch is fine.
export async function listQwenModels(input: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<AdapterModel[]> {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/models`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_DISCOVERY_TIMEOUT_MS);
  const signal = input.signal ?? controller.signal;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal,
    });
    if (!res.ok) {
      throw new Error(`vLLM ${url} returned ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const data = Array.isArray(body.data) ? body.data : [];
    const models: AdapterModel[] = [];
    const seen = new Set<string>();
    for (const entry of data) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id });
    }
    return models.sort((a, b) =>
      a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
    );
  } finally {
    clearTimeout(timeout);
  }
}
