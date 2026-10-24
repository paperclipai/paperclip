# Recurring server work migration stack

Baseline: `785d54636e1c8513ee5503d602daf6a5ee1970d6` (2026-10-24).

The requested outcome is a reviewed PR stack for every remaining recurring server
work item below. A PR owns one reason for background activity. Split compound
items into separate PRs as their producer and lifecycle audits identify distinct
owners. Each PR includes behavior, producer audit, tests, and documentation.
Do not mark an item done from a timer removal or a green check alone.

## Scope and completion ledger

| ID | Original checklist duty | Required slices / disposition | PR / evidence |
| --- | --- | --- | --- |
| 01 | Custom-image setup expiry | Session writes, existing expiry, startup/retry/drain | [#17443](https://github.com/paperclipai/paperclip/pull/17443), CI/review running |
| 02 | Remaining chat maintenance | Provider runtime discovery; voice reconciliation; milestones; wake notices; interaction continuations; terminal confirmations; GitHub recovery; Teams maintenance, separately by owner | Pending |
| 03 | Run and task recovery | Orphan runs and active leases; shutdown workspace settlement; scheduled retries; queued runs; stranded assignments; resolved dependencies; task watchdogs; silent-run monitoring; stale locks | Pending |
| 04 | Decision retention and notifications | Retention deadlines and notification delivery are separate reasons | Pending |
| 05 | Decision expiry and interrupted effects | Expiry, effect recovery, continuation recovery | Pending |
| 06 | Tool connection health | Configuration/use activation and defined proactive health deadlines | Pending |
| 07 | Secret proposals, tool reviews, gateway tokens | Separate expiry/scrub/recovery owners | Secret proposals: [#17446](https://github.com/paperclipai/paperclip/pull/17446), CI/review running; gateway credential expiry in progress; tool reviews pending |
| 08 | GitHub connection events and continuity | Event discovery/replay and credential continuity separately | Pending |
| 09 | Merged-PR confirmations | Candidate writes, webhook activation where supported, outstanding-candidate fallback | Pending |
| 10 | External-object refresh | Configuration changes, refresh deadlines, source events | Pending |
| 11 | Status-card evaluation | Settings/card mutations and evaluation deadlines | Pending |
| 12 | Plugin scheduled jobs | Registration/update/removal and actual job deadlines | Pending |
| 13 | Routine, agent-timer and issue-monitor scheduling | Remove periodic wake backstops after complete producer coverage; routine execution-status reconciliation separately | Pending |
| 14 | Skill-version retention and native-harness backup expiration | Separate retention owners and existing retention guarantees | Pending |
| 15 | Automatic database backups | Shared scheduling, actual backup deadlines, existing checkpoint contract | Pending |
| 16 | Aggregate maintenance tick | Retire enabled and disabled branches after all constituent owners migrate | Pending |

## Stack and verification contract

The first PR targets master. Each following PR targets its predecessor branch so
its diff shows only its own reason. Parent changes must be propagated before
final verification. Record the exact checked head and base for every PR. All PRs
must finish with passing checks, fresh 5/5 Greptile review, and no unresolved
findings. This request does not authorize merging the stack.

Reuse the delivery coordinator, transaction notifications, and shared scheduler.
Existing durable rows own work; no table per loop. Keep domain/provider behavior
in its service and wiring in startup. A write signal is not durable truth. Preserve
outer commit/rollback and uncertain-outcome reconciliation. Audit every supported
producer, including alternate routes and recovery writers.

For each slice verify applicable empty/configured-idle/history quiet states,
first real producer, actual deadlines, rollback/outer commit, restart, failures,
changes during execution, drain/resume, and shutdown. Use real PostgreSQL where
transaction boundaries matter and controlled providers where external behavior
is under test. Record failures and subsequent repair evidence.

External-source reconciliation may remain only for a concrete supported obligation
with a defined cadence and stopping condition, using the shared scheduler. Never
remove the only missed-event backstop without replacing its recovery contract.

## Boundaries

Cloud sleep eligibility and durable alarm coverage remain conservative. An
in-process deadline cannot wake a stopped host. Browser traffic, persistent
connector transport architecture, probes, telemetry/exporter qualification, and
end-to-end provider suspension are outside this requested recurring-server stack;
none are claimed solved by these PRs. Required active-operation lease renewals and
request timeouts remain with their owners.
