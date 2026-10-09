# Continuation accounting baseline

Explicit-only Product E2E suite: real Chromium, Paperclip server/database, runner
and qualified Codex provider. Select `--suite continuation-accounting`. It is
excluded from `--all`; it does not change scheduled paid coverage.

| Cases | Runtime | Cells | Expected provider executions |
|---|---|---:|---:|
| `accounting-productive-neutral`, `accounting-productive-noisy` | Legacy and native | 4 | 5 each |
| `accounting-exhaustion-neutral`, `accounting-exhaustion-noisy` | Legacy | 2 | 3 each |
| `accounting-repair-stop` | Legacy | 1 | 2, plus a cancelled scheduled record |
| `accounting-repair-approval` | Legacy | 1 | 3 |

Each cell has a twelve-minute limit and existing isolated fixture cleanup.
Browser-created tasks use public APIs/tools only. The Stop case invokes the same
public run-cancel endpoint as the UI before the second repair is due. Questions
and approval are answered in the browser. The server restart uses the existing
isolated restart mechanism, without editing persisted counters or task data.

The productive pair saves exactly five documents, one per real question/response
turn, each at revision one. It exceeds the repair/failure allowances without
spending them. Quiet turns post one attributed marker; noisy turns post three distinct numbered
attributed misleading historical quotations. The oracle requires those comments
in actual run evidence, not merely in the prompt. Repair exhaustion retains one
episode, two attempts and visible board ownership. Restart preserves exact run
identities. Stop is observed beyond the scheduled due time. Pending approval
must own the wait, and its acceptance permits one completion.

Snapshots and calibrated checks use the existing `continuation.json` and
`api-state.json` evidence paths, with loaded task screenshots at meaningful
checkpoints. Existing result validation, billing collection, sanitation,
publication and cleanup apply. Missing usage is not zero cost. Paid results are
fresh measurements, distinct from deterministic provider fixtures.

See the [scenario matrix](../../doc/plans/2026-09-22-continuation-accounting-baseline.md)
for deterministic fault, replay, spending and ownership coverage. Infrastructure
failures are not induced in paid cells; their cross-lane allowance semantics are
covered by actual scheduler tests with controlled failures.

Results and follow-ups are retained in the [accounting measurement report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-2026-09-22.md),
including the original failed fixture campaign. A new measurement never replaces
or regrades an earlier campaign.
