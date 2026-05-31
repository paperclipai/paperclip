# pilot-reporting

Phase 4A-S4 B6-prep helpers (LET-411 under parent LET-365).

These are two **pure** Markdown renderers — they take a typed input bundle
and return a string. They do no I/O: no HTTP, no DB, no document upsert, no
secret-store read, no provider transport. CI runs them without any E2B
credential.

The renderers will be consumed by LET-371 (B6) when the 2-week E2B pilot
starts. LET-371 owns the live wiring (daily-job scheduler, status-page
poller, document-upsert call). This package only ships the deterministic
building blocks.

## Components

### `renderDailySnapshot(input)`

Markdown snapshot of one UTC pilot day. Renders the row set defined in
LET-371 §"Daily Command Center snapshot":

- Day-to-date / month-to-date spend vs. 20 / 200 USD hard caps.
- Lease success rate (running tally), p95 cold start, p95 lease-ready.
- Isolation incidents (always reported, default 0).
- Raw-secret leaks (always reported, default 0).
- Vendor uptime from the E2B status page.
- Kill-switch state per layer.
- Banner section that surfaces cap breaches, isolation/leak counts ≥ 1,
  tripped/manual-disable switches, and vendor uptime dips below 99.5%.

Output is suitable to drop into a comment body. **LET-411 does not post
snapshots**; LET-371's daily-job caller takes the string and posts on
LET-365 at 00:05 UTC.

### `renderExitCriteriaReport(input)` + `evaluateExitCriteria(input)`

Markdown body for the mandatory issue document
`phase-4a-s4-pilot-exit-criteria-YYYY-MM-DD`. Evaluation pass also
returned separately so callers can branch (pass → ADR §7 gate issue for
Phase 4B / fail → revert + incident + ADR addendum) without re-parsing the
rendered Markdown.

The renderer covers every row in LET-371 §"Exit-criteria report":

- Per-criterion evaluation table (lease success rate, p95 cold start,
  p95 lease-ready, isolation incidents, raw-secret leaks, monthly cost,
  vendor uptime, operator confidence).
- Daily snapshot tally.
- Incident log (isolation + raw-secret), green-log placeholder when empty.
- Total cost vs cap with day-of-close + month-state.
- Vendor uptime computed across the pilot window.
- Operator-confidence comments from the three required reviewers
  (`Architect`, `QA Validator`, `Hermes Orchestrator`).
- Recommendation block (pass → Phase 4B / fail → revert + escalate).
- Optional early-halt section when the pilot stopped before the
  scheduled window end.

**LET-411 does not upsert documents**; LET-371's document-upserter takes
the string and writes it to the issue document store.

## Inputs

All inputs are defined in `./types.ts`. The shapes are the integration
seam between this prep work and B2 / B3:

| Field | Shipped by | Notes |
|---|---|---|
| `BillingCounterSnapshot` | LET-367 (B2 counter store) | `dayState` / `monthState` are pre-resolved by the caller via `resolveCapState`. |
| `ProviderStatusSnapshot.killSwitches` | LET-368 (B3 panel read-model) | Layer ids: `sandbox_provider`, `billing_cap`, `isolation_guard`, `secret_egress_guard`. |
| `VendorStatusPageSnapshot` | E2B status-page poll | Caller fetches; renderer never makes a network call. |
| `LeaseLatencyAggregate` | Paperclip lease history for provider `e2b` | Caller aggregates success/failure + p95. |
| `IsolationIncidentReport` / `SecretLeakReport` | Operator-curated incident log | Renderer truncates summaries at 240 chars. |
| `OperatorConfidenceComment` | LET-365 comment scrape | Caller maps comment id + role + verdict. |

When LET-367 / LET-368 ship a shape that diverges from what is declared
here, add a thin adapter in the LET-371 caller — **do not mutate the
shipped B2 / B3 shapes for this prep work** (per LET-411 AC #4). File a
`Component-inputs-gap` comment on LET-411 in that case so the seam evolves
with eyes on it.

## LET-371 integration seam

LET-371 wires two callers — both live behind the post-G2 boundary:

1. **Daily-job caller** (LET-371-owned)
   - Cron: 00:05 UTC.
   - Project from live B2 / B3 / status-page / lease-history into a
     `DailySnapshotInput`.
   - Call `renderDailySnapshot(input)`.
   - Post the string as a comment on LET-365.
2. **Document-upserter caller** (LET-371-owned)
   - Fires at pilot end (week 2) or on early-halt trigger.
   - Project pilot-window aggregates into an `ExitCriteriaInput`.
   - Call `renderExitCriteriaReport(input)` + branch on
     `evaluateExitCriteria(input).overall`.
   - Upsert the rendered body as the issue document with key
     `phase-4a-s4-pilot-exit-criteria-YYYY-MM-DD`.

Both callers stamp `truthLabel: "preview"` until Andrii's G2
(`confirmation:LET-365:canary-flag-flip:rev1`) is accepted. After G2, the
caller flips to `truthLabel: "live"`. The renderer surfaces this label in
the snapshot / report header so a stub-driven artifact can never be
confused with a live-pilot artifact.

## Constraints (LET-411)

- Zero key requirement. No `secrets/sandbox/e2b/apiKey/pilot` resolve.
- No live HTTP from this package.
- Components do not initialise any provider transport.
- Fail-closed boundary preserved — `truthLabel` defaults to `preview`.
- Raw secrets never persisted in code, tests, logs, comments, or PR
  description.

## Tests

Tests live as `*.test.ts` siblings (`daily-snapshot.test.ts`,
`exit-criteria-report.test.ts`) per the existing server convention. They
cover the state cases LET-411 names: within-cap, soft-cap,
hard-cap auto-disable, isolation incident, secret leak, vendor uptime
dip, green pass, cost-breach halt, isolation-incident halt, latency
failure, no-sample / no-data placeholder behaviour.

Run them with:

```
pnpm --filter @paperclipai/server vitest run src/services/sandbox/pilot-reporting
```

Note on path: LET-411 spec calls for tests under
`server/test/services/sandbox/pilot-reporting/`, but this repo
discovers tests via `*.test.ts` siblings under `src/` (see
`server/vitest.config.ts` — there is no `server/test/` tree). Tests are
filed alongside the renderers so vitest picks them up without config
changes; this matches LET-410's
`packages/shared/src/harness-reliability/classifier.test.ts` layout.
