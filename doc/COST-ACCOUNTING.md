# Cost accounting and budget enforcement

This document describes the implementation after the September 2026 reliability audit. The execution ledger and the finance ledger serve different purposes: `cost_events` records USD usage attributed to agent work; `finance_events` records billing charges and credits in their original currencies. Provider invoices can be imported explicitly for comparison and reviewed corrections. Operators can also fetch OpenAI and Anthropic organization cost reports using a company-owned admin credential. Provider reports, invoices, and run estimates remain separate; Paperclip does not guess exchange rates.

## From a run to a report

1. Before provider dispatch, the heartbeat stores issue/project/billing-code attribution and marks accounting pending. Adapters normalize usage into input tokens (excluding cache reads, including cache writes), cached input tokens, output tokens, billing identity, and an optional USD price. Usage is per run unless the adapter explicitly declares session-cumulative counters. A missing price is distinct from a reported zero.
2. Eligible direct OpenAI API receipts receive a versioned token-price estimate when the provider supplies no dollars (see below). Native execution and supported CLI/ACPX adapters checkpoint usage before workspace and issue finalization. Each checkpoint is versioned and fsynced to a private instance spool before its database write; database outages leave the file for replay. The heartbeat stores the final adapter receipt on `heartbeat_runs`, including partial usage returned for failed or timed-out execution. `subscription_included` usage contributes tokens but no incremental monetary charge. An explicit cache-adjusted price takes precedence over the nominal price.
3. `accountRunCost` acquires the company accounting lock and then locks the run. In one PostgreSQL transaction it inserts idempotent cost receipts, updates monthly spend projections, evaluates budgets, increments lifetime runtime totals, settles any reservation, and acknowledges run accounting. The original reported amount is preserved; a reviewed correction appends an audit record and changes only the effective valuation. Every new run receipt has a company-scoped idempotency key. Duplicate delivery cannot increment totals again. Complete per-model receipts are split only when both their tokens and prices reconcile to the run total; otherwise the aggregate receipt is retained.
4. Startup and periodic recovery scan terminal pending runs, independently of heartbeat scheduling being enabled. Failed writes roll back, leave the marker pending, and retry. A bounded batch rotates failed attempts so one bad receipt cannot starve other pending runs. Dispatched runs that have not produced a final receipt remain pending, including when cancellation marks a run terminal before its provider stops. A late final receipt can then be recorded exactly once. Recovery does not invent a zero-valued receipt or price. Proven pre-provider failures are acknowledged without creating a charge.
5. Reports aggregate `cost_events`. Company and agent monthly counters and runtime lifetime counters are projections. New receipts use the attribution captured for the run. Deleted issue/project targets become unallocated; foreign-company references are rejected. Legacy project attribution is inferred only when run activity identifies one project. The unallocated bucket is included so project totals conserve company spend.

Amounts remain denominated in **cents**, including fractional cents. Ledger amounts and spend projections use PostgreSQL `numeric(24,7)`, preserving nanodollar precision instead of rounding every run to a whole cent. Arithmetic uses integer nanodollars, with one half-away-from-zero rounding step at the storage boundary. Monetary inputs accept decimal strings; use strings when exact representation matters. Unsafe large numeric inputs are rejected. Existing JSON number fields remain for compatibility, alongside exact decimal fields such as `costCentsExact`, `spendCentsExact`, `amountCentsExact`, `netCentsExact`, and budget `observedAmountExact`. Display rounding never changes storage or admission decisions. Budget limits remain whole cents.

## Ingestion and retries

`POST /api/companies/:companyId/cost-events` accepts an optional `idempotencyKey` (1–200 characters). Retrying the same normalized receipt with the same key returns its existing event. Reusing the key with different content returns `409`. Keys are scoped to a company; callers must reuse the original `occurredAt`, not regenerate it on retry. Without a key, each POST intentionally creates a new event. Automatic run accounting always supplies keys.

