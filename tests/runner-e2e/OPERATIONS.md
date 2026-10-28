# Bounded eval operations

The request ledger and gateway are opt-in. The ordinary launcher still supports
unmetered legacy campaigns. Do not infer a spending limit from a campaign ID.
Enable the bounded path with `PAPERCLIP_E2E_OPERATIONS_MANIFEST=/absolute/file.json`.
Keep this manifest, its journal, and request receipts private.

The [coverage and operating-cost guide](OPERATIONS-COVERAGE.md) records cadence
ownership, suite-growth requirements, non-model allocation, the separate Runner
Eval audit, and remaining activation gaps.

## Supported admission

The bounded path admits local `core-compatibility` and `feedback-persistence` cells
for `runner-codex`, `runner-acpx-claude`, `legacy-codex`, and `legacy-claude`.
Daytona admits the two native profiles in those suites when the manifest declares
`remoteGateway: "cloudflare"`. Each cell needs one exact priced model and its
provider credential; Daytona also needs its provider key. Other suites and remote
routes, subscription profiles, hosted tools, multimodal inputs, premium service
modes, and separate judges fail admission. This whitelist is implementation scope, not
evidence that every admitted harness has passed live qualification.

Before creating the journal or requesting credentials, manifest validation checks
that every selected model's worst-case single-request reservation fits the initial
campaign allowance after declared operating holds. Prices for unused models do
not affect this selection check. Passing it does not promise the whole campaign
will fit: later requests still use the journal's current commitments and limits.

Bounded daily and weekly workflows check source-byte limits before upload: 16 MiB
for the resolved lockfile, 1 GiB for the build bundle, and 256 MiB each for cell
evidence and the merged report. Build artifacts expire after one day; the others
expire after 30 days. These are source-byte and retention controls, not measured
compressed storage charges. ZIP framing and platform billing need separate receipts.

Evidence and reports are copied into fresh private staging directories. Up to
4,096 directory entries are inspected. Discovery visits accounting and snapshot
directories across attempts before archive and Playwright diagnostic directories.
Accounting under `scheduled/` and JSON records have copy priority over logs,
images and archives. Each retained file has a
SHA-256 digest. The staging receipt reserves 8 MiB inside the total and identifies
missing, changed, unsafe or oversized files and incomplete traversal. Originals
are never deleted or rewritten. Hidden paths remain excluded. The expected regular
`playwright-output/.last-run.json` bookkeeping file is outside the retained evidence
scope and does not fail retention. Other hidden paths make the scope incomplete.
Skipped paths and unvisited subtrees are named; overlong names use a bounded preview
and full-path digest. Partial staging is uploaded before the workflow
fails, so a storage limit cannot silently turn missing evidence into success.
These upload limits do not cap runtime disk writes or Actions caches. Each service
still needs billing evidence.

### Private recurring history

Daily and weekly evidence and merged reports are retained in a dedicated private
S3 bucket. They are not uploaded as plaintext GitHub artifacts, sent to the public
history publisher, or deployed to Pages. The report command's output also stays
inside the private report. The public workflow retains only a fixed availability
marker for the existing schedule monitor, with no report contents, storage address
or object identity. Public-repository GitHub artifacts are readable by signed-in
repository readers; authentication alone does not make those reports private.

Deploy `.github/infra/runner-e2e-private-history.yml` with the existing GitHub OIDC
provider and set `RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET`,
`RUNNER_E2E_PRIVATE_HISTORY_AWS_ROLE_ARN` and
`RUNNER_E2E_PRIVATE_HISTORY_AWS_REGION`. The role trusts only this repository's
`runner-e2e-private-paid` and `runner-e2e-private-history` environments. Create both
with a deployment branch policy allowing only the default branch. Reserve them
for this workflow: the shared `runner-e2e-paid` and `runner-e2e-history` environments
also serve protocol evaluations that execute target-branch code and must not
have access to the private archive role. Set the three archive variables in both
dedicated environments. This workflow separately requires the default branch before
paid access and reporting. Manual target-branch tests have no OIDC permission. A separate recurring
job receives that permission only when the target SHA equals the default-branch
workflow SHA. Both jobs reuse the same anchored setup and test steps. The role has configuration reads
and GetObject/PutObject under `runner-e2e-private/bounded-v1/`; no deletion,
policy changes or access to the public history bucket. AWS credentials are step
outputs supplied only to private transfer commands, never exported to paid agents.

Admission verifies retention before paid execution. Every transfer verifies all
four public-access blocks, disabled object ACLs, no bucket-policy reader grants,
versioning, the 30-day/current and one-day/noncurrent expiration rules, and absence
of Object Lock and replication. Inspection failure stops the transfer. The private
bucket is not a CDN origin and has no external reader grant.

Evidence and report archives each contain at most 256 MiB of staged files and
4,097 entries including the staging receipt, with an additional 8 MiB ceiling for
ZIP framing. Archives use stored entries, without decompression. Extraction checks
paths, entry types, duplicate names, directory size, payload totals and ZIP checksums
before committing a fresh destination. Transfers use one conditional PutObject or
one ranged GetObject. Automatic AWS retries and workflow reruns are refused. The
bucket also rejects PutObject requests without an If-None-Match condition. A local
transfer receipt cannot be overwritten by rerunning the command in the same directory.
Each command retains admission and outcome metadata. After private storage passes
inspection, completed and failed transfers each get one independent receipt-upload
attempt without repeating the original transfer. Successful receipts include the
archive hash and object version; lost responses remain failed or unknown. A failed
privacy inspection prevents all uploads, and an unsuccessful receipt upload can
leave only the local receipt. Its own upload remains pending in the snapshot,
so the snapshot is not proof of complete billing. Operator downloads and STS
credential exchanges also need separate cost attribution.

