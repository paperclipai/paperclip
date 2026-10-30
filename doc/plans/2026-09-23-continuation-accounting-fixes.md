# Continuation accounting fixes — September 23, 2026

Follow the [test-first accounting baseline](2026-09-22-continuation-accounting-baseline.md)
and preserve its failed measurements. Repair the product against those assertions;
do not change their intended outcomes.

## Implementation

1. Persist independent infrastructure-failure and max-turn continuation counts in
   server-owned run context. Repair slots remain in the durable disposition episode.
   Carry both counts across waits, repairs and controller restart. A change of retry
   reason cannot erase prior debt or charge another lane. Historical ambiguous
   counters remain conservative; known repair/productive counters are not failures.
2. Promote delayed legacy repairs against their persisted episode fingerprint and
   successful source run, checking company, issue, agent and bounded repair slot.
   Retain the existing late Stop, wait/approval, ownership, pause and spending gates.
3. Replace the two obsolete scripted native `same_agent` probes with the reachable
   public question/response contract: create a durable question, wait for its answer,
   deliver once, and reject duplicate delivery. Keep the misleading-prose pair and
   the sequence longer than the infrastructure retry allowance.
4. Keep the development service worker out of Vite's module revalidation. The failed
   browser trace contains a bodyless module `304` through the worker before React
   mounts. A small real-browser regression checks repeated conditional reloads with
   the actual worker; production cache/privacy tests continue using a stamped build.
   The live rerun must establish whether the observed blank-page failure is resolved.

## Verification

- Existing failing unit, scheduler and promotion assertions must pass unchanged.
- Exercise alternating failure/productive/resource-wait retries through the actual
  scheduler, recreate the controller each time, and exhaust each allowance separately.
- Verify repairs preserve both debits, invalid source/episode/slot cannot promote,
  and late gates cancel delayed repairs without another debit.
- Run all deterministic lifecycle layers, E2E support, the cheap browser suite,
  relevant typechecks, then the required repository checks.
- Rerun all eight explicit `continuation-accounting` real-provider/browser cells in
  parallel GitHub Actions jobs. Retain original grades, source/definition fingerprints,
  cleanup, retries, usage/cost coverage and failure evidence. Save the new measurement
  separately from September 22; do not regrade the baseline.

Other retained findings remain in the [backlog](2026-09-22-legacy-continuation-authority.md).
