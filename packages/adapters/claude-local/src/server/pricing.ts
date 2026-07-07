import type { UsageSummary } from "@paperclipai/adapter-utils";

/**
 * Per-model Anthropic token pricing, in USD per **million** tokens.
 *
 * The Claude CLI reports `total_cost_usd` only when it authenticates against the
 * first-party Anthropic API with an API key. On Vertex AI and Amazon Bedrock the
 * CLI does not know the platform's pricing, so it emits no cost — token I/O is
 * populated but cost comes back null/0. For those metered paths we recompute the
 * cost from token usage here so cost reporting isn't stuck at $0 (WOR-47).
 *
 * Rates are the published list prices (see the claude-api skill pricing table):
 *   input  = standard input tokens
 *   output = output tokens
 *   cacheRead  = cached input tokens (~0.1x input)
 *   cacheWrite = 5-minute cache writes (~1.25x input) — used only if the adapter
 *                ever captures cache-creation tokens (it currently does not).
 * Matching is by substring against a normalized model id so platform-qualified
 * ids (e.g. `claude-opus-4-8@20260101`, `us.anthropic.claude-opus-4-8-v1`) resolve.
 */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Ordered longest/most-specific match first so `opus-4-8` wins over a broader
// hypothetical `opus` entry. Each entry: [substring, rate per MTok].
const MODEL_RATES: Array<[string, ModelRate]> = [
  // Opus tier: $5 / $25
  ["opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["opus-4-7", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["opus-4-6", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["opus-4-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["opus-4-1", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["opus-4", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  // Fable / Mythos tier: $10 / $50
  ["fable-5", { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 }],
  ["mythos-5", { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 }],
  // Sonnet tier: $3 / $15
  ["sonnet-5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["sonnet-4-5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  // Haiku tier: $1 / $5
  ["haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ["haiku", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

const PER_MILLION = 1_000_000;

/** Look up the per-MTok rate for a model id, or null if unknown. */
export function lookupModelRate(model: string | null | undefined): ModelRate | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  for (const [needle, rate] of MODEL_RATES) {
    if (normalized.includes(needle)) return rate;
  }
  return null;
}

/**
 * Compute USD cost from token usage for a given model. Returns null when the
 * model has no known rate (caller should leave cost unresolved rather than
 * booking $0). `cachedInputTokens` is priced at the cache-read rate; regular
 * `inputTokens` at the input rate.
 *
 * Note: the claude-local adapter does not currently capture cache-creation
 * (cache-write) tokens, so those are not included here — the estimate can
 * slightly undercount when a run writes a large cache prefix.
 */
export function computeCostUsdFromUsage(
  model: string | null | undefined,
  usage: UsageSummary | null | undefined,
): number | null {
  const rate = lookupModelRate(model);
  if (!rate || !usage) return null;
  const input = Math.max(0, usage.inputTokens ?? 0);
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const cost =
    (input * rate.input + cached * rate.cacheRead + output * rate.output) / PER_MILLION;
  return Number.isFinite(cost) ? cost : null;
}
