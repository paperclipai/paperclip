/**
 * Pure normalization functions for the pricing catalog.
 *
 * Two upstream sources are merged into a single shape:
 *   - models.dev: per-provider grouped JSON with `cost` keyed by USD per 1M tokens.
 *   - LiteLLM `model_prices_and_context_window_backup.json`: flat keys with per-token USD costs
 *     and `*_above_<N>_tokens` tier variants.
 *
 * Both are converted into the catalog shape declared in `index.ts`. models.dev wins on conflict
 * and LiteLLM fills gaps (long-context tier thresholds, Bedrock region aliases, etc.).
 */

import type { CatalogEntry, Catalog } from './index.js';
import { resolveBedrockAlias, STATIC_ALIASES } from './aliases.js';

// ---------- Public API ----------

export function normalizeKey(provider: string, model: string): string {
  const p = (provider ?? '').trim().toLowerCase();
  const m = (model ?? '').trim().toLowerCase();
  if (!m) return '';
  // If the model id already includes the provider prefix, do not double it.
  if (p && m.startsWith(`${p}/`)) return m;
  if (!p) return m;
  return `${p}/${m}`;
}

/**
 * Resolve the catalog lookup key for a `(provider, model)` pair coming off a
 * heartbeat result. Returns null when there is not enough information to look
 * anything up (e.g. acpx-local emits `model: null`).
 *
 * Ordering matters:
 *   1. Lowercase + trim both inputs.
 *   2. If `model` already begins with `${provider}/`, treat it as the full key
 *      (handles opencode-local's `anthropic/claude-sonnet-4-6` shape).
 *   3. Otherwise compose `${provider}/${model}`.
 *   4. Try to collapse Bedrock regional aliases (`us.anthropic.claude-...`).
 *   5. Apply static alias overrides.
 */
export function lookupKey(
  provider: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const p = (provider ?? '').trim().toLowerCase();
  const m = (model ?? '').trim().toLowerCase();
  if (!p || !m) return null;

  // Already provider-prefixed (opencode-local, pi-local).
  let key = m.startsWith(`${p}/`) ? m : `${p}/${m}`;

  // Collapse Bedrock-style `us.anthropic.claude-...-v1` keys onto the base.
  const bedrock = resolveBedrockAlias(key);
  if (bedrock) {
    key = bedrock;
  }

  // Apply curated static aliases last so callers can patch over both raw and
  // post-Bedrock-collapse keys.
  if (STATIC_ALIASES[key]) {
    key = STATIC_ALIASES[key]!;
  }

  return key;
}

export interface ModelsDevRecord {
  providerId: string;
  modelId: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
  reasoning?: boolean;
}

export interface LiteLLMRecord {
  key: string;
  data: Record<string, unknown>;
}

export function entryFromModelsDev(record: ModelsDevRecord): CatalogEntry | null {
  const cost = record.cost ?? {};
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') {
    return null;
  }
  const entry: CatalogEntry = {
    input_per_mtok: cost.input,
    cached_input_per_mtok: typeof cost.cache_read === 'number' ? cost.cache_read : cost.input,
    output_per_mtok: cost.output,
    source: 'models.dev',
  };
  if (typeof cost.cache_write === 'number') {
    entry.cache_write_per_mtok = cost.cache_write;
  }
  if (typeof cost.reasoning === 'number') {
    entry.reasoning_per_mtok = cost.reasoning;
  }
  return entry;
}

