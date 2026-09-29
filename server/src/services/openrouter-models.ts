import type { AdapterModel } from "@paperclipai/adapter-utils";

let cached: { until: number; models: AdapterModel[] } | undefined;
let pending: Promise<AdapterModel[]> | undefined;

/** OpenRouter's public catalog does not require access to anyone's credentials. */
export async function listOpenRouterModels(refresh = false): Promise<AdapterModel[]> {
  if (!refresh && cached && cached.until > Date.now()) return cached.models;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Could not load OpenRouter models. Retry or enter a model ID manually.");
    const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> };
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
    const models = body.data.flatMap(model => typeof model.id === "string" && model.id.includes("/")
      ? [{ id: `openrouter/${model.id}`, label: typeof model.name === "string" ? model.name : model.id }]
      : []).sort((a, b) => a.label.localeCompare(b.label));
    cached = { until: Date.now() + 60_000, models };
    return models;
  })();
  try { return await pending; } finally { pending = undefined; }
}
