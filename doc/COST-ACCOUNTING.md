# Cost accounting and budget enforcement

This document describes the implementation after the September 2026 reliability audit. The execution ledger and the finance ledger serve different purposes: `cost_events` records USD usage attributed to agent work; `finance_events` records billing charges and credits in their original currencies. Provider invoices can be imported explicitly for comparison and reviewed corrections. Operators can also fetch OpenAI and Anthropic organization cost reports using a company-owned admin credential. Provider reports, invoices, and run estimates remain separate; Paperclip does not guess exchange rates.

## UI scope

The October 5 scope review preserves the existing Finance tab, headline totals, ledger summary, biller/kind breakdowns, recent events, API/CLI ingestion, and automatic Browser Use reporting. Recent financial events appear on the Finance tab only, following the October 6 Overview simplification. Cost accuracy, estimate labels, incomplete-spend warnings, user/project attribution, and stable background refresh remain in scope.

The new charge-entry/provider-import dialog and Accounting health panel (including invoice review, corrections, inspection, and repair controls) are deferred from the board UI. They are not mounted or polled by Costs or Budgets. Their server services and authenticated operator API/CLI commands remain available. Existing Finance reports still load and refresh, including for organizations with no events; no existing Finance functionality is gated on adoption or hidden behind a feature flag. The new reservation and unknown-price budget options are available under **Advanced settings**, collapsed by default; pending/unpriced warnings remain visible.

## From a run to a report

1. Before provider dispatch, the heartbeat stores issue/project/billing-code attribution and marks accounting pending. Adapters normalize usage into input tokens (excluding cache reads, including cache writes), cached input tokens, output tokens, billing identity, and an optional USD price. Usage is per run unless the adapter explicitly declares session-cumulative counters. A missing price is distinct from a reported zero. Native runs require a fresh, complete per-run usage report for the terminal turn; attachment snapshots and partial reports cannot finalize a charge. The Codex runner carries report completeness separately from its accumulated counters so retained older fields cannot fill gaps in a newer partial report.
2. Eligible direct OpenAI API receipts receive a versioned token-price estimate when the provider supplies no dollars (see below). Native execution and supported CLI/ACPX adapters checkpoint usage before workspace and issue finalization. Native terminal events persist fresh same-turn usage before the runtime commits its result; replayed events rebuild the receipt after a stop between event and receipt persistence. Each checkpoint is versioned and fsynced to a private instance spool before its database write; database outages leave the file for replay. A failed checkpoint capture persists a sticky incomplete-accounting marker before its error reaches the adapter; heartbeat retries that write before failure finalization. Older complete attempts, spool replay, and recorder replacement cannot clear the marker or settle the reservation. Missing evidence requires recovery rather than treating an earlier zero-cost attempt as the whole run. The heartbeat stores the final adapter receipt on `heartbeat_runs`, including partial usage returned for failed or timed-out execution. `subscription_included` usage contributes tokens but no incremental monetary charge. An explicit cache-adjusted price takes precedence over the nominal price.
3. `accountRunCost` acquires the company accounting lock and then locks the run. In one PostgreSQL transaction it inserts idempotent cost receipts, updates monthly spend projections, evaluates budgets, increments lifetime runtime totals, settles any reservation, and acknowledges run accounting. The original reported amount is preserved; a reviewed correction appends an audit record and changes only the effective valuation. Every new run receipt has a company-scoped idempotency key. Duplicate delivery cannot increment totals again. Complete per-model receipts are split only when both their tokens and prices reconcile to the run total; otherwise the aggregate receipt is retained.
4. Startup and periodic recovery scan terminal pending runs, independently of heartbeat scheduling being enabled. Failed writes roll back, leave the marker pending, and retry. A bounded batch rotates failed attempts so one bad receipt cannot starve other pending runs. Dispatched runs that have not produced a final receipt remain pending, including when cancellation marks a run terminal before its provider stops. A late final receipt can then be recorded exactly once. Recovery does not invent a zero-valued receipt or price. Proven pre-provider failures are acknowledged without creating a charge.
5. Reports aggregate `cost_events`. Company and agent monthly counters and runtime lifetime counters are projections. New receipts use the attribution captured for the run. Deleted issue/project targets become unallocated; foreign-company references are rejected. Legacy project attribution is inferred only when run activity identifies one project. The unallocated bucket is included so project totals conserve company spend.

