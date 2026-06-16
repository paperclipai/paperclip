# BUG-009 — Error-handling hardening found by adversarial re-review of the fix set

| | |
|---|---|
| **Severity** | MEDIUM (cluster) |
| **Source** | Adversarial re-review of the BUG-001…008 fixes (3 parallel reviewers, big-picture → shell → TS) |
| **Files** | `scripts/create-pilot-company.sh`, `scripts/create-pilot-plan.sh`, `scripts/reset-pilot.sh`, `server/src/services/teams-catalog.ts`, `server/src/__tests__/teams-catalog-service.test.ts` |
| **Category** | Error Handling / Correctness |
| **Status** | Fixed |

## Summary

A second review pass over the bug-fix commits found that the fixes hardened *some* curl/extraction
calls while leaving siblings in the same scripts unguarded, plus one genuine defect in a fix itself.
None are exploitable; all are silent-failure / robustness gaps in the pilot tooling and one small
refactor smell.

## Findings fixed

1. **`create-pilot-plan.sh` — silent wrong-project fallback (MED, defect in BUG-008).** The
   `?? list[0]` back-compat fallback re-introduced the exact position-based selection BUG-008 fixed,
   with no signal. Now emits a stderr warning when it falls back by position (no `"Pilot"` match but
   other projects exist).

2. **`create-pilot-company.sh` + `create-pilot-plan.sh` — unguarded `d.issue.id` extraction (MED).**
   `node -e 'process.stdout.write(d.issue.id)'` on the POST /plans response throws `TypeError` on a
   server error body, aborting under `set -e` with a bare node stack while the server's error
   message (in `$PLAN_JSON`) was never shown. Both now try/catch, exit non-zero, and print the raw
   response. The POST /plans curl itself is also now guarded.

3. **`create-pilot-company.sh` — unguarded `/activate` (LOW).** On failure the plan was created but
   left DRAFT with no hint. Now exits with a manual-activate instruction.

4. **`reset-pilot.sh` — unguarded `ISSUES_JSON` / `AGENTS_JSON` fetches (MED).** Under `set -e` both
   aborted mid-reset. `ISSUES_JSON` (before any destructive op) is now fatal with a clear "reset
   incomplete, no plans deleted" message and a guarded JSON parse. `AGENTS_JSON` (after plans are
   deleted) now falls back to `[]` so the existing "no root CTO → skip session reset" path runs
   instead of orphaning the reset.

5. **`teams-catalog.ts` — duplicate `defaultSafeCatalogAdapterType()` (LOW, smell from BUG-004).**
   The refactor read the env-var-backed adapter type twice per install (helper + warning message).
   `buildCatalogImportInput` now takes `defaultAdapterType` as a parameter; install computes it once
   and reuses it for the warning.

6. **`teams-catalog.ts` preview no-hint coverage (LOW).** BUG-004 made `previewCatalogTeamImport` run
   the adapter-defaults machinery for the first time. Added a test asserting the no-model-hint path
   (`core-exec-team` preview) yields bare `{ adapterType: "claude_local" }` (no spurious
   `adapterConfig`) and no errors.

## Findings dismissed (verified not real / overstated)

- **"BUG-002's fix is only a markdown file; the real fix is `317035bc`."** Wrong — `3b54202b` did
  modify `reset-pilot.sh` (the hard-fail). `317035bc` was the original A3 cap-sizing commit. Reviewer
  conflated the two.
- **`reset-pilot.sh` `{"amount":NaN}` injection.** `observed = Number(i.amountObserved || 0)` guards
  the missing case; only a non-numeric *string* from the budget API could produce NaN, which that API
  does not return. Negligible.
- **`localhost.evil.com` matches `*localhost*` in the remote-cwd guard.** That guard only prints an
  advisory warning — it gates nothing — so a false-negative is cosmetic. Left as-is.

## Verification

- `bash -n` clean on all three scripts.
- `npx vitest run teams-catalog-service + session-rotation-decision` → **51 passed** (1 new).
- `tsc --noEmit` → no errors in `teams-catalog.ts`.

## Note

The two reviewers independently flagged the unguarded fetch/extract calls (#2, #4), which is why the
cluster was worth a pass even though most are pre-existing rather than introduced by the fixes.
Several remaining `node -e` extractions on non-critical responses (stop/delete/resume results)
already use `try/catch` with safe fallbacks and were intentionally left tolerant.
