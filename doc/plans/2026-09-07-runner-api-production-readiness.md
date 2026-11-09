# Runner API production readiness — 2026-09-07

The implementation is ready for final review and an opt-in rollout after the
remaining release checks pass. General release is not yet approved. The tools
are disabled by default and can be enabled for selected companies.

## Implemented safeguards

- The catalog covers mounted REST routes and identifies non-REST protocols.
- Calls use run-bound agent credentials and the real HTTP authorization path.
- Active-run and work-mode checks run again after file preparation.
- File opens reject symlinks at every path component.
- Runner lifecycle changes and active-task deletion aliases are blocked.
- Mutation receipts prevent automatic replay after an uncertain outcome.
- Credential-value and management operations cannot enter generic tool results
  or replay receipts. Safe secret metadata remains discoverable.
- HTTP errors that may follow a committed write retain an unknown outcome.
- Dedicated child creation now records its agent and run in the activity log.
- Eval journals and bounded provider traces survive disposable server cleanup.
- The shared ledger blocks new paid work if accounting is incomplete.

## Qualification evidence

Sonnet 5 through OpenCode 1.18.17 and OpenRouter passed the read, mutation and
cross-company denial smoke cases after fixes. It also passed eight additional
cases covering files, Ask/Plan modes, API-only options and a mixed workflow.
The initial malformed-JSON failure remains in the report. The corrected tool
schema tells models to pass structured JSON directly, and invalid string-encoded
objects receive an actionable error before HTTP dispatch.

Sonnet passed all 60 common-task regression runs: ten workflows, three repetitions
per arm. It used no unnecessary API fallback. Per-workflow average cost changes
ranged from -1.4% to +5.5%. No cost or latency increase crossed the 20% investigation
threshold. These are small samples, not a guarantee for all workloads.

Gemini 3.8 Flash passed read, mutation and denial smoke cases. DeepSeek V4 Flash
0731 completed the API read but did not finish within 120 seconds. It remains
unqualified under this limit. Both interrupted attempts have retained billing
reconciliation evidence. No missing charge was discarded or treated as zero.

Luna passed all 60 paired common-task runs with no unnecessary fallback. Two
workflows exceeded the 20% cost threshold: document reading (+38.8%) and task
search (+35.1%). Separate one-pair repeats changed cost by -29.1% and +7.8%.
Task-search time increased 54.5% in its single repeat. Cache use and model turns
varied. These samples do not establish the cause; retain the flags in rollout
monitoring. Corrected child creation includes the required audit event.

Final rebased read tests passed on both Luna and Sonnet. Sonnet used the new
repository-pinned OpenCode 1.18.29; the larger cohort used 1.18.17. Paid testing
stopped at $9.875960 and 88.16 active minutes. No missing accounting remains.
The remaining campaign time cannot fit another 120-second reservation.

The rebased branch passed the full Linux build and typecheck. Repository tests
were run by project and serialized shard. All 143 serialized server suites passed.
The runner TypeScript suite passed 1,599 tests with two platform skips. Rust
release tests, conformance and replay checks passed. The required API authority
check passed 814 tests, including the real runnerd/PRP/HTTP integration.

Retained verification logs record the initial environment failures and targeted
reruns: missing `jq`, an overlay-filesystem identity test that passed on tmpfs,
and parallel Rust linking that passed with one build worker. The macOS full
runner suite has platform-specific failures; Linux is the qualified full-check
platform. Latest-head CI remains the final release gate.

Review fixes also block issue reopen/resume/interrupt intents, require explicit
controller credential injection, and add recoverable ledger stop/reconciliation
transitions. These changes have provider-free evidence. They do not have new
paid-model results after the campaign time limit.

## Release gates

1. Preserve the completed paired comparison and its investigated threshold flags.
2. Record final costs, latency, source revisions, failures and unrun operations.
3. Require green current-head CI and completed security/code review before merging.
4. Keep API tools disabled until an operator selects the first rollout companies.
5. Inspect task correctness, fallback frequency, cost, latency, denials and unknown
   mutation outcomes before expanding access.

The catalog-wide operation cases are authored, but most have not had paid model
execution. Generated cases that need additional fixtures do not establish working
coverage. The coverage matrix must continue to show those gaps. The original $300
budget and 90-minute active paid-campaign limit apply to all stages and retries.

Implementation review: https://github.com/paperclipai/paperclip/pull/13003

Eval suite and evidence: https://github.com/paperclipai/paperclip-evals/pull/20