The Overview always shows **By user** below **By agent**, including single-user companies. The synthetic `local-board` (Board) principal is excluded; any historical charges attached to it remain in **Unattributed** so spend is not lost. `GET /api/companies/:companyId/costs/by-user` uses the same authorization and date filters as the other cost reports. Attribution comes from the run's recorded `responsible_user_id`, not the current issue owner. Active users with no spend appear with zero totals; former members with spend remain visible. Charges with no valid company-scoped user attribution appear under **Unattributed**, preserving the company total. Runs are counted distinctly even when they have multiple receipts. Estimates and unpriced charges are labeled.

Amounts remain denominated in **cents**, including fractional cents. Ledger amounts and spend projections use PostgreSQL `numeric(24,7)`, preserving nanodollar precision instead of rounding every run to a whole cent. Arithmetic uses integer nanodollars, with one half-away-from-zero rounding step at the storage boundary. Monetary inputs accept decimal strings; use strings when exact representation matters. Unsafe large numeric inputs are rejected. Existing JSON number fields remain for compatibility, alongside exact decimal fields such as `costCentsExact`, `spendCentsExact`, `amountCentsExact`, `netCentsExact`, and budget `observedAmountExact`. Display rounding never changes storage or admission decisions. Budget limits remain whole cents.

## Ingestion and retries

`POST /api/companies/:companyId/cost-events` accepts an optional `idempotencyKey` (1–200 characters). Retrying the same normalized receipt with the same key returns its existing event. Reusing the key with different content returns `409`. Keys are scoped to a company; callers must reuse the original `occurredAt`, not regenerate it on retry. Without a key, each POST intentionally creates a new event. Automatic run accounting always supplies keys.

All linked agent, run, issue, project, and goal references must belong to the reporting company, and a linked run must belong to the reported agent. Non-finite/negative costs and negative/fractional token counts are rejected. The receipt, projections, budget incidents, approvals, and local activity-log rows commit together. Live activity publication and provider cancellation happen after commit; a notification or cancellation transport failure cannot undo a recorded charge.

Finance ingestion uses the same company-scoped key/conflict semantics. Credits remain separate nonnegative events with `direction: credit`. The top-level finance summary is explicitly USD; `currencies` contains independent totals for every recorded currency. Biller/kind groups retain currency. No exchange rate is guessed and unlike currencies are never added into one monetary total.

## Budgets and incomplete accounting

Company, agent, and project policies all apply. Monthly windows use UTC calendar months; lifetime policies coexist with monthly policies. A zero or inactive limit does not enforce a stop. Raising a saved zero limit activates enforcement; editing a disabled positive limit preserves its disabled state unless activation is explicitly requested. Generic company/agent budget updates synchronize the policy in the same transaction as the legacy budget field.

Active hard-stop policies block admission when recorded spend reaches the limit, when a terminal run still awaits accounting, or when usage lacks a reliable price. `unpricedUsagePolicy: block` is the default. An operator can explicitly choose `allow` to permit work despite missing prices; reports continue to identify incomplete pricing. This choice does not bypass pending accounting transactions. Subscription-included usage does not count as a monetary pricing gap.

At a hard stop the budget service pauses the scope, creates one open incident/approval for the policy window, and persists a cancellation delivery version. Cancellation is retried after failures and may be delivered more than once. It rechecks the policy and limits cancellation to work that existed at the check, so a delayed delivery does not cancel newly admitted work after a budget grant. Provider shutdown is best effort.

Raising a limit must exceed **current** observed spend. Resuming also requires all other hard-stop policies on that scope to permit work. Calendar rollover or disabling a policy releases budget-owned pauses only; manual pauses, terminated agents, and archived companies are preserved. Choosing to keep a scope paused dismisses the incident without generating a fresh approval on each admission check. A subsequent limit increase followed by another threshold crossing creates a new incident.

A legacy budget pause with no policy remains blocked until a policy or explicit operator resume resolves it. Manual agent pauses keep the normal agent admission error. Accounting activity is excluded from task-progress evidence, so recording a receipt cannot suppress plan-only recovery.

Policies optionally configure `reservationCents` (default zero), also editable as “Reserve per run (USD)” under **Advanced settings** on the Costs budget cards. Before dispatch, Paperclip locks the company, checks all relevant policies, and reserves the maximum configured estimate against company, agent, and project capacity. Concurrent dispatches cannot claim the same capacity. Zero disables the estimate; a zero-valued reservation still fences duplicate dispatch of the same run. Existing reservations retain their original amount after policy edits and carry across UTC month boundaries until settled. A native recovery owner may reuse its hold only after current budget and pause checks; its own in-progress accounting does not exempt it from other blockers. Daily heartbeat cost caps also compare exact stored cents before admitting work.

