# Billing Ledger and Reporting

## Context

Paperclip currently stores model spend in `cost_events` and operational run state in `heartbeat_runs`.
That split is fine, but the current reporting code tries to infer billing semantics by mixing both tables:

- `cost_events` knows provider, model, tokens, and dollars
- `heartbeat_runs.usage_json` knows some per-run billing metadata
- `heartbeat_runs.usage_json` does **not** currently carry enough normalized billing dimensions to support honest provider-level reporting

This becomes incorrect as soon as a company uses more than one provider, more than one billing channel, or more than one billing mode.

Examples:

- direct OpenAI API usage
- Claude subscription usage with zero marginal dollars
- subscription overage with dollars and tokens
- OpenRouter billing where the biller is OpenRouter but the upstream provider is Anthropic or OpenAI

The system needs to support:

- dollar reporting
- token reporting
- subscription-included usage
- subscription overage
- direct metered API usage
- future aggregator billing such as OpenRouter

## Product Decision

`cost_events` becomes the canonical billing and usage ledger for reporting.

`heartbeat_runs` remains an operational execution log. It may keep mirrored billing metadata for debugging and transcripts, but reporting must not reconstruct billing semantics from `heartbeat_runs.usage_json`.

## Decision: One Ledger Or Two

We do **not** need two tables to solve the current PR's problem.
For request-level inference reporting, `cost_events` is enough if it carries the right dimensions:

- upstream provider
- biller
- billing type
- model
- token fields
- billed amount

That is why the first implementation pass extends `cost_events` instead of introducing a second table immediately.

However, if Paperclip needs to account for the full billing surface of aggregators and managed AI platforms, then `cost_events` alone is not enough.
Some charges are not cleanly representable as a single model inference event:

- account top-ups and credit purchases
- platform fees charged at purchase time
- BYOK platform fees that are account-level or threshold-based
- prepaid credit expirations, refunds, and adjustments
- provisioned throughput commitments
- fine-tuning, training, model import, and storage charges
- gateway logging or other platform overhead that is not attributable to one prompt/response pair

So the decision is:

- near term: keep `cost_events` as the inference and usage ledger
- next phase: add `finance_events` for non-inference financial events

This is a deliberate split between:

- usage and inference accounting
- account-level and platform-level financial accounting

That separation keeps request reporting honest without forcing us to fake invoice semantics onto rows that were never request-scoped.

## External Motivation And Sources

The need for this model is not theoretical.
It follows directly from the billing systems of providers and aggregators Paperclip needs to support.

### OpenRouter

Source URLs:

- https://openrouter.ai/docs/faq#credit-and-billing-systems
- https://openrouter.ai/pricing

Relevant billing behavior as of March 14, 2026:

- OpenRouter passes through underlying inference pricing and deducts request cost from purchased credits.
- OpenRouter charges a 5.5% fee with a $0.80 minimum when purchasing credits.
- Crypto payments are charged a 5% fee.
- BYOK has its own fee model after a free request threshold.
- OpenRouter billing is aggregated at the OpenRouter account level even when the upstream provider is Anthropic, OpenAI, Google, or another provider.

Implication for Paperclip:

- request usage belongs in `cost_events`
- credit purchases, purchase fees, BYOK fees, refunds, and expirations belong in `finance_events`
- `biller=openrouter` must remain distinct from `provider=anthropic|openai|google|...`

### Cloudflare AI Gateway Unified Billing

Source URL:

- https://developers.cloudflare.com/ai-gateway/features/unified-billing/

Relevant billing behavior as of March 14, 2026:

- Unified Billing lets users call multiple upstream providers while receiving a single Cloudflare bill.
- Usage is paid from Cloudflare-loaded credits.
- Cloudflare supports manual top-ups and auto top-up thresholds.
- Spend limits can stop request processing on daily, weekly, or monthly boundaries.
- Unified Billing traffic can use Cloudflare-managed credentials rather than the user's direct provider key.

Implication for Paperclip:

- request usage needs `biller=cloudflare`
- upstream provider still needs to be preserved separately
- Cloudflare credit loads and related account-level events are not inference rows and should not be forced into `cost_events`
- quota and limits reporting must support biller-level controls, not just upstream provider limits

### Amazon Bedrock

Source URL:

- https://aws.amazon.com/bedrock/pricing/

Relevant billing behavior as of March 14, 2026:

