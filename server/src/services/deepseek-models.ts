import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";

let cached: { key: string; until: number; models: AdapterModel[] } | undefined;
// In-flight requests are keyed by the same credential hash as the cache, so one
// account's refresh never returns another account's result or error.
const pending = new Map<string, Promise<AdapterModel[]>>();

/** DeepSeek's `/models` endpoint requires the connection's own Bearer key. */
export async function listDeepSeekModels(credential: string): Promise<AdapterModel[]> {
  const key = createHash("sha256").update(credential).digest("hex").slice(0, 16);
  if (cached && cached.key === key && cached.until > Date.now()) return cached.models;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const request = (async () => {
    const response = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${credential}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Could not load DeepSeek models. Retry or enter a model ID manually.");
    }
    const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> };
    if (!Array.isArray(body.data)) throw new Error("DeepSeek returned an invalid model catalog.");
    const models = body.data.flatMap((model) => typeof model.id === "string" && model.id.trim()
      ? [{ id: model.id, label: typeof model.name === "string" && model.name.trim() ? model.name : model.id }]
      : []);
    cached = { key, until: Date.now() + 60_000, models };
    return models;
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}