A final accounting transaction settles the reservation against the actual charge. Positive pre-provider failure evidence releases it without a charge. Time passing, a missing process, cancellation intent, or a policy change alone does not prove provider work has stopped and never releases a held reservation. A run permanently missing its final receipt requires evidence recovery; the system has no “assume zero” button.

Reservations are estimates, not provider-enforced spending caps. Delayed receipts and in-progress calls can exceed the estimate. Provider spending controls are needed for an external invoice ceiling.

## Dates, completeness, and UI

Cost and finance endpoints default to the current UTC month through now. Explicit `from`/`to` bounds remain inclusive; `period=all` requests all time. Reversed or malformed bounds are rejected. Date-filterable CLI cost/finance reports expose `--from`, `--to`, and `--all-time`. Operational accounting, budget, live quota and rolling-window commands reject these flags because their endpoints do not filter by arbitrary dates. The board sends explicit ranges, and month/year-to-date starts use UTC. Rolling spend excludes future events. The dashboard compares spend with the monthly cap only for Month to Date; historical ranges show the monthly limit without a utilization percentage. Provider report imports require explicit `from` and `to` dates in their payload, with an exclusive end date. To import yesterday, use its UTC midnight as `from` and today’s UTC midnight as `to`.

Cost summaries expose `eventCount`, `estimatedEventCount`, `unpricedEventCount`, `pendingRunCount`, and `pricingComplete`. Estimated charges count toward budgets, while the UI distinguishes estimates from provider-reported dollars. Agent totals and expanded model rows show **Estimated** when every charge in that group is estimated, or **Partially estimated** for a mix. Groups with no estimates have no estimate badge. These labels follow the selected date range and use ledger-event counts, not run counts; they do not infer pricing status from the provider or model name. `pricingComplete` means no missing prices or pending receipts; it does not mean invoice reconciliation has occurred. The Costs page warns when totals are incomplete. Provider cards include cached tokens and calculate subscription shares using each token once. Reports normalize historical unqualified OpenAI events without a receipt fingerprint from inclusive input to exclusive input before grouping (provider-qualified `openai/...` models from Pi/OpenCode already use exclusive input and are preserved), so mixed historical/new totals count cache reads once across agents, models, providers, billers, projects, issues, and rolling windows. This read-time conversion preserves original ledger rows and charges; legacy Anthropic input already excludes cache reads. Provider spend is compared with the real company budget, not a fabricated proportional allocation. Run displays prefer cache-adjusted prices and preserve explicit zeroes. Session rotation uses an explicit layout marker on new raw usage snapshots; unmarked historical snapshots retain their original input threshold calculation so cache hits are not counted twice after upgrade.

Provider pace warnings project month-to-date spend across the UTC month and compare it with the same company cap displayed by the bar. Run-history totals preserve separate cached input for legacy Claude/Gemini snapshots and provider-qualified OpenCode/Pi model snapshots, while retaining inclusive legacy Codex totals. Finance timelines use event time, then creation time, newest first, with bounded request limits. The headline event count covers USD only; non-USD events remain in their own currency summaries and in the timeline.

Gemini token normalization follows the [CLI stream statistics](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/stream-json-formatter.ts) and [API usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata): cached prompt tokens are separated from input, and thinking tokens contribute to output.

## Upgrade and operational limits

The generated migrations widen monetary columns, add receipt identities and run recovery markers, and restrict incident uniqueness to open incidents. Existing whole-cent values retain their value. Column type changes and index creation acquire database locks; schedule upgrades according to database size. The new nonnegative check rejects invalid legacy ledger rows rather than silently rewriting them.

Historical rounded charges, missing receipts, ambiguous token semantics, and absent provider prices cannot be reconstructed from these migrations. Old runs are not automatically re-billed. Imported invoices and reviewed corrections can resolve historical prices when there is evidence. Historical runtime totals are retained as an explicit baseline; the inspector identifies legacy totals that lack one instead of fabricating a reconstruction. When a receipt is available but has no price, operators can explicitly allow unpriced usage; doing so does not make the displayed total complete. Runs that permanently lose their final receipt remain pending and require recovery or explicit disabling of the hard-stop policy. Automated reconstruction of missing receipts from arbitrary provider logs is not implemented.

Tests use disposable PostgreSQL databases and cover company isolation, concurrent duplicate delivery, sub-cent threshold crossings, complete rollback after a late write failure, pending-run recovery, mixed-model conservation, currency separation, monthly rollover, manual pause preservation, simultaneous policies, cancellation delivery failures, and recovery foreign-key lock compatibility. Adapter tests cover timeout receipts and cache semantics, alongside UI amount/share tests. Provider report tests exercise request/response contracts, credential isolation, pagination, revisions, transaction rollback and duplicate delivery with fixture HTTP responses. They do not establish live billing-account permissions.