All linked agent, run, issue, project, and goal references must belong to the reporting company, and a linked run must belong to the reported agent. Non-finite/negative costs and negative/fractional token counts are rejected. The receipt, projections, budget incidents, approvals, and local activity-log rows commit together. Live activity publication and provider cancellation happen after commit; a notification or cancellation transport failure cannot undo a recorded charge.

Finance ingestion uses the same company-scoped key/conflict semantics. Credits remain separate nonnegative events with `direction: credit`. The top-level finance summary is explicitly USD; `currencies` contains independent totals for every recorded currency. Biller/kind groups retain currency. No exchange rate is guessed and unlike currencies are never added into one monetary total.

## Budgets and incomplete accounting

Company, agent, and project policies all apply. Monthly windows use UTC calendar months; lifetime policies coexist with monthly policies. A zero or inactive limit does not enforce a stop. Generic company/agent budget updates synchronize the policy in the same transaction as the legacy budget field.

Active hard-stop policies block admission when recorded spend reaches the limit, when a terminal run still awaits accounting, or when usage lacks a reliable price. `unpricedUsagePolicy: block` is the default. An operator can explicitly choose `allow` to permit work despite missing prices; reports continue to identify incomplete pricing. This choice does not bypass pending accounting transactions. Subscription-included usage does not count as a monetary pricing gap.

At a hard stop the budget service pauses the scope, creates one open incident/approval for the policy window, and persists a cancellation delivery version. Cancellation is retried after failures and may be delivered more than once. It rechecks the policy and limits cancellation to work that existed at the check, so a delayed delivery does not cancel newly admitted work after a budget grant. Provider shutdown is best effort.

Raising a limit must exceed **current** observed spend. Resuming also requires all other hard-stop policies on that scope to permit work. Calendar rollover or disabling a policy releases budget-owned pauses only; manual pauses, terminated agents, and archived companies are preserved. Choosing to keep a scope paused dismisses the incident without generating a fresh approval on each admission check. A subsequent limit increase followed by another threshold crossing creates a new incident.

A legacy budget pause with no policy remains blocked until a policy or explicit operator resume resolves it. Manual agent pauses keep the normal agent admission error. Accounting activity is excluded from task-progress evidence, so recording a receipt cannot suppress plan-only recovery.

Policies optionally configure `reservationCents` (default zero), also editable as “Reserve per run (USD)” on the Costs budget cards. Before dispatch, Paperclip locks the company, checks all relevant policies, and reserves the maximum configured estimate against company, agent, and project capacity. Concurrent dispatches cannot claim the same capacity. Zero disables the estimate; a zero-valued reservation still fences duplicate dispatch of the same run. Existing reservations retain their original amount after policy edits and carry across UTC month boundaries until settled.

A final accounting transaction settles the reservation against the actual charge. Positive pre-provider failure evidence releases it without a charge. Time passing, a missing process, cancellation intent, or a policy change alone does not prove provider work has stopped and never releases a held reservation. The health panel displays held capacity. A run permanently missing its final receipt requires evidence recovery; the system has no “assume zero” button.

Reservations are estimates, not provider-enforced spending caps. Delayed receipts and in-progress calls can exceed the estimate. Provider spending controls are needed for an external invoice ceiling.

## Dates, completeness, and UI

Cost and finance endpoints default to the current UTC month through now. Explicit `from`/`to` bounds remain inclusive; `period=all` requests all time. Reversed or malformed bounds are rejected. CLI cost/finance reads expose `--from`, `--to`, and `--all-time`. The board sends explicit ranges, and month/year-to-date starts use UTC. Rolling spend excludes future events.

Cost summaries expose `eventCount`, `estimatedEventCount`, `unpricedEventCount`, `pendingRunCount`, and `pricingComplete`. Estimated charges count toward budgets, while the UI distinguishes estimates from provider-reported dollars. Agent totals and expanded model rows show **Estimated** when every charge in that group is estimated, or **Partially estimated** for a mix. Groups with no estimates have no estimate badge. These labels follow the selected date range and use ledger-event counts, not run counts; they do not infer pricing status from the provider or model name. `pricingComplete` means no missing prices or pending receipts; it does not mean invoice reconciliation has occurred. The Costs page warns when totals are incomplete. Provider cards include cached tokens and calculate subscription shares using each token once. Provider spend is compared with the real company budget, not a fabricated proportional allocation. Run displays prefer cache-adjusted prices and preserve explicit zeroes.

