# Pricing

The pricing service is the central fallback that converts `(provider, model, usage)` to USD cents when an adapter cannot report a cost itself. It exists so `cost_events.cost_cents` reflects reality instead of silently writing `0` whenever a CLI's stdout fails to parse.

**Key principle: fallback only, never override.** If an adapter reports `costUsd`, that wins. The pricing service only fills in nulls. If the catalog also has no entry, the row is written as `NULL` (unpriced) — never coerced to `0`.

---

## Where it lives

- `packages/pricing/` — the workspace package.
  - `src/index.ts` — `priceUsd(provider, model, usage, billingType?)` entry point.
  - `src/normalize.ts` — provider/model identifier normalization, alias handling.
  - `src/aliases.ts` — Bedrock region map and other static alias rules.
  - `src/refresh.ts` — script that rebuilds `data/catalog.json`.
  - `data/catalog.json` — vendored snapshot, committed to the repo.
- Server consumer: `server/src/services/heartbeat.ts` (`normalizeBilledCostCents`).
- Backfill: `server/src/scripts/backfill-cost-cents.ts`.

Runtime never makes a network call. All lookups read the vendored snapshot.

---

## Catalog shape

Each entry in `data/catalog.json` is keyed by the normalized `${provider}/${model}` and has the following shape:

```ts
type CatalogEntry = {
  // Required pricing rates, in USD per million tokens.
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;

  // Optional rates. Omitted when the provider does not charge separately.
  cache_write_per_mtok?: number;   // Anthropic-style cache writes
  reasoning_per_mtok?: number;     // Claude extended thinking, o1-style reasoning

  // Optional long-context tier. When usage exceeds tier_threshold_tokens,
  // input/output bill at the over_threshold_* rates instead.
  tier_threshold_tokens?: number;
  over_threshold_input_per_mtok?: number;
  over_threshold_output_per_mtok?: number;

  // Optional alias list. Keys in this array resolve to the parent entry.
  // Used for Bedrock regional prefixes (us./eu./apac.) — see "Known
  // approximations" below.
  region_aliases?: string[];

  // Provenance for catalog diffs.
  source: "models.dev" | "litellm";
};
```

Example:

```json
{
  "anthropic/claude-opus-4-6": {
    "input_per_mtok": 15.00,
    "cached_input_per_mtok": 1.50,
    "cache_write_per_mtok": 18.75,
    "output_per_mtok": 75.00,
    "reasoning_per_mtok": 75.00,
    "region_aliases": ["us.anthropic.claude-opus-4-6", "eu.anthropic.claude-opus-4-6"],
    "source": "models.dev"
  }
}
```

---

## Sources

The catalog is built from two MIT-licensed public sources:

