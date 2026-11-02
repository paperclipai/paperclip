import type { AdapterModel } from "@paperclipai/adapter-utils";

let cached: { until: number; models: AdapterModel[] } | undefined;
let pending: Promise<AdapterModel[]> | undefined;
const minimaxModelOrder = ["openrouter/minimax/minimax-m3.1-flash:free", "openrouter/minimax/minimax-m3"];

/** OpenRouter's public catalog does not require access to anyone's credentials. */
export async function listOpenRouterModels(refresh = false): Promise<AdapterModel[]> {
  if (!refresh && cached && cached.until > Date.now()) return cached.models;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models?sort=most-popular", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Could not load OpenRouter models. Retry or enter a model ID manually.");
    const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown; architecture?: { output_modalities?: unknown } }> };
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
    const minimaxModels: AdapterModel[] = [];
    const models = body.data.flatMap(model => {
      if (typeof model.id !== "string" || !model.id.includes("/")) return [];
      const entry = { id: `openrouter/${model.id}`, label: typeof model.name === "string" ? model.name : model.id };
      const outputs = model.architecture?.output_modalities;
      if (model.id.startsWith("minimax/") && Array.isArray(outputs) && outputs.length === 1 && outputs[0] === "text") {
        if (!minimaxModelOrder.includes(entry.id)) return [];
        minimaxModels.push(entry);
      }
      return [entry];
    });
    minimaxModels.sort((a, b) => minimaxModelOrder.indexOf(a.id) - minimaxModelOrder.indexOf(b.id));
    let minimaxIndex = 0;
    const orderedModels = models.map(model => minimaxModels.includes(model) ? minimaxModels[minimaxIndex++]! : model);
    cached = { until: Date.now() + 60_000, models: orderedModels };
    return orderedModels;
  })();
  try { return await pending; } finally { pending = undefined; }
}