Gemini token normalization follows the [CLI stream statistics](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/stream-json-formatter.ts) and [API usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata): cached prompt tokens are separated from input, and thinking tokens contribute to output.

## Upgrade and operational limits

The generated migrations widen monetary columns, add receipt identities and run recovery markers, and restrict incident uniqueness to open incidents. Existing whole-cent values retain their value. Column type changes and index creation acquire database locks; schedule upgrades according to database size. The new nonnegative check rejects invalid legacy ledger rows rather than silently rewriting them.

Historical rounded charges, missing receipts, ambiguous token semantics, and absent provider prices cannot be reconstructed from these migrations. Old runs are not automatically re-billed. Imported invoices and reviewed corrections can resolve historical prices when there is evidence. Historical runtime totals are retained as an explicit baseline; the inspector identifies legacy totals that lack one instead of fabricating a reconstruction. When a receipt is available but has no price, operators can explicitly allow unpriced usage; doing so does not make the displayed total complete. Runs that permanently lose their final receipt remain pending and require recovery or explicit disabling of the hard-stop policy. Automated reconstruction of missing receipts from arbitrary provider logs is not implemented.

Tests use disposable PostgreSQL databases and cover company isolation, concurrent duplicate delivery, sub-cent threshold crossings, complete rollback after a late write failure, pending-run recovery, mixed-model conservation, currency separation, monthly rollover, manual pause preservation, simultaneous policies, cancellation delivery failures, and recovery foreign-key lock compatibility. Adapter tests cover timeout receipts and cache semantics, alongside UI amount/share tests. Provider report tests exercise request/response contracts, credential isolation, pagination, revisions, transaction rollback and duplicate delivery with fixture HTTP responses. They do not establish live billing-account permissions.

## Reproducing reliability checks

Run `pnpm test:accounting` for the accounting test typecheck, focused server tests, historical migration tests, V8 coverage, and mutation sentinels. The thirteen accounting service modules each require at least 98% line coverage, 90% branch coverage, 96% statement coverage, and 96% function coverage. HTML and JSON reports are written to `coverage/accounting/`. These percentages do not include the full heartbeat service, adapters, browser UI, or child server processes.

The expanded accounting gate includes prospective Codex pricing and provider-report imports. All four deliberately introduced accounting mutations must be caught by their intended assertions. Separate regressions cover late pre-provider cancellation proof, reservation release without replacing the stop result, lost-channel receipt incompleteness, and exact reservation editing. The full test runner includes every adapter project configured in the root Vitest configuration; a roster check prevents silent omissions.

The server suite includes four SIGKILL cases: before receipt insertion, after the ledger write but before runtime totals, at the last write before commit, and after commit but before acknowledging cancellation delivery. SQL barriers make these boundaries deterministic. After killing the server process group, the harness terminates the orphan database connection still waiting at the barrier, restarts the real server, and checks exactly one receipt, one set of totals, and one incident/approval. A second restart proves replay does not duplicate them. This tests application crash recovery, not a database power failure. Eight fixed random seeds exercise 640 mixed operations with concurrent receipt retries, policy changes, admission checks, recovery, and injected cancellation failures.

The migration fixtures restore the predecessor column/index/journal shape, populate historical maximum integer amounts, rounded-zero receipts, finance credits/currencies, and closed incidents, then use the production migrator. An invalid negative legacy receipt must reject the upgrade without changing the schema or migration journal; an explicit repair allows retry.

Run `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/cost-accounting.spec.ts` for the browser workflow. It boots a throwaway instance and the built UI, invokes a deterministic local provider through the real Claude adapter, checks cost display and the budget stop, rejects a manual wake while paused, raises the budget in the UI, and starts another run. It asserts exact cents and cache tokens through the API, then imports an invoice, reviews and applies a sub-cent correction, and independently verifies the resulting totals. Stopped, resumed, and reconciled screenshots are attached to the Playwright report. It uses no paid provider credentials or calls.


