import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * Free OpenCode Zen / Go models for the local adapter's model picker.
 *
 * OpenCode's local `opencode models` output already lists Zen/Go models when the
 * machine is logged into those providers, but it does not mark which ones are
 * free. We load the public catalogs and mark / add the free entries so the model
 * dropdown shows them with a `(free)` label.
 *
 * Free detection uses the public catalog id suffix plus the zero-cost entries in
 * the `models.dev` catalog. The suffix alone misses stealth releases such as
 * `big-pickle`; the cost lookup catches new free models without a `-free` id.
 * If `models.dev` is unavailable we fall back to the suffix and the small
 * hard-coded stealth set.
 *
 * The logic mirrors `@paperclipai/adapter-opencode-gateway`'s catalog loader.
 * Adapter packages do not import each other, so this stays self-contained; if a
 * third OpenCode-family adapter appears, extract a shared module.
 */

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_MODELS_DEV_URL = "https://models.dev/api.json";
export const OPENCODE_MODEL_CATALOG_TTL_MS = 30 * 60 * 1000;
export const OPENCODE_MODEL_CATALOG_TIMEOUT_MS = 3_000;
export const OPENCODE_MODELS_DEV_TIMEOUT_MS = 8_000;
/**
 * The full `models.dev` catalog is several megabytes, so it is refreshed far
 * less often than the tiny Zen/Go lists. Most free ids also carry `-free`; this
 * metadata only improves stealth-release detection.
 */
const ZERO_COST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** How long an offline fallback is reused before retrying the network. */
const FALLBACK_TTL_MS = 60_000;

/** Free models that do NOT carry the `-free` suffix (stealth releases). */
export const KNOWN_FREE_MODEL_IDS = new Set(["big-pickle", "grok-code"]);

type Provider = "opencode" | "opencode-go";

const PROVIDER_LABELS: Record<Provider, string> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};

export function isFreeOpenCodeModelId(
  modelId: string,
  zeroCostIds?: ReadonlySet<string>,
): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.endsWith("-free") ||
    KNOWN_FREE_MODEL_IDS.has(normalized) ||
    zeroCostIds?.has(normalized) === true
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Extract ids whose `models.dev` `cost.input` and `cost.output` are both zero.
 *
 * `models.dev` is the catalog OpenCode itself uses for pricing. We only use the
 * ids to label entries that already exist in the live Zen/Go catalogs, so
 * deprecated entries in `models.dev` never get appended on their own.
 */
export function parseZeroCostModelIds(raw: unknown): Set<string> {
  const root = asRecord(raw);
  const ids = new Set<string>();
  if (!root) return ids;
  for (const provider of ["opencode", "opencode-go"] as const) {
    const models = asRecord(asRecord(root[provider])?.models);
    if (!models) continue;
    for (const [modelId, value] of Object.entries(models)) {
      const cost = asRecord(asRecord(value)?.cost);
      if (cost?.input === 0 && cost.output === 0) ids.add(modelId.trim().toLowerCase());
    }
  }
  return ids;
}

export interface OpenCodeFreeModel {
  id: string;
  label: string;
}

export function parseFreeModelCatalog(
  raw: unknown,
  provider: Provider,
  zeroCostIds?: ReadonlySet<string>,
): OpenCodeFreeModel[] {
  const record = asRecord(raw);
  const data = Array.isArray(record?.data) ? record!.data : Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: OpenCodeFreeModel[] = [];
  for (const entry of data) {
    const modelId = nonEmpty(asRecord(entry)?.id);
    if (!modelId || !isFreeOpenCodeModelId(modelId, zeroCostIds)) continue;
    const id = `${provider}/${modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: `${PROVIDER_LABELS[provider]} · ${modelId} (free)` });
  }
  return out;
}

/** Baked-in fallback so the free models still show when the catalog fetch fails. */
export const FALLBACK_OPENCODE_FREE_MODELS: AdapterModel[] = [
  "opencode/big-pickle",
  "opencode/beam-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/nemotron-3.5-super-vl-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/jev-1.13-free",
  "opencode/longcat-2.5-preview-free",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "opencode/space-bunny-free",
  "opencode-go/longcat-2.5-preview-free",
  "opencode-go/beam-free",
].map((id) => {
  const provider: Provider = id.startsWith("opencode-go/") ? "opencode-go" : "opencode";
  const label = id.slice(id.indexOf("/") + 1);
  return { id, label: `${PROVIDER_LABELS[provider]} · ${label} (free)` };
});

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenCode model catalog ${url} returned HTTP ${response.status}`);
  return response.json();
}

