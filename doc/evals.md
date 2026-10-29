# Paperclip evaluation guide

The public directory calls full-product testing **E2E tests**. Suites describe
what is tested; deployment targets describe which app instance was tested.
QA smoke is a named selection of existing journeys against QA, and appears in
the same campaign history as other E2E runs. Agent execution (local or Daytona),
provider, model and profile are independent filters. Browser-only journeys need
no agent or model. Historical records without target metadata remain explicitly
"Not recorded" rather than being assigned an inferred environment.

The history sidebar includes the current suite catalog and retained historical
suites. Each suite has its latest matching run and latest full run, with full
coverage determined from the recorded suite definition, selection and execution
counts. An unexecuted full selection remains unfinished, and a subset
can pass without qualifying as a full suite run; failed full selections remain
visible. Changing a model filter does not redefine the suite's recorded coverage.
Existing `runner-e2e` URLs, test IDs, commands, and measurement timestamps remain
stable. **Runner protocol evals** remain a separate category because they test
the runner/provider against a mock control plane.

Sidebar suite links open that suite's campaign history with other filters cleared.
The Suite dropdown combines with the current filters instead. Explicit URLs retain
their selected filters; when a suite is absent from a preset, the empty state
explains the combination and links to the suite's runs.
Active filters have blue borders and tinted fields. The filter toolbar counts
active values, including a count beside More filters for collapsed controls.
Reset all filters clears every campaign filter and the sidebar suite search.

`node --import ./cli/node_modules/tsx/dist/loader.mjs tests/runner-e2e/history-browser.browser.mjs`
exercises the history UI using synthetic metadata and Chromium, with no model calls. It checks suite coverage, correlated
suite/target/model/execution filters, saved QA selections, URL history and mobile
navigation. Install the existing Playwright Chromium dependency before running.
For presentation-only refreshes,
`node --import ./cli/node_modules/tsx/dist/loader.mjs tests/runner-e2e/history-refresh.ts --history <history.json> --output <directory>`
renders an existing history file. Its optional `--public-campaign`, `--public-url` and
`--preset` arguments import a reviewed public measurement without replacing
existing campaigns. Private Cloud bundles are rejected. The output contains
only index HTML and history/pointer JSON; it does not upload evidence or change
retained campaign bundles.

The explicit-only [chat feature evals](../tests/runner-e2e/CHAT-FEATURES.md) promote
two natural-language task scenarios into local native Product E2E cells. They
verify saving an unstarted task and delegating a saved announcement back to chat,
using ordinary production instructions, real browser messages and independent
state/provenance checks. The broader YAML catalog remains planning inventory.

The explicit-only [Daytona restart continuity journey](../tests/runner-e2e/README.md)
extends the existing native restart oracle to a 125-second controller outage,
using the recorded Claude and Codex models in disposable development fixtures.
It requires same-process adoption, saved files and finalization without replay;
local regression checks and catalog discovery are separate from live acceptance.

The explicit-only [GitHub review bot journey](../tests/runner-e2e/GITHUB-REVIEW-JOURNEY.md)
converts the Ponytail walkthrough into attended App setup, scoped installation,
automatic PR review, and independent two-service checks. It supports attached
self-hosted/Cloud targets and separately selected local/Daytona agents. Account
and credential bindings stay in the private eval repo; registration and oracle
tests do not establish a completed live pass or unattended CI qualification.

