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
