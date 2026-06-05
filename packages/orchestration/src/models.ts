/** Default model catalog per engine + complexity tier.
 *
 *  Maps `(engine, complexity)` → the model name we actually call. This is the
 *  shipped default; tenants can supply their own catalog by wrapping
 *  `selectModel`. Bump in lockstep when vendors release new flagships.
 */

import { COMPLEXITY_RANK, type ComplexityClass, type Engine, type ModelSelection } from './types.js';

interface ModelEntry {
  engine: Engine;
  /** Vendor model identifier as it appears in dashboards. */
  model: string;
  tier: 1 | 2 | 3;
  max_input_tokens: number;
  multimodal: boolean;
  /** Lowest complexity this model is the "right size" for. Selector picks the
   *  cheapest model whose tier ≥ requested complexity. */
  min_complexity: ComplexityClass;
}

/** Catalog ordered cheapest → most expensive within each engine. */
export const MODEL_CATALOG: ReadonlyArray<ModelEntry> = [
  // Claude — reasoning
  {
    engine: 'claude',
    model: 'claude-haiku-4-5',
    tier: 1,
    max_input_tokens: 200_000,
    multimodal: true,
    min_complexity: 'simple',
  },
  {
    engine: 'claude',
    model: 'claude-sonnet-4-6',
    tier: 1,
    max_input_tokens: 200_000,
    multimodal: true,
    min_complexity: 'medium',
  },
  {
    engine: 'claude',
    model: 'claude-opus-4-7',
    tier: 1,
    max_input_tokens: 200_000,
    multimodal: true,
    min_complexity: 'complex',
  },

  // ChatGPT — orchestration / multimodal
  {
    engine: 'chatgpt',
    model: 'gpt-4o-mini',
    tier: 1,
    max_input_tokens: 128_000,
    multimodal: true,
    min_complexity: 'simple',
  },
  {
    engine: 'chatgpt',
    model: 'gpt-4o',
    tier: 1,
    max_input_tokens: 128_000,
    multimodal: true,
    min_complexity: 'medium',
  },
  {
    engine: 'chatgpt',
    model: 'gpt-5',
    tier: 1,
    max_input_tokens: 256_000,
    multimodal: true,
    min_complexity: 'complex',
  },

  // Gemini — document intelligence / long-context
  {
    engine: 'gemini',
    model: 'gemini-flash',
    tier: 1,
    max_input_tokens: 1_000_000,
    multimodal: true,
    min_complexity: 'simple',
  },
  {
    engine: 'gemini',
    model: 'gemini-pro',
    tier: 1,
    max_input_tokens: 2_000_000,
    multimodal: true,
    min_complexity: 'medium',
  },
  {
    engine: 'gemini',
    model: 'gemini-ultra-long-context',
    tier: 1,
    max_input_tokens: 2_000_000,
    multimodal: true,
    min_complexity: 'complex',
  },

  // Perplexity — research
  {
    engine: 'perplexity',
    model: 'perplexity-sonar',
    tier: 1,
    max_input_tokens: 200_000,
    multimodal: false,
    min_complexity: 'simple',
  },
  {
    engine: 'perplexity',
    model: 'perplexity-sonar-pro',
    tier: 1,
    max_input_tokens: 200_000,
    multimodal: false,
    min_complexity: 'medium',
  },

  // API (Tier 2) — automation only. Single placeholder model; concrete
  // selection happens in adapter integration code, not the router.
  {
    engine: 'api',
    model: 'api-automation-default',
    tier: 2,
    max_input_tokens: 200_000,
    multimodal: false,
    min_complexity: 'simple',
  },
];

/** Pick the cheapest model in the engine that meets the requested complexity
 *  and respects the requested context size + multimodal need. Returns null
 *  when nothing in the catalog satisfies. */
export function selectModel(
  engine: Engine,
  complexity: ComplexityClass,
  opts: { estimated_input_tokens?: number; requires_multimodal?: boolean } = {},
): ModelSelection | null {
  const wantedRank = COMPLEXITY_RANK[complexity];
  const candidates = MODEL_CATALOG.filter(
    (m) =>
      m.engine === engine &&
      COMPLEXITY_RANK[m.min_complexity] <= wantedRank &&
      (opts.estimated_input_tokens === undefined ||
        m.max_input_tokens >= opts.estimated_input_tokens) &&
      (!opts.requires_multimodal || m.multimodal),
  );
  // The catalog is ordered cheapest-first; pick the model whose min_complexity
  // is closest to but not above the request — i.e. the highest min_complexity
  // that is still ≤ wantedRank, or the cheapest meeting threshold otherwise.
  const eligible = candidates.filter((m) => COMPLEXITY_RANK[m.min_complexity] <= wantedRank);
  if (eligible.length === 0) return null;

  // Pick the model whose min_complexity rank == wantedRank if present
  // (avoids "most-expensive model on a Simple task" — cheapest-sufficient bias).
  const exact = eligible
    .filter((m) => COMPLEXITY_RANK[m.min_complexity] === wantedRank)
    .at(-1);
  const chosen =
    exact ??
    eligible
      .slice()
      .sort((a, b) => COMPLEXITY_RANK[b.min_complexity] - COMPLEXITY_RANK[a.min_complexity])[0];
  if (!chosen) return null;

  return {
    engine: chosen.engine,
    model: chosen.model,
    tier: chosen.tier,
    max_input_tokens: chosen.max_input_tokens,
    multimodal: chosen.multimodal,
  };
}
