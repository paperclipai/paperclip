---
name: fix-slow-queries
description: >-
  Diagnose and fix slow Paperclip PostgreSQL queries using Cloud and Neon evidence,
  local reproduction, performance and result comparisons, regression tests, and
  a PR with passing checks. Use for costly queries, repeated database work, or
  slow requests with a suspected database cause.
---

# Fix Slow Queries

Deliver a measured improvement with preserved behavior and a reviewable PR whose
latest commit passes checks. A list of suspicious SQL or an unverified rewrite
is an intermediate result. Respect a narrower request for diagnosis only.

## 1. Establish the target and finish line

- Resolve the reported URL, environment, company/workspace, deployed revision,
  owning repository, and local checkout. Read its `AGENTS.md` and scoped rules.
  Paperclip and the private `paperclip-cloud` control plane have different rules.
- Work in a dedicated branch/worktree. Reuse suitable existing work; keep the
  checkout running a live server out of branch switching and benchmark setup.
- Select a bounded batch, usually the top two or three query families. Record
  deferred candidates so discovery does not turn into an unbounded rewrite.
- The finish line is: reproducible baseline, faster treatment, output/behavior
  proof, relevant regression coverage, and green checks on each final PR head.
  A concrete access or infrastructure blocker must be reported as incomplete.

## 2. Find the actual database and rank the work

Read [Cloud discovery](references/cloud-discovery.md) when starting from a hosted
workspace. Follow the chain from Paperclip Cloud fleet admin to the stack's Neon
project, branch, endpoint, database, and runtime role. Record the corresponding
application deployment and time window. Do not reuse IDs from a previous run.

Capture query text/fingerprint, calls, total execution time, mean time, rows,
and available I/O, temporary-file, and lock-wait evidence. Rank both expensive
individual calls and frequent work with high aggregate cost. Group variants by
their actual caller; do not add unrelated query means into an endpoint latency.

Keep three claims separate:

| Claim | Evidence needed |
| --- | --- |
| SQL is expensive | Query statistics and a reproducible execution plan |
| The database path dominates a slow request | Correlated SQL, connection wait, and application timings |
| More database capacity would help | Resource/queue pressure in the same window and a capacity-specific experiment |

Cumulative query statistics are not a recent-window trace. Capture reset times
or two snapshots and calculate deltas. A large database-time total alone does
not justify resizing Neon. Application CPU headroom also does not rule out a
busy Node main thread.

## 3. Trace each candidate to its behavior

Use `rg` on distinctive SQL fragments, table names, JSON keys, and predicates.
Trace the full path: route or scheduler → service → generated SQL → indexes.
Record frequency, fan-out, page limits, redaction, authorization, and any second
query the caller performs. Compare the deployed implementation with local code.

State a falsifiable cause and the contract the fix must preserve. Typical causes
include casts on indexed columns, repeated detoasting of large JSON, broad
candidate scans, unbounded result sets, duplicate reads, and unnecessary polling.
Use plans and caller evidence to choose among them.

Inspect existing indexes and recent related fixes before adding another index.
For advisory locks, identify the caller, key, transaction duration, and wait
chain first. Preserve checkout, leases, ownership, recovery, and no-replay rules;
removing a lock or polling loop is not a query optimization by itself.

## 4. Reproduce the baseline locally

Read [Local proof](references/local-proof.md) before building or changing the
benchmark. Use disposable real PostgreSQL and synthetic data with representative
row counts, selectivity, and payload sizes. Record the PostgreSQL version and
any difference from the hosted server.

Pin the pre-fix commit. Capture the complete SQL and parameters the real service
generates, including projections, joins, ordering, limits, and relevant imported
query helpers. Prove the baseline exhibits the suspected cost before editing.
If it does not, improve the fixture or revise the hypothesis.

Save baseline results, timings, and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
Define the performance acceptance criterion for this fixture before measuring
the treatment. Avoid a brittle universal millisecond threshold.

## 5. Implement and prove both kinds of green

Make the smallest change supported by the measurements. Author the fix on our
branch from source and evidence. Related community reports can supply leads;
respect any instruction to keep the implementation independent of their code.

Run baseline and treatment against equivalent fixtures under the same settings:

- **Performance:** use warmups and repeated samples, report medians and spread,
  and examine plan/buffer changes. Alternate order or repeat in reverse order
  when caching could explain the gain. Report neutral or slower paths honestly.
- **Correctness:** compare every returned SQL column and the externally visible
  behavior. Preserve ordering, duplicates, nulls, tenant scope, and redaction.
  A faster wrong result fails even when row counts match.

When intentionally bounding history, compare query speed at the same result
limit separately from the contract change. Test default/max limits and older
record access. Do not call truncated output equivalent to the former full list.