Managed Claude and AWS AgentCore report cumulative session usage. The runner saves a per-run baseline, subtracts it from fresh reports, and preserves it across retries and controller recovery. A new run attached to a warm session uses the last complete report as its baseline; reconnecting the same run never resets it. Partial, invalid or regressing reports remain pending. AgentCore reports awaiting interrupted-invocation metadata, and session-ceiling estimates whose token counts remain lower bounds, cannot complete a receipt or release its reservation. Legacy runner checkpoints without a baseline cannot establish historical per-run charges; a subsequent attachment with a complete baseline restores prospective accounting. AgentCore's returned prices remain labeled as estimates.

ACPX usage may contain placeholder zero counters when its token breakdown is missing or partial. The runner's explicit completeness flag travels with the usage through the driver and durable replay. Per-turn reports are accumulated across retries and restored from the run log after a controller restart. A complete later turn cannot hide an incomplete earlier turn. A terminal event cannot settle such a receipt; the run stays pending until complete usage arrives. Explicitly complete zero usage remains valid and does not prevent retrying an initial turn that did no work. An empty zero-cost attempt before a paid turn does not block prospective Codex pricing; partial positive known spend remains preserved.

## Reproducing reliability checks

Run `pnpm test:accounting` for the accounting test typecheck, focused server tests, historical migration tests, V8 coverage, and mutation sentinels. The gate verifies the saved test reports contain passing results for all four crash cases and both historical migration cases; missing or skipped tests fail the gate. The thirteen accounting service modules each require at least 98% line coverage, 90% branch coverage, 96% statement coverage, and 96% function coverage. HTML and JSON reports are written to `coverage/accounting/`. These percentages do not include the full heartbeat service, adapters, browser UI, or child server processes.

The CI lane that executes the coverage provider requires a frozen install from the checked-in lockfile. It neither resolves a stale manifest inline nor runs the accounting gate after an install failure. Dependency changes must receive the repository lockfile bot’s refresh before this gate can pass; other test lanes retain the repository’s existing install policy.

The repository's lockfile bot owns dependency lock updates. The new coverage package requires its generated lock refresh before running frozen-install workflows. Live provider evals, optional E2E, Storybook visual checks and canary onboarding retain their frozen-only installs: a stale lock stops the job before tests or provider access; these jobs never resolve replacement dependencies as a fallback. Wait for the bot's reviewed lockfile refresh rather than retrying with an unfrozen install.

The expanded accounting gate includes prospective Codex pricing and provider-report imports. All four deliberately introduced accounting mutations must be caught by their intended assertions. Separate regressions cover late pre-provider cancellation proof, reservation release without replacing the stop result, lost-channel receipt incompleteness, and exact reservation editing. The full test runner includes every adapter project configured in the root Vitest configuration; a roster check prevents silent omissions.

The server suite includes four SIGKILL cases: before receipt insertion, after the ledger write but before runtime totals, at the last write before commit, and after commit but before acknowledging cancellation delivery. SQL barriers make these boundaries deterministic. After killing the server process group, the harness terminates the orphan database connection still waiting at the barrier, restarts the real server, and checks exactly one receipt, one set of totals, and one incident/approval. A second restart proves replay does not duplicate them. This tests application crash recovery, not a database power failure. Eight fixed random seeds exercise 640 mixed operations with concurrent receipt retries, policy changes, admission checks, recovery, and injected cancellation failures.

The migration fixtures restore the predecessor column/index/journal shape, populate historical maximum integer amounts, rounded-zero receipts, finance credits/currencies, and closed incidents, then use the production migrator. An invalid negative legacy receipt must reject the upgrade without changing the schema or migration journal; an explicit repair allows retry.

Run `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/cost-accounting.spec.ts` for the browser workflow. It boots a throwaway instance and the built UI, invokes a deterministic local provider through the real Claude adapter, checks cost display and the budget stop, rejects a manual wake while paused, raises the budget in the UI, and starts another run. It asserts exact cents and cache tokens through the API, then imports an invoice and applies a reviewed sub-cent correction through the operator API. It rejects a correction without a reason, replays the correction without duplicating it, and independently verifies the resulting totals. A separate workflow verifies that charges and credits submitted through the existing finance-events API still appear in Overview and Finance, with independent currency totals and idempotent invoice replay. The deferred accounting tools are absent. Screenshots are attached to the Playwright report. It uses no paid provider credentials or calls.