## Durable capture and operator recovery

The spool lives at `<instance-root>/accounting-receipts`. Directories use mode 0700 and receipt files 0600. Files contain accounting fields only; transcript text, prompts, tools, and credentials are excluded. Publication awaits file and directory fsync on POSIX. Each record carries company/run identity, a controller source ID, sequence, timestamp, normalized usage, completeness, and price. Replay validates the schema and fingerprint and rotates failures behind fresh entries in bounded batches. Old controller snapshots are retained as evidence but cannot overwrite a replacement controller or an acknowledged run. Multiple provider attempts are accounted together; incomplete attempts and capture failures remain incomplete.

The spool survives process death on persistent local storage, including the tested boundary before the first database write. It does not survive destruction of that storage, and cannot recover provider activity that was never emitted as usage. Back up persistent instance storage together with PostgreSQL. No arbitrary provider-log scraping or automatic provider re-execution occurs during accounting recovery.

Board-only routes under `/api/companies/:companyId/accounting` provide:

| Route | Behavior |
| --- | --- |
| `GET /health` | Pending and unpriced counts, oldest pending time, last errors/retry counts, cancellation backlog, held capacity |
| `GET /inspect` | Independent ledger/projection and original run-receipt comparison; no data repair |
| `POST /repair` | Rebuild repairable totals using the reviewed `fingerprint` and a required `reason`; stale review returns 409 |
| `POST /retry` | Retry a company-owned `runId`; record the request and any failed attempt |
| `GET` / `POST /invoices` | List or idempotently import normalized invoice evidence and financial events |
| `POST /provider-costs/import` | Fetch completed daily provider reports for explicitly selected projects/workspaces |
| `GET /invoices/:invoiceId` | Compare exact amounts and expose unmatched, ambiguous, non-inference, or unsupported-currency lines |
| `GET` / `POST /events/:eventId/adjustments` | Read correction history or apply a reviewed correction |

Agents cannot use operator endpoints. Board viewers may inspect but cannot mutate. Repairs and corrections record the operator and reason in local activity history. An inspection fingerprint binds the repair to the observed discrepancies; the service recomputes them under the company lock before writing. Missing original evidence and legacy runtime uncertainty are never silently repaired. New runtime totals reconcile against an explicit historical baseline plus acknowledged v2 run receipts, including backdated receipts.

The CLI exposes `accounting health`, `accounting inspect`, `accounting repair`, `accounting retry`, `accounting invoices`, `accounting invoice:import`, `accounting invoice:review <id>`, `accounting provider:import`, and `accounting event:correct <id>`, using the ordinary authenticated company context. Mutations take `--payload-json`; inspection is the dry run for repair.

## Invoice review and corrections

Imports use the normalized format in [the invoice template](examples/accounting-invoice.json). Map provider exports to this format explicitly. Invoice identity is `(company, biller, externalId)`; same-content replay is harmless, different-content reuse returns 409. Line order does not affect identity. No provider credentials or remote API calls are needed.

A match requires a unique company/biller-scoped `costEventId`, `runId` (optionally with model), or `providerRequestId`. All supplied identifiers must agree. Multiple candidates or multiple lines claiming one charge are ambiguous and cannot be applied as invoice-backed corrections. Non-USD invoices, fees, and credits remain visible evidence and are never silently converted into USD inference spend. Every imported invoice line also creates an idempotent finance event in the same transaction: inference charges, fees, and credits retain their kind and currency. An import either commits invoice evidence and timeline entries together or commits neither. Replaying an invoice creates no duplicate charge. Importing an invoice does not automatically change run valuations.

