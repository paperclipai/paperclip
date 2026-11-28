# Chat feature evals

`chat-features` promotes executable entries from the [scenario catalog](chat-scenarios/README.md)
into real Product E2E executions. The two original task journeys remain intact.
Additional domain cases use `chat-catalog-contract.ts` and the explicit registry;
listing a cell or calibrating its oracle is not live acceptance. The complete
244-scenario denominator and unchanged requests are frozen in
`chat-campaign-manifest.json`. Its raw-file/defaults inventory hash is
`9dc9cf6a5426cf1b56bc30a3571851f233f9dd5e93a1292eaee414d33b52df77`.

Domain cases own production API setup, explicit user followups, observations,
case-specific grading and optional cleanup. The shared driver submits the exact
catalog query, saves prerequisite state before action, records real API comments,
run attribution and rendered links, and rechecks after browser reload. Every case
declares run/time limits and an oracle version. Missing checks and contradictory
grades fail. Known `coverageGaps` make a diagnostic case fail acceptance until its
conditions are implemented; they are not blocked cases reported as passing.

The registry contains only executable setups/actions/oracles. Scenarios absent
from it remain in the denominator as unimplemented; optional external services
must be real or explicitly labeled simulations. The frozen campaign ledger owns
implementation readiness and all attempts separately from catalog discovery.
No model judge supplies a generic pass.

Discovery reads pure `chat-catalog-descriptors.json` metadata and does not import
any domain. The runtime loads the selected area's module and rejects descriptor
bounds/oracle/policy drift. `chat-catalog-fingerprint.ts` compiles imports to find
real local dependencies, including transitive helpers and the selected domain,
and binds the normalized execution, exact scenario/defaults, package versions and
lockfile. Whole source revision and global suite hash remain separate provenance.
The six reviewed dynamic resolutions are pinned to their callsite source hashes;
source drift falls back to conservative source coverage. Installed or external
journey overrides refuse the reviewed local-chat lane. No global loader hook is
installed. This permits unchanged cases to retain a measurement when an unrelated,
unloaded domain changes; a changed executable dependency invalidates that case.

Standard funding/readiness and successful native runs are defaults. A scenario
that preserves a special funding or paused state declares a setup policy and
must independently verify its named prerequisites before the query. Declared
terminal counts distinguish cancellation and denial from successful execution.
Creation-only journeys may explicitly allow bounded separate worker execution
while requiring a settled source and their own exact task/assignee oracle.
Authenticated identity cases select the existing human-session fixture path;
private secondary-user credentials join the attempt's redaction sink. Scenarios
whose stated context has no working chat require a genuine boundary journey;
these cannot receive a native chat pass from seeing an onboarding or login gate.

Catalog lanes that already use the original native case clock use that same
deadline for the prerequisite worker's readiness. The separate 45-second cap
cannot cut short a normal 60-second local OpenCode hello probe or its owned
verification recovery. Manual configuration repair and stopped lifecycle states
still fail setup. Other lanes keep their authored readiness cap. Each worker's
scoped state transitions and recovery flags are retained without provider output.
The helper consumes the public lifecycle state and fixed automatic-recovery or
verification-paused diagnostic; private lifecycle operation fields are not exposed.
Tests pass actual lifecycle diagnostics through the agent response normalizer;
the case budget and native execution limits do not increase.


| Scenario | Actual user request | Independent outcome |
| --- | --- | --- |
| `tasks.create-backlog` | Add a task for Morgan to draft the launch announcement in Launch, but don't start it yet. | Exactly one task, Launch project, Morgan assignee, backlog at creation, no worker execution, usable chat link after reload. |
| `tasks.delegate-announcement` | Have Morgan write a two-sentence launch announcement using the Launch project brief, save it on the task, and send me the result here when it's finished. | Exactly one task, actual Morgan execution, current worker-authored document grounded in the project brief, task Done, automatic completion response in the original chat, usable result after reload. |

The queries are read directly from `chat-scenarios/tasks.yaml`. Context and
expected outcomes stay evaluator-side. The fixture creates a disposable company,
CEO, Morgan and Launch project through production APIs; both agents use the
shipped role instructions. The brief contains a product, date and random invitation
code absent from the user query. The browser sends one message through Agent Chat.
The harness never creates the result task, writes the announcement, completes the
task, or sends a hidden follow-up.

## Run the first slice