## Durable capture and operator recovery

The spool lives at `<instance-root>/accounting-receipts`. Directories use mode 0700 and receipt files 0600. Files contain accounting fields only; transcript text, prompts, tools, and credentials are excluded. Publication awaits file and directory fsync on POSIX. On the first use in each process, every ancestor directory must also be readable and support fsync, including for an existing spool or credential-recovery path. This includes real target ancestors and directories containing each storage symlink. Reuse revalidates the complete ancestry and symlink targets; moving an unchanged leaf under a new parent invalidates the proof. Permission or flush failures block recording and credential exchange until corrected; restarting cannot waive an unfinished flush. Each record carries company/run identity, a controller source ID, sequence, timestamp, normalized usage, completeness, and price. Replay validates the schema and fingerprint and rotates failures behind fresh entries in bounded batches. Old controller snapshots are retained as evidence but cannot overwrite a replacement controller or an acknowledged run. Multiple provider attempts are accounted together; incomplete attempts and capture failures remain incomplete.

Before replacing a stopped run's recorder, recovery saves every pending spool receipt for that company and run, independently of the bounded startup sweep. A save failure blocks replacement and retains the old source for retry. Native recovery then restores its latest journal snapshot; subsequent cumulative Codex run usage replaces that snapshot rather than adding it twice. OpenCode and ACPX per-turn reports are accumulated by turn, rebuilt from company/run-scoped durable events after a controller restart, and protected against replaying older reports. Missing earlier usage or terminal evidence keeps the aggregate incomplete; missing prices preserve known spend with an unpriced marker. Native turn prices are summed in integer nanodollars. A complete zero-cost, zero-token failed resume does not discard the successful Claude retry's model breakdown; other unattributed attempts retain the aggregate fallback.

Settlement also drains every pending spool receipt for the run under the company accounting lock before checking completeness or acknowledging usage. A newer partial receipt prevents settlement of an older complete snapshot. Recovered journal writes and ledger settlement share a transaction; spool files are removed only after its commit, so a failed charge or projection write leaves the original evidence available for retry. A concurrent replay rename causes a rescan; repeated file movement defers settlement.

Recovery indexes immutable spool-file identities once per batch, outside company locks. Each settlement skips indexed files belonging to other runs, revalidates its matching receipts, and checks newly published or renamed files. Standalone settlement builds the same index before taking its lock. This avoids repeatedly reading unrelated receipt contents while admissions and ledger writes wait.

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

A match requires a unique company/biller-scoped `costEventId`, `runId` (optionally with model), or `providerRequestId`. All supplied identifiers must agree. Multiple candidates or multiple lines claiming one charge are ambiguous and cannot be applied as invoice-backed corrections. Non-USD invoices, fees, and credits remain visible evidence and are never silently converted into USD inference spend.

Imports retain every invoice line as evidence. Inference lines matching an existing Finance debit for the same charge, biller, and currency do not create another debit, including when the invoice reports a different price. Ambiguous inference matches also remain evidence without adding a debit. Other lines create idempotent finance events in the same transaction, retaining their kind and currency; uniquely matched charges are linked so overlapping exports cannot count them twice. Fees and credits remain separate events. An import either commits invoice evidence and new timeline entries together or commits neither. Replaying an invoice creates no duplicate charge. Importing an invoice does not automatically change run valuations or revise an existing Finance entry; differences require operator review. Unrelated identifiers cannot establish that two records represent the same payment.

A correction requires `idempotencyKey`, exact `expectedCents`, `correctedCents`, `reason`, and `pricing` provenance. An optional `invoiceLineId` must uniquely match and support the corrected amount. The expected value guards against stale review; the correction key prevents duplicate application after an ambiguous response. `reportedCostCents` and the original receipt fingerprint remain unchanged. `cost_adjustments` preserves every prior valuation, actor, reason, evidence, and pricing revision, including the original provenance in `previousPricing`. The effective `costCents`, projections, runtime totals for supported new receipts, and budget state update atomically. Pricing an unpriced receipt can release a budget-owned pause; other policies and manual pauses still apply.

## Scale and fault qualification

`pnpm benchmark:accounting` creates its own disposable PostgreSQL database **and receipt-spool home**. It never uses the caller's database or pending receipts. `PAPERCLIP_ACCOUNTING_BENCH_ROWS` selects 1,000–10,000,000 events (one million by default), spread across twelve UTC months. Results go to `coverage/accounting/scale.json`; copy that file before running coverage, which cleans the same output directory. There are no machine-dependent latency assertions in CI.