A correction requires `idempotencyKey`, exact `expectedCents`, `correctedCents`, `reason`, and `pricing` provenance. An optional `invoiceLineId` must uniquely match and support the corrected amount. The expected value guards against stale review; the correction key prevents duplicate application after an ambiguous response. `reportedCostCents` and the original receipt fingerprint remain unchanged. `cost_adjustments` preserves every prior valuation, actor, reason, evidence, and pricing revision, including the original provenance in `previousPricing`. The effective `costCents`, projections, runtime totals for supported new receipts, and budget state update atomically. Pricing an unpriced receipt can release a budget-owned pause; other policies and manual pauses still apply.

## Scale and fault qualification

`pnpm benchmark:accounting` creates its own disposable PostgreSQL database, seeds one million events across twelve months, measures report latency and eight concurrent writers on one company, exercises two active budget policies, recovers 250 pending receipts, records an analyzed project-budget query plan, and runs the independent integrity checker. `PAPERCLIP_ACCOUNTING_BENCH_ROWS` optionally sets 1,000–10,000,000 events. Results go to `coverage/accounting/scale.json`. There are no machine-dependent latency assertions in CI.

The September 28 local run on macOS arm64 / Node 25.6.1 measured all-time summary p95 39 ms and project grouping p95 64 ms. With eight concurrent writers, throughput was about 325 writes/s without active policies and 22 writes/s with two active policies; p95 was 72 ms and 359 ms respectively. The budgeted 250-receipt backlog drained in three bounded batches in about 12.7 seconds, with zero integrity discrepancies. Active policies deliberately read the authoritative ledger, which is more expensive than updating a projection. These synthetic warm local results are evidence, not production service-level guarantees.

Monthly projections carry an explicit UTC month marker. The first write after upgrade or rollover initializes from the ledger; subsequent same-month writes use exact atomic increments. Backdated events do not increment the current month. Reports and budget decisions continue using the ledger. Composite project/date and partial unpriced indexes support targeted queries; pending recovery is indexed in its actual update-time order.

Additional fault tests use independent Node writer processes, kill a recorder after fsync but before database persistence, and proxy PostgreSQL to discard the `COMMIT` acknowledgement after the server commits. Retrying all of these preserves exactly one charge and correct projections. Mutation tests remove deduplication, company filtering, projection updates, and the inclusive hard-stop comparison in Vite memory. Each must fail its named assertion after an unchanged baseline passes; import errors and skipped tests do not count as detected mutations. Workspace source is never rewritten by the mutation runner.


## Prospective Codex estimates

