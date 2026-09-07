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

The full Luna comparison is still running. Its corrected child-creation tests
now retain the required audit event. The companion report will separate this
source revision from earlier audit failures and incomplete attempts.

The rebased branch passed the full Linux build and typecheck. The full test suite
is running. Focused Linux verification also passed the real runnerd/PRP/HTTP
integration, resumed-session binding, platform file checks and runtime exposure.

## Release gates

1. Complete the selected Luna comparison and investigate any threshold flags.
2. Record final costs, latency, source revisions, failures and unrun operations.
3. Finish the full Linux test run and the PR review/check loops on current master.
4. Keep API tools disabled until an operator selects the first rollout companies.
5. Inspect task correctness, fallback frequency, cost, latency, denials and unknown
   mutation outcomes before expanding access.

The catalog-wide operation cases are authored, but most have not had paid model
execution. Generated cases that need additional fixtures do not establish working
coverage. The coverage matrix must continue to show those gaps. The original $300
budget and 90-minute active paid-campaign limit apply to all stages and retries.
