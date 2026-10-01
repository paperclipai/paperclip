# Paperclip evaluation guide

Paperclip has two live eval families with different questions, owners, and
evidence. Choose the family before selecting a model, profile, or case.

- **Runner Evals:** real Runner/provider behavior against a seeded mock control
  plane. Definitions live in `paperclip-evals/evals/paperclip-runner`; see the
  [direct live protocol evals](../packages/paperclip-runner/docs/runner-protocol-live-evals.md).
- **Product E2E Evals:** real browser, Paperclip server, database, Runner,
  provider, and (where selected) Daytona, using an isolated instance and
  grading oracle. See [`tests/runner-e2e`](../tests/runner-e2e/README.md) and
  [Everyday Workflows](../tests/runner-e2e/EVERYDAY-WORKFLOWS.md).

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

## Selecting a family

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

The explicit-only `context-integrity` Product E2E suite covers ordered public
comment continuation and explicit invocation of an assigned pinned skill across
the seven selected legacy/native local profiles. Select it by suite or exact
execution ID because `--all` excludes explicit-only suites. Each cell applies a
1,000-cent company and agent budget hard stop before task creation and records
both limits in its evidence.

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
The 26 native `first-task` cells exercise onboarding before native selection
becomes the UI default. Live results and semantic answer reviews must accompany
any qualification claim; catalog presence alone is not a pass.

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

The explicit-only Product E2E `confirmation-replies` suite tests conversational
approval and rejection, persisted message provenance, approval before execution,
ambiguous proposals, and the existing card-click path with native Claude/Codex.
See the [suite contract](../tests/runner-e2e/README.md#conversational-confirmation-replies-explicit-only).
