# BUG-002 — Silent guards PATCH failure leaves stale budget cap

| | |
|---|---|
| **Severity** | MEDIUM |
| **Backlog item** | A3 — right-size pilot budget caps + reset-pilot floor |
| **Origin commit** | `317035bc` fix(scripts): right-size pilot budget caps in reset-pilot.sh |
| **File** | `scripts/reset-pilot.sh` |
| **Category** | Error Handling |
| **Status** | Fixed |

## Summary

A3's first job is to raise `agentMonthlyTokens` to 5M so a full dev_team chain fits under the
hard-stop (the old ≤500k default tripped the kill-switch mid-chain on every HIVA-17 pilot). The
guards PATCH swallowed its own failure: `... 2>/dev/null || echo '{}'` turned any 401/403/5xx or
network error into an empty body, which the script reported as a one-line stderr warning and then
**continued**. The pilot then ran with the old, too-small cap — reintroducing the exact mid-chain
budget stall the change was meant to remove, with no operator-visible failure.

## Reproduction

1. Run `reset-pilot.sh <companyId>` against a server where
   `PATCH /instance/settings/guards` returns non-2xx (auth, validation, transient 5xx) or is
   unreachable.
2. `curl` fails → `GUARDS_RESULT='{}'` → `GUARDS_OK='warn'`.
3. Script prints `warning: could not update instance guards` to stderr and proceeds through the
   full reset.
4. The cap is never raised. The next pilot chain stalls at the old cap mid-review.

## Root cause

`scripts/reset-pilot.sh:62-75` — the `2>/dev/null || echo '{}'` fallback defeated `curl -f` and
`set -euo pipefail`, and the failure branch was a non-fatal warning. The most important step of the
script could be skipped while the script reported overall success.

## Fix

- Drop `2>/dev/null || echo '{}'`. On a failed request, print why the cap matters (HIVA-17 mid-chain
  stall) and `exit 1`.
- If the request succeeds but the response has no `budget` object (unexpected shape / partial
  success), dump the response and `exit 1` rather than warn-and-continue.

The cap update is now a precondition for the rest of the reset, not a best-effort side note.

## Verification

- `bash -n scripts/reset-pilot.sh` clean.
- Manual trace: a rejected PATCH now exits 1 before any plan deletion / session reset; a malformed
  200 response also exits 1 with the body shown.

## Notes

- The kill-switch floor arithmetic itself (`Math.max(observed + 5_000_000, 5_000_000)`) was reviewed
  and is correct — it tightens the previous `+100M` floor that rendered the hard-stop meaningless.
  Only the failure path was defective.