The benchmark measures all-time reports, eight concurrent writers on one company, two active budgets, admission, eight concurrent ledger/budget/health report bundles competing with writers, durable checkpoints, 100,000 historical run rows, overview/writes/admission with 102 policies (100 unrelated to the writing agent), 1,000/10,000-file receipt backlogs, and recovery of 250 completed runs. An independent integrity check must find no discrepancies. Report bundles measure service/database work, not browser rendering, HTTP latency, provider quota calls, or financial-event queries. The fixture concentrates spend in one agent; it is not a production traffic model.

The October 4 local comparison on macOS arm64, 10 CPUs, Node 25.6.1 measured the following at one million ledger events. PostgreSQL, API code, and storage shared one developer machine. These are observations, not service-level guarantees.

| Measurement | Before | After |
| --- | ---: | ---: |
| Budgeted writes/second, eight writers | 20.1 | 35.1 |
| Budgeted write p95 | 396 ms | 227 ms |
| All-time summary p95 | 44 ms | 48 ms |
| All-time project grouping p95 | 71 ms | 75 ms |

The expanded run measured report-bundle p95 of 678 ms with eight viewers and eight writers, write p95 of 569 ms under that read load, admission p95 of 103 ms, and durable checkpoint p95 of 11 ms. A 102-policy overview had p95 of 73 ms. Health over 100,000 historical runs had p95 of 19 ms. Scanning 10,000 pending receipt files added about 580 ms to recorder startup; receipts are retained until safely persisted. The API process's event-loop delay p95 was 12 ms. The 250-run recovery finished in three batches in 11.5 seconds, with zero integrity findings.

At ten million events, budgeted throughput rose from 2.8 to 3.8 writes/s and p95 fell from 2.80 to 2.09 seconds. Recovery of 250 runs fell from 90.4 to 71.8 seconds, with no integrity discrepancies. However, eight concurrent report bundles plus eight writers reached 12.2-second report p95 and 12.4-second write p95. Warm all-time summary p95 was 649 ms; the first all-time summary took 59.2 seconds (44.5 seconds before the change). Seeding took 7.2 minutes. These larger runs shared developer hardware with test activity; report code was unchanged, so their variability is not evidence of a report-query regression. They do show that this implementation is **not qualified for heavy traffic on a ten-million-row company**. The aggregation and storage capacity limit remains; the recovery guard prevents it from also creating overlapping sweeps.

Performance protections:

- Cost writes aggregate the affected company, agent, and project policies in one ledger scan and one pending-run scan. Each policy retains its own scope and UTC/lifetime window. Exact ledger values remain authoritative, including unknown pricing and native recovery guards.
- A budget operation reuses its observation for thresholds, incident amounts, and reasons. The observation also carries its UTC window across a midnight boundary. It does not cache observations across ledger mutations. PostgreSQL filters policies to the affected scopes before returning rows.
- Overview policy and incident reads run in batches of four, so a large policy list does not enqueue one query per policy at once.
- Health, integrity inspection, and invoice comparison use read-only, repeatable-read snapshots. Their counts and details agree without taking the company accounting write lock. Repairs retain the write lock and revalidate the inspection fingerprint before making changes.
- One heartbeat service shares a running receipt replay/recovery/policy sweep across overlapping scheduler ticks. Success or failure releases the guard; a later tick can retry. This is a per-process scheduler protection, not a distributed lease. Ledger locks and receipt idempotency still protect multiple processes.

The regression suite checks SQL scan counts, mixed-scope/window totals, pending/unpriced/native recovery guards, snapshot consistency while a writer commits, and coalesced recovery through both success and failure. It also retains the concurrency, crash recovery, exact-money, and mutation tests. Wall-clock benchmarks stay separate from CI correctness gates.

Capacity remains finite. Budget decisions still sum authoritative ledger rows, so a very large company or lifetime project costs more per write. First writes after a UTC rollover rebuild monthly projections. Cold all-time reports can be much slower than warm reports. A large receipt backlog still requires directory scanning. Qualify the expected company write rate, storage latency, database pool size, and viewer concurrency on deployment hardware before increasing traffic; monitor receipt age and recovery duration as well as request latency. Sustained traffic near measured saturation needs further database aggregation work with equivalent repair and consistency guarantees.

Monthly projections carry an explicit UTC month marker. The first write after upgrade or rollover initializes from the ledger; subsequent same-month writes use exact atomic increments. Backdated events do not increment the current month. Reports and budget decisions continue using the ledger. Composite project/date and partial unpriced indexes support targeted queries; pending recovery is indexed in its actual update-time order.

