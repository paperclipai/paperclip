import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as STATIC_HERMES_MODELS } from "../index.js";

/**
 * Discover Hermes models.
 *
 * Hermes has no non-interactive `hermes model list` command. The full
 * registry lives in `~/.hermes/models_dev_cache.json` (~1.8MB), but
 * surfacing all 3000+ entries would overwhelm the UI dropdown. V1 strategy:
 *
 *   1. PAPERCLIP_HERMES_MODELS env override (CSV of provider/model ids)
 *   2. Static fallback list shipped in src/index.ts
 *
 * Anything not in this list is still acceptable as a free-form `model`
 * config string — Paperclip will pass it directly to `hermes -m`.
 */
export async function discoverHermesModels(): Promise<AdapterModel[]> {
  const override = (process.env.PAPERCLIP_HERMES_MODELS ?? "").trim();
  if (override.length > 0) {
    const parsed: AdapterModel[] = [];
    for (const raw of override.split(",")) {
      const id = raw.trim();
      if (!id) continue;
      parsed.push({ id, label: id });
    }
    if (parsed.length > 0) return dedupe(parsed);
  }
  return [...STATIC_HERMES_MODELS];
}

export async function listHermesModels(): Promise<AdapterModel[]> {
  try {
    return await discoverHermesModels();
  } catch {
    return [];
  }
}

function dedupe(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const out: AdapterModel[] = [];
  for (const m of models) {
    const id = m.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: m.label.trim() || id });
  }
  return out;
}
