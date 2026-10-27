# Eval coverage and operating costs

Use this with [OPERATIONS.md](OPERATIONS.md). The bounded daily and weekly
selections cover Product E2E only. They do not authorize or cap the separate
Runner protocol workflow, manual matrix runs, or other live probes.

## Initial cadence

The runner E2E maintainers own these selections and their failure triage.
Both profiles use the exact model and limits in the reviewed pricecard.

| Journey | Failure detected | Feature-map association | Cadence |
| --- | --- | --- | --- |
| Native Claude message marker | A real task cannot complete and persist its expected answer through the metered route | `runs-adapters/runs` | Daily and weekly |
| Native Claude complaint and suggestion | Completed tools fail to save attributed feedback or collection loses it | `activity/agent-commentary` | Daily and weekly |
| Native Codex message marker | The corresponding Codex task/connection path fails | `runs-adapters/runs` | Weekly |
| Native Codex complaint and suggestion | The corresponding Codex feedback/tool path fails | `activity/agent-commentary` | Weekly |

These associations identify partial coverage. They do not qualify every run
lifecycle, the Commentary browser page, continuation, or remote execution.
The October 21 local pilot measured one successful sample per selected cell:
$0.427624800 and 72.757 summed attempt seconds for the daily selection,
$0.791539400 and 127.069 seconds for the weekly selection. These are historical
gateway estimates from the Linux ARM64 container. They include model setup
requests and attempt setup/teardown, but omit queue/build time and non-model
charges. Earlier failed and interrupted attempts remain in campaign spending.

`scheduled-measurements.json` retains the exact attempt, source revision,
definition, model, price version, result hash and journal hashes for each sample.
`forecast.json` includes this evidence and a snapshot hash. It separates the
historical successful selection from samples matching the current definition,
model, environment, runtime, route and pricing. A missing matching cell makes
the compatible selection total unknown. The feedback definition changed after
these four samples; its earlier results are not current qualification.

Per-cell mean and median are descriptive. P95 stays unknown below 20 samples
and then uses nearest rank; this is not a statistical confidence guarantee.
Do not sum per-cell percentiles into a campaign percentile. Hosted cost/time
and the selection's P95 remain unknown until separately measured. A passing
sample does not predict failure frequency or account for infrastructure,
storage, observability or subscriptions. Forecasts never reduce reservations
or the approved budget limits.

At the October 21, 2026 catalog audit, 47 suites declared 738 cells. `--all`
included 179; the other 559 required explicit selection. The bounded weekly
selection included four cells, and daily two. These are dated inventory counts,
not live acceptance results or an enduring catalog-size contract. Inspect the
current `pnpm test:e2e:runner -- --list` before choosing work. In particular,
Everyday Workflows, provider connections, feedback persistence, interruption,
and case handoffs must not be inferred from a passing `--all` campaign.

Keep the broader rotating lane disabled until its exact cells have a metered
route, complete retained attempts, a measured cost/time distribution, and a
budget that includes failures. Prefer targeted continuation, approval, and
cleanup cases that detect different failures over another model running the
same marker. A release lane may broaden coverage only with its own reviewed
manifest; the daily/weekly allowance does not authorize it.

## Adding an eval or changing its cadence

The change's fixture documentation and PR must declare:

- A responsible maintainer/team and the concrete failure the case detects.
- Feature-map capability IDs, or an explicit unmapped gap. State what the
  journey does not exercise within a broader capability.
- Exact suite, case, profiles, models, environment, and intended cadence.
  State whether it is explicit-only and how it differs from existing coverage.
- A deterministic alternative considered, and why paid behavior is necessary.
- Attempt, request, output-token, concurrency, retry, and wall-time limits.
  Include setup, judges, child/background work, and cleanup in the route audit.
- Estimated cost/time before the first run, then all-attempt measurements with
  sample count, retained failures, source/definition IDs, and uncertainty.
  An unmeasured field is unknown, never zero.
- Feedback collection/review, trace verification, missing-receipt handling,
  and a failure/cleanup owner. Novel complaints are reviewed independently
  of the product grade.

Use the existing [Product E2E authoring skill](../../.agents/skills/add-product-e2e-eval/SKILL.md)
or the separate [Runner authoring skill](../../.agents/skills/add-runner-eval/SKILL.md).
Update the existing scheduled selection and forecast only after qualification;
adding a catalog entry alone must not enable recurring spending.

