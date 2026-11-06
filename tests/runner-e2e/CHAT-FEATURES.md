# Chat feature evals

`chat-features` promotes two entries from the [scenario catalog](chat-scenarios/README.md)
into real Product E2E executions. The scope is deliberately small: prove the
fixture, browser interaction, independent grading and report loop before adding
more features. Catalog coverage is not live acceptance.

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

Run creation first and inspect its packaged report before delegation. For the original Codex
acceptance, run each cell three times against fresh fixtures on the same definition
revision. Keep every attempt, including failures; a retry does not erase one. A
fixture or product correction starts a new three-sample measurement. All cells
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

Only after this loop is stable should another scenario be promoted. Keep each
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