interface FreeCatalogCache {
  expiresAt: number;
  models: AdapterModel[];
  zeroCostIds: Set<string>;
}

let cache: FreeCatalogCache | null = null;
let zeroCostCache: { expiresAt: number; ids: Set<string> } | null = null;

export interface LoadFreeModelsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  modelsDevTimeoutMs?: number;
  force?: boolean;
}

export interface OpenCodeFreeModelData {
  models: AdapterModel[];
  /** Lower-case model ids that `models.dev` reports at zero cost. */
  zeroCostIds: Set<string>;
}

/**
 * Load the free Zen + Go models plus the zero-cost id set used to label
 * stealth releases. Never throws; falls back to the baked list.
 */
export async function loadOpenCodeFreeModelData(
  options: LoadFreeModelsOptions = {},
): Promise<OpenCodeFreeModelData> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OPENCODE_MODEL_CATALOG_TIMEOUT_MS;
  const modelsDevTimeoutMs = options.modelsDevTimeoutMs ?? OPENCODE_MODELS_DEV_TIMEOUT_MS;
  const now = Date.now();
  if (!options.force && cache && cache.expiresAt > now) {
    return { models: cache.models, zeroCostIds: cache.zeroCostIds };
  }

  const zeroCostFresh = Boolean(zeroCostCache && zeroCostCache.expiresAt > now);
  const results = await Promise.allSettled([
    fetchJson(OPENCODE_ZEN_MODELS_URL, fetchImpl, timeoutMs),
    fetchJson(OPENCODE_GO_MODELS_URL, fetchImpl, timeoutMs),
    zeroCostFresh
      ? Promise.resolve(null)
      : fetchJson(OPENCODE_MODELS_DEV_URL, fetchImpl, modelsDevTimeoutMs),
  ]);
  let zeroCostIds = zeroCostCache?.ids ?? new Set<string>();
  if (!zeroCostFresh && results[2].status === "fulfilled" && results[2].value !== null) {
    zeroCostIds = parseZeroCostModelIds(results[2].value);
    zeroCostCache = { expiresAt: now + ZERO_COST_CACHE_TTL_MS, ids: zeroCostIds };
  }
  const merged: OpenCodeFreeModel[] = [];
  if (results[0].status === "fulfilled") {
    merged.push(...parseFreeModelCatalog(results[0].value, "opencode", zeroCostIds));
  }
  if (results[1].status === "fulfilled") {
    merged.push(...parseFreeModelCatalog(results[1].value, "opencode-go", zeroCostIds));
  }

  const live = merged.length > 0;
  const models = live
    ? merged.map((model) => ({ id: model.id, label: model.label }))
    : FALLBACK_OPENCODE_FREE_MODELS;
  const data: OpenCodeFreeModelData = { models, zeroCostIds };
  cache = {
    expiresAt: now + (live ? OPENCODE_MODEL_CATALOG_TTL_MS : FALLBACK_TTL_MS),
    models,
    zeroCostIds,
  };
  return data;
}

/** Load the free Zen + Go models. Never throws; falls back to the baked list. */
export async function loadOpenCodeFreeModels(
  options: LoadFreeModelsOptions = {},
): Promise<AdapterModel[]> {
  return (await loadOpenCodeFreeModelData(options)).models;
}

export function resetOpenCodeFreeModelCacheForTests(): void {
  cache = null;
  zeroCostCache = null;
}

/**
 * Merge discovered local models with the free catalog: mark discovered free
 * models and append free models the CLI did not report.
 */
export function mergeFreeModels(
  discovered: AdapterModel[],
  freeModels: AdapterModel[],
  zeroCostIds?: ReadonlySet<string>,
): AdapterModel[] {
  const seen = new Set<string>();
  const merged: AdapterModel[] = [];
  for (const model of discovered) {
    const modelId = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
    const free = isFreeOpenCodeModelId(modelId, zeroCostIds);
    const label = free && !model.label.includes("(free)") ? `${model.label} (free)` : model.label;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push({ id: model.id, label });
  }
  for (const model of freeModels) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}