- Bedrock supports on-demand and batch pricing.
- Bedrock pricing varies by region.
- some pricing tiers add premiums or discounts relative to standard pricing
- provisioned throughput is commitment-based rather than request-based
- custom model import uses Custom Model Units billed per minute, with monthly storage charges
- imported model copies are billed in 5-minute windows once active
- customization and fine-tuning introduce training and hosted-model charges beyond normal inference

Implication for Paperclip:

- normal tokenized inference fits in `cost_events`
- provisioned throughput, custom model unit charges, training, and storage charges require `finance_events`
- region and pricing tier need to be first-class dimensions in the financial model

## Ledger Boundary

To keep the system coherent, the table boundary should be explicit.

### `cost_events`

Use `cost_events` for request-scoped usage and inference charges:

- one row per billable or usage-bearing run event
- provider/model/biller/billingType/tokens/cost
- optionally tied to `heartbeat_run_id`
- supports direct APIs, subscriptions, overage, OpenRouter-routed inference, Cloudflare-routed inference, and Bedrock on-demand inference

### `finance_events`

Use `finance_events` for account-scoped or platform-scoped financial events:

- credit purchase
- top-up
- refund
- fee
- expiry
- provisioned capacity
- training
- model import
- storage
- invoice adjustment

These rows may or may not have a related model, provider, or run id.
Trying to force them into `cost_events` would either create fake request rows or create null-heavy rows that mean something fundamentally different from inference usage.

## Canonical Billing Dimensions

Every persisted billing event should model four separate axes:

1. Usage provider
   The upstream provider whose model performed the work.
   Examples: `openai`, `anthropic`, `google`.

2. Biller
   The system that charged for the usage.
   Examples: `openai`, `anthropic`, `openrouter`, `cursor`, `chatgpt`.

3. Billing type
   The pricing mode applied to the event.
   Initial canonical values:
   - `metered_api`
   - `subscription_included`
   - `subscription_overage`
   - `credits`
   - `fixed`
   - `unknown`

4. Measures
   Usage and billing must both be storable:
   - `input_tokens`
   - `output_tokens`
   - `cached_input_tokens`
   - `cost_cents`

These dimensions are independent.
For example, an event may be:

- provider: `anthropic`
- biller: `openrouter`
- billing type: `metered_api`
- tokens: non-zero
- cost cents: non-zero

Or:

- provider: `anthropic`
- biller: `anthropic`
- billing type: `subscription_included`
- tokens: non-zero
- cost cents: `0`

## Schema Changes

Extend `cost_events` with:

- `heartbeat_run_id uuid null references heartbeat_runs.id`
- `biller text not null default 'unknown'`
- `billing_type text not null default 'unknown'`
- `cached_input_tokens int not null default 0`

Keep `provider` as the upstream usage provider.
Do not overload `provider` to mean biller.

Add a future `finance_events` table for account-level financial events with fields along these lines:

- `company_id`
- `occurred_at`
- `event_kind`
- `direction`
- `biller`
- `provider nullable`
- `execution_adapter_type nullable`
- `pricing_tier nullable`
- `region nullable`
- `model nullable`
- `quantity nullable`
- `unit nullable`
- `amount_cents`
- `currency`
- `estimated`
- `related_cost_event_id nullable`
- `related_heartbeat_run_id nullable`
- `external_invoice_id nullable`
- `metadata_json nullable`

Add indexes:

- `(company_id, biller, occurred_at)`
- `(company_id, provider, occurred_at)`
- `(company_id, heartbeat_run_id)` if distinct-run reporting remains common

## Shared Contract Changes

### Shared types

Add a shared billing type union and enrich cost types with:

- `heartbeatRunId`
- `biller`
- `billingType`
- `cachedInputTokens`

Update reporting response types so the provider breakdown reflects the ledger directly rather than inferred run metadata.

### Validators

Extend `createCostEventSchema` to accept:

- `heartbeatRunId`
- `biller`
- `billingType`
- `cachedInputTokens`

Defaults:

- `biller` defaults to `provider`
- `billingType` defaults to `unknown`
- `cachedInputTokens` defaults to `0`

## Adapter Contract Changes

Extend adapter execution results so they can report:

- `biller`
- richer billing type values

Backwards compatibility:

- existing adapter values `api` and `subscription` are treated as legacy aliases
- map `api -> metered_api`
- map `subscription -> subscription_included`

Future adapters may emit the canonical values directly.

OpenRouter support will use:

- `provider` = upstream provider when known
- `biller` = `openrouter`
- `billingType` = `metered_api` unless OpenRouter later exposes another billing mode

Cloudflare Unified Billing support will use:

- `provider` = upstream provider when known
- `biller` = `cloudflare`
- `billingType` = `credits` or `metered_api` depending on the normalized request billing contract

Bedrock support will use:

- `provider` = upstream provider or `aws_bedrock` depending on adapter shape
- `biller` = `aws_bedrock`
- `billingType` = request-scoped mode for inference rows
- `finance_events` for provisioned, training, import, and storage charges

## Write Path Changes

### Heartbeat-created events

When a heartbeat run produces usage or spend:

1. normalize adapter billing metadata
2. write a ledger row to `cost_events`
3. attach `heartbeat_run_id`
4. set `provider`, `biller`, `billing_type`, token fields, and `cost_cents`

The write path should no longer depend on later inference from `heartbeat_runs`.

### Manual API-created events

Manual cost event creation remains supported.
These events may have `heartbeatRunId = null`.

Rules:

- `provider` remains required
- `biller` defaults to `provider`
- `billingType` defaults to `unknown`

## Reporting Changes

### Server

Refactor reporting queries to use `cost_events` only.

#### `summary`

- sum `cost_cents`

#### `by-agent`

- sum costs and token fields from `cost_events`
- use `count(distinct heartbeat_run_id)` filtered by billing type for run counts
- use token sums filtered by billing type for subscription usage

#### `by-provider`

- group by `provider`, `model`
- sum costs and token fields directly from the ledger
- derive billing-type slices from `cost_events.billing_type`
- never pro-rate from unrelated `heartbeat_runs`

#### future `by-biller`

- group by `biller`
- this is the right view for invoice and subscription accountability

#### `window-spend`

- continue to use `cost_events`

#### project attribution

Keep current project attribution logic for now, but prefer `cost_events.heartbeat_run_id` as the join anchor whenever possible.

## UI Changes

### Principles

- Spend, usage, and quota are related but distinct
- a missing quota fetch is not the same as “no quota”
- provider and biller are different dimensions

### Immediate UI changes

1. Keep the current costs page structure.
2. Make the provider cards accurate by reading only ledger-backed values.
3. Show provider quota fetch errors explicitly instead of dropping them.

### Follow-up UI direction

The long-term board UI should expose:

- Spend
  Dollars by biller, provider, model, agent, project
- Usage
  Tokens by provider, model, agent, project
- Quotas
  Live provider or biller limits, credits, and reset windows
- Financial events
  Credit purchases, top-ups, fees, refunds, commitments, storage, and other non-inference charges

## Migration Plan

Migration behavior:

- add new non-destructive columns with defaults
- backfill existing rows:
  - `biller = provider`
  - `billing_type = 'unknown'`
  - `cached_input_tokens = 0`
  - `heartbeat_run_id = null`

Do **not** attempt to backfill historical provider-level subscription attribution from `heartbeat_runs`.
That data was never stored with the required dimensions.

## Testing Plan

Add or update tests for:

1. heartbeat-created ledger rows persist `heartbeatRunId`, `biller`, `billingType`, and cached tokens
2. legacy adapter billing values map correctly
3. provider reporting uses ledger data only
4. mixed-provider companies do not cross-attribute subscription usage
5. zero-dollar subscription usage still appears in token reporting
6. quota fetch failures render explicit UI state
7. manual cost events still validate and write correctly
8. biller reporting keeps upstream provider breakdowns separate
9. OpenRouter-style rows can show `biller=openrouter` with non-OpenRouter upstream providers
10. Cloudflare-style rows can show `biller=cloudflare` with preserved upstream provider identity
11. future `finance_events` aggregation handles non-request charges without requiring a model or run id

## Delivery Plan

### Step 1

- land the ledger contract and query rewrite
- make the current costs page correct

### Step 2

- add biller-oriented reporting endpoints and UI

### Step 3

- wire OpenRouter and any future aggregator adapters to the same contract

### Step 4

- add `executionAdapterType` to persisted cost reporting if adapter-level grouping becomes a product requirement

### Step 5

- introduce `finance_events`
- add non-inference accounting endpoints
- add UI for platform/account charges alongside inference spend and usage

## Non-Goals For This Change

- multi-currency support
- invoice reconciliation
- provider-specific cost estimation beyond persisted billed cost
- replacing `heartbeat_runs` as the operational run record