Follow the installation steps in [README.md](README.md#local-commands). The Codex
subscription profile uses the catalog's recorded default model and an
explicit `CODEX_AUTH_JSON` login. Load that login privately into the launcher
environment; do not print it or save it in tracked configuration. The existing
subscription fixture stages only `auth.json` in the disposable company login slot
and removes it with the isolated instance.

The local native OpenCode profile uses the current production-qualified model
and `OPENROUTER_API_KEY` through the existing encrypted company-secret fixture.
Each of the two journeys has a cell for each original profile. These four cells
remain unchanged; the TestOps profile below adds one separately named backlog cell.

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list --suite chat-features
pnpm test:e2e:runner -- --id chat-features.runner-codex-subscription.local.create-backlog --max-automatic-retries 0
pnpm test:e2e:runner -- --id chat-features.runner-codex-subscription.local.delegate-announcement --max-automatic-retries 0
pnpm test:e2e:runner -- --id chat-features.runner-opencode.local.delegate-announcement --max-automatic-retries 0
```

Run creation first and inspect its packaged report before delegation. For the historical first-slice repeatability probe, each cell used three fresh fixtures on the same definition revision. The full-catalog campaign instead allows one initial attempt and one documented fix-and-rerun per failing scenario, with automatic retries disabled. Keep every attempt, including failures; a retry does not erase one. A
fixture or product correction starts a new three-sample measurement. Both cells
are explicit-only and excluded from `--all`; this does not implement or qualify
the rest of the YAML inventory.

## OpenCode TestOps integration acceptance

The additional explicit cell
`chat-features.runner-opencode-deepseek-1017.local.create-backlog` runs the same backlog
query, public fixture and saved-state oracle on native OpenCode with
`openrouter/deepseek/deepseek-v4.1-flash-1017`. It requires only the selected
`OPENROUTER_API_KEY` profile credential. The launcher stores an encrypted secret
reference for the disposable agents; no key belongs in catalog data or chat.
This selected model is a qualification candidate. Other OpenCode suites keep
their existing model, and delegation is not registered for this profile.

```sh
pnpm test:e2e:runner -- --id chat-features.runner-opencode-deepseek-1017.local.create-backlog --max-automatic-retries 0
```

Use a separately named TestOps integration-acceptance plan and launch for this
single cell. It retains one human request, one accounted controller work run,
120-second turns, a seven-minute attempt, the five-minute stable-state bound
and zero automatic retries. Morgan is created as fixture context but must not
execute the saved backlog task. Existing setup probes and unknown usage remain
reported separately. The original 244-scenario campaign, failed attempts and
Codex measurements are not reset or regraded by this measurement.

The existing normalized result, JUnit and packaged report carry the outcome to
the execution integration. Catalog selection and provider-free oracle checks
do not establish an AWS model pass or a successful TestOps upload. Accept this
integration only after the real AWS execution and its TestOps result agree.

## Bounds and grading

Creation expects one accounted native work run; delegation expects three (CEO
handoff, Morgan work, CEO completion response). Runs have a 120-second timeout
and attempts a seven-minute deadline. The visible task and completion reply must
settle within five minutes after the human request, including a five-second stable
observation. This is an independent journey acceptance bound: three runs may not
each consume their maximum timeout and still pass. The outer attempt also covers
fixture setup, reload and link checks, and evidence collection. A failed provider
run rejects immediately; the historical missing turn-start event was not a
five-minute poll timeout. Automatic retries are disabled. Company
and agent budgets are 500 cents each, CEO daily work runs are capped at three,
Morgan at one, and periodic heartbeats are disabled. Initial production hello
probes fall outside heartbeat usage and budget accounting; detailed setup tokens
and cost are unavailable. These limits are not an absolute inference or cash cap.
Subscription cost coverage must remain explicit in the report.

An obsolete CEO assignment can leave a cancelled queue entry when the CEO creates
a task and then assigns it to Morgan. Grader v2 distinguishes that entry from
provider work only when the dispatch gate records `issue_assignee_changed`, an
explicitly null start time, no native issue, and its unchanged stale-queue stop
receipt. The entry must belong to this company and the one task now assigned to
Morgan. It stays in the full observation and final ledger, with its events and an
explicit provider-log omission reason. Active, unrelated, or unproved cancellations
still fail. The three successful work runs, worker output, completion delivery,
and original deadlines remain required. Backlog creation still permits no task wake.

Because this subscription currently reports unpriced usage, setup explicitly sets
`unpricedUsagePolicy: allow` on the disposable company and both agents through the
public budget API and verifies all three policies. The 500-cent hard stops remain
enabled for reported costs; they cannot cap unknown dollar usage. Run caps and
deadlines remain independent bounds. Without this explicit funding prerequisite,
the default policy pauses the company after the first unpriced run and cancels
the delegated worker. Such a pause is not a successful chat journey.

`chat-feature.json` retains the scenario ID, capability IDs, grader version,
saved records, audit attribution, rendered links and individual checks.
`chat-feature-runs.json` uses the existing native run evidence collector, including
on failures. Setup evidence records fixture IDs, synthetic brief, readiness and
saved budgets. Ordinary Product E2E evidence packaging, redaction, cleanup, failure
classification and dashboards own the result. The definition digest includes the
query, defaults, flow and grader sources.
Individual saved-state checks are also recorded when the journey fails, so the
report shows partial progress without turning it into a passing workflow.

The grader rejects duplicate tasks, wrong owners/projects/companies, early execution,
missing audit attribution, missing or stale deliverables, extra human nudges and
uncorrelated completion replies. Document provenance binds the current revision
to Morgan's actual run. The completion check reuses `completionDelivery`; a
handoff promise or a marker alone cannot establish delivery. Chromium verifies
the task link and reload persistence.

The checks establish the specified saved state, two-sentence structure, required
brief facts and result access. They do not score writing quality or every semantic
claim in the response. Inspect the retained conversation and announcement before
accepting the first samples; the existing completion semantic-review rubric still
applies. Oracle calibration tests exercise both valid evidence and plausible wrong
outcomes without calling a model.

Preserve the historical measurements below when promoting another scenario. Keep each
starting condition explicit: connected versus missing connection, allowed versus
approval-required, and so on. Reuse the fixture/report infrastructure and add a
case-specific outcome oracle; do not make all YAML paragraphs executable through
an unconstrained model judge.

## Initial measurement — 2026-10-26

Three fresh samples per cell on definition
`7fb20426ce3f1dd4efeddfb79f231336ea65a16b9c2a73bf6131e997acd74e9d`
produced **5/6 passes**: backlog creation 3/3 and delegation 2/3. These used local
native Codex subscription execution with `gpt-5.6-sol`. All six cleaned up
successfully. Both workflows have successful browser-to-provider evidence, but
the initial repeatability target is not met.

In campaign `local-2026-10-26T15-48-12-199Z`, the first CEO run in delegation
failed before creating a task: `runnerd did not report the provider turn identity`.
Retained events show submission and provider startup, followed by the transport's
turn-start deadline. The precise cause of the missing event remains unresolved;
the existing machine classification is retained without claiming that the provider
or infrastructure has been proven responsible. Investigate this before expanding
the suite. No replacement sample erased this failure.

The local `results/chat-feature-acceptance/acceptance.md` records every sample and
earlier failed revision; its sibling dashboard uses the standard report generator.
Results are ignored generated artifacts, so retain or publish them through the
existing Product E2E pipeline when handing this measurement to another machine.

### Follow-up measurement — 2026-10-26

The unchanged delegation cell subsequently passed three fresh executions:
`local-2026-10-26T16-50-50-751Z`, `local-2026-10-26T16-54-58-203Z`, and
`local-2026-10-26T16-58-39-074Z`. The latter two campaigns also ran backlog
creation concurrently and passed both cells. All five selected executions used
one attempt with zero automatic retries, retained the same definition above,
and passed cleanup. Five existing turn-identity, early-terminal and runner-exit
regressions passed as well.

These are green rechecks, not a demonstrated repair of the earlier startup
interruption: no production code, timing limits or oracle assertions changed,
and the missing turn-start event did not reproduce. Keep the original failure
in the history. Across the original final-definition batch and this recheck,
backlog is 5/5 and delegation is 5/6. The local
`results/chat-feature-recheck/verification.md` records the follow-up evidence;
its standard dashboard is explicitly scoped to the latest campaign.

## Full catalog campaign

The frozen denominator is 244 requests across 35 areas and 191 capabilities. The [durable progress record](../../doc/plans/2026-10-26-chat-catalog-eval-progress.md) and `chat-campaign-manifest.json` distinguish complete, partial, unimplemented, blocked and actual measured results. Discovery and oracle calibration are not live acceptance. Each canonical scenario has one initial attempt and at most one coherent correction/rerun, with automatic retries zero; failures and unrun scenarios remain in the denominator.

Domain descriptors declare real setup/actions/independent grading and exact bounds. `expectedHumanMessageCount` and `setupHumanMessageCount` count only the source standing-chat history; genuine human comments and operator actions elsewhere are retained separately in scenario evidence. `setupHumanMessageCount` defaults to zero; genuine earlier source-chat human turns and native setup runs remain in the declared total, with persisted comment/run IDs captured before the canonical query. No historical model reply is fabricated.

Only `steering.preserve-draft` and `tasks.attachment-brief` may currently declare one `queryAttachments` receipt. The canonical typed query remains unchanged; the production composer appends its exact attachment reference. Before and after send, the harness independently reads the public same-source receipt and actual bytes, verifies SHA-256 and human attribution, and binds it to the real canonical comment. Extra markdown, text changes, foreign receipts and hidden followups fail. Attachment fingerprints pin both production composer source hashes as data, without importing the UI graph.

### Company secret governed approval alternative

`secrets.configure-company-secret` v12 declares `expectedRunCount: 3`,
`minimumRunCount: 2`, `expectedHumanMessageCount: 2`, and
`optionalCompanySecretBindingApproval: true` in static discovery metadata.
The base remains exactly two human actions and two native runs. Only this case
may add one actual human UI acceptance and one native continuation for its
current, exact governed binding proposal. The flow reports raw human comments,
verified question answers and the verified binding approval separately; it
never inserts a comment or counts a pending or unexecuted card.

The extra action requires the new human-saved secret, exact Morgan/environment
target, immutable payload, real current-person acceptance and executed result,
proposal/mutation audits, and exactly one successful approval-bound native
continuation. The final configuration and visible confirmation remain required.
The existing operator-directed and authorized direct-binding paths remain two
runs/two actions. Query, model and 480000 ms budget are unchanged. Original v11
result 5057 remains FAILED after a real secure save and an unanswered pending
binding proposal. V12 result 5059 also remains FAILED before entry on a safe
environment-name text card. V13 admits the bounded metadata-NAME purpose without
requiring one authored regexp or sentence template; the actual submitted
canonical environment name must satisfy any authored pattern. Value questions,
unknown prefills and changed actor/payload remain rejected. V13 is unrun until
fresh native evidence qualifies it.

### Authored skill inspection

`skills.author-skill` v4 follows the normal library card to the exact saved skill.
It accepts the canonical company-scoped detail route or the exact Studio route.
The detail view opens Overview first; select Files, then its normal Edit control. Both paths must show the
editable saved checklist, survive reload, and match the same public current
version. The receipt identifies the actual editor surface. The original case
clock, query, and one-human/one-native limits remain unchanged. The 375px check
rejects omission or waiver of the required review; a protective instruction
that content must not overflow does not waive that review. Older failed
attempts are retained; component controls do not establish a native pass.

### Team install conflict recovery

`teams.install-team` v3 accepts either an honestly reported missing required
skill or a supported catalog recovery that preserves the original local skill
and agent. An unresolved report may name the required skill’s currently occupied
slug or name; it need not use a particular failure label. Recovery requires the accepted catalog key and source hash, exact
current immutable-version bytes, and that key assigned to the intended imported
members. It does not accept merely installing an unattached skill. The original
repeat query, resource identity reconciliation, final rendered-link inspection,
two-human/two-native limits, and case clock remain unchanged. Failed earlier
attempts remain failed; this correction does not establish a native pass.

### Six prerequisite probes are not completed journeys

The following six definitions retain explicit coverage gaps and must not be
reported as full intended behavior coverage or passing refusal tests. Authored
callbacks and calibrated hypothetical observations do not prove a live journey.

| Scenario | Implemented evidence/action | Remaining prerequisite or implementation boundary |
| --- | --- | --- |
| `access.invite-teammate` | Separate real active-invite creation and accepted-state checkpoints; consequential role-question branch; exact join-link hash binding; source-qualified guard before acceptance; actual intended-person membership and different-identity reuse rejection. | Supported agent invitation grant is unavailable through the current public membership mutation. Known unsafe invitation acceptance remains blocked by the shared source guard. |
| `access.manage-membership` | Actual initial project permission, unrelated company membership and instance-user baselines, with independent post-query readback and preservation of unrelated grants. | Public grant provisioning rejects agent principals; actual membership mutation is board-only and currently records a human actor. |
| `activity.routine-audit` | Real routine/revision/run/task reads and independent audit oracle. | Historical prerequisite construction is unfinished. No rule requires a real 24-hour wait; a deterministic historical input fixture requires a separately reviewed narrow fixture-policy decision. No historical seeding exception is implemented here. |
| `agents.restore-instructions` | Exact prior bytes and visible historical/agent-attributed restoration evidence, without demanding a new UUID or literal `restore` source label. | Current file storage does not create the two visible revisions or retained restoration history required by the catalog. |
| `budgets-costs.subscription-fees` | Public report/editability/ownership/current-price audit state capture and existing human-link UI; editable shared ownership is supported. | No admitted genuine same-account duplicate fixture/provenance or public archived-price readback exists. Candidate rows are never promoted to verified duplicates by matching labels/owners. Canonical setup remains explicitly blocked. |
| `skills.enable-for-agent` | Saved assignment, unchanged skill/policy, future native selected-version snapshot independently matched to exact public version bytes; natural assignment wording accepted. | Public configuration-grant provisioning remains blocked. Lifecycle policy does not implement runtime `skills.use` denial; no denial is fabricated from install/edit restrictions. |

Queries, intended contexts/outcomes, declared run/human counts and deadlines stay
unchanged. These source improvements do not rewrite earlier measurements or
qualify any blocked conditional as a pass.

### Selected private inputs and published operator sources

A case declares `requiredCredentials` by standard credential name and, where
needed, `externalInput` by provider and required field names. The launcher resolves
only that selected case into a mode0600 file outside diagnostic artifacts. The
worker exposes `input.privateInputs.credentials`, `.read(name)` and
`.configuration("external-provider")`; boundary callbacks retain their typed
`credentials` map. Extra wizard/external keys are never inserted into the chat
agent's secret references or inherited server environment. The launcher removes
raw input files even when retaining recovery/diagnostic state. The definition
snapshot retains only credential/reference/field names. Offline eligibility calls
`chatCatalogCaseFingerprint(descriptor, normalizedExecution, retainedNames,
retainedInstalledIdentity)` (or the boundary equivalent with its retained names),
so recomputing an identity after cleanup never requires the raw credential file.

Only `instance-operations.update-instance` and `instance-operations.provision-runtime`
can declare `installedSource: "published-global-npm"`. They require private0600
`PAPERCLIP_CHAT_INSTALLED_SOURCE_CONFIG` with schemaVersion1, disposable true,
`source: {version, integrity}`, and optional distinct `target: {version, integrity}`.
Provision additionally names `piCredentialEnv: "OPENROUTER_API_KEY"` and declares
that selected private credential. These are exact semver/sha512 pins, never a local
source pack or arbitrary URL. During the governed attempt the launcher obtains
registry metadata and actual public CLI/server tarballs, verifies their integrity,
installs the source into its owned prefix, and records the complete dependency tree.
The supervisor binds the actual CLI PID, version and CLI/server bytes before setup
and after an allowed update restart. The operator receipt stays private0600;
fingerprints bind public artifact hashes and the full owned dependency tree.
Source-local refusal remains the default for every other ordinary chat case.

## Frozen capability coverage

The campaign retains its original 244 scenarios and 191 declared capabilities.
Merged production now also maps `runs-adapters/model-accounts`; that capability
is outside this frozen catalog and remains uncovered and unqualified by it.
The setup-health cell is diagnostic only and is excluded from those 244 scenarios
and from `--all`, as is the explicit-only chat catalog.

The explicit setup-health diagnostic first makes one bounded, read-only OpenRouter
current-key request on the trusted remote Linux job. Unrecognized credentials stop
before agent creation or any model call. A recognized key permits the existing
single ordinary lifecycle hello. The closed receipt records only HTTP status,
recognition, expiry and key-budget availability; unlimited/unknown key budgets do
not establish account credit or model access. Response bodies, labels, amounts,
account identities and key values are never retained. There is no retry.

Before freezing a campaign candidate, run the offline runtime-declaration guard:

```sh
node --import ./cli/node_modules/tsx/dist/loader.mjs tests/runner-e2e/chat-catalog-consistency.ts
```

It imports all 242 lazy declarations through the existing runtime loaders without
calling fixture, browser, database, or provider callbacks. Catalog listing alone
reads the discovery JSON and cannot establish runtime declaration consistency.
The same guard also runs in the existing Product E2E unit-test command.

## Retired TestOps plans

The one-case **Chat feature evals** plan and three-case
**Chat completion pilot — OpenCode 1017** plan are retired. Their scenarios are
included in the [full catalog](#full-catalog-in-testops). Use that plan or select
cases from it; do not recreate the smoke or pilot plans.

The former `chat-feature-testops.yml` and `chat-completion-testops.yml` workflows
are removed. Their bootstrap functions reject registration before any API call
or mutation marker. Shared transport, evidence, export and verification helpers
remain for the full-catalog workflow and retained historical evidence. Retiring a
plan does not delete its cases, results, launches or private evidence.

Retained launch helpers encode TestOps name filters as Base64 of UTF-8 JSON in
`search`. Plain name text returns HTTP 400. Their nonce and once-only guards
remain unchanged; this transport contract does not restore the retired plans.

## Full catalog in TestOps

The [Chat catalog TestOps workflow](../../.github/workflows/chat-catalog-testops.yml)
registers all 244 scenarios from the 35 YAML areas in a separate
**Chat feature catalog — OpenCode 1017 (candidate)** plan. Its source-derived
manifest is `chat-full-catalog-testops-manifest.json`. This is the active chat
plan. The former backlog and three-case pilot plans are retired; their cases
and measured history are preserved.
Legacy aliases reuse existing TestOps case identities without renaming them.

The catalog contains 236 Agent Chat routes, five browser boundaries, one external
assistant route and two Slack routes. An execution mapping is not a passing
measurement. Five implementations declare incomplete coverage. Six routes do not
produce the generic final PNG required by the unchanged evidence owner. Eighteen
declare additional credentials and 37 declare external inputs. These groups
overlap. Exact requirements and limitations appear in each case's preconditions.
A declared credential does not establish whether its runtime reference exists.

This lane runs the app and fixtures from candidate
`ab2019e976076ec0eb60b026844f3d9211cb0208`. It retains the evaluated app from
`3b66c3c144360ddf32714a0742fd774b8ceafb16`. The first repair source added:
owned SDK staging, public membership for three incidental human fixtures,
company settings observation inside its original case deadline, and exact
controller-secret baseline handling for secure human entry. The last repair
uses the explicit `company-secret-controller-baseline.v2` oracle. Its deployment
secret, Morgan-only binding and privacy checks remain required.

The manifest retains the original `de0941835cc8f0d01c982574ee258e110babdbeb`
definition provenance and records each changed row field in `source.repairMetadata`.
Case clocks and the controller model remain unchanged. Source3's explicit Studio144 native-accounting revision is described below. The later repair source records its
query and outcome changes explicitly; see Repair source 2 below.
Original failed measurements stay historical. Trusted selection, evidence transfer
and publishing use the workflow's immutable master revision. Each result records
both revisions.
A pass qualifies that candidate measurement, not the current master app. Other
lanes sharing a case retain their own sources. This integration does not merge
the broad catalog branch or its core fixes, reset earlier campaign ordinals, or
change the previous 196-of-244 acceptance gate.

Native execution uses OpenCode and
`openrouter/deepseek/deepseek-v4.1-flash-1017` on the existing AWS fleet. Each case
uses the manifest-declared query, oracle, counts, clocks and budgets with zero
automatic retries; explicit reviewed condition changes are recorded below. Browser boundaries and the external assistant retain their original
surfaces and may have zero native work runs. The external companion keeps its own
declared provider requirement. Setup inference and unpriced usage are not free.

Initial setup uses the existing reporting environment:

1. Dispatch reviewed master with `operation=bootstrap`. It reconciles the exact
   244 cases and the dedicated plan, then registers and binds its own GitHub job.
   Missing cases use one marked POST each. Existing cases retain their identities
   and history. Alias conflicts, foreign selections and uncertain writes stop
   setup. It makes no model call or synthetic test result.
2. Read the registration receipt. Store its compact `binding` JSON as
   `CHAT_FULL_CATALOG_TESTOPS_BINDING`. It contains observed plan, job, integration
   and case IDs plus registered full names, and fits one GitHub environment
   variable. The job must retain its observed single `Branch/defaultValue`
   definition for `refs/heads/master`.
3. Use normal TestOps **Run** for the full plan or a selected subset. The service's
   actual expected case list controls execution. Do not manually dispatch another
   evaluation after an uncertain request. Initial route verification uses a small
   selection and does not qualify all 244 cases.

Each worker executes one case. Native cases allow two workers at once for any
selection size. Selections of up to three cases that include external input keep
the native lane at one worker. The separate external-input lane remains serial
because those cases can share QA resources. A larger mixed selection can therefore
run two native cases and one external-input case at once.

This lower-load configuration changes scheduling, not case clocks, model settings
or zero automatic retries. It does not qualify eight-way native execution or
establish a cause for earlier noncompletion. A full run can take hours. Its elapsed
time depends on setup and fleet capacity; declared case clocks are not a
completion-time guarantee.

Each finished worker starts its own protected reader and safe exporter. A
separate reporting job uploads that case and verifies its result and two JSON
attachments while other workers continue. The reader has only an exact-key AWS
session. The worker has only its declared model keys. Only the uploader has the
TestOps key. The existing eight-cell private authority limit is unchanged.

The exporter freezes each UUID-bearing Allure bundle once. An uncertain upload
response triggers readback, never an automatic resend. The final job verifies
complete selected-case coverage and the original statuses without uploading the
results again. Failed originals and failed cleanup remain failed beside passed
results. Missing originals cannot become fabricated measurements or a
full-selection pass. Backend ingestion does not guarantee that an open TestOps
page refreshes without user action.

The caller and reusable case workflow must both be admitted at their exact
`refs/heads/master` paths in the existing runner group. Called jobs use their own
protected environments; the caller passes empty named secret placeholders and
never inherits or forwards actual model or reporting keys. Streaming runs use
the fixed `chat-catalog-testops-streaming-v1` serialization group. Runs started
before this change retain their original batch-reporting flow.

Raw evidence and final PNGs remain in protected storage. Public GitHub artifacts
and TestOps attachments contain only allowlisted provenance, checks, accounting
and private-evidence receipts. Raw conversations, screenshots, provider sessions
and credentials do not enter the public artifact path. Additional credentials
reach only cases that declare them. External inputs use the existing selected-case
private-input owner, disposable-resource checks and oracle commitments.
Unconfigured inputs remain setup blockers.

### Historical repair source 2 (2026-11-03)

On 2026-11-03, repair source 2 pinned candidate `36dff2eab3dfb6de6efb4fd2ce6c1a58f8a5f383`, succeeding `9ab0f951a5b5990c266ef4456610e0a0775aa334`. It carries the reviewed fixture, scoped observation, version-readback and evidence-readiness repairs. The checked static descriptor snapshot is byte-exact to this candidate and its digest is verified. Runtime descriptors are synchronized with the actual declarations; all 242 lazy factories must pass the real no-callback consistency check, together with the two legacy-cell controls, before each new repair-batch GO. The previous candidate's mismatched metadata caused launch 1690 to be cancelled before case/model work; it is an operational attempt, not a feature result.

The manifest keeps the original definition source and values, with explicit scoped changes: Fast response names the requested product feature; goal-tree and authored-skill outcomes use the product-supported optional-owner and ordinary navigation contracts; question delivery/validation and company-secret setup declare their reviewed oracle versions. Each new measurement binds this candidate and the exact changed definition; earlier grades and the 244-case gate are unchanged. SDK scan-audit capture improves private failure diagnosis only: rejection, evidence requirements and privacy bounds remain in force, and the other SDK cases stay held until the finding is understood.

Workflow, model, case clocks, native-run bounds, credentials, protected reporting and case identities do not change. The full harness TypeScript graph has not been qualified by local pure tests; source import/admission and the existing credential-free remote Runner build remain required before native queries. Static TestOps descriptions may still show the original definition until a separate idempotent metadata reconciliation at a safe source boundary.

### Historical repair source 3 (2026-11-03; candidate only)

Historical target `43c44ccc823a8c972b247fa7159281887e6f5255` added the reviewed skill import guidance, version-aware Studio sample checks, scoped app review/test and team-auth prerequisites, and the synthetic announcement-dismissal input. The core guidance PR remains unmerged; candidate-owned catalogs carry that explicit runtime/tool-description change. App testing declares its changed setup context and outcome. The exact human query is preserved.

Studio test 144 alone changes native accounting from minimum/maximum 2/2 to 2/3. Acceptance requires all three genuine settled turns: initial CEO, actual Studio worker, and exactly one source-bound completion delivery. The original 540-second case clock, controller, one human request and all other case limits remain fixed. The manifest records each previous/current field against the original definition source; no old grade or catalog pass gate is rewritten.

The SDK public-input registry is generated from the committed candidate tree. Compiler, parser, Zod, lock runtime identities, scanner and canary build certificates are unchanged. This does not establish the original SDK detector or a plugin pass. Plugin 558 remains held until genuine canary build evidence is reauthenticated. The public announcement fixture is one reviewed synthetic 443-byte JSON under an isolated staging prefix; production announcements and the global index are untouched. Each original worker process still selects one case, so only the dismissal case enables that input.

The full-catalog private evidence policy binds the launcher digest from the same reviewed manifest as the immutable candidate target. Every final GO reads `launch.ts` from that exact Git object and validates its digest against every selected singleton policy before submission. The legacy pilot launcher digest remains separately pinned.


### Historical repair source 4 (2026-11-03; candidate only)

Historical target `51ef450754370c8a8f2cbe4bd18e1536bbc93966` adds remaining-original-deadline observation for primary guidance; independently expected normalized MCP results; fixed owned timeline-file reads through fixture board authority; finite supported CLI profile guidance with no identifier substitutions and fresh board/API/company/human readback; real completion-turn observation for plan review; and the reviewed true-price hire counterpart. Original failed attempts remain unchanged.

The app-review journey now requires inspection of the exact full redacted arguments and audit hash in the normal shared review card, then verifies that authorized provider dispatch equals that proposal. The 17-line product disclosure is an explicit candidate-only overlay from unmerged core PR #18734; no backend permission or approval rule changes. The independent core guidance PR #18717 also remains unmerged.

SDK public-source eligibility explicitly changes its expected restored lock from stale c7f230 to the authenticated credential-free build-input SHA256 `54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8`. Compiler/parser/Zod identities and all privacy/AST/custody guards remain enforced. This correction is not a plugin pass: case 115 must qualify with its original 300-second/one-native limits, and the other five SDK cases, including plugin 558's canary certificates, remain held. All case clocks and the controller model remain unchanged; Studio144's earlier explicit 2..3 accounting revision remains the only native-bound change.

### Historical repair source 5 (2026-11-03; candidate only)

The reviewed prior cut `de6d29e025683f5c28125bcaa4f38b41836d8516` has not run as a campaign lane. It adds case53 observation within its original300s budget, case74 actual rich-editor ordered-block inspection, case550 normal Projects-surface announcement fixture, case578 server-canonical secret-key metadata checks, and case466 canonical native status audit joins to the exact accepted task/run/worker decision. The timeline keeps its real exit1, human handoff and exit0 checks; legacy audit support remains. Queries, models and original per-case clocks/run counts stay fixed. Its candidate-only UI487 overlay includes reviewed pre-trim size guards from unmerged corePR18734/50600786. Historical Source4 `51ef450754370c8a8f2cbe4bd18e1536bbc93966` remains the source of launch1888; later master metadata never retargets that running workflow. These repairs and focused controls are not real feature acceptance. Other five SDK cases remain held pending actual115 evidence; no core PR is merged.


### Repair source 6 (2026-11-03; candidate only)

The canonical candidate above retains Source5 and adds initial personal-secret and team-install observation within their original deadlines, real hire-review link readiness, and skill-update observation at genuine provider checkpoints after local native readiness. Case queries, controller model, permissions and declared clocks/run counts remain unchanged from Source5; Studio144 retains its earlier explicit 2..3 accounting revision.

The reviewed product overlay from unmerged core PR #18742 at `61996a96dd09e90a5788e8711a94fc5ae631f425` allows a new Ask-first review for a strictly authenticated later same-person human intent following a declined request, including the normal reopened-comment source. Repeating the same intent stays denied; this grants no approval or execution authority. Both PostgreSQL route regressions ran and passed on that core head. The candidate preserves the compatible gateway and actual database row contracts; this is not a core merge or a qualified chat pass. Core PRs #18717, #18734 and #18742 remain unmerged. SDK115 completion remains unknown; the other five SDK cases remain held.

For one selected case, the trusted controller downloads each exact bundle and publication artifact name into an explicit matching child directory. For multiple cases, it keeps separate named artifact directories. The gather command authenticates the frozen selection, every prepared bundle and its hashes before it copies the safe projections. Final coverage still authenticates the original publication receipts and verifies TestOps results without another export or upload. Empty, mixed, foreign and symbolic-link layouts fail closed. The producer's optional once-upload marker has an exact closed schema; it does not replace a verified publication receipt.


The optional Company-secret binding approval is declared only by
`secrets.configure-company-secret` with `optionalCompanySecretBindingApproval: true`.
Its two base human inputs may be followed by one independently verified UI approval
(maximum three actual human inputs). Its native bounds are explicitly 2..3 and its
original 480000ms attempt, model and zero automatic retries remain unchanged.
The controller copies this static marker from the candidate descriptor and checks
it against source task metadata; metadata extraction never executes fixture hooks.
This conditional accounting does not pre-complete approval or qualify a live pass.

## Candidate catalog oracle calibrations

The next unrun credential observer revision retains original Company5133 and
Personal5128 as failed. Company v14 adds a plain secure-save confirmation ACK.
Only an actual current-human private form save can precede its ordinary Confirm
click. The source card, immutable payload, human resolver and audit, new secret,
and successful bound continuation remain required. This ACK is not the optional
executed binding approval. Direct paths retain native2/human2; governed paths
retain native2..3 and base human2 plus one verified approval, within480000ms.
The worker types actual requested Name/Key metadata and verifies the submitted
metadata and stored canonical key. Requested and stored metadata are recorded
separately. The native agent must discover and bind the actual saved secret ID.
No extra acceptance field, chat message or lookup alias is invented.

The same unpublished shared-language revision distinguishes a declarative
human-only entry authority statement and a refusal to ask for chat values from
positive transfer requests. Independent unsafe destinations remain rejected.
Its six consumers advance once: Company14, Personal13, and four external7
cases. Personal retains native3/human2/660000ms. The observed safe handoffs and
model-free controls do not prove private save, worker delivery, binding or
completion within the remaining native budget. All current YAML queries,
model, clocks, controller-helper bytes and protected evidence wire are retained.


### Existing multipart-form walkthrough context

The multipart fixture records its already pending form in the source task's normal
editable description before the original chat query. This context contains the
actual form ID, title, questions, options and validation. It contains no future
answers or tool-use instructions. The first native turn bound to that human query
must not create a replacement question form before the person answers the supplied
one. A different follow-up question after the bound answer remains allowed.

This is a disclosed fixture-context and walkthrough-fidelity change (required-question
v5), with the original query, two native runs, one human chat query plus its bound
UI answer, model and 300000ms attempt unchanged. Result 5172 remains its original
PASSED result for the earlier persistence/continuation scope, with the recorded
confusing duplicate-form and inaccurate walkthrough metadata limitations. It is
not retroactively regraded, and no new native result is claimed.

Personal secret v14 admits the measured result 5169's safe My secrets/definition
menu directions with a noncanonical inline code hint. The hint is retained as an
advertised hint, never rewritten into a trusted URL. Actual visible Account →
Settings → Secrets hrefs must independently match the current company, and the
My secrets control must expose the required own-value entry. Foreign links,
other paths, hidden navigation and mismatched definitions remain inadmissible.
The private worker still independently verifies the responsible person and exact
definition before entering the value. Result 5169 remains FAILED; this local
observer correction does not qualify the unexercised save, consumer or final reply.

Menu evidence labels the parameter as `expectedDefinitionId`; the observed UI proof
is the current-company route and visible definition key. Private entry retains the
independent exact-ID/current-owner check. Delayed flyout and own-entry visibility
are awaited within the same passed navigation deadline.

Team install v8 accepts a current, exact-skill unresolved installation or slug-conflict
report when the saved required skill is still missing. Independent current recovery
claims and all-skills-installed claims still fail. Result 5171 remains originally
FAILED; a local diagnostic changed only its truthful repeat phrase from "remains
unresolved" to the already supported "remains blocked" and passed the owning grade.
This is an assertion correction, with no new native pass or runtime-migration credit.
The derived runtime fixture, protected local skill, actor/phase/resource/link checks,
original query, two native/human turns and 480000ms attempt are unchanged.

Company secret v15 admits a bound question asking whether deployment-key secure
entry has been completed, as well as the existing save-then-confirm instruction.
This is an acknowledgment of an actual prior current-person secure save, not
permission to execute a binding. The separate saved-value, payload, actor,
continuation and governed-approval proofs remain mandatory. Original failures
remain unchanged; v15 has not run natively. Counts, queries and clocks are unchanged.


The next coherent fixture calibration retains every original outcome from launch
3277 (all four selected cases reported FAILED). Multipart question v6 removes the
shared send helper's automatic human dismissal when the ordinary composer is
already usable below the saved form. Later human comments still classify the form
as historical, but it remains answerable and the latest human direction governs;
this setup correction does not guarantee that a native turn will reuse it.
The original query, same-form fidelity check and one answer-bound continuation
remain required.

Company secret v16 and Personal secret v15, plus the four shared external secret
consumers at v8, admit a bounded instruction to enter the value at the independently
supported secure destination and save there. They retain the actual current-human
secure-save prerequisite, separate governed binding approval where required,
consumer delivery, owner isolation and no-leak proofs. Personal menu discovery
separates its single imprecise setup hint from independently validated, visible,
current-company task citation anchors; neither hint nor citation grants private
entry authority.

Team install v9 accepts a truthful current report that the exact required skill
remains unattached when independently saved state proves it is still missing.
False attached/full-recovery claims and contradictions with an actually recovered
state remain rejected. This assertion calibration provides no runtime-migration
or new native pass credit. All 244 YAML definitions, original queries, model,
permissions, human/native bounds and clocks remain unchanged. Cap 2 and zero
retries remain the controller policy. Existing candidate core overlays stay
unmerged, and the held full-catalog gate remains 196 of 244. The next native
measurement is still required; none of these local controls regrades an original.


The next secret-pair measurement retains launch 3310's one original PASS and three
original FAILURES. Multipart question v6 was independently verified on the same
form without dismissal or replacement, with exact real answers and one continuation
in 241214ms of its original 300000ms cell. This does not prove reliability or isolate
the fixture change as the sole cause.

Company secret v17 recognizes an ordered secure-save acknowledgment across bound
explanatory clauses, while rejecting a declined save or acknowledgment. Its original
initial native succeeded in 344242ms; only 86070ms remained at the false pre-human
gate. Measured handlers do not explain that latency, and no avoidable latency bug
was proved. Human entry and later native turns remain unqualified.

Personal secret v16 preserves the canonical saved confirmation policy through real
secure entry, acceptance and independent accounting. Both supported wake policies
must match the original saved card exactly. The actual wake-on-accept/After Saving
card was rejected before private entry; canceled or negated acknowledgments remain
rejected. Team install v10 accepts a bounded qualifier on the exact required-skill
subject for truthful partial-installation reporting. Its local calibration does
not regrade original 5242 or provide runtime-migration credit; the fifteen other
saved-state and phase checks remain required.

Only Company, Personal and Team versions change in this batch. All 244 YAML
queries, contexts, outcomes, permissions, human/native bounds, model and clocks
remain fixed. The next measurement is only the Company and Personal secret pair,
with cap 2, zero automatic retries and original 480000ms/660000ms cells. Team remains
calibrated locally; the final uniform ten is still required on this same source.
All original grades, historical conditions, unmerged core holds and the 196/244
full-catalog gate remain intact.


Prospective timeline and provider-routing conditions

Timeline v13 accepts a same-identified-task account that orders the first worker's
real command failure and pause before the different saved repair worker's verified
repair, without requiring an explicit assignment phrase. Independent same-task
saved handoff, actor, command, chronology, link, privacy and read-only proofs remain
mandatory. Launch 3376's original timeline FAILED result remains unchanged; its
completed truthful account motivated this prospective calibration, not a regrade.

The reviewed OpenCode chat profile now supplies model-specific
`OPENCODE_CONFIG_CONTENT` selecting OpenRouter `provider.sort: "throughput"` only
for `deepseek/deepseek-v4.1-flash-1017`. This changes the profile environment and
provider-routing condition: it is a PROSPECTIVE performance experiment, with
benefit unknown. The exact model, default reasoning behavior, permissions, output
options, auxiliary-model configuration and all original native/human bounds and
clocks are unchanged. Previous default-routing failures are retained; no runtime
latency repair, reliability improvement or new native pass is claimed.

Approval resubmission metadata describes the existing revision/resubmission
operation and its unchanged authority boundary so ordinary API discovery can find
it. This does not approve or execute a hire. Candidate core changes remain open
and unmerged; the 196/244 full-catalog gate remains held. All 244 YAML identities,
queries, contexts and outcomes remain unchanged. Combined qualification and any
next native measurement remain pending the coherent release decision.

Personal secret v17 accepts an asserted current personal value, key, token or
credential that worked or works. This is a narrative calibration, not permission
to count save-only, planned, negated, unrelated-task or another person's success.
The original launch 3376 failure remains FAILED even though its plain-comment
path reached secure current-owner save, actual worker delivery with a 200 receipt
and a separate CEO acknowledgment. Independent consumer delivery, actor/owner
isolation, receipt, privacy and no-leak proofs remain mandatory. No new native
pass or latency improvement is claimed; the original three native/two human inputs
and 660000ms cell remain unchanged. Timeline and Personal are two of the four oracle version
leaves changed in this prospective batch.

Skill authoring v6 observes the four required checklist points within their
actual heading-and-list sections rather than requiring every term in one text
block. The launch 3376 native authored and saved the skill, but its original
FAILED observer stopped before UI reload/readback qualification. This repair
provides no native pass credit: actual file, author, version, editable Studio,
reload and matching readback proofs remain required. Unrelated sections, missing
requirements and waivers remain rejected. This is the third prospective oracle
version leaf; skill review/update is the fourth calibration below.

Any next throughput-routing measurement first uses a small representative
announcement case before expanding to the uniform ten. That experiment remains
unrun and requires a separate release decision; neither local projection nor
these assertion calibrations demonstrate a performance benefit.


Skill review/update v3 preserves a complete persisted preview on its original
path. Only an incomplete persisted preview may fall back to the current rendered
final response, anchored after the actual human review request and corroborated
by the same committed successful native run. Hidden, stale, foreign, reasoning,
tool-output and API-only summaries remain excluded. Hydration waits consume the
original observation deadline without renewing it. The later human apply request,
actual upstream version change and unchanged local fork remain mandatory. Launch
3376's original FAILED review/update result stays unchanged; its later apply
phase was never reached, so this calibration supplies no completed native pass.
Together the four prospective oracle leaves are Timeline v13, Personal v17,
Skill authoring v6 and Integrator v3; every other descriptor field and sourceFiles
array remains unchanged. The routing experiment remains unrun and its performance
benefit is unproved. No main pass credit or release acceptance is claimed.