1. **[models.dev](https://models.dev/api.json)** — primary. Public CDN-cached JSON, no auth, no rate limits.
2. **[LiteLLM `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)** — fallback for any model not in models.dev.

Attribution lives in `THIRD_PARTY_LICENSES.md` at the repo root.

---

## Refresh process

The catalog is regenerated weekly by a GitHub Action (`.github/workflows/pricing-refresh.yml`) which opens a **pull request** with the diff for review. We do not auto-merge — the diff is small enough to eyeball, and a bad upstream change should not silently land.

Manual refresh:

```sh
pnpm --filter @paperclipai/pricing refresh
```

This fetches both sources, normalizes them, writes `packages/pricing/data/catalog.json`, and exits. The diff against the previous snapshot is the reviewable artifact.

---

## Lookup semantics

`priceUsd(provider, model, usage, billingType?)` returns `number | null`:

1. **Normalize** the key. `normalize.ts` strips redundant provider prefixes, lowercases, resolves aliases, handles Bedrock regional IDs, and tolerates `model = null` (acpx-local). The lookup key is `${provider}/${model}` after normalization.
2. **Check `billingType` allowlist.** Only `["metered_api", "credits", "unknown"]` are eligible. Anything else returns `null` immediately without a catalog read. See "billingType eligibility" below.
3. **Look up the catalog entry.** Miss → return `null` (the row will be written as `cost_cents = NULL`).
4. **Compute cents** from the entry and `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, optional `cache_write_tokens`, optional `reasoning_tokens`). If `tier_threshold_tokens` is set and total input exceeds it, the over-threshold rates apply.

The pricing service is **never** consulted when an adapter has already reported a non-null `costUsd`. Adapter wins. This includes adapter-reported `costUsd = 0` for genuinely free runs.

---

## billingType eligibility

`cost_events.billing_type` is one of `metered_api`, `subscription_included`, `subscription_overage`, `credits`, `fixed`, `unknown`.

The pricing service only prices rows whose `billingType` is in the allowlist:

```
["metered_api", "credits", "unknown"]
```

Subscription rows (`subscription_included`, `subscription_overage`) and `fixed` rows write `NULL` when the adapter has no cost. This is deliberate: subscription cost is not USD-denominated per run, so writing a token-derived number would be a lie. **This is a behavior change from before this PR**, where subscription rows with null adapter cost wrote `cost_cents = 0`.

---

## Known approximations

These are real and intentional. Documented here so maintainers and users do not have to rediscover them.

### Bedrock region collapse

Bedrock model IDs like `us.anthropic.claude-opus-4-6-v1` and `eu.anthropic.claude-opus-4-6-v1` are collapsed to the base `anthropic/claude-opus-4-6` rate via `region_aliases`. Bedrock's regional surcharges (e.g. EU and APAC are typically priced higher than US) are **not** modeled. If you operate primarily in a non-US region and need exact billing, reconcile against the AWS bill rather than relying on this catalog.

### opencode-local reasoning merge

`packages/adapters/opencode-local/src/server/parse.ts` merges reasoning tokens into `outputTokens` before reporting to the heartbeat. When the pricing service later fills in a null cost for an opencode row, those merged reasoning tokens are priced at the **output** rate. For Claude extended-thinking runs (where `reasoning_per_mtok` may differ from output, and where reasoning volume can dominate output) this **undercounts** real spend. Fixing it requires opencode to emit reasoning tokens separately.

### cursor-local heuristic provider

`resolveProviderFromModel()` in cursor-local can return `provider = "cursor"` when it cannot identify the upstream provider. There is no catalog entry under `cursor/*`, so those rows stay unpriced. This is preferable to guessing the wrong provider.

### acpx-local null model

The acpx adapter hard-codes `model: null`, `provider: "acpx"`. These rows are always unpriced by design. `normalize.ts` tolerates the null model — it does not throw — but no catalog lookup is attempted.

### Subscription `billingType` behavior change

Subscription rows that previously wrote `cost_cents = 0` now write `cost_cents = NULL` (see "billingType eligibility"). UI surfaces interpret NULL as "unpriced" rather than "$0," which is the correct read for subscription-included usage.

---

## Backfilling historical $0 rows

If your database has accumulated `cost_events` rows with `cost_cents = 0` because the old code path coerced unknown costs to zero, run the backfill:

```sh
# Dry run first — shows proposed updates without writing.
pnpm pricing:backfill --dry-run

# Limit to a specific agent:
pnpm pricing:backfill --dry-run --agent-id=<uuid>

# Apply when the dry-run output looks right:
pnpm pricing:backfill
```

The script:

- Snapshots affected rows into `cost_events_backfill_snapshot` first (rollback-safe).
- Only touches rows where `billing_type` is in the allowlist AND `cost_cents = 0` AND the catalog has a price for the row's `(provider, model)`.
- Recomputes `agent_runtime_state.total_cost_cents` from the new sums afterward.
- Is idempotent: a second run finds non-zero (or NULL) `cost_cents` and skips.

Rows whose model is not in the catalog stay at `cost_cents = 0` after backfill — the script does not flip them to NULL, because the user's existing UI state expects them. New writes go through the new NULL semantics; backfill is conservative.
