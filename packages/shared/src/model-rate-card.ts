/**
 * Notional list-price rate card for inference models.
 *
 * This exists so a run that burns real tokens but reports no cash cost (a
 * subscription-included Claude CLI run, for example) can still be given a
 * *notional* figure — what the same tokens would have cost at published list
 * price. That figure is recorded as `cost_events.rate_card_cents` and is
 * deliberately NOT `cost_events.cost_cents`: nobody is invoiced for it, and it
 * must never reach budget enforcement.
 *
 * ⚠️ UNITS: every number in `ModelRate` and in RATE_CARD below is
 * **USD per MILLION tokens** — not per token, not cents. This codebase has been
 * bitten by that unit before (a per-million figure read as per-token is a
 * 1,000,000x error).
 *
 * Rates verified 2026-07-29 against
 * https://docs.claude.com/en/docs/about-claude/pricing.md
 *
 * `cacheWrite` is the **5-minute-TTL** cache-write rate (the API default),
 * which is 1.25x base input. The 1-hour-TTL write rate is 2x base input and is
 * deliberately not modelled: a cost event carries no TTL signal, so we cannot
 * tell the two apart and would only be guessing. Cache *reads* are 0.1x base
 * input regardless of TTL.
 */

export interface ModelRate {
  /** USD per MILLION tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute TTL cache write (the API default). */
  cacheWrite: number;
}

export interface RateCardTokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
}

/**
 * A dated price tier. `from` is an inclusive UTC instant; the tier applies from
 * that moment until the next tier's `from`. A `null` start is open-ended
 * (applies to everything before the first dated tier).
 */
interface RateTier {
  readonly from: string | null;
  readonly rate: ModelRate;
}

/** Either a single flat rate (the common case) or a list of dated tiers. */
type RateCardEntry = ModelRate | { readonly tiers: readonly RateTier[] };

const OPUS_TIER: ModelRate = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET_TIER: ModelRate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const FABLE_TIER: ModelRate = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

/**
 * Claude Sonnet 5 shipped with a documented introductory price that ends on a
 * known date, and it is one of the largest consumers here — so it is modelled
 * as dated tiers rather than by picking one side. Passing the event's
 * `occurredAt` prices historical rows at the rate in force then, and stops this
 * silently overstating Sonnet 5 spend by 50% once September 2026 arrives.
 */
const SONNET_5_INTRO_ENDS = "2026-09-01T00:00:00.000Z";

/** USD per MILLION tokens, keyed by normalised model id. */
const RATE_CARD: Readonly<Record<string, RateCardEntry>> = {
  "claude-opus-5": OPUS_TIER,
  "claude-opus-4-8": OPUS_TIER,
  "claude-opus-4-7": OPUS_TIER,
  "claude-opus-4-6": OPUS_TIER,
  "claude-opus-4-5": OPUS_TIER,
  "claude-sonnet-5": {
    tiers: [
      // Introductory pricing, through 2026-08-31 inclusive (UTC).
      { from: null, rate: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
      // Standard pricing, from 2026-09-01.
      { from: SONNET_5_INTRO_ENDS, rate: SONNET_TIER },
    ],
  },
  "claude-sonnet-4-6": SONNET_TIER,
  "claude-sonnet-4-5": SONNET_TIER,
  "claude-fable-5": FABLE_TIER,
  "claude-mythos-5": FABLE_TIER,
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const REGION_PREFIX_RE = /^(?:us|eu|apac)\./;
const PROVIDER_PREFIX_RE = /^anthropic[./]/;
const DATE_SNAPSHOT_SUFFIX_RE = /-\d{8}$/;
/** Context-window / deployment suffix, e.g. `claude-opus-4-8[1m]`. */
const BRACKET_SUFFIX_RE = /\[[^\]]*\]$/;

/**
 * Reduce the many spellings of a model id to the canonical public alias.
 *
 * Model ids reach us from Bedrock (`us.anthropic.claude-…`), Vertex
 * (`claude-opus-4-5@20251101`), gateways (`anthropic/claude-sonnet-5`), dated
 * snapshots (`claude-haiku-4-5-20251001`), context-window variants
 * (`claude-opus-4-8[1m]`), and dotted forms (`claude-opus-4.8`).
 */
export function normalizeRateCardModelId(model: string): string {
  let id = model.trim().toLowerCase();
  if (!id) return "";

  // Region prefix precedes the provider prefix on Bedrock cross-region ids.
  let changed = true;
  while (changed) {
    changed = false;
    if (REGION_PREFIX_RE.test(id)) {
      id = id.replace(REGION_PREFIX_RE, "");
      changed = true;
    }
    if (PROVIDER_PREFIX_RE.test(id)) {
      id = id.replace(PROVIDER_PREFIX_RE, "");
      changed = true;
    }
  }

  // Vertex pins the snapshot with an `@` suffix.
  const at = id.indexOf("@");
  if (at >= 0) id = id.slice(0, at);

  id = id.replace(BRACKET_SUFFIX_RE, "");
  // Model ids appear both dotted and dashed (`claude-opus-4.8` / `-4-8`).
  id = id.replaceAll(".", "-");
  id = id.replace(DATE_SNAPSHOT_SUFFIX_RE, "");

  return id.trim();
}

function resolveEntryRate(entry: RateCardEntry, at: Date): ModelRate | null {
  if (!("tiers" in entry)) return entry;

  const instant = Number.isFinite(at.getTime()) ? at.getTime() : Date.now();
  let resolved: ModelRate | null = null;
  for (const tier of entry.tiers) {
    const from = tier.from == null ? Number.NEGATIVE_INFINITY : Date.parse(tier.from);
    if (Number.isNaN(from)) continue;
    if (instant >= from) resolved = tier.rate;
  }
  return resolved;
}

/**
 * Look up the list rate in force for `model` at `at` (defaults to now).
 * Returns `null` for a model we have no published rate for — callers must treat
 * that as "unpriced" and must NOT substitute zero.
 */
export function resolveModelRate(model: string, at: Date = new Date()): ModelRate | null {
  const entry = RATE_CARD[normalizeRateCardModelId(model)];
  if (!entry) return null;
  return resolveEntryRate(entry, at);
}

function tokenCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Notional list-price cost of `tokens` in whole cents.
 *
 * Returns `null` when the model has no rate-card entry — the caller should
 * record `cost_status = "unpriced"` rather than pretend the work was free.
 * A tiny-but-nonzero token count that rounds below a cent returns `0`, which is
 * a genuinely priced sub-cent result and is distinct from `null`.
 */
export function deriveRateCardCents(
  model: string,
  tokens: RateCardTokens,
  at: Date = new Date(),
): number | null {
  const rate = resolveModelRate(model, at);
  if (!rate) return null;

  const usd =
    (tokenCount(tokens.inputTokens) / 1_000_000) * rate.input +
    (tokenCount(tokens.cachedInputTokens) / 1_000_000) * rate.cacheRead +
    (tokenCount(tokens.outputTokens) / 1_000_000) * rate.output +
    (tokenCount(tokens.cacheWriteTokens) / 1_000_000) * rate.cacheWrite;

  if (!Number.isFinite(usd)) return 0;
  return Math.max(0, Math.round(usd * 100));
}