For authenticated retrieval, set the bucket variable and AWS profile, then run:

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/runner-e2e/private-history.ts download report RUN_ID /tmp/eval-RUN_ID
```

Use `evidence` instead of `report` for the original staged accounting and diagnostics.
The requested destination must not already exist. Keep the downloaded report private.
To publish a selected campaign, review its retained normalized report and invoke the
existing trusted history publisher explicitly with the public destination; no agent
rerun is needed. Recurring execution never invokes that publication path.

Reporting and publication install only the committed lockfile from the trusted
workflow revision, with lifecycle scripts disabled and a job-local package store.
They never resolve new dependency versions while the job has OIDC access. If
that revision has an outdated lockfile, reporting fails before accessing the
archive. Use the normal master lockfile maintenance process; do not bypass the
frozen install in the credential-bearing job.

### Public history retention

Public history remains an explicit manual operation. The optional bounded publisher
uses `<history-prefix>/bounded-v1/` when `PAPERCLIP_E2E_BOUNDED_HISTORY=true`; existing
manual history otherwise retains its original prefix. Bounded publication is limited
to the original CI workflow attempt and is not retried under the same allowance.

Before any upload, the publisher validates all outgoing bundles: at most 64 MiB
and 256 files for the immutable campaign including its manifest, 16 MiB and eight
files for mutable history, and 64 MiB for the Pages bundle. History JSON reads
are limited to 4 MiB. The active index keeps at most 64 campaigns from the last
28 days and rebuilds latest/green pointers from those records. If publication
stops, the static index can retain links that later expire.

The bucket must have versioning enabled and exact prefix lifecycle rules for
30-day current-version expiration, one-day noncurrent-version expiration without
a retained-version floor, expired delete-marker removal and one-day incomplete
multipart cleanup. The publisher rejects overlapping transitions, different
expiration policies, Object Lock and replication. Access denied is a failure,
not proof that a feature is absent. Its role needs `s3:GetBucketVersioning`,
`s3:GetLifecycleConfiguration`, `s3:GetBucketObjectLockConfiguration` and
`s3:GetReplicationConfiguration` on that bucket. Configuration is verified at
each publication; it cannot guarantee that an operator will preserve it afterward.

The publisher admits at most 280 S3 CLI commands over ten minutes, with a
30-second command timeout and automatic AWS retries disabled. Uploads use
single `PutObject` operations in STANDARD storage; immutable objects use
`If-None-Match`. A private receipt is synced before each command and retained
locally for the operator to retain privately. Unknown responses remain unknown. Source bytes, S3
commands and expiration eligibility are not invoices or exact deletion times.
Credential lookup, public downloads/CDN egress, Pages hosting and shared service
charges require separate accounting; these limits do not cap public traffic.

The launcher owns one loopback HTTP gateway per attempt. The real provider key
stays in the parent launcher. Playwright receives an ephemeral token, and fixture
setup saves that token through a shared AI connection with the existing custom
Responses/Messages routing contract. The agent does not receive ambient provider
keys. The server environment strips the gateway token and upstream credentials.

Every upstream attempt reserves its maximum estimated charge in an fsynced
journal before dispatch. Requests, retries, and cancelled calls retain distinct
IDs. Braintrust gateway requests include the reserved request ID, campaign,
execution, attempt and phase as allowlisted `paperclip_eval_*` metadata in the
SDK-compatible parent context. The private receipt saves that context before
dispatch. A live hosted probe did not retain the propagated metadata, so this
header alone does not prove lookup by request ID after a pre-header cancellation.
The returned `x-bt-span-id`, when present, identifies the Braintrust log row's
`id`; the stored `span_id` and `root_span_id` can differ. The private receipt's
historical field name `gatewaySpanId` continues to hold that returned row ID.
Direct provider routes receive no Braintrust context. Older receipts cannot
acquire a missing gateway row ID from a time or session match.
A matching logged row does not itself prove complete usage or final billing.
Unknown usage keeps the reservation held. One shared writer serializes
admission across cells, so concurrent requests cannot each spend the same remaining
allowance. Campaign deadline, request count, and in-flight count are also enforced.
Private request receipts retain transport IDs, response IDs, usage and cache TTLs,
route/cache/failover evidence, and final accounting status without request bodies
or credentials. Raw provider responses remain only in the normal private evidence.

### Disconnects and gateway shutdown

When an HTTP client disconnects, the gateway drains an already-dispatched
provider response for at most five more seconds to retain its final usage.
The original provider timeout and campaign deadline still apply; the grace
period never extends either. No additional provider request or retry is made.
An upload or identity lookup interrupted before dispatch is not sent upstream.
Gateway shutdown immediately stops admission, disconnects clients, and waits
for that same bounded drain. Repeated shutdown calls share the same completion.

A private receipt records `clientDisconnected: true` and keeps the request
outcome `cancelled`, even if a complete provider response arrives during drain.
A disconnect during receipt or ledger persistence also saves the corrected
cancellation outcome before completion.
Final usage may then replace its existing hold with an estimate under the normal
ledger rules. It does not change the product verdict or establish invoice
settlement. If no complete usage arrives, the unknown hold remains. The provider
may continue billing after an abort, so a grace timeout is not evidence of zero
cost. Drain time belongs to launcher cleanup and can add up to five seconds per
attempt; no historical receipt or hold is rewritten by this change.

## Provisional completion and later reconciliation

Recurring campaigns may finish with provisional accounting when every pending
charge has an explicit reviewed bound, all requests have stopped, no receipts
conflict, and known costs plus retained holds fit the campaign cap. Product,
cleanup, feedback, trace and ingestion requirements still apply. Reports and
Braintrust experiment metadata label accounting as `provisional`,
`receipts_complete`, `blocked`, or `unavailable`. Receipt completeness is separate
from invoice reconciliation. The original failed campaign remains failed; a
later report or policy does not change its original result.

The optional `provisionalBound` on a manifest model or operating component is:

```json
{
  "version": 1,
  "scope": "full_lifecycle",
  "evidenceSha256": "SHA256_OF_RETAINED_REVIEWED_AUDIT",
  "configurationSha256": "SHA256_OF_EXACT_REVIEWED_CONFIGURATION"
}
```

These placeholders are invalid until replaced with actual lowercase SHA-256
values. Use `costBoundConfigurationSha256` from `cost-bound-evidence.ts` for
stable key-sorted JSON hashing. The model configuration contains `provider`,
`mode` (the manifest route), `price`, `maximumInputTokens`,
`maximumOutputTokens`, and `reservation` (the nine-decimal value from
`evalRequestReservation`). An operating configuration contains allowance
`reference`, `runner`, `verifiedAt`, `expiresAt`, optional `accountingReadiness`
(only when present), and a `component` object with
its `component`, `maxUsd`, and `reference`. Changing any of those values
invalidates the approval hash. Evidence metadata itself is excluded from this
configuration hash.

An operator must retain and review the audit before configuring its hash.
Hashes bind evidence and configuration; they do not prove the audit is true.
A model audit must establish the provider's full context ceiling, all billable
token prices and tiers, standard inference, and the route's billing behavior.
The gateway enforces output limits and supported request shapes. An operating
audit must cover setup, failed attempts, build time, publication, transfer,
observability and the full retained-storage lifecycle, including uncertainty in
resource deletion and invoice arrival. It must name the enforceable resource
limits and rates that keep the whole component below `maxUsd`. A current-day
usage estimate or an arbitrary contingency amount is insufficient. A zero bound
also needs evidence. Keep raw audits private; public reports expose only counts
and the existing journal checkpoint.

The ledger retains bound evidence before model dispatch. Unexpected or missing
Braintrust route confirmation, failover, a returned model mismatch, or observed
usage above a declared limit disqualifies that request's bound. Provider usage
normalization retains a separate input/output lower bound even when missing or
contradictory cache counters prevent pricing. Malformed reported counts also
disqualify a bound. In-flight
requests, conflicts, pending charges above their bound, and campaign overruns
still block completion. Gateway cancellation before route confirmation remains
unqualified even if it retained an admission reservation. Later receipts remain
the way to resolve it.

Provisional completion never releases a reservation or manufactures a zero
charge. A missing receipt stays unknown and holds its full bound, less any
known partial amount, until a valid final receipt supersedes it. The existing
receipt importer still requires complete billing/resource windows before it
marks a receipt final. Later bills can reveal an overrun; this local journal
cannot stop external billing. Reconcile the same retained journal after its
billing windows close, regenerate its report, and inspect any overruns before
admitting more work. Existing subscription costs remain separate from the
incremental daily/weekly budgets.

Old journals and reports remain readable. They gain no bound evidence by
upgrade or by this policy; unresolved legacy charges still block. Existing
configured allowances and price cards are not automatically qualified by the
new optional field. Recurrence remains subject to its existing enable gates.

## Manifest

A manifest contains no credentials. This structural example uses fixture prices;
replace them with independently verified model prices and context limits before
running a real campaign. The launcher does not discover current prices for you.

```json
{
  "version": 1,
  "limits": {
    "campaignId": "qualification-example",
    "maxUsd": "100",
    "deadlineAt": "2026-10-20T23:00:00Z",
    "maxRequests": 200,
    "maxConcurrent": 1
  },
  "ledgerPath": "/private/path/qualification/ledger.jsonl",
  "executionIds": ["EXACT_SELECTED_EXECUTION_ID"],
  "maxAttemptsPerExecution": 2,
  "route": "direct",
  "models": [{
    "provider": "anthropic",
    "maximumInputTokens": 1000000,
    "maximumOutputTokens": 16384,
    "timeoutMs": 180000,
    "price": {
      "provider": "anthropic",
      "model": "EXACT_SELECTED_MODEL",
      "version": "verified-pricecard-date",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing",
      "inputUsdPerMillion": "2",
      "cachedReadUsdPerMillion": "0.2",
      "cacheWrite5mUsdPerMillion": "2.5",
      "cacheWrite1hUsdPerMillion": "4",
      "outputUsdPerMillion": "10"
    }
  }]
}
```

`executionIds` must equal the launcher's selected set, and the retry option must
fit `maxAttemptsPerExecution`. Use `--list` to resolve the selection first.
Operations records this attempt cap in the journal's immutable limits and fsyncs
each attempt admission before starting its gateway. The count is per execution
across the whole shared journal, including restarts, renamed output campaigns,
and attempts that fail before making any provider request. Changing the cap or
reusing an admitted attempt ID is refused.
The maximum input value is the verified provider context ceiling, **not** a
requested input cap. The gateway clamps output to `maximumOutputTokens`; it does
not tokenize or truncate prompts. The conservative reservation prices the whole
input ceiling at the highest cache-write/long-context rate, plus capped output.
A small daily budget may therefore admit Claude but refuse Codex even when the
expected charge is small. Do not reduce the context ceiling to bypass this guard.

For modern OpenAI models, specify both `cacheWrite30mUsdPerMillion` and
`cacheWrite12hUsdPerMillion`. Optional `longContext` contains `aboveInputTokens`
and a complete `rates` object with the same token-rate fields. Above that total
input threshold (including cache), the estimate uses those rates for the entire
request. Reservations use the maximum rate across both tiers. Missing cache-write
counters, ambiguous TTL splits for nonzero writes, and model mismatches remain
unknown. Older OpenAI models without these usage fields need separate qualification.
Write prices are total token prices, not surcharges. Sources:
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[OpenAI prices](https://developers.openai.com/api/docs/pricing), and
[Claude prices](https://platform.claude.com/docs/en/about-claude/pricing).

For `gpt-5.6-sol`, a response that omits the entire write-TTL breakdown can use
the actual request's documented implicit cache policy: `prompt_cache_options.ttl`
or its 30-minute default. This fallback requires a visible input, no explicit
breakpoints, no stored prompt/conversation/response references, and no compaction.
The private receipt records `cacheWriteAttribution` with the policy version and
lifetime. These amounts remain estimates. Provider splits take precedence;
partial or malformed splits are never repaired. `prompt_cache_retention: "24h"`
does not imply a 12-hour write lifetime. The gateway does not change cache policy,
and this fallback does not reprice historical requests or release old holds.

For Braintrust, use `route: "braintrust"`, add the exact `projectId` UUID, and
provide `BRAINTRUST_API_KEY` securely. Configure project providers named
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Disable default provider fallback in the
project. The request pins that endpoint and project, disables gateway response
caching, and never automatically retries or requests fallback. A cache hit,
failover header, or unexpected successful endpoint invalidates the receipt and
holds its reservation. Provider prompt caching stays enabled and is metered.
The response stream is passed through and cumulative usage is counted once.
Gateway and native tracing are separate opt-ins; see the README tracing section.

When both a bounded operations manifest and explicit Braintrust tracing are
configured, the launcher starts a separate loopback OTLP relay for each attempt.
The worker and its native providers receive an expiring ingest token. The
Braintrust service key stays in the controller, even when model requests use
Braintrust without native tracing. The relay accepts only trace/log exports to
the configured project; neither request headers nor payload parent metadata can
select another project or an API endpoint. JSON is canonicalized before export;
protobuf payloads retain their original fields after bounded validation, which
rejects ambiguous singular fields and routing values.

Each relay allows at most 2,048 admitted exports, 8 MiB per request before and
after decompression, 64 MiB of forwarded payloads, and four simultaneous exports.
The default allowance limits each attempt to 4,096 records and 16 MiB of
expanded source JSON. Historical receipts with up to 16,384 records and 256 MiB
remain readable; controller callers may still supply explicit limits up to
those maxima. This measurement includes the full decoded source plus each record in
its own envelope with the shared resource and scope fields repeated. It counts
span names, IDs, times, events, links and log bodies, not only routing attributes.
Protobuf fields use the pinned OTLP v1.9 schema; unknown fields fail admission
until the schema is updated. Existing valid payloads are forwarded unchanged.
It closes at the campaign deadline or four hours after startup, whichever comes
first. Admission consumes the allowance before upstream dispatch. Failures and
client retries do not refund it; the relay itself never retries. A durable receipt
must be written before dispatch and before acknowledging the receiver outcome.

Version 2 private `<ledgerPath>.otlp/<attempt-hash>.jsonl` receipts record policy,
admission time, wire/payload bytes, payload digest, dispatch/outcome, partial
rejection counts, record counts, expanded source bytes, and closure totals.
Version 1 receipts remain readable with unknown expanded size and record count.
They contain no payload bodies, tokens or
upstream error text. Receipt files are exclusive and cannot be reset on restart.
An admission without an outcome is unresolved. Accepted ingestion does not prove
indexing, and attempted forwarding bytes are not billed Braintrust storage.
These receipts do not replace the observability overhead reservation or invoice
reconciliation. After the worker relay closes, bounded controller finalization
uses a separate one-request, 64 KiB relay with a 30-second deadline. Its exclusive
expanded-source allowance is 1 MiB with at most 256 records. Its
receipt is `<ledgerPath>.otlp/<attempt-hash>-finalization.jsonl`. This preserves
the original trace and grade while accounting for the final controller export.
This path currently supports the admitted local cells; remote transport remains
unqualified.

Scheduled experiment creation, grade insertion and summary retrieval share a
60-second window, three-request cap, 4 MiB total payload allowance and eight-score
cap. They run serially without automatic retry. Admission is persisted before
dispatch in `<ledgerPath>.experiment-ingestion.jsonl`; uncertain responses retain
their allowance and unresolved status. Reusing that file fails instead of
resetting the budget. These limits cover the selected daily/weekly campaigns;
the standalone experiment-import command does not use this transport budget.

Private `ingestion-usage.json` binds all three receipt paths to the campaign's
admitted attempts and ledger hash. Missing, malformed, unclosed or unresolved
receipts leave the total unknown while preserving readable partial measurements.
These are admitted transport payload bytes, not Braintrust processed-data units
or an invoice. Vendor charges remain unreconciled. The current two-attempt daily
maximum is 132.125 MiB and the four-attempt weekly maximum is 260.25 MiB,
including finalization and the campaign's experiment payload allowance. These
bounds do not include other projects, standalone imports or retained storage.
The corresponding default expanded-source ceilings are 34 MiB daily and 68 MiB
weekly before the separate 4-MiB experiment allowance. These source measurements
support a priced forecast; they are not Braintrust's processed-data meter or a
vendor-enforced dollar limit. Gateway auto-logging is a separate input to that
forecast. Retain vendor usage reports for reconciliation rather than equating
transport or expanded source bytes with an invoice.

## Recurring campaigns

The existing `runner-full-stack-e2e.yml` owns both schedules: daily at 08:47 UTC
and weekly on Sunday at 09:47 UTC. Scheduled runs require both
`RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED=true` and
`RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED=true`. Leave the operations gate unset
until the workflow, billing coverage and infrastructure allowance are qualified.
There is no separate scheduler. The protected `runner-e2e-private-paid` environment needs
`BRAINTRUST_API_KEY`; repository variable `RUNNER_E2E_BRAINTRUST_PROJECT_ID` names
the exact project UUID. The key is available only to the bounded execution and
finalization step, after dependency installation and immutable builds.

Native Claude gateway cases also require the pinned Claude CLI for the managed
account's setup hello probe. The agent still runs through the pinned ACP runtime.
The workflow installs and checks the CLI before providing credentials for both
native and legacy Claude selections, including the aggregate scheduled selection.
For a local campaign, verify that same CLI prerequisite before starting a paid
attempt. Installing the ACP package alone does not satisfy this setup path.

Bounded cases keep the gateway in the setup phase until the created agent's
asynchronous lifecycle verification reaches ready. This wait uses the remaining
attempt deadline, allows at most 45 seconds locally and the bounded attempt window
for Daytona provisioning, and stops on an observed setup error
or hold. The private `budgeted-setup.json` snapshot retains state transitions.
Budgeted Daytona fixtures give the saved-account hello probe five minutes inside
that attempt window; its former 90-second default could expire during cold startup.
Only then does the case begin agent-phase accounting and create its task.
Older evidence that advanced after fixture creation may label hello probes as
agent cost. Its campaign totals still include those requests; retain that phase
limitation when comparing setup and task spending.

Attempt wall time includes setup and teardown. Agent time is the sum of captured
heartbeat-run windows, which can overlap. Missing runtime evidence, no captured
runs or an invalid run timestamp leaves agent time unknown; the report never substitutes attempt
wall time. A campaign total stays unknown if one of its retained attempts lacks
that measurement. A measured zero remains zero. Missing or invalid Daytona lease
windows likewise leave lease time and its runtime estimate unknown. Local attempts
do not contribute Daytona lease time. Existing published numeric measurements are
retained as historical evidence; this change does not reconstruct their provenance.

Bounded daily/weekly campaigns require a public repository and use the existing
standard `ubuntu-latest` runner for both compilation and execution. They do not
follow the manual campaign's AWS runner switch. GitHub charges no standard
hosted compute minutes for public repositories; retain runner/job evidence and
recheck the [billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
when reviewing the allowance. This does not establish zero artifact, cache,
external history, observability or subscription cost. Manual selections keep
the existing AWS/GitHub runner choice.

Daily selects native Claude's marker and feedback-persistence cases with a shared
$20 allowance. Weekly adds native Codex's two corresponding cases with a
shared $100 allowance. Daily campaigns admit at most 30 model requests; weekly
campaigns admit at most 60. The October 23 qualification campaigns used 10 model
requests each. The largest observed native attempt exported 6,531,801 expanded
source bytes and 2,455 records. The defaults retain headroom for those measured
cases; exhausting a limit remains visible and never silently drops required
evidence. Model requests and declared operating overhead share
this limit. Each campaign runs sequentially in one job with one
journal, one attempt per execution, zero automatic retries, a 30-minute request
deadline and a finite request count. Codex's worst-case request reservation exceeds
$20, so it is absent from daily selection. Its context ceiling is unchanged.
The $20/$100 limits cover additional costs caused by each run. Show the existing
Braintrust Pro subscription separately at $249/month (operator policy confirmed
October 21, 2026); do not allocate it into these run limits. New processing,
scoring, retention or capacity charges still count toward the run allowance.
The monthly run allowance is at most $1,120 (31 daily plus five weekly runs),
or $1,369 including the separately reported existing subscription. These are
maximum allowances, not forecasts of actual spending.
This is an admission limit with retained reservations, not a reconciled invoice
total or a provider-enforced billing limit.

Before enabling recurrence, set `RUNNER_E2E_OPERATING_OVERHEAD_JSON` to an object
with `daily` and `weekly` reviewed allowances. The catalog selects the allowance
for the actual trigger, then passes only that validated allowance to preparation.
A missing selected cadence or unknown outer field fails admission. A single
allowance remains supported when the same bounds fit both schedules. Each
allowance has `version: 1`, an evidence `reference`, the actual `runner`
(`github-hosted` for bounded schedules), and `verifiedAt`/`expiresAt` timestamps no more
than 31 days apart. Its `components` array must contain exactly `ci_compute`,
`artifact_storage`, `observability`, and `shared_subscription`. Each component
needs a USD-string `maxUsd` and its own evidence `reference`. References are
stable audit IDs or paths, not credentials or arbitrary prose. No default
amounts are supplied. The supporting audit must include rates, resource/time
bounds, included allowances, allocation denominators, and the controls that
keep actual resource use within those bounds. Zero requires evidence of an
included or zero incremental charge; setting a zero allowance is not a receipt.
Under the current policy, `shared_subscription` may reserve zero for the
existing Braintrust subscription with a reference to that policy and current
plan evidence. Any newly incurred subscription or capacity charge needs its own
incremental allocation; the existing fee must remain visible separately.

Unscheduled local controllers use `runner: "local"` to retain their actual
execution origin. The same component, cap, expiry and receipt rules apply. This
label supplies no default zero charge and releases no reservation. Scheduled
allowances still require `github-hosted`; a local allowance fails that gate. The
separate hosted Runner controller enforces the same origin when admitting work.
Historical manifest reads preserve their original label; they grant no new admission.

The catalog checks that this allowance matches the selected runner, covers at
least the next four hours, and leaves room for a full conservative model-request
reservation. This happens before the build and test runners start. The workflow passes
the exact validated allowance to preparation; it does not read a potentially
changed repository variable again. Preparation rechecks it and retains it in the
manifest and forecast. Setup, builds, failed jobs, publication and retained
artifacts must all fit the declared components, not just the agent's runtime.

The journal initializes `overhead:<component>` reservations under
`campaign-overhead` from its immutable limits before admitting model requests.
These are allocation holds, not dispatched requests or completed resource
lifecycles. They do not occupy model concurrency, but they count toward the
finite charge-record limit. Resuming cannot change or drop them. Until matched
cost observations arrive, the report shows them as unknown and keeps their
allowance held; even a zero allowance does not claim a known zero charge.
The finalizer permits provisional completion only when each pending charge has
explicit reviewed bound evidence as described below. Missing or unqualified
bounds remain incomplete accounting; a reservation alone does not qualify.

Reconcile a component through its existing request ID with provenance-bound
`infrastructure` or `invoice` observations. Partial observations keep the
remaining reservation held; a final nonconflicting observation can replace it.
Never mark a receipt final before its resource and billing window are complete.
An external bill above the allowance remains visible and stops further model
admission. The journal cannot stop AWS, storage or subscription billing itself;
provider resource limits and a verified receipt collector remain activation
requirements. No operating-cost allowance has been configured or qualified by
the presence of this code.

Collect retained GitHub usage after the workflow completes, including failed or
cancelled workflows, without dispatching or retrying anything:

```sh
node --import tsx tests/runner-e2e/operating-receipts.ts github RUN_ID /private/path/github-usage.json
```

The collector uses the existing `gh` authentication and only reads
`paperclipai/paperclip`. It verifies the Product E2E workflow, first attempt,
revision and repository, reads every returned job/artifact page up to 1,000
records per inventory, and rejects changed or incomplete inventories. It retains
job identities, summed job seconds, run-start delay, artifact sizes and expiration
dates. Skipped jobs with a null or zero runner ID count as not started and use
zero VM time. Started jobs still require a numeric runner identity. It omits
arbitrary job names, artifact names and upstream responses.
Existing output files cannot be replaced. This is a current inventory, not an
invoice: deleted artifacts are absent, compressed bytes are not billed
byte-hours, job duration is not VM lifetime, and present repository visibility
does not establish visibility throughout an earlier run. Caches and external
S3 history remain separate. A visible public-hosted zero compute rate never
automatically releases an overhead reservation.

Import a reviewed cost receipt and its exact source evidence into an existing
campaign's declared overhead reservation:

```sh
node --import tsx tests/runner-e2e/operating-receipts.ts import /private/path/ledger.jsonl /private/path/receipt.json /private/path/source-evidence.json
```

The receipt contains `version: 2`, `costBasis: "component_cumulative"`,
`campaignId`, `allowanceReference`, `component`,
the source file's `evidenceSha256`, `windowStartedAt`, `windowEndedAt`, `coverage`
(`partial` or `complete`), `source` (`infrastructure` or `invoice`), `provider`,
`classification`, and an explicit USD-string `costUsd` when known. Estimated and
allocated charges also require a stable `pricingVersion`. `reconciled` requires
an invoice source. An unknown amount has no `costUsd` and always remains partial.
The observation window must have ended; completeness is the reviewer's assertion
that this component's entire resource and billing window is represented. A
checksum proves which file was used, not that the invoice or allocation is true.
Shared allocations must record their numerator, denominator, window and excluded
costs in that source file. Do not import a whole shared invoice as one campaign's
charge without an explicit allocation method.

Each amount is the cumulative total for the entire component, including all its
providers and separate charges through `windowEndedAt`. Later receipts must keep
the same `windowStartedAt` and cannot shorten the window or make completed
coverage partial again. Combine separate billing windows in the retained source
evidence before importing their total; two separate $0.80 charges require a
cumulative $1.60 receipt. Version 1 receipts lacked this declaration and are
rejected on import. Existing journal records are preserved; the importer also
refuses to extend a component whose prior receipts lack cumulative evidence.
It also checks the ledger's precedence rules before import: a larger cumulative
estimate cannot be hidden by an earlier, smaller invoice. Such imports fail
without changing retained evidence or the journal; reconcile the entire expanded
window with evidence the ledger can account for before retrying.

The importer validates campaign/allowance identity and source hash, retains both
files privately under `ledger.jsonl.overhead/`, and syncs them before appending
the observation. Files are written and synced under unique temporary names, then
published atomically without replacing existing evidence. A partial write is
removed without occupying the final path, so retry needs no manual repair.
Retries sync matching existing files too. Reimporting an identical
receipt adds no journal entry. A partial amount
keeps the rest of the allowance held. Complete invoices can supersede estimates;
conflicting complete invoices remain visible and block admission. This command
does not open a new spending window, change limits, dispatch tests or rewrite
previous records. Regenerate the campaign report from the same ledger afterward;
an old report snapshot is not rewritten by an offline receipt import.

### Compare retained Anthropic billing exports

Use the read-only comparison command to repeat a provider-window comparison
without dispatching a test or changing the cost journal:

```sh
node --import ./server/node_modules/tsx/dist/esm/index.mjs tests/runner-e2e/anthropic-billing-comparison.ts /private/path/comparison-config.json /private/path/new-comparison.json
```

The private configuration has this shape. `apiKeyLabel` is the label in the CSV,
not an API credential. Copy `sourceDataAsOf` from the provider's reporting view.
Use absolute input paths and retain the original exported CSV bytes.

```json
{
  "version": 1,
  "manifest": "/private/path/manifest.json",
  "ledger": "/private/path/ledger.jsonl",
  "usageExport": "/private/path/claude-usage.csv",
  "costExport": "/private/path/claude-cost.csv",
  "workspace": "Dedicated eval workspace",
  "apiKeyLabel": "dedicated-eval-key",
  "date": "2026-10-23",
  "sourceDataAsOf": "2026-10-23T18:07:00Z"
}
```

The first supported export shape is one Claude Sonnet 5 campaign, one workspace
and key label, standard global inference, and context buckets at or below 200k.
Usage rows are hourly; cost rows are daily. Both must cover the selected UTC
date, and every selected journal request must have finished inside that day and
before the source timestamp. The command rejects mixed scopes, duplicate rows,
unsupported pricing dimensions, conflicting observations and damaged journals.
A provider export may still be delayed after these checks pass. Matching scope
labels do not establish exclusive use of a key or completeness of its export.

The output records source hashes, the journal checkpoint, the reporting window,
its provisional status, provider tokens priced with the retained manifest,
rounded provider charges, and the retained request subtotal. Complete and
partial token receipts remain distinct from dollar-cost completeness. Each known
token category counts once per request even when the cost or other token fields
are unknown. Missing-field counts remain explicit. Final token evidence takes
precedence over partial evidence; equally strong contradictory values fail. Canceled requests without a
returned model identity remain explicitly unconfirmed. The token and estimated
USD differences can be positive or negative; neither is assigned to a request.
Non-model charges are shown separately. The report does not add the provider
total to the ledger subtotal or interpret rounded zero charges as free usage.

The command creates a new mode-0600 output and refuses to replace an existing
file. It makes no network or provider call, does not import receipts, and leaves
all reservations and historical evidence intact. A comparison is supporting
evidence for reconciliation, not a settled invoice or an admission override.
Keep the config, raw exports and comparison private; they are not public report
projections. Other providers and export shapes still require their own reviewed
comparison path.

The checked pricecard expires on November 19, 2026. Admission stops when the
pricecard expires, the catalog model changes, the project is missing, or the
preflight already exists. Review current official prices and context limits
before updating `scheduled-prices.json`. `forecast.json` records the selected
IDs, provenance-linked pilot measurements, compatibility gaps, uncertainty,
reservations and price expiry. The historical daily/weekly successful model
subtotals are $0.428650100/$0.793676500; they are not campaign bills. Setup model
calls and attempt setup/teardown are included, while CI setup/build/queue and
non-model charges are excluded. Current compatible totals stay unknown if any
selected cell lacks a matching measurement. The historical hosted daily selection took 107.286 summed attempt seconds.
The weekly Codex samples ran locally; a complete hosted weekly total remains
unknown. Measurement hosts form separate cohorts. The original hosted workflow
failed during report dependency setup after both worker cases passed.
Per-cell medians describe only the retained samples; P95 requires at least 20
matching samples and does not establish reliability. See
[measurement provenance and limitations](OPERATIONS-COVERAGE.md#initial-cadence).
Daily coverage is limited to the two Claude journeys. The feedback definition
has changed since its passing pilot. Broader rotation and Daytona remain
unqualified and are not silently included by `--all`.

Dispatch `cadence: daily` or `weekly` from the default branch to qualify the same
path manually. Bounded dispatch rejects custom target revisions and selectors.
Bounded authorization pins the commit from the workflow event; a later merge
does not replace that revision or invalidate a queued campaign.
Workflow attempts after the first cannot start paid work with a fresh journal.
Rerunning reporting can reuse the original attempt-one evidence. Recover the
retained ledger for a deliberately resumed campaign; do not reset it or launch a
new campaign merely to hide a failure. The existing `manual` mode remains an
explicit, unbounded qualification path and does not inherit these allowances.

After execution, deterministic review dismisses only exact synthetic feedback
bodies corroborated by all feedback-persistence graders. Novel feedback remains
`needs_investigation`; no extra model call is made. Missing accounting, unbounded
pending charges, conflicts, spending overruns, feedback collection/submission failures, novel feedback, export failure
and incomplete experiment import or indexing fail the job with bounded diagnostic codes.
Successful unchanged runs produce artifacts without posting messages. GitHub's
workflow failure notifications remain the operator's notification channel.
Missing/non-starting schedules require an external workflow monitor; this change
does not claim that a workflow can detect its own failure to start.

The launcher starts the public Playwright JavaScript entry point directly with
Node and sends SIGINT for cancellation and watchdog cleanup. The package-manager
wrapper can exit before Playwright completes its shutdown, so it is excluded.
Playwright handles that signal by stopping workers and closing its web server;
SIGTERM can exit before web-server cleanup. The web-server supervisor still
receives SIGTERM and owns its server's shutdown. Both paths retain the existing
bounded grace period and forced cleanup for surviving owned processes.
When a worker exits without a result, the launcher also recovers its original
trace identity from the private fixture snapshots. The supervisor can finalize
that trace with the failed outcome. A mismatched project, execution or company
is rejected. Recovered identity does not prove native export or complete phases.

If a worker exits before writing its result, the server supervisor spends at
most five seconds collecting feedback from that attempt's saved company before
stopping the isolated server. Recovery snapshots remain private and are kept
separate from the worker's original evidence. The failed result includes any
recovered counts and review fingerprints; active runs or missing reads remain
partial or unavailable. Each atomic recovery checkpoint carries its attempt
identity, so a later write timeout cannot hide already saved feedback when the
final receipt is absent. Completed results are never replaced. The launcher
retains the private database whenever a worker result is missing, including when
the supervisor was killed before it could capture feedback. This retention is
reported as unconfirmed cleanup and requires inspecting the retained state.
Authenticated public-MCP fixtures do not use the local operator recovery path.

Original grades are imported into Braintrust without rerunning agents. The
access-controlled artifact includes the journal, forecast, feedback dispositions,
experiment receipt, indexing receipt and findings. The trusted report job rebuilds the dashboard
and retains its evidence-bound experiment link. Export acceptance and native
indexing are separate. A bounded, read-only Braintrust query verifies the attempt
root, finalization, native API activity and any expected feedback tools. It also
compares indexed experiment rows with original grades, revisions and attempt IDs.
The verifier tries at most three rounds within 45 seconds, retains missing/query
failures, and never reruns an agent. Native record counts measure export volume,
not distinct provider requests or charges. Codex exports can be high volume and
Braintrust can double-count native/log observations; use the deduplicated gateway
ledger as the estimate authority. Private indexing receipts contain only counts,
identities and verification status, without trace contents or credentials.

Scheduled finalization separately verifies every non-infrastructure request in
the campaign journal against its private gateway receipt. It queries Braintrust
by row `id`, checks the expected provider and model, and retains the actual span
and trace IDs in `gateway-indexing-receipt.json`. Setup, failed and canceled
requests remain in the denominator. Missing receipts, missing row IDs, duplicate
row attribution, conflicting records and query errors fail the gateway coverage
gate. A receipt or journal change during inspection also prevents verification.
The file reports whether campaign metadata was retained, independently of the
receipt-to-row match. It contains no prompts, responses or credentials.

Each lookup batches at most 100 rows, makes at most three rounds, and has a
45-second deadline. It performs no inference, writes no vendor records, changes
no journal amounts and releases no holds. The findings include
`gatewayIndexVerification`; a missing match is `gateway_indexing_incomplete`.
This verifies stored identity and coverage, not provider billing or automatic
nesting of gateway spans under native attempt traces. Those remain separate
qualification requirements.

## Inspection and limits

Retained deterministic grades can be imported into a private Braintrust experiment
without invoking agents or judges. Prepare a JSON array of absolute paths to the
original `result.json` for **every** retained attempt in `normalized-results.json`.
The original files supply each attempt's actual source and definition hash;
the selected result's revision must not be assigned to older attempts.

```sh
PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID=PROJECT_UUID \
node cli/node_modules/tsx/dist/cli.mjs tests/runner-e2e/braintrust-experiment-import.ts \
  /private/campaign/normalized-results.json /private/campaign/original-result-paths.json \
  /private/campaign/experiment-plan.json --dry-run