The explicit-only [necessary free-text question journey](../tests/runner-e2e/README.md#necessary-free-text-question)
checks one essential input, the rendered prompt and context, the real answer,
one bound continuation, and an exact saved confirmation. Its four development
cells use the recorded Codex and Claude models. Registration and calibration do
not establish Slack, staging authentication, warm lifecycle, or live qualification.

[Reusable Product journeys](../tests/runner-e2e/PRODUCT-JOURNEYS.md) add explicit
deployment targets and starting-state recipes. The shared task-properties
journey uses no model; Cloud onboarding supplies reusable verified state. Cloud
fleet operations and trusted CI remain private. Local eval gateway qualification
does not qualify Cloud routes, and these selections stay outside `--all`.

The explicit-only [case handoff workflow](../tests/runner-e2e/README.md#persistent-case-handoffs-explicit-only)
contains arithmetic and receipt smoke cells for a same-task round trip among three native agents using real case/task
APIs, saved documents, handoff receipts, and browser readback. Receipt smoke has
an explicit terminal handoff to `done` on its fourth run, proving case closure
through normal task completion without a fifth provider run. It also has
an initial task-owned brief supplied at kickoff through `initialDocuments`,
ordinary native task document reads/writes, and case-page rollup readback.
Earlier case-document campaign results remain preserved and do not qualify
this subsequent document ownership change. The suite has
separately selectable local Codex API-key and subscription profiles with the
same model and limits. The API profile uses an encrypted company-secret
reference; the subscription profile receives only an explicitly supplied private
login fixture. The original arithmetic cell remains subscription-only.
The receipt cell declares exactly four task work runs, 90-second work-run limits,
a five-minute attempt, and 100-cent accounted-work budgets. Initial agent setup
also performs production hello probes outside heartbeat counts, budget accounting
and the work-run usage report. Up to three initial probes are expected; their
detailed tokens and cost are unavailable, and a timeout need not cancel an
in-flight probe immediately. These limits do not establish an absolute provider
inference cap, and unknown setup usage is not free. The original arithmetic cell
retains its own limits.
Service tests and workflow discovery remain distinct from a completed provider run.

The [Slack connector probe catalog](../server/src/services/connectors/slack/evals/README.md)
organizes eleven manual model acceptance probes and a selector for existing
deterministic regressions (`pnpm test:slack-connector`). It is not a registered
model campaign; transport fixtures do not prove that an agent chooses a tool
or that a real Slack interaction completes.

The explicit-only [live provider connection suite](../tests/runner-e2e/PROVIDER-CONNECTIONS.md)
is a Product E2E workflow for fresh subscription/API-key/gateway connections,
with attended login and independent artifact checks against local or staging targets.

The bounded [personal Muse receiver probe](muse-personal-agent.md#bounded-24-hour-probe)
uses ordinary task APIs and retained native receipts to measure unattended
receiver behavior. It is a separate manual qualification probe, not a registered
Product E2E campaign. Synthetic receiver tests cannot qualify personal Muse;
real setup, clarification and fresh-conversation collaboration remain separate
release gates.

Paperclip has two live eval families with different questions, owners, and
evidence. Choose the family before selecting a model, profile, or case.

The explicit-only [native instruction consolidation comparison](plans/2026-10-03-native-completion-consolidation.md)
uses six Product E2E cells per source variant. It measures the completion
constraint reduction separately from the earlier native tool-description
trial. Provider-free start/resume payload capture is a byte measurement;
behavioral qualification requires the original paired live outcomes and
retained content. Neither source admission nor a scripted pass proves model
behavior.

- **Runner Evals:** real Runner/provider behavior against a seeded mock control
  plane. Definitions live in `paperclip-evals/evals/paperclip-runner`; see the
  [direct live protocol evals](../packages/paperclip-runner/docs/runner-protocol-live-evals.md).
- **Product E2E Evals:** real browser, Paperclip server, database, Runner,
  provider, and (where selected) Daytona, using an isolated instance and
  grading oracle. See [`tests/runner-e2e`](../tests/runner-e2e/README.md) and
  [Everyday Workflows](../tests/runner-e2e/EVERYDAY-WORKFLOWS.md).

The [chat scenario catalog](../tests/runner-e2e/chat-scenarios/README.md) is a
planning inventory within Product E2E: natural user requests, assumed context and
expected outcomes linked to the feature and agent-access maps. It includes
conditional setup, permission, approval and recovery journeys. Its YAML files
are not registered runnable cells and contribute no passing coverage or scores.

Runner Evals answer whether a real runner/provider can perform a bounded
protocol operation against the expected control-plane contract. Product E2E
Evals answer whether a person can complete a product workflow through the real
Paperclip surfaces and whether the resulting artifact and state are usable.
The names describe the system under test; “headless” is an execution option,
not an eval category.

The explicit Product E2E `completion-updates` suite compares onboarding and
idle, busy, multiple-task, and restart Agent Chat handoffs on native Claude/Codex. It separates mechanical
completion delivery/result access from semantic review of the retained answer;
see the [probe contract](../tests/runner-e2e/README.md#completion-update-probes-explicit-only).

The explicit-only [task-titles suite](../tests/runner-e2e/README.md#automatic-task-titles)
checks that production guidance causes a real native agent to name prompt-only
standard/Ask tasks early, while preserving user-supplied titles. Its oracle
correlates browser creation, native tool receipts, durable titles, audit ownership,
and the reloaded task UI; fixture prompts contain no naming instructions.

The explicit-only [native connection guidance suite](../tests/runner-e2e/README.md#native-connection-guidance-explicit-only)
adds neutral decline prompts, same-task run-attributed explanations, and measured
no-use controls across three native local profiles. Its fifteen configured cells
are preparation for future matched instruction comparisons, not a live result.
Historical Everyday cases and production prompts are preserved.

## Selecting a family

Pi's explicit-only `pi-controls` Product suite tests Stop while native permission
is unanswered and browser-originated same-turn steering, locally and on Daytona.
Its [fixture contract](../tests/runner-e2e/FIXTURES.md#pi-active-controls) separates
control acknowledgment, actual message consumption and owned process retirement.
The current Pi matrix has 26 explicit cells (13 local and 13 Daytona), including
these four controls, pending-native-question controller restart, and a Daytona-only
exact-Pi-child provider-death journey. Provider death must expire the original
unanswered card and reject stale replies without a replacement run; any durable
fallback is distinct from restoration. File editing
also requires native edit/validation events and a registered artifact download.
All remain unqualified until measured on the exact candidate runtime and harness.

Use **Runner Evals** for a runner protocol, adapter, transport, native session,
tool grant, or one-turn provider qualification question. The workflow checks
out an exact `paperclip-evals` revision, builds the Runner and viewer, runs a
live roster, and renders the canonical Evalbook report. The control plane is a
seeded test authority, so a passing result does not prove browser UX, production
server behavior, database persistence, Daytona behavior, or a real third-party
mutation.

Use **Product E2E Evals** for browser interaction, issue/task lifecycle,
approval and clarification UI, project/repository selection, persistence over a
controller restart, artifact delivery, billing/evidence behavior, or runner
continuity in local or Daytona environments. The harness creates a fresh
Paperclip instance per cell and uses public APIs and the production browser
surface. The suite's [Everyday Workflows](../tests/runner-e2e/EVERYDAY-WORKFLOWS.md)
are Product E2E even when their results are imported into Evalbook.

Do not combine a partial Runner campaign and a partial Product E2E campaign into
one score. A campaign is comparable when its definition/grader, model/profile,
environment, and contract match. The evaluated Paperclip revision may
intentionally differ for a before/after fix comparison; record it as a
comparison axis.

## Ownership and codepaths

Runner Evals are owned by the Runner/evals maintainers. Definitions, rosters,
case prompts, and the report program live in the sibling private repository
`paperclipai/paperclip-evals`; Runner integration, viewer, aggregation, and
publication code live under `packages/paperclip-runner` and the
`runner-protocol-live-evals.yml` workflow. The public-facing report uses the
same Evalbook renderer and Runner Lab viewer as the trusted report after
sanitization.

Product E2E Evals are owned by the runner E2E maintainers. The catalog and
harness are under `tests/runner-e2e`; the package scripts are `test:e2e:runner`,
`test:e2e:runner:unit`, `test:e2e:runner:typecheck`, and
`test:e2e:runner:report`. `README.md`, `FIXTURES.md`, `SECURITY.md`, and
`EVERYDAY-WORKFLOWS.md` are the detailed sources of truth. The harness starts
the server and embedded database, creates the company/agent/task through the
real APIs, drives Chromium, and invokes the selected local or Daytona runner.

The explicit-only `agent-chat-hardening` Product E2E suite covers native chat
recovery, hiring, status evidence, and review handoff on local and selected warm
Daytona paths. Its [fixture contract](../tests/runner-e2e/README.md) distinguishes
startup cancellation from active response cancellation and HTTP send replay
from ambiguous provider action recovery. Select it explicitly; `--all` excludes it.

The explicit-only [production hiring templates suite](../tests/runner-e2e/README.md#production-hiring-templates)
adds two local native Codex/Claude cells. It exercises API-created production
CEO defaults, an explicitly requested hiring skill/reference read, a permanent
coder hire, independently computed saved JSON fixtures and worker reuse.
Each cell requires five work turns and admits at most two strictly attributed
server task-completion turns. Every actual run remains counted; unknown or
extra-work turns fail. Source/read coverage and workflow outcome are
separate: missing read provenance leaves the candidate/baseline pair
uncomparable even if work succeeds. Baseline bundles and coder examples derive
from their own source revision, without requiring candidate wording or length.

The explicit-only `context-integrity` Product E2E suite covers ordered public
comment continuation and explicit invocation of an assigned pinned skill across
the seven selected legacy/native local profiles. Select it by suite or exact
execution ID because `--all` excludes explicit-only suites. Each cell applies a
1,000-cent company and agent budget hard stop before task creation and records
both limits in its evidence.

The explicit-only [stock-harness suite](../tests/runner-e2e/STOCK-HARNESS.md)
reuses skill, ordered-continuation, and chat-restart journeys across eight local
legacy/native profiles with production-default hires. It closes the custom QA
manual coverage gap. Its required credential-free prerequisite maps vendor
instruction layering, the tiny hire bundle, and shared startup/resume reductions
to executable checks. The 24 live cells are configured; no live qualification is
claimed from their setup or unit calibration.

The explicit-only `agent-chat-stories` suite covers the experimental settings
lifecycle for a configured native agent and follow-ups during active work. Its
fixture-driven file wait and persisted-plan oracle are documented in the
[Product E2E guide](../tests/runner-e2e/README.md). It does not qualify the native
onboarding wizard or change the native API-tool rollout defaults.

The explicit-only `grok-qualification` and `grok-subscription-qualification`
Product suites exercise Grok Build with API and company subscription
authentication respectively. Keep their results separate; the subscription
fixture seeds an explicitly supplied login and does not qualify interactive
login. See the [Grok fixture contract](../tests/runner-e2e/README.md#grok-build-qualification).

The explicit [Direct blocker guidance suite](../tests/runner-e2e/README.md#direct-blocker-guidance)
checks the legacy coordination skill against human authority, missing hiring
permission, and requester scope decisions through saved browser interactions.

## Validation ladder

The native Codex Daytona `recover-controller` cell in Everyday Workflows
requires active process and lease continuity, native receipt continuity and
workspace finalization. See the [restart evidence contract](../tests/runner-e2e/EVERYDAY-WORKFLOWS.md).
Catalog discovery and deterministic calibration do not establish live recovery.

The explicit-only [public MCP suite](../tests/runner-e2e/PUBLIC-MCP.md) evaluates
paid assistant delegation, later retrieval, feedback, review, uncertain retries
and permission boundaries. It uses the Product E2E fixtures, launcher, evidence
packaging and dashboard, with separate external-assistant and team-worker billing.
The [2026-10-01 results](plans/2026-10-01-public-mcp-paid-eval-results.md) retain
two complete model matrices, provenance, costs and the earlier failure history.

Start with credential-free checks and a catalog listing. For Product E2E:

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list
```

For one explicitly selected local cell, configure only the credentials named
by that cell in `.env.runner-e2e.local`, then run a narrow ID:

```sh
pnpm test:e2e:runner -- --id core-compatibility.runner-codex.local.message-marker
```

Use the selectors documented in the [runner E2E README](../tests/runner-e2e/README.md)
for a suite, profile, case, group, or environment. Daytona needs the immutable
image digest and `DAYTONA_API_KEY`; follow the README and fixture security guide.
`--all` excludes manual suites such as `everyday-workflows`. Select that suite
explicitly; use a narrow selector while developing a fixture.

For Runner Evals, the narrowest useful local validation is the report program's
help/validation path and the deterministic Runner checks documented in
[`runner-workflow-evals.md`](../packages/paperclip-runner/docs/runner-workflow-evals.md).
Hosted direct live runs must use the default-branch workflow, an exact 40
character `evals_sha`, an explicitly selected roster (or the maintained
enabled `all` campaign), and the protected paid environment. The complete
hosted command is intentionally kept in the workflow and
[direct live protocol guide](../packages/paperclip-runner/docs/runner-protocol-live-evals.md).
Live provider runs can spend money; use the existing workflow authorization and
the user's stated scope when selecting them.

## Failure taxonomy

Record the primary failure class and preserve the evidence that supports it.

- **Product failure:** evidence shows Paperclip or Runner behavior violates the
  authored case or a hard invariant, such as wrong task state, missing approval
  gate, lost persistence, bad artifact, or incorrect protocol operation.
- **Model/provider behavior failure:** the provider turn completed with usable
  evidence but the model gave the wrong answer, ignored an interaction, failed
  to complete the authored operation, or violated a semantic assertion. It is
  scored as behavior, not silently retried as infrastructure.
- **Grading/evidence failure:** the case or matcher cannot establish its claim,
  a required recording/screenshot/result is malformed, or the report contract
  is invalid. Fix the harness or grader before interpreting the score.
- **Infrastructure failure:** the evidence points to provider/profile
  unavailability, transport admission failure, service startup failure, a
  missing credential/image, or inability to produce usable evidence. Startup,
  transport, and timeout symptoms can instead be product defects when evidence
  implicates Paperclip or Runner; classify from the observed failure and
  supported cause, rather than the symptom name alone. Preserve the artifact.

Missing usage or price data means unknown, not free. Keep provider-reported
costs separate from estimates, and include retry costs when available.
Latency, cleanup, billing coverage, and unpriced usage are dimensions of the
result and should remain visible alongside the primary class. A timeout after
successful product state reads can be a product behavior failure; a failed
server-health read may be infrastructure, but inspect its cause. Use the
family-specific classifier and read the attempt evidence before changing an
analytical label.

## Evidence, provenance, and history

Polling latency is an interval rather than an exact first-detection time. The
[Product E2E timing contract](../tests/runner-e2e/README.md#latency-observation-bounds)
keeps last-absent/first-present bounds, resolution, strict or inclusive targets,
and pass/fail/inconclusive timing verdicts alongside the unchanged workflow grade.

Retained result snapshots and dated measurement reports belong in
`paperclip-evals`; application tests, Product E2E fixtures/graders, and executable
scenario inventories remain in this repository. Keep a compact results index
with immutable archive links and public report links, as in the
[lifecycle baseline](../tests/lifecycle-baseline/README.md#recorded-results-moved-to-paperclip-evals).
The private archive is not a dependency of app test execution. Keep large logs,
traces, and videos in the existing campaign artifact storage.

An Evalbook report is a presentation of immutable attempt records, not the
source of truth. Keep the campaign ID, Paperclip commit, `paperclip-evals`
commit, catalog/roster or definition fingerprint, model/profile, environment,
grader version, selected cells, retries, and provider/runtime usage with the
report. Public projections follow each family's reviewed allowlist and may
include sanitized fixture conversation, named tool outcomes, screenshots, and
structured evidence intended for public history. Credentials, secrets, private
data, raw unredacted records, and hidden reasoning stay out of public
projections.

Distinguish a complete campaign from a partial campaign. A narrow selector,
manual diagnostic, missing cell, or infrastructure retry can be useful evidence
without being a qualification run. History should retain both, with explicit
coverage and completeness, while trend and latest-green views compare only
compatible complete campaigns. Refreshing an existing report from retained
evidence has zero provider calls and is a new presentation of the old
measurement, not a new model run.

Product E2E test details and screenshot galleries show the recorded application
URL when it is available. The worker environment, such as Daytona, does not
imply an application URL. Public projections can retain the reviewed URL in
`targetUrl`. Test details put recorded checks first and keep raw usage, timing,
and startup evidence under Diagnostics. Optional `presentation` metadata in a
retained campaign supplies its title, description, notes, and evidence links
inside the shared report shell when the dashboard is regenerated.

Standard runner Product E2E attempts also retain a sanitized `taskChat` recording
for Test details: task briefs, complete saved messages, requests and answers,
and native agent progress. Related task threads are separate; incomplete capture
is labeled. This automatic capture runs before teardown on success and failure.
See the [Product E2E evidence contract](../tests/runner-e2e/README.md#evidence-and-cleanup).

Existing public histories are available at
[Runner protocol history](https://d1p6rlowie26tp.cloudfront.net/runner-protocol-evals/index.html)
and [Runner Product E2E history](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/).
The consolidated eval hub is at
[pages.paperclip.ing/evals](https://pages.paperclip.ing/evals/).

For a repeatable workflow, use the matching skill: [paperclip-evals](../.agents/skills/paperclip-evals/SKILL.md),
[add-runner-eval](../.agents/skills/add-runner-eval/SKILL.md), or
[add-product-e2e-eval](../.agents/skills/add-product-e2e-eval/SKILL.md).

## Diagnose failures before buying another campaign

Use this loop to turn eval failures into product improvements. The unit of work
is a broken user outcome or invariant, not an individual red cell.

1. **Freeze the evidence.** Record the inspected application revision and each
   campaign's evaluated revision, definition/grader fingerprint, model/profile,
   environment, exact selected IDs, attempts, and usage coverage. Read the
   history feed and retained attempt records before launching models. A report
   refresh, skipped workflow, passing unit suite, or old-definition green cell
   is not a new live measurement. Inventory explicit-only suites separately
   from `--all`.
2. **Reconstruct the failed boundary.** Read durable task state, interactions,
   event chronology, source/worker identity, delivered output, and the failing
   assertion. State whether the test reached the boundary it claims to test.
   Separate observed failure, machine class, analytical cause, and confidence.
   A cancelled queued wake does not by itself prove lost work; a failed decline
   assertion does not prove unauthorized execution. A saved artifact does not
   prove the user received a correct completion update.
3. **Group by cause and product contract.** Join cells only when their evidence
   supports the same mechanism. Check for already-merged fixes and definition
   corrections before proposing new work. Keep product defects, provider/model
   behavior, grading defects, infrastructure, and unexercised boundaries
   distinct. Preserve the original grades when attribution changes.
4. **Design the smallest general correction.** Name the desired user behavior,
   the authoritative state/transaction or provider boundary that owns it, the
   affected callers, and the existing guarantees that must survive. Check it
   against `PRODUCT.md` and `SPEC-implementation.md`. A change to an intentional
   product rule is a contract change, not an excuse to delete its guard. Avoid
   case-name branches, phrase-specific prompts, unconditional retries, or
   weakening approval, ownership, cancellation, and budget gates to get green.
5. **Prove the mechanism cheaply.** Calibrate a grader against correct and
   plausible wrong retained evidence. Reproduce a product race with scripted
   providers or service tests. Pair every proposed fix with a regression that
   exercises the opposite boundary (for example, eligible delivery versus
   revoked access, benign obsolete wake versus interrupted active work).
   Presentation-only changes use the existing report refresh path and make no
   provider calls; do not claim replay can prove changed runtime behavior.
6. **Select a bounded live confirmation.** Write the exact failed representative
   IDs and only the passing controls affected by the change. Pin the source,
   definitions, models, and remote image. Record an attempt cap, provider and
   compute budget, wall-clock deadline, and concurrency before dispatch under
   the existing live-run authorization. Missing pricing means unknown, not free.
   Do not rerun unaffected green cells during diagnosis or retry usable behavior
   failures until they happen to pass. Preserve every attempt. Expand to a
   compatible qualification campaign only after the causal fix passes.
7. **Close with evidence and remaining scope.** Report original versus new
   measurements, exact selected coverage, regression results, cost coverage,
   and unresolved boundaries. A partial verification may close one defect; it
   cannot turn the full catalog green or establish reliability from one attempt.

Keep one triage record per cause with: affected cell IDs; evidence links;
observed failure; supported cause and confidence; existing fix/revision; proposed
product contract; invariant regressions; next exact live selection; budget and
stop condition; owner; and disposition. Useful dispositions include confirmed
product defect, model behavior, grader correction, infrastructure repair,
fixed-but-not-remeasured, historical pass, and unqualified coverage.

Parallelize independent artifact inventory, deterministic checks, and isolated
cells. Keep a cell's dependent turns ordered. When delegating, use inexpensive
agents for bounded extraction, catalog reconciliation, and test execution; keep
causal attribution, product design, and final review with the lead. Begin local
browser campaigns at the documented conservative concurrency and increase only
with measured host headroom. Hosted fanout must respect the workflow's provider
and fleet caps; more simultaneous timeouts do not improve wall-clock efficiency.

Current tools support exact-ID selection and retained-evidence report refresh,
but not an automatic cause-aware "rerun unresolved failures" planner. Build an
explicit selection manifest rather than treating `--all` as that planner. Review
the launcher's automatic retry policy when budgeting; Product E2E may create one
fresh attempt for a retryable failure.

## Install the authoring skills

The reviewable sources live in this repository's `.agents/skills`. For a
multi-repository workspace, install the three skills at
`~/paperclipai/.agents/skills` (not `~/paperclipai/skills`). From the Paperclip
checkout, run:

```sh
for skill in paperclip-evals add-runner-eval add-product-e2e-eval; do
  install -d "$HOME/paperclipai/.agents/skills/$skill"
  install -m 644 ".agents/skills/$skill/SKILL.md" \
    "$HOME/paperclipai/.agents/skills/$skill/SKILL.md"
done
```

This replaces only the three named skill entrypoints. Run it again after
updating their tracked sources. Each skill locates the repository independently
of its installation directory.

## Maintain the public hub

The hub is a static directory with two links to the existing history systems.
It displays a dated snapshot, not a live scoreboard. It does not run models,
create another result archive, or change the existing campaign URLs.

Build from the public history feeds and check its summary logic:

```sh
python3 -m unittest discover -s scripts/evals-hub -p 'test_*.py'
python3 scripts/evals-hub/build.py --output .paperclip/evals-hub
```

The hub checks need Python 3 and do not call model providers.

For offline checks, pass `--history-dir <directory>` containing
`runner-protocol-evals-history.json` and `runner-e2e-history.json`.
For a pre-merge preview, pass `--docs-ref <branch-or-sha>` to link the guide
at that revision. The default guide link uses `master`.

Publish with the [Paperclip page helper](../.agents/skills/paperclip-page/SKILL.md)
and the configured page-uploader credentials. Use Bash 4 or newer; macOS's
system Bash 3 cannot run this helper. On macOS with Homebrew Bash installed,
put `$(brew --prefix bash)/bin` first in `PATH` before these commands:

```sh
export PAPERCLIP_PAGE_BUCKET=pages.paperclip.ing
export PAPERCLIP_PAGE_BASE_URL=https://pages.paperclip.ing
export AWS_REGION=us-east-1
bash .agents/skills/paperclip-page/scripts/publish.sh .paperclip/evals-hub --slug evals --dry-run
bash .agents/skills/paperclip-page/scripts/publish.sh .paperclip/evals-hub --slug evals
```

For later refreshes, rebuild in the same output directory and publish with
`--update`. Keep its ignored `.paperclip-page/state.json` ownership record;
without that record, the helper will refuse to overwrite an existing prefix.
Verify the public page and its links after publication. This manual refresh
does not add a scheduled workflow. Preserve the measurement date when choosing
a newer rendering of the same campaign.

Remaining native chat boundaries are in the explicit-only
`agent-chat-qualification` suite: active task reassignment, user Retry after
verified worker process loss, and multi-turn answers grounded in actual task
records. See the [workflow and qualification limits](../tests/runner-e2e/README.md#remaining-native-agent-chat-qualification).
The 26 native `first-task` cells inspect the production wizard's saved native
default on qualified targets, without an API runner switch. The 26 Legacy cells
select Legacy explicitly in Advanced. Live results and semantic answer reviews must accompany
any qualification claim; catalog presence alone is not a pass.

The explicit-only [native question/resume qualification](../tests/runner-e2e/README.md#task-continuation)
separates a completed two-answer user journey from semantic-tool documentation
qualification. It verifies the exact provider-pause or semantic-response-wake
binding for each answer and preserves prior grades when the definition changes.

## Lifecycle behavior baseline

The credential-free [lifecycle baseline](../tests/lifecycle-baseline/README.md)
joins unit, scripted-runner, and database integration assertions to a scenario
inventory before changing narrative-based lifecycle policy. Run
`pnpm test:lifecycle-baseline` to retain current passes and failures. Its Product
E2E matcher calibration is separate from live execution; unrun live coverage
remains explicitly unmeasured.

The separate [live lifecycle baseline](../tests/runner-e2e/LIFECYCLE-BASELINE.md)
defines 46 real-provider Product E2E cells, including paired narrative probes and
named existing controls on legacy and native Codex. Discover it with
`pnpm test:e2e:runner -- --list --suite lifecycle-baseline`. Historical execution
results and follow-up coverage are recorded in that suite's guide.

Continuation accounting has an explicit-only eight-cell Product E2E [baseline suite](../tests/runner-e2e/CONTINUATION-ACCOUNTING.md), complementing the deterministic lifecycle inventory.

The explicit Product E2E `instruction-persistence` suite verifies private file
edits, nested and binary agent files, stopped-provider directory saves, server restart, and a fresh task's
downloaded proof on local native/legacy Codex and native Daytona. See the
[Product E2E runbook](../tests/runner-e2e/README.md).

The explicit-only Product E2E `api-response-reading` suite verifies retrieval of
large saved API responses on local and Daytona native Codex runs. See the
[Runner E2E guide](../tests/runner-e2e/README.md#bounded-api-response-reading).

The explicit-only Product E2E `extended-harnesses` suite covers pending Cursor,
Copilot and Pi ACP profiles on local and Daytona. See the
[fixture admission, credentials and budget contract](../tests/runner-e2e/README.md#extended-acp-harnesses-explicit-only).
The private Runner Evals campaign of the same name provides complementary
semantic protocol cases; catalog membership is not live qualification.

The explicit local [Copilot protection fixtures](../tests/runner-e2e/FIXTURES.md#copilot-native-protection)
exercise native permission denial with operator cancellation and bounded attached
command settlement. Their registration remains separate from paid qualification;
source/pack provenance and complete persisted evidence are required.
The explicit-only Product E2E `confirmation-replies` suite tests conversational
approval and rejection, persisted message provenance, approval before execution,
ambiguous proposals, and the existing card-click path with native Claude/Codex.
See the [suite contract](../tests/runner-e2e/README.md#conversational-confirmation-replies-explicit-only).

Hiring notification accounting now also requires exact completed action attribution. Missing native/provider ID mapping is uncomparable evidence; it must not be reported as a model task regression or waived through name/order matching. The fixture waits for both known completion callbacks and settled bracketed observations, including the gap before pending outbox work becomes a wake. Strict action replay and original machine verdicts are retained separately.

The explicit-only [planning guidance utility comparison](../tests/runner-e2e/PLAN-TASK-GUIDANCE.md) measures task decomposition and handoffs with current, short, and disabled skills.

The explicit-only [task-workspaces Product E2E suite](../tests/runner-e2e/README.md#projectless-task-workspaces-explicit-only)
covers projectless task files, deferred repository acquisition, controller restart
and nested Git/dirty-file persistence on legacy local, native local and native
Daytona OpenCode. Its three configured cells use independent filesystem, public
API and download oracles; no live qualification is implied by fixture registration.

The explicit-only [feedback persistence case](../tests/runner-e2e/README.md#feedback-persistence-explicit-only)
checks real native complaint/suggestion submissions and retained bodies with
run-attributed tool receipts on local and Daytona execution. Its four native
Claude/Codex cells are explicit-only. Remote registrations remain unqualified
until retained live attempts prove them. It uses the normal Product E2E report
and keeps synthetic feedback distinct from actionable product findings.
