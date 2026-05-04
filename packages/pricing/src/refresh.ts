#!/usr/bin/env tsx
/**
 * Pricing catalog refresh script.
 *
 * Fetches both upstream sources, normalizes them, merges them, sorts the result by key, and
 * writes `data/catalog.json` with stable 2-space indentation for diff readability.
 *
 *   pnpm --filter @paperclipai/pricing refresh
 *
 * Network failures abort with a non-zero exit so that the weekly GHA opens no PR.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  entryFromLiteLLM,
  entryFromModelsDev,
  mergeCatalogs,
  normalizeKey,
  sortCatalog,
} from './normalize.js';
import type { Catalog } from './index.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json';

interface ModelsDevApi {
  [providerId: string]: {
    id?: string;
    models?: Record<string, ModelsDevModel>;
  };
}

interface ModelsDevModel {
  id?: string;
  reasoning?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
}

type LiteLLMApi = Record<string, Record<string, unknown>>;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'paperclipai-pricing-refresh/0.0.1' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function normalizeModelsDev(api: ModelsDevApi): Catalog {
  const out: Catalog = {};
  for (const [providerId, providerObj] of Object.entries(api)) {
    const models = providerObj?.models ?? {};
    for (const [modelId, modelObj] of Object.entries(models)) {
      const entry = entryFromModelsDev({
        providerId,
        modelId,
        cost: modelObj.cost,
        reasoning: modelObj.reasoning,
      });
      if (!entry) continue;
      const key = normalizeKey(providerId, modelId);
      out[key] = entry;
    }
  }
  return out;
}

function normalizeLiteLLM(api: LiteLLMApi): Catalog {
  const out: Catalog = {};
  for (const [key, data] of Object.entries(api)) {
    if (key === 'sample_spec' || !data || typeof data !== 'object') continue;
    const mode = (data as { mode?: unknown }).mode;
    if (mode !== undefined && mode !== 'chat' && mode !== 'completion' && mode !== 'responses') {
      // Skip embeddings, audio, image-gen, etc. — Lane C only prices chat/completion.
      continue;
    }
    const entry = entryFromLiteLLM({ key, data });
    if (!entry) continue;
    const provider = String((data as { litellm_provider?: unknown }).litellm_provider ?? '');
    const normalized = normalizeKey(provider, key);
    out[normalized] = entry;
  }
  return out;
}

async function main(): Promise<void> {
  console.error('[pricing] fetching models.dev...');
  const modelsDevRaw = await fetchJson<ModelsDevApi>(MODELS_DEV_URL);
  console.error('[pricing] fetching LiteLLM...');
  const liteLLMRaw = await fetchJson<LiteLLMApi>(LITELLM_URL);

  const md = normalizeModelsDev(modelsDevRaw);
  const ll = normalizeLiteLLM(liteLLMRaw);
  console.error(`[pricing] models.dev entries: ${Object.keys(md).length}`);
  console.error(`[pricing] LiteLLM entries:    ${Object.keys(ll).length}`);

  const merged = sortCatalog(mergeCatalogs(md, ll));
  console.error(`[pricing] merged catalog:     ${Object.keys(merged).length}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, '..', 'data', 'catalog.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.error(`[pricing] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[pricing] refresh failed:', err);
  process.exit(1);
});
