# Controlled runner recovery tests

Run from the Paperclip repository after installing and building dependencies:

```sh
pnpm test:runner-recovery
```

This command runs provider-free tests with a disposable embedded Postgres database.
It does not call a model, launch a paid browser campaign, or produce a model score.
The database test must run rather than skip before claiming its coverage; consult
its output for platform support. Run these tests when changing recovery policy,
continuation delivery, or replacement admission.

## Boundaries and checks

| Test owner | Established premise | Required outcome |
|---|---|---|
| `native-replacement-evidence.test.ts` | Explicit known/unknown process ownership, history, workspace, action receipts, and retry budget | Allow replacement only with complete safe evidence. Return a specific cause and next action otherwise. |
| `stopped-codex-turn.test.ts` | Precisely bound fixture transcripts with a closed text-only turn, partial output, wrong turn identity, or an unknown action | Accept the closed safe transcript; reject incomplete or uncertain current-turn effects. |
| `native-safe-replacement.test.ts` | Inject the stopped-session verifier result into the real database reconciler; record real saved file bytes and one user comment | Verified recovery schedules one successor whose continuation includes the comment once; missing proof or an unconfirmed action schedules none. All cases retain the saved file and user comment. |
| `native-safe-replacement.test.ts` | Concurrent reconciliation, transaction failpoints, changed ownership, exhausted budgets, and cancelled work | Preserve one successor lineage, roll back incomplete commits, respect user intent, and stop retries at the incident limit. |

The injected verifier is a test boundary. These tests do not prove that an
operating-system process actually stopped or that a provider completes the
successor. They establish controller decisions and persistence under known
conditions. Real stop verification and a user-visible final result require
separate integration/acceptance evidence.

## Why the paid crash probes were retired

The former `recover-runner` and `recover-runner-safe` cases killed the daemon at
an arbitrary point and expected automatic completion. They did not establish
that every old process had stopped or that unfinished actions were safe to
repeat. A no-tools prompt did not establish those facts. Their failures therefore
do not establish a recovery correctness bug. `recover-runner-uncertain` exercised
a useful safety rule but did not measure model quality or a complete user journey.

Historical records remain in Evalbook, including failed grades and paid cost.
The main scorecard omits all three cases. Supported controller restart and
Stop/new-direction journeys remain in `everyday-workflows`.

Before adding another live crash-recovery story, specify the supported recovery
path, prove its fault boundary, perform the recovery action, then independently
verify saved work, pending input, and a usable final result. Until that journey
is qualified, do not score arbitrary process termination as a model failure.