export function entryFromLiteLLM(record: LiteLLMRecord): CatalogEntry | null {
  const d = record.data;
  const inputPerToken = numericField(d, 'input_cost_per_token');
  const outputPerToken = numericField(d, 'output_cost_per_token');
  if (inputPerToken === null || outputPerToken === null) return null;

  const cacheReadPerToken = numericField(d, 'cache_read_input_token_cost');
  const cacheWritePerToken = numericField(d, 'cache_creation_input_token_cost');

  const entry: CatalogEntry = {
    input_per_mtok: toMtok(inputPerToken),
    cached_input_per_mtok:
      cacheReadPerToken !== null ? toMtok(cacheReadPerToken) : toMtok(inputPerToken),
    output_per_mtok: toMtok(outputPerToken),
    source: 'litellm',
  };
  if (cacheWritePerToken !== null) {
    entry.cache_write_per_mtok = toMtok(cacheWritePerToken);
  }

  // Tiered pricing: e.g. `input_cost_per_token_above_200k_tokens`.
  const tier = detectTier(d);
  if (tier) {
    entry.tier_threshold_tokens = tier.threshold;
    if (tier.input !== null) entry.over_threshold_input_per_mtok = toMtok(tier.input);
    if (tier.output !== null) entry.over_threshold_output_per_mtok = toMtok(tier.output);
  }

  return entry;
}

export function mergeCatalogs(modelsDev: Catalog, liteLLM: Catalog): Catalog {
  const merged: Catalog = {};

  // Start with LiteLLM (lower priority) so models.dev overrides.
  for (const [key, entry] of Object.entries(liteLLM)) {
    merged[key] = { ...entry };
  }

  for (const [key, mdEntry] of Object.entries(modelsDev)) {
    const existing = merged[key];
    if (!existing) {
      merged[key] = { ...mdEntry };
      continue;
    }
    // models.dev wins on overlapping fields, but we keep tier info / cache_write
    // from LiteLLM if models.dev did not specify them.
    const combined: CatalogEntry = {
      ...existing,
      ...mdEntry,
      source: 'merged',
    };
    if (
      mdEntry.cache_write_per_mtok === undefined &&
      existing.cache_write_per_mtok !== undefined
    ) {
      combined.cache_write_per_mtok = existing.cache_write_per_mtok;
    }
    if (
      mdEntry.tier_threshold_tokens === undefined &&
      existing.tier_threshold_tokens !== undefined
    ) {
      combined.tier_threshold_tokens = existing.tier_threshold_tokens;
      combined.over_threshold_input_per_mtok = existing.over_threshold_input_per_mtok;
      combined.over_threshold_output_per_mtok = existing.over_threshold_output_per_mtok;
    }
    if (mdEntry.reasoning_per_mtok === undefined && existing.reasoning_per_mtok !== undefined) {
      combined.reasoning_per_mtok = existing.reasoning_per_mtok;
    }
    merged[key] = combined;
  }

  return merged;
}

/** Sort the catalog by key for deterministic JSON diffs. */
export function sortCatalog(catalog: Catalog): Catalog {
  const sorted: Catalog = {};
  for (const key of Object.keys(catalog).sort()) {
    sorted[key] = catalog[key]!;
  }
  return sorted;
}

// ---------- Helpers ----------

function numericField(obj: Record<string, unknown>, field: string): number | null {
  const v = obj[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toMtok(perToken: number): number {
  // Convert per-token (USD) to per-million-tokens (USD), rounded to a sane precision
  // to keep diffs stable.
  const perMtok = perToken * 1_000_000;
  return Math.round(perMtok * 1_000_000) / 1_000_000;
}

function detectTier(d: Record<string, unknown>): {
  threshold: number;
  input: number | null;
  output: number | null;
} | null {
  // LiteLLM uses suffixes like `_above_200k_tokens` or `_above_128k_tokens`.
  const re = /^input_cost_per_token_above_(\d+(?:k|m)?)_tokens$/;
  const tierKey = Object.keys(d).find((k) => re.test(k));
  if (!tierKey) return null;
  const match = re.exec(tierKey);
  if (!match) return null;
  const threshold = parseTokenCount(match[1]!);
  if (threshold === null) return null;
  const input = numericField(d, tierKey);
  const output = numericField(d, `output_cost_per_token_above_${match[1]}_tokens`);
  return { threshold, input, output };
}

function parseTokenCount(raw: string): number | null {
  const m = /^(\d+)(k|m)?$/.exec(raw.toLowerCase());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'k') return n * 1_000;
  if (m[2] === 'm') return n * 1_000_000;
  return n;
}