## Reading campaign time

The report's summed attempt time uses every retained accounting receipt,
including failed retries. A missing attempt makes the total unknown; the report
keeps the observed subtotal and missing count. The observed attempt window runs
from the earliest retained start to the latest retained finish. Parallel attempts
overlap in that window, while their individual durations add to the sum. Gaps
between attempts remain in the window. Carried-forward evidence can span older
runs, so this window is not the current workflow's duration.

Agent execution and Daytona lease time remain separate measurements. Attempt
durations include the setup and cleanup inside their recorded boundaries.
New browser-worker results retain a separate phase receipt for fixture setup,
execution, feedback capture, cleanup and worker finalization. Repeated cleanup
segments add together. Atomic checkpoints preserve completed phases if the
worker is interrupted; the active phase has no inferred end time. Parent
recovery checks identity, interval bounds and file size before retaining that
partial receipt. Missing, malformed or unavailable receipts keep phase totals
unknown, while closed segments remain visible as observed subtotals.

These phases start inside the test callback, after browser/server startup, and
end before result publication. Parent teardown/finalization, CI queue/build time
and provider-billed runtime need their own receipts. Historical results and
non-browser launchers without a worker receipt remain explicitly unmeasured.
Test details show each selected attempt's receipt status and raw timing metadata.
Do not infer missing measurements by subtracting summed agent time from the
observed window. Refreshing a report computes these views from retained
results without making provider calls or changing the original measurements.

## Costs outside the model journal

Keep a separate cost component for each resource, with its currency, service,
resource/request identity, source window, allocation basis, and status. Join
components to campaign/attempt IDs where evidence permits. Do not sum a model
estimate with the invoice that later reconciles that same usage.

| Component | Evidence and allocation | When evidence is missing |
| --- | --- | --- |
| Provider models and paid tools | Dedicated project/key usage and billing exports; match provider request IDs or the narrowest available billing window | Preserve estimates, unknown requests, held reservations and the reconciliation difference |
| Daytona | Owned sandbox ID, actual resources, billable lifecycle and provider receipt; include failed creates, retries, stopped storage and delayed deletion | Retain the reservation or an explicitly partial estimate; a requested TTL does not prove deletion |
| CI compute | Workflow/job IDs, runner type, actual billed runtime and invoice rates; include setup, builds and failed jobs | Mark CI cost unknown; a short agent turn does not imply a cheap CI job |
| Storage and transfer | Artifact size, retention window and billed storage/egress | Report the unpriced component, including retained failure evidence |
| Braintrust/gateway usage | Project usage export and its window; distinguish included allowance from incremental overage | Do not treat free-looking trace metrics as proof of zero provider charges |
| Shared subscriptions | Show the existing Braintrust Pro $249/month separately under the October 21 operator policy; allocate newly incurred subscription/capacity charges from invoices with an explicit denominator | Keep new shared charges unallocated rather than assign an invented exact per-test cost |