Reject or revise the change if either proof fails. Keep the reproducible harness
with the source where repository conventions allow it; keep bulky evidence out
of git. Exhaust viable query/caller changes and existing indexes before proposing
an exceptional migration. Document the serious reason and why migration-free
alternatives are insufficient. Do not add startup scripts, boot-time DDL, or
recurring backfills to bypass the migration constraint.

If a migration remains necessary, follow the database migration rules and the
production-size timing procedure in [Local proof](references/local-proof.md).
Measure the complete migration, including index builds, backfills, and lock waits.
First optimize a migration exceeding the roughly one-to-two-minute budget; if
it cannot be brought within an acceptable duration, flag it for human review
with the measured timings and alternatives before presenting it as deployable.

## 6. Verify the blast radius

Choose checks from the caller graph and affected contracts, not only the edited
function. Relevant cases from this workflow include:

| Change | Regression evidence |
| --- | --- |
| UUID/JSON joins | Canonical, uppercase, malformed, missing and non-string IDs; native/legacy precedence; company scope |
| JSON projections | Scalar/array/object/null inputs, text conversion, all fields, redaction |
| History bounds | Service and route callers, UI/API defaults, older deep links, empty recent history, retry and navigation races |
| Ownership/recovery reads | Retained processes, active leases, blocked replay, workspace failure, receipts and delivery |
| Polling/caching | Idle work reduction, committed-change wakes, missed events, restart/sleep recovery, fresh destructive checks |

Use real database tests for SQL semantics. Exercise assembled services/routes
and actual UI components when those are affected. Update query mocks when the
builder shape changes; a broken mock is not evidence that runtime SQL is wrong.

Run focused checks first, then the owning repository's required pre-PR checks.
For this repo, consult `AGENTS.md` for typecheck, full tests, build, and conditional
map/token/migration gates. Capture command, commit, exit status, and log location.
Do not call an interrupted suite a pass. Preserve its partial evidence and state
what completed locally versus on the final commit in CI.

## 7. Create the PR and carry it through checks

Use [prepare-paperclip-pr](../prepare-paperclip-pr/SKILL.md) for public Paperclip
changes, [check-pr](../check-pr/SKILL.md) for feedback, and
[prcheckloop](../prcheckloop/SKILL.md) for checks. Follow the owning repository's
workflow instead when the fix belongs in `paperclip-cloud`.

- Use the full PR template. Include cause, contract, benchmark command, baseline
  revision, fixture, before/after timings, equality evidence, regression results,
  and remaining risks. Label synthetic local timings as local SQL measurements.
  For an exceptional migration, include its justification, production-size fixture,
  complete duration, blocking time, optimization attempts, and any human decision
  still needed. Query speedup does not establish acceptable migration cost.
- Split independent fixes into independently reviewable PRs; disclose actual
  dependencies. Attach every created PR to the current chat/task where supported.
- After each push, refresh the head SHA. Address actionable reviews and failures,
  rerun affected local proof, and wait for fresh review and all expected checks
  on that SHA. Follow this repo's Greptile 5/5/no-unresolved-findings requirement.
- Distinguish code failures from runner shutdowns or external outages. Rerun a
  demonstrated transient failure once. Cancel obsolete runs only after verifying
  they belong to this work and an older head; never terminate unrelated jobs.
- Do not finish with "CI pending." Continue the loop within its repair bounds,
  or report the exact blocker, check URL, attempts, and next action. An empty
  check list, an old review score, or a draft-only subset of checks is not green.

Thanking contributors and closing their PRs requires explicit authorization.
When authorized, explain which report our verified PR covers, acknowledge any
uncovered scope, and leave unrelated PRs open. This skill does not itself grant
permission to comment, close, merge, deploy, resize, or mutate a hosted database.

## Constraints

- your solution should not require a migration script to be run unless there is a serious reason - in almost all cases a migration script is a non starter
- similarly you should not add some new boot script - e.g. dont' work around migration scripts by running the migration on every boot
- if you add migrations, you should also have a sense on the time it will take on a large paperclip instance with thousands of tasks. the best option is to test on a clone of a production-size database and time it. if you don't have that you should make one. migrations that take an unacceptably large time to run (e.g. more than 1 or 2 minutes) must be flagged - first try to optimize the migration and then flag for a human if that's impossible

## 8. Hand off the evidence

Report each PR URL and final head, measured gains and neutral paths, correctness
comparison, completed local checks, latest-head CI/review status, and limitations.
If working from a Paperclip issue, attach evidence/work products using the
repository's artifact workflow. Keep private identifiers and tenant data out of
public PRs. State whether anything was deployed.

If rollout is authorized, verify the deployed revision and compare a fresh,
comparable query-statistics window and request timing. Until then, production
latency improvement remains unverified even when local SQL is much faster.