```

Inspect the plan. To import it, provide `BRAINTRUST_API_KEY` securely, remove
`--dry-run`, and use a separate `experiment-receipt.json` output path. The importer
requires explicit accounting identities and source/definition hashes; older
incomplete provenance fails closed. It retains original failed and successful
grades, cleanup outcomes, feedback counts, source revisions and trace identities.
Carried-forward CI attempts retain their original campaign IDs and must match
the report's retained receipts. Request costs attach only when the attempt's
campaign also matches the journal's campaign, even if attempt IDs coincide.
It does not upload prompts, feedback bodies, matcher details or raw errors.

The evidence digest determines the private experiment name. Identical evidence
reuses that experiment and stable row IDs after an interrupted insert. Changed
evidence creates a different experiment and requires a separate receipt path.
The importer validates an existing receipt before retrying and never lowers its
confirmed accepted-row count. The receipt checkpoints accepted batches;
HTTP acceptance still requires independent indexing/UI verification. Retain failed
receipts. A retry must use the same original evidence, not newly run agents.
Set `PAPERCLIP_E2E_BRAINTRUST_EXPERIMENT` to the receipt path when rebuilding the
campaign report to retain the experiment link. Its evidence hash must match the
report's selected source/definition identities, attempts, request-ledger checkpoint
and feedback review. Refreshing only
the report rendering preserves the link; changed evidence requires a new import.

Request-ledger amounts remain metadata with their journal hash and classifications.
They are not additive cost metrics, and missing rows remain unknown rather than
zero. The campaign ledger may include setup probes outside the imported tests.
Do not add experiment metadata amounts to native or gateway trace costs. Native
trace rollups are not invoice reconciliation and can omit setup or duplicate logs.
API contracts: [create experiment](https://www.braintrust.dev/docs/api-reference/experiments/create-experiment)
and [insert retained events](https://www.braintrust.dev/docs/api-reference/experiments/insert-experiment-events).

- `operations-preflight.json` preserves the exact manifest in the campaign folder.
- `ledger.jsonl` is the append-only authority for request admission and observations.
- `ledger.jsonl.requests/` contains private per-request checkpoints.
- `ledger.jsonl.summary.json` preserves known, reserved/held, conflicting, and
  unknown amounts on normal finalization, including failed campaign workers.
- `campaign.json` and the dashboard preserve retained attempts and show missing
  selected results after worker failure. Their request-ledger section shows the
  shared ledger's known subtotal, classifications, additional held reservations,
  unresolved requests and per-attempt totals. It can include earlier campaigns
  sharing that budget. It is a separate view of model spending: do not add it to
  heartbeat totals. The journal hash and record count identify the checkpoint.
- If the journal cannot be read or validated, the report records accounting as
  unavailable with no numeric totals. Retained results and reports are still
  written, and the launcher/report command exits unsuccessfully. Recover the
  original journal before resuming paid work; reporting does not repair or reset it.
- To regenerate a merged report with the same ledger, pass
  `PAPERCLIP_E2E_OPERATIONS_LEDGER=/absolute/ledger.jsonl` to `report.ts`.
  Dashboard refresh and public publication preserve and validate its closed
  numeric projection. Raw request receipts and the journal remain private.

All model amounts from usage times a pricecard are **estimated**, not billed or
reconciled. This path does not yet price CI compute, storage, subscriptions,
Daytona, separate judges, or gateway overhead. Unknown observations and these
coverage gaps must be included in operational reporting. Provider billing can
lag and discounts can differ; a local list-price cap is not a provider-side cap.

Resuming the same journal requires exactly the original limits. A dead process
can leave a lock and held reservations; inspect the owner and upstream receipts
before recovering it. Never delete a live writer's lock or reset a ledger merely
to regain budget. Older journals without an attempt cap remain readable for
reporting and reconciliation. Operations refuses an implicit upgrade because request receipts cannot reconstruct
zero-request attempts. Use the explicit audited migration below only after
reviewing all retained campaign attempts. Do not replace or reset an active pilot
ledger to evade this check.

No recurring schedule is enabled by this integration. Qualification of actual
agent streams, tools, continuation, cancellation, native traces, and remote routes
is required before treating those routes as operationally proven. Forecasts,
provider reconciliation, and the campaign feedback disposition workflow are
separate remaining integration work.

### Setup and agent request attribution

Each admitted attempt creates a private phase checkpoint under
`<ledgerPath>.attempts/`. The launcher passes its path only to the test worker;
the Paperclip server does not inherit it. Before fixture setup finishes,
requests are recorded as `setup`, including connection checks and hello probes.
The worker atomically advances the checkpoint to `agent` immediately after
fixture creation and before task execution. Cleanup does not reset this phase,
so late agent requests retain their task attribution.

The gateway reads and validates the checkpoint for each request before reserving
spend. That admission fixes the request's phase even if the phase changes while
its response streams. Missing, malformed, or foreign-attempt checkpoints stop
new dispatches rather than guessing a phase. Request records remain in the
fsynced journal after the worker exits. This boundary applies to the admitted
local core cells; it does not establish coverage for separate judges, paid tools,
child-agent attribution, or remote routes. Historical journals retain their
original attribution and are not retroactively rewritten.

### Auditing a legacy journal before adding an attempt cap

A journal created before durable attempt admission can acquire one attempt policy
through `ledger-attempt-policy.ts`. Stop its launcher and gateway first. Review
all retained campaigns, including startup failures with no model request. Save
the review and its source references as a private evidence file. Each prior
attempt needs its original execution and accounting attempt ID; request receipts
alone are insufficient. If that history is incomplete, do not resume paid work.

Create a private JSON audit with these fields:

- `version`: `1`.
- `ledgerPath` and `evidencePath`: absolute private file paths.
- `previousJournalHash`: the current journal's final record hash.
- `evidenceSha256`: SHA-256 of the reviewed evidence file.
- `maxAttemptsPerExecution`: the finite cap to adopt, including past attempts.
- `priorAttempts`: an array of `{ "executionId": "...", "attemptId": "..." }`.

Run `node cli/node_modules/tsx/dist/cli.mjs tests/runner-e2e/ledger-attempt-policy.ts /absolute/private-audit.json`.
The command checks evidence and journal hashes, takes the normal exclusive writer
lock, and appends one fsynced policy record. It refuses unfinished requests,
omitted recorded request identities, duplicate attempts, or an existing attempt
policy. The imported count can already exceed the cap; then no new attempt is
admitted for that execution. The command cannot prove the completeness of the
operator's review of zero-request attempts. Retain the evidence for inspection.

All original journal bytes, request counts, charges, held reservations, campaign
identity, dollar limit, concurrency limit and deadline remain intact. Subsequent
launch manifests must use the adopted cap. The migration cannot extend an expired
deadline, change an existing cap, or replenish an allowance. An interrupted append
remains an accounting failure and must be recovered before more paid work.

The explicit `feedback-persistence` native Claude/Codex cells on local and Daytona
execution also accept an operations manifest. Remote cells require the Cloudflare
gateway declaration and immutable image. They use the same metered connection, prices, campaign
journal, setup boundary, and durable attempt allowance as core compatibility.
Collection and the independent saved-evidence oracle require no additional
model call. The synthetic items need review as test data, not product incidents.


### Qualify model spend while operating reconciliation is pending

Set `accountingReadiness: "model_requests"` on the reviewed allowance to use
complete model receipts as the scheduled readiness gate. This is an explicit
operator policy. The report retains the full-accounting status, operating
reservations and model-readiness status separately. It does not release any
historical hold or certify a full-lifecycle vendor cost bound. Missing model
receipts, conflicts, active requests, excess commitments, and the existing
product, cleanup, feedback and trace checks still fail qualification.


### Explicit bounded Daytona gateway qualification

A manual manifest can set `remoteGateway: "cloudflare"` for the native Codex
or Claude marker/feedback Daytona cells. Install `cloudflared` on the controller
PATH, or set `PAPERCLIP_EVAL_CLOUDFLARED` to its executable path. Empty overrides
use the PATH default. The parent starts its existing model
gateway and native OTLP relay, then exposes only their authenticated endpoints
through one owned HTTPS quick tunnel. It verifies a fresh health nonce before
fixture setup, waits up to 120 seconds for registration and 120 seconds for
public readiness, and does not retry tunnel creation or provider work.

Only attempt-scoped tokens leave the controller. Provider and Braintrust keys
stay in the parent; the fixture/server retains the existing Daytona provisioning
credential separately. The model gateway still enforces its campaign allowance,
request count, concurrency, deadline and receipt journal. The bridge streams
responses and preserves terminal-usage draining after a client disconnect.
The tunnel receives no ambient provider credentials or Cloudflare config. Its
exposure closes at the campaign deadline or four hours after startup, whichever
comes first, and on attempt cleanup. Owned gateway,
relay and tunnel cleanup failures remain failures. A configured remote route
is not live acceptance; retain the actual Daytona result, cleanup, feedback,
native traces and complete model receipts.

The Daytona image runs Linux/x64. ARM or macOS controllers use the image's
verified daemon by default; only an explicit cross-compiled remote override
replaces it.

Daily and weekly selections remain local. This explicit remote option adds no
scheduled coverage or public report publication.

The worker generates the attempt's trace parent. The relay validates the project
in both the header and payload, but does not pin that worker-generated parent.
Treat the attempt OTLP token as authority to submit trace attribution within
this eval project. Keep it limited to the trusted harness/provider runtime;
never expose it to test prompts or unrelated clients. The project check is not
an attempt-isolation guarantee. Indexing verification is a separate retained
or scheduled check; the manual launcher alone does not perform it.

### Hosted report dependencies

The trusted report job applies a reviewed `report-lock.patch` before its frozen
install. `report-lock.json` pins the input lock, patch and resulting lock hashes.
This updates existing patch identities and the already declared yaml dependency
without registry resolution. The worker target and its lock artifact never
control report dependencies. An already-reviewed output lock is used unchanged. An unknown committed lock fails before install;
update and review this correction when dependency inputs change. The original
failed run remains failed when retained evidence gets a new presentation.

The trusted authorization job checks this correction before catalog/build and
paid work. Unknown dependency locks fail before model admission. Manual history
publication applies the same correction before its frozen install. Qualification
image builds apply it only when target and workflow revisions match; a different
target keeps its own lock and does not require these reporting helper files.