Retain both the service total and the allocation denominator so allocated
amounts can be reproduced. A zero incremental usage charge can coexist with a
nonzero shared subscription. Never add the entire subscription to every test.
The approved daily/weekly budgets cover additional run costs, so they exclude
the existing $249/month fee while including new usage and capacity charges.
Scheduled admission now reserves the declared CI, storage, observability and
subscription allowances inside the same $20/$100 journal limit. Missing or stale
allowances stop scheduling before the AWS test runner starts. Missing receipts
keep their reservations held. Explicit reviewed full-lifecycle bounds may allow
provisional completion while billing remains pending; missing bounds, conflicts
and overspending still fail. Legacy reservations gain no qualification from the
policy change. This is a local admission
control, not a provider billing cap. Actual resource bounds, cost collection and
reviewed allowances still need qualification before recurrence is enabled; see
[the allowance contract](OPERATIONS.md#recurring-campaigns).

Recurring evidence and reports use private S3 archives with file/byte/request
boundaries, retained transfer receipts and verified access/expiration rules;
see [private recurring history](OPERATIONS.md#private-recurring-history). The
public workflow retains only a content-free availability marker for monitoring.
Public history is a separate explicit publication step. Private retention still
needs hosted OIDC qualification and actual storage/transfer billing evidence;
local archive tests and an infrastructure template do not establish those facts.

## Separate Runner Eval audit

The October 21 audit inspected Paperclip source on master `8b873e0112` plus the
eval operations stack, and the available `paperclip-evals` checkout at
`0bae4e0947dc7959cae25b73d27533c096f23a14`. This is a source audit, not a
new live run or proof of the workflow's configured private-repository revision.

Runner reports already retain immutable attempts, retry-inclusive estimated
cost and provider list cost as separate views, compatible-cohort comparisons,
and missing-usage coverage. Its mock control plane is a different authority
from the Product E2E server/database; Product feedback persistence cannot be
claimed from a Runner tool assertion.

The private `run_live_campaign.py` requires an explicit authorization envelope.
The hosted `runner-protocol-live-evals.yml` instead fans out individual
`run_live_roster.py` cells, supplies their direct provider credentials, and uses
configured per-attempt limits. It does not use the Product E2E shared gateway
journal, Braintrust attempt parent, indexing verifier, or feedback finalizer.
The private campaign wrapper's aggregate authorization must not be assumed to
protect that different hosted path.

Before adding Runner recurrence, its owners must establish an aggregate
allowance across fanout and retries, meter setup/provider bypasses, and qualify
native tracing through its actual packaged runner. Preserve direct-provider
qualification as its own route. Implement definition/roster changes in the
maintained private repository, pin that reviewed revision in the existing
workflow, and retain Runner's existing Evalbook renderer and scores. These
gaps remain open; Product E2E qualification does not close them.

## Missing campaign detection

Workflow failure notifications cover runs that start. The independent observer
is `scripts/eval-schedule-monitor.mjs`. Run it through a separate host with an
authenticated GitHub CLI and one private state file:

```sh
node scripts/eval-schedule-monitor.mjs "$HOME/.config/paperclip-evals/schedule-monitor.json"
```

The observer uses only GitHub GET requests. It never starts or retries paid
work and does not need provider credentials. It reads the two existing enable
gates plus `RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED_AT`, an ISO timestamp set
when recurrence is enabled. Missing activation time fails visibly; occurrences
before activation are not treated as missed. Workflow run titles carry the
literal cron expression to distinguish daily and weekly runs, including Sunday.

Only the legacy `RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED` gate being off establishes
disabled recurrence. If that gate is on while the operations gate is absent or
off, the observer reports `configuration_incomplete` and retains one incident
notification. Older deployed workflows use only the legacy gate, so a missing
new gate must not imply that those paid schedules are disabled. Verify the
deployed default-branch workflow and both variables before enabling recurrence.

The observer allows 90 minutes for schedule delay. It checks the most recent due
occurrence per cadence, marks a run overdue after four hours, and requires a
successful terminal run plus a nonempty, unexpired merged-report artifact.
The workflow's finalizer remains responsible for checking report content and
accounting. Metadata inspection does not repeat that validation. Unexpected
reruns, ambiguous matching runs, incomplete API lists and API failures remain
visible. The observer reads at most 100 rows per collection and fails closed
if a response is truncated.

Retained state includes the last successful inspection and inspected run IDs.
`notifications` is a durable outbox of problems and recovery transitions. Each
entry has an ID. After confirmed delivery, the host acknowledges those IDs:

```sh
node scripts/eval-schedule-monitor.mjs "$HOME/.config/paperclip-evals/schedule-monitor.json" --ack <notification-id> ...
```

Until acknowledgment, later inspections return the same pending entries even
if the problem has recovered. The host uses IDs to deduplicate delivery. This
survives a process exit between saving state and printing output; it does not
claim exactly-once delivery across an external notification service. After
acknowledgment, an unchanged problem stays quiet. A new missed occurrence is a
new incident. Disabled recurrence and unchanged healthy runs create no new
alerts. Use one writer for both checks and acknowledgments; do not reset the
state file to clear an incident. Malformed history fails before a query or
write. The external host owns notification delivery and its own liveness.

Schedule this observer outside the paid workflow after source and recurrence
are ready. It should inspect at least daily, after both scheduled start times
and their grace windows. Until that external trigger and notification delivery
are configured and exercised, missed-run detection remains an activation gap.
