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

## TestOps completion pilot

The separate `Chat completion TestOps` workflow connects only these preserved
catalog cases to the private Paperclip Evals project:

- `projects.project-work`
- `projects.project-defaults`
- `instance-operations.restart-service`

It evaluates the immutable catalog source in
`chat-completion-testops-contract.mjs`. This keeps the broader catalog on its
integration branch. The source includes the bounded TestOps host prerequisite
from #18515. Changing the pin requires source review. The original DeepSeek
1017 model, case clocks, independent checks, and zero retries remain fixed.
Source registration does not establish a new live result.

Run the named plan **Chat completion pilot — OpenCode 1017** in TestOps. The
adapter validates the actual project, plan, job, launch and selected cases before
build or provider access. A selected subset runs only those cases. The AWS matrix
has concurrency one and does not cancel sibling cases after a failure.

The main-only reporter uses the existing protected `ALLURE_TOKEN`; the evaluated
app and worker never receive it. Original evidence stays in the existing private
AWS storage with the unchanged validators, scanners, byte bounds and exact-key
policies. A separate trusted projection carries verdicts, checks, accounting and
private-evidence receipts. The final PNGs are verified in protected storage;
only their checksums and availability are recorded in TestOps. GitHub artifacts
contain metadata only. Raw logs, screenshots, hidden
reasoning, API snapshots, credentials and provider sessions are not attachments.
Original failed grades and cleanup failures remain failed. Same-run readback
requires matching results and complete result-owned attachment metadata within
the existing bounded processing window; it does not claim remote byte hashes.

Initial setup uses the existing workflow operations:

1. Dispatch reviewed `master` once with `operation=bootstrap`. This creates or
   reconciles only the three exact automated cases and the dedicated plan. It
   registers the GitHub job with an empty Allure results directory. It reuses
   only the existing enabled GitHub integration from
   `CHAT_TESTOPS_INTEGRATION_ID`. No model or fabricated result is created.
   The observation receipt captures a closed parameter-shape inspection before
   binding. Only the observed single `Branch/defaultValue` definition for
   `refs/heads/master` is accepted. Bootstrap enables the job and assigns cases
   while preserving that definition; the plan uses its default branch.
2. Read the closed registration receipt. Store its observed `binding` JSON as
   `CHAT_COMPLETION_TESTOPS_BINDING` in `runner-e2e-testops-reporting`.
3. Use TestOps **Run**. For the initial operator launch, set an exact next
   workflow run number in `CHAT_COMPLETION_TESTOPS_LAUNCH_RUN_NUMBER`, set a new
   32-hex `CHAT_COMPLETION_TESTOPS_LAUNCH_NONCE`, then dispatch `launch-plan`
   once. Its request produces the TestOps-owned `evaluate` dispatch. Do not
   manually dispatch an additional evaluation after an uncertain launch.
4. Verify the fresh TestOps launch, all selected case results, source links,
   independent checks, private-evidence receipts and cleanup. Inspect screenshots
   through authenticated private-history retrieval. Retain earlier failed attempts.

The runtime accepts only `operation`, `ALLURE_JOB_RUN_ID` and reserved username
metadata. It rejects arbitrary source/model/budget selectors, branch workflows,
replays and foreign cases. All secret-bearing jobs recheck actual GitHub run and
actor identities. The existing one-case backlog plan remains independent.

## TestOps-backed AWS backlog cell

The dedicated `Chat feature TestOps` workflow accepts only the shipped default
branch and the fixed OpenCode backlog cell. `evaluate` is the default operation
and requires TestOps' `ALLURE_JOB_RUN_ID`. A protected reporting job verifies the
project, singleton plan, assigned public workflow, selected case and current
GitHub run before any build or provider access. The evaluated process receives
no TestOps token. It retains the original one-query, one-work-run, 120-second
turn, 420-second attempt, 300-second settled-state and zero-retry limits.

Two metadata operations prepare that route. `bootstrap` registers the actual
public CI job through pinned `allurectl` with an empty results directory and
reconciles only the dedicated case and singleton plan. It produces no passing
test result. After the registered job and protected case/plan/job identifiers
are verified, `launch-plan` sends one TestOps plan-run request and exits.
The TestOps job then dispatches `evaluate`; an operator must not dispatch a
second evaluation manually. Missing or ambiguous registration and selection
metadata stops before inference.

The workflow reuses the existing AWS fleet and strict private evidence storage.
Its shipped-main authority is separate from manual candidate approval. Original
logs, provider records and failure evidence remain private. The reporting adapter
exports only a source/run-bound normalized result, JUnit and screenshots already
marked by the owned fixture screenshot producer with matching file hashes.
A separate protected reporting job converts that projection to the exact TestOps
case. Failed grades and cleanup failures remain failed.

Reporting setup uses the master-only `runner-e2e-testops-reporting` environment,
with the existing reporting token delivered through the reviewed sealed-box
bootstrap. `CHAT_TESTOPS_CASE_ID`, `CHAT_TESTOPS_PLAN_ID` and
`CHAT_TESTOPS_JOB_ID` must name the observed dedicated mapping; the numeric
`CHAT_TESTOPS_GITHUB_WORKFLOW_ID` supports TestOps' registered workflow URL.
No arbitrary source, model, case, retry or budget input is accepted.

The initial `launch-plan` administrator operation also requires a protected
`CHAT_TESTOPS_LAUNCH_RUN_NUMBER`. After registration, the trusted operator creates
this variable once with the reviewed next workflow run number and reads it back.
The launcher compares GitHub's actual run number, attempt, workflow, source and
actors before any TestOps mutation. A later dispatch or replay cannot reuse that
approved number. Missing or uncertain metadata stops; an uncertain request needs
reconciliation rather than a new send. The nonce and launch search provide
additional evidence. Normal TestOps **Run** uses `evaluate` and is independent of
this one-time administrator fence. The launch nonce is protected configuration,
not a dispatch input. Job parameter IDs are opaque. The launcher preserves the
API's exact ID/value pair for `refs/heads/master` and uses the fixed workflow's
`evaluate` default. An operation parameter is used only when the protected
`CHAT_TESTOPS_OPERATION_PARAMETER_ID` matches a returned ID with a `bootstrap`
or `evaluate` value; the launcher then sets it to `evaluate`. Other values,
duplicate IDs and conflicting configuration are rejected. No relationship to
global environment-variable IDs or names is inferred.

`CHAT_TESTOPS_INTEGRATION_ID` names the reviewed existing project GitHub
integration. The launcher verifies its project, type and enabled state, then binds
only the newly registered public job to it. It never changes integration settings
or credentials. Since the job response does not expose that association, only the
real TestOps-to-GitHub dispatch can qualify it.

After `allurectl watch` finishes, the same protected reporter checks the actual
TestOps job-run, launch, selected case, result source/status and attachment
metadata. Processing reads are bounded to 12 polls, five-second gaps and a
120-second processing deadline. Unknown or missing results remain unverified.
The check downloads no attachment content and claims no server-side attachment
byte hash. Its closed receipt is retained separately. An upload success alone
is not a passing feature result, and verifying an original failure cannot turn
that failure into a pass.

Build and worker installs use the existing reviewed report-lock policy. Only its
committed input or output lock is accepted; its authenticated correction is the
only allowed normalization. Dependency manifests, patch inputs and policy must
remain unchanged. Installs are frozen with lifecycle scripts disabled. The
credential-free build rechecks that boundary before packaging, and the worker
matches the source/lock receipt before installing. Arbitrary resolver drift is
rejected before provider access.
