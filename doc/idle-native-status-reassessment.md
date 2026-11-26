# Native status reassessment without idle polling

Native status reassessment uses committed changes and the shared delivery
scheduler. It no longer runs on every periodic orphan-recovery pass.

## What creates work

Existing native result, assessment, decision, task and review rows remain the
source of truth. No new queue table or database migration is required.

| Change | Existing producer boundary |
| --- | --- |
| Work-product creation, update, import, removal, attachment or trusted promotion | Work-product/task services and the promotion transaction |
| Task status/version, assignment, execution state or blocker configuration | Task mutation transaction |
| Direct claim release, terminal/stale lock cleanup, queue release, recovery or tree restoration | Existing task-scoped claim mutation transaction |
| Automatic review retirement | Automatic completion review owner |
| Approval/link or interaction outcome, including OAuth card creation/reopening | Approval/review-state notification boundaries |
| Accepted/rejected control-plane run evidence | Run-event append transaction |
| Workspace barrier or physical ownership settlement | Workspace operation, finalizer and verified recovery owners |
| Coordinator claim/retry, effect settlement or run projection | Native finalization and run-milestone boundaries |

These signals request inspection. They do not grant permission to complete a
task. Discovery retains the three existing conditions: changed work-product
history, changed authoritative task status/version, or a retired selected
completion review. The owner still classifies the selected result and appends
assessments and decisions through the existing status committer.

A settled worker makes no recurring queries. Insufficient evidence is dormant.
Real contention or operational failure keeps a retry. A saved retry or lease
expiry keeps its actual future deadline. Startup reconstructs candidates in
100-row pages; the coordinator processes bounded batches and retains changes
through drain/resume and concurrent dispatch. Shutdown uses its existing owner.

## Authority and separate responsibilities

Scheduled commit checks the selected source, current task/run, retry and lease,
pending effects and native process ownership inside the status transaction.
Retired-review completion also checks the latest contract, workspace barrier,
physical workspace ownership, governance and dependencies. Evidence is
reclassified under source locks. Contention defers instead of blocking an idle
worker indefinitely or committing stale completion.

The legacy reconciler retains explicit recovery and a one-time startup pass.
Its periodic call skips reassessment but preserves the superseded historical
source guard before independent workspace recovery. Workspace/result settlement,
retained session cleanup, native wake delivery and generic orphan recovery are
separate duties; their recurring scans have not been removed by this slice.

Case-handoff delivery and lease changes do not improve evidence: every persisted
non-cancelled state already counts as accepted. Cancellation is negative evidence
and is fenced by the source lock at scheduled commit. Creation generates the
handoff identity inside its transaction before returning it. No reassessment wake
is added to every lease renewal. Target-agent status is also not a classification
trigger: attention validation checks existence, not whether an agent is invokable.
Creating an agent does not satisfy result criteria or verification. Missing
arbitrary target identities have no row to lock; this change does not provide a
general predicate-lock guarantee for independent identity insertion.

Pending child completion is a guard and a fresh parent-turn obligation. It is not
silently consumed by completing the old result. New contracts supersede the old
result's eligibility; creating one does not revive that old result. Direct SQL
writers and independent replicas do not receive process-local notifications.
The supported producer model remains the active server and integrated transaction
owners; this change does not add a distributed notification transport.

## Evidence and limits

Current qualification is recorded in the [audit](plans/2026-10-26-native-status-reassessment-sleep-audit.md).
The broad 9fddb source passes 2731 cases in 28 complete files. The final 5ea3
runtime source, after the evidence-trigger quality fix, passes 1211 cases in five
complete affected files. Their overlapping counts are not added together. Real
producer/transaction coverage includes first writes, rollback/outer commit,
authority races, saved deadlines, drain/resume, claim release and retained history.
The final worker suite includes all 43 cases.

Required quality review remains mandatory on both retired-review and evidence
reassessment. An unmet review produces its existing nonterminal decision and
review recovery action, rather than repeatedly attempting completion as an
operational retry. Real required/optional regressions and controlled coarse-hint
negatives fail before repair and pass afterward without changing time limits.

Historical discovery measurements in the audit retain their original revision:
10,000 selected-history tasks return no company candidates in about 35 ms;
10,000 real candidates require 101 queries and about 1.56 seconds to discover.
This is discovery cost, not complete backlog execution. The current worker still
retains candidates in memory proportional to backlog size. Its permanent
103-item lifecycle case verifies settlement across batches and SQL quiet.
Cancellation is checked between pages, not during an already-running SQL call.

Database build, server typecheck/build, module boundaries and migration-order
checks pass. The host's embedded PostgreSQL bootstrap remains limited by
exhausted System V semaphores; acceptance uses fresh owned PostgreSQL 17 databases
and preserves embedded-only fresh-per-call isolation through the existing recovery
helper. Adapted test imports restore exactly; assertions are unchanged. No full
local repository-suite or live external-provider qualification is claimed.

Remote exact-head CI and review still gate merging. The
[stack ledger](plans/2026-10-24-recurring-server-sleep-stack.md) tracks other duties.
Worker quiet does not establish database suspension, Cloud alarm coverage, host
sleep or fleet cost savings.