Codex commonly reports tokens without dollars. For new receipts, `codex-pricing.ts` applies the immutable `openai-standard-2026-09-30` catalog only when both provider and biller are OpenAI, billing is metered API, usage is per run, and the exact model ID is supported. The initial catalog covers `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna`, and `gpt-5.6-sol`, from the [official pricing page](https://developers.openai.com/api/docs/pricing). Unknown models, unsupported tiers, session-cumulative receipts and mixed-model receipts remain unpriced. OpenAI-compatible custom endpoints do not establish OpenAI billing. Existing provider-reported amounts, including zero, take precedence.

Calculation separates ordinary input, cached reads, cache writes, and output. Cache writes are a subset of input, not extra tokens. Integer arithmetic rounds once to nanodollars. An explicit pricing context can select the supported service/context tier; when request-level context is unavailable, the estimate records standard processing and short-request assumptions. A large cumulative run is not evidence that any individual request crossed a long-context threshold. Such estimates can differ from a bill because of tier/context assumptions, negotiated prices, or fees. They are useful estimates, not externally enforced budget ceilings.

The recorder calculates and freezes the amount, rate version, base rates and assumptions **before** writing its durable spool. Finalization, a process restart, or a later catalog change cannot silently reprice that captured receipt. Native runs carry their managed AI connection's billing identity into this path. Estimated costs feed the same exact, idempotent accounting and budget transaction as provider-reported costs. The original receipt remains available after an invoice correction. Historical missing dollars are not backfilled automatically.

## Getting financial events into Paperclip

Open **Costs → Recent financial events → Record or import charges**. There are three entry paths:

1. **Record charge** records a subscription payment, fee, credit or refund. Enter USD, the UTC date and a description. The client keeps its idempotency key through an ambiguous failed response, so retrying the same entry cannot charge twice.
2. **Import invoice** accepts the normalized [invoice JSON format](examples/accounting-invoice.json). Stable biller/invoice/line IDs provide idempotency. Invoice import produces timeline events atomically and preserves evidence for separately reviewed run corrections.
3. **Provider report** fetches API cost reports from OpenAI or Anthropic. Save a provider organization admin key as a **company secret**, then select it, the matching provider organization ID, explicit project/workspace IDs, and a UTC interval. Dates cover at most 31 completed days; the end date is exclusive. Use `default` only to intentionally include provider rows with no project/workspace ID.

The provider importer uses fixed HTTPS endpoints, refuses redirects, verifies Anthropic organization identity, sends the selected OpenAI organization header, filters selected scopes and bounds time, pages and response size. It reads all pages before writing. Missing days, overlapping scoped results or invalid currencies/amounts reject the import. OpenAI amounts arrive in USD; Anthropic reports decimal cents. A complete bucket without a selected scope is an explicit zero.

Each daily company/provider/account/scope snapshot has a revision. Reimporting unchanged data writes no event. Increases append debit deltas; decreases append credits, including corrections back to a previous total. A slow older fetch cannot overwrite a newer changed snapshot. The snapshot, finance event and activity record commit together.

**Provider report totals are separate from invoice/manual-charge totals.** The finance summary exposes `providerReportedCentsExact`; report rows remain labeled in the timeline but are excluded from net charges and biller/kind charge groupings. This prevents importing a report and its invoice from adding the same expenditure twice. Neither is added to run-cost estimates. A manually entered charge and an invoice representing the same payment must still be kept distinct by the operator; Paperclip cannot infer that identity from unrelated IDs.

API: `POST /api/companies/:companyId/accounting/provider-costs/import`. CLI: `paperclipai accounting provider:import --payload-json '<json>'`, with the normal authenticated company context. Payload:

```json
{
  "provider": "openai",
  "secretId": "00000000-0000-4000-8000-000000000001",
  "accountId": "org_example",
  "scopeIds": ["proj_example"],
  "from": "2026-09-01",
  "to": "2026-09-02"
}
```

Imports are initiated explicitly; this implementation does not schedule background billing synchronization. Repeated API/CLI invocations are safe for an external scheduler. It does not retrieve ChatGPT/Claude subscription invoices, apply exchange rates, or claim provider API reports cover every invoice item. [Anthropic's report](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) excludes Priority Tier costs. The [OpenAI Costs API](https://platform.openai.com/docs/api-reference/usage/audio_transcriptions_object) requires organization billing access; an ordinary inference key may be insufficient. These accounts need to be configured before live imports work.

## Subscription quotas and refresh behavior

Company quota requests resolve the caller's accessible subscription AI connections and read each account with its own managed credential. They do not substitute the server host's login for a remote agent account. Private, revoked or cross-company connections are filtered through AI connection authorization. Unmanaged remote credentials require connecting the account in AI connections before its quota is available.

Responses carry an opaque account identity and successful capture timestamp. The 30-second cache is scoped to company, user, connection, grant and credential revision; authorization and revision metadata are checked before reading cached results. Transient failures retain the last successful UI observation with its original timestamp. Rotation, revocation and explicit authentication rejection clear obsolete windows. Public messages never contain provider subprocess commands or raw diagnostics.

Both Costs page variants retain loaded reports and expanded rows during background refresh failures, with a small stale-data notice. Initial failures remain visible. Company/date changes isolate cached reports. The run-count label is `runs: 0 api · 11 sub`: distinct recorded runs, not tasks or individual model requests. Input totals include cache reads, with the cached portion shown explicitly.

Receipt identity and supplemental charges: `heartbeat:` idempotency keys are reserved for internally generated run receipts. Additional API-reported charges may link to the same run with their own keys. They contribute to monthly and acknowledged-run lifetime totals, while receipt-integrity checks compare only the original provider receipt. Recovery isolates each budget scope so a deleted target or failed scope does not prevent recovery elsewhere.