Additional fault tests use independent Node writer processes, kill a recorder after fsync but before database persistence, and proxy PostgreSQL to discard the `COMMIT` acknowledgement after the server commits. Retrying all of these preserves exactly one charge and correct projections. Mutation tests remove deduplication, company filtering, projection updates, and the inclusive hard-stop comparison in Vite memory. Each must produce its specifically marked assertion failure after an unchanged baseline passes, with the other sentinels passing. Setup errors, timeouts, unrelated assertions, and skipped tests do not count as detected mutations. Workspace source is never rewritten by the mutation runner.


## Prospective Codex estimates

Codex commonly reports tokens without dollars. For new receipts, `codex-pricing.ts` applies the immutable `openai-standard-2026-09-30` catalog only when both provider and biller are OpenAI, billing is metered API, usage is complete and per run, and the exact model ID is supported. The initial catalog covers `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna`, and `gpt-5.6-sol`, from the [official pricing page](https://developers.openai.com/api/docs/pricing). Unknown models, unsupported tiers, session-cumulative receipts and mixed-model receipts remain unpriced. OpenAI-compatible custom endpoints do not establish OpenAI billing. Existing provider-reported amounts, including zero, take precedence. A Codex CLI, Cursor, or OpenCode terminal event without valid usage counters or a reported price is incomplete and unpriced; it cannot become a zero-dollar estimate. Its reservation remains held pending reliable accounting evidence. Explicitly reported zero counters remain distinct from absent counters.

Calculation separates ordinary input, cached reads, cache writes, and output. Cache writes are a subset of input, not extra tokens. Integer arithmetic rounds once to nanodollars. An explicit pricing context can select the supported service/context tier; when request-level context is unavailable, the estimate records standard processing and short-request assumptions. A large cumulative run is not evidence that any individual request crossed a long-context threshold. Such estimates can differ from a bill because of tier/context assumptions, negotiated prices, or fees. They are useful estimates, not externally enforced budget ceilings.

The recorder calculates and freezes the amount, rate version, base rates and assumptions **before** writing its durable spool. Finalization, a process restart, or a later catalog change cannot silently reprice that captured receipt. Native runs carry their managed AI connection's billing identity into this path. Estimated costs feed the same exact, idempotent accounting and budget transaction as provider-reported costs. The original receipt remains available after an invoice correction. Historical missing dollars are not backfilled automatically.

## Getting financial events into Paperclip

Financial events remain visible in **Costs → Finance → Recent financial events**. Ingestion is available through the API and CLI; the proposed entry/import dialog is deferred.

1. **Existing finance-event ingestion:** `POST /api/companies/:companyId/finance-events` or `paperclipai finance event:create --payload-json '<json>'` records charges, fees, credits, and refunds. Supply amounts in cents, the currency, occurrence time, and a description. Use a stable `idempotencyKey` to safely retry after an uncertain response. Existing callers without that optional key remain supported.
2. **Supported integrations:** Browser Use Cloud automatically records its provider charges as linked cost and finance events. Not every agent adapter writes financial events; ordinary inference receipts use the separate cost ledger.
3. **Operator invoice import:** `paperclipai accounting invoice:import --payload-json '<json>'` accepts the normalized [invoice JSON format](examples/accounting-invoice.json). Stable biller/invoice/line IDs provide idempotency. Invoice import produces timeline events atomically and preserves evidence for separately reviewed run corrections.
4. **Operator provider-report import:** the API/CLI fetches API cost reports from OpenAI or Anthropic. Supply a company secret containing the provider organization admin key, the matching provider organization ID, explicit project/workspace IDs, and a UTC interval. Dates cover at most 31 completed days; the end date is exclusive. Use `default` only to intentionally include provider rows with no project/workspace ID.

The provider importer uses fixed HTTPS endpoints, refuses redirects, verifies Anthropic organization identity, sends the selected OpenAI organization header, filters selected scopes and bounds time, pages and response size. It reads all pages before writing. Missing days, overlapping scoped results or invalid currencies/amounts reject the import. OpenAI amounts arrive in USD; Anthropic reports decimal cents. A complete bucket without a selected scope is an explicit zero.

Each daily company/provider/account/scope snapshot has a revision. Reimporting unchanged data writes no event. Increases append debit deltas; decreases append credits, including corrections back to a previous total. A slow older fetch cannot overwrite a newer changed snapshot. The snapshot, finance event and activity record commit together.

**Provider report totals are separate from invoice/manual-charge totals.** The finance summary exposes `providerReportedCentsExact`; report rows remain labeled in the timeline but are excluded from net charges and biller/kind charge groupings. This prevents importing a report and its invoice from adding the same expenditure twice. Neither is added to run-cost estimates. A manually entered charge and an invoice representing the same payment must still be kept distinct by the operator; Paperclip cannot infer that identity from unrelated IDs.

API: `POST /api/companies/:companyId/accounting/provider-costs/import`. CLI: `paperclipai accounting provider:import --payload-json '<json>'`, with an authenticated company owner/admin (or instance administrator/local operator) context. Ordinary members and agents cannot use this endpoint.

Create a dedicated company secret through `POST /api/companies/:companyId/secrets` with the provider admin key as `value` and this explicit designation in its metadata:

```json
{
  "providerMetadata": {
    "providerBilling": { "provider": "openai", "accountId": "org_example" }
  }
}
```

Use `anthropic` and its organization ID for Anthropic. The designation must match both import fields exactly; missing, malformed or mismatched designations are rejected before secret resolution or provider requests. The secret's top-level `provider` still identifies its storage backend, not its billing provider. Existing secret status, version and access-audit checks remain in force. A secret ID alone never authorizes sending an unrelated credential to a billing provider.

Import payload:

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

Budget-policy saves use safe error messages and retain the operator's draft settings on failure. Detailed accounting diagnostics are available through the operator API/CLI, rather than a panel on every Costs tab.

The shared Costs page retains loaded reports and expanded rows during background refresh failures, with a small stale-data notice. Initial failures remain visible. An initial budget-load failure shows one safe notice above the tabs, including when Budgets is hidden; successful polling restores incident controls automatically. Budget-load and stale-report notices remain independent when requests fail together. Company/date changes isolate cached reports. The run-count label is `runs: 0 api · 11 sub`: distinct recorded runs, not tasks or individual model requests. Input totals include cache reads, with the cached portion shown explicitly.

Receipt identity and supplemental charges: `heartbeat:` idempotency keys are reserved for internally generated run receipts. Additional API-reported charges may link to the same run with their own keys. They contribute to monthly and acknowledged-run lifetime totals, while receipt-integrity checks compare only the original provider receipt. Recovery isolates each budget scope so a deleted target or failed scope does not prevent recovery elsewhere.

### Review hardening

Native restart recovery reuses a held reservation only when the coordinator's
current, unexpired lease owns the same run and project. Ordinary duplicate
provider dispatch remains rejected. A process adapter with no tokens, provider,
price, or explicit unknown-price marker does not create an unpriced charge;
provider adapters with missing prices still do.

Budget policy updates may omit unchanged settings, including the amount for an
existing policy. Omitted settings are read under the accounting transaction lock.
Creating a policy still requires an amount. Partial edits preserve an explicitly
disabled policy; the legacy monthly-cap endpoints explicitly enable a positive
cap and disable a zero cap. Generic agent and company budget
edits deliver hard-stop cancellation after their transaction commits.

Status-card update costs retain the ledger's fractional-cent storage precision.
The mutation gate retains partial results and per-run reports/logs under
`coverage/accounting/` when its baseline fails or a mutation survives.

Failed native turns persist observed run-delta usage before semantic-result
finalization. A matching terminal failure, cancellation, or interruption closes
that usage snapshot; ledger acknowledgement still waits until the native coordinator
has a result or a terminal failure. A retryable failed heartbeat keeps its
reservation and can resume. An open native coordinator's pending accounting
blocks fresh admission without pausing or cancelling its own recovery. Actual
budget overruns, unpriced charges, and closed runs missing accounting still
enforce hard stops; manual pauses remain unchanged. Replacing its recorder restores the native run's
cumulative snapshot; recovery does not add the same tokens twice, and an empty
final result cannot erase earlier observed usage. Missing terminal evidence and
session-only totals remain pending.

Budget admission completes before the final dispatch ownership check. A rejected
handoff releases a newly created hold using explicit evidence that the adapter
was never entered. Process adapter configuration and spawn failures likewise
return pre-provider proof; failures after a child exists cannot claim it.

Scheduled retry gates acquire company, issue, then run locks, in the same order
as accounting and attribution writes. Delayed budget cancellation rechecks the
policy version and current blocking state when it writes durable stop intent,
under the company admission lock. External shutdown happens after that lock is
released so the provider can save its final receipt. Raising a budget before the
stop is claimed preserves newly admitted work, including previously queued rows;
a run with an already claimed stop cannot enter provider work after the grant.
For multiple provider attempts, known prices remain in the exact spend total
when another attempt is unpriced. The aggregate stays marked unpriced, so the
configured unknown-price policy still controls whether new work may start.
