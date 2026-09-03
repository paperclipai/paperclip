# Paid runner full-stack E2E

This is the billable browser acceptance campaign system for Paperclip runner
profiles. It is deliberately separate from `tests/e2e`: every independently
scheduled execution gets
a fresh Paperclip home, embedded Postgres database, instance configuration,
port, workspace, company, encrypted secrets, environment, and agent.

The vocabulary is: a **campaign** is one workflow invocation against one SHA; a
**suite** is a durable testing purpose; a **matrix** is that suite's profiles ×
environments × cases; an **execution/cell** is one parallel job; and an
**attempt** is one isolated harness run, including an infrastructure retry.

The browser creates and assigns the task. The harness does not call a private
runner hook or write fixtures directly to the database.

## Credentials

Copy `.env.runner-e2e.example` to `.env.runner-e2e.local` and fill only the
credentials needed by the selected cells:

```bash
cp .env.runner-e2e.example .env.runner-e2e.local
chmod 600 .env.runner-e2e.local
```

Shell variables take precedence over the local file. The recognized names are:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `DAYTONA_API_KEY`
- `PAPERCLIP_E2E_DAYTONA_IMAGE` (Daytona only)

The image must be an immutable `image@sha256:...` reference. The launcher
reports missing variable names but never prints values. It passes raw provider
keys only to Playwright, which posts each value once to the company-secrets API.
Paperclip receives secret references in agent/environment payloads. Provider
keys, Daytona keys, `DATABASE_URL`, and `DATABASE_MIGRATION_URL` are removed
from the Paperclip child process.

Never put credentials in `catalog.ts`, screenshots, fixture metadata, workflow
inputs, or a tracked env file.

## Local commands

Install dependencies and Chromium once. Native local cells also need the local
runner binaries:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm --filter @paperclipai/paperclip-runner build:runner-binaries
```

List cells without loading credentials or starting Paperclip:

```bash
pnpm test:e2e:runner -- --list
```

Examples of explicit billable runs:

```bash
pnpm test:e2e:runner -- --id core-compatibility.legacy-codex.local.message-marker --headed
pnpm test:e2e:runner -- --suite openrouter-model-breadth --case hello-complete
pnpm test:e2e:runner -- --group native --environment local
pnpm test:e2e:runner -- --profile runner-codex --case message-marker
pnpm test:e2e:runner -- --case plan-revise-accept --group local
pnpm test:e2e:runner -- --case ask-question --group native
pnpm test:e2e:runner -- --all
```

The catalog contains three suites. `core-compatibility` (**Core Runner
Compatibility**) is seven major runner profiles × local/Daytona × three
workflows: 42 cells. Its cases are:

- `message-marker`: one basic visible response and Done transition;
- `plan-revise-accept`: an initial Plan, a browser-requested revision on the
  same Plan, browser acceptance of the new revision, and verified execution;
- `ask-question`: a direct answer from a task created in Ask mode.

`openrouter-model-breadth` (**OpenRouter Model Breadth**) is four qualified
models from the tracked weekly tool-capable ranking snapshot × native OpenCode
× local, with 11 supported model/workflow cells. Xiaomi MiMo V2.5 remains
recorded in the immutable ranking snapshot but is excluded from paid
qualification because its latency repeatedly exhausts the cell deadline.
DeepSeek V4 Flash remains qualified for hello and question/resume, but its Plan
cell is excluded after three successful semantic completions consistently
ignored the required exact final response. Its cases are:

- `hello-complete`: a basic nonce response and explicit Done transition;
- `question-resume-complete`: one structured question, browser selection of
  “Cobalt,” then a resumed completion on the same task; and
- `plan-approve-complete`: one exact two-step Plan, browser approval of that
  revision, then a resumed completion on the same task.

`local-session-integrity` (**Local Session Integrity**) is the seven supported
local native and direct-adapter profiles × two two-run structured-question
workflows: 14 cells. Both prove that a required structured interaction is
rendered, answered in the browser, and resumed once on the same task without
duplicating the final response. The second workflow restarts the isolated
Paperclip server while the interaction is waiting, reloads that state, and
then resumes it. The suite has no Daytona cells.

The complete catalog is 67 cells and 116 expected paid agent turns. Follow-up
steps remain ordered within their cell; all other cells are independent.
Narrow selectors are strongly recommended while developing fixtures.

`--suite`, `--group`, `--profile`, `--environment`, and `--case` are repeatable. Repeated
values in one dimension use OR semantics; dimensions and repeated groups use
AND semantics. `--id` is exclusive with dimension selectors and `--all`.
`--headed`, `--ui`, and `--debug` are forwarded to Playwright. An unknown
selector, an empty selection, or a run with no explicit selector exits before
Paperclip starts. `--max-parallel <n>` controls the number of isolated
profile/environment/case harnesses that can overlap (default 1, also configurable
with `PAPERCLIP_E2E_MAX_PARALLEL`). Headed/UI/debug runs are forced to one worker.
The Plan case is still sequential internally because its turns share one task;
it runs in parallel with unrelated scenarios.

Use a single `--id` smoke test for routine local verification. Full-matrix
parallelism is intended for GitHub Actions; raising local parallelism starts
multiple Paperclip/Postgres/Chromium stacks and can consume substantial CPU and
memory.

Credential-free checks are:

```bash
pnpm test:e2e:runner:unit
pnpm test:e2e:runner:typecheck
```

The OpenRouter ranking snapshot is tracked in `openrouter-models.json`; nightly
runs never mutate it. Refresh it deliberately, review the source/capture/hash
diff, and rerun credential-free checks:

```bash
pnpm test:e2e:runner:models:update
```

## Daytona image

Use the immutable digest printed by the `Publish verified Daytona image` job,
or publish the current source locally:

```bash
content_id="$(pnpm --silent test:e2e:runner:image-id)"
source_revision="$(git rev-parse HEAD)"
image="ghcr.io/paperclipai/paperclip-daytona-runner:e2e-content-${content_id}"
if ! docker buildx imagetools inspect "$image" >/dev/null 2>&1; then
  docker buildx build \
    --platform linux/amd64 \
    --build-arg "PAPERCLIP_RUNNER_CONTENT_ID=${content_id}" \
    --build-arg "PAPERCLIP_RUNNER_SOURCE_REVISION=${source_revision}" \
    --file docker/daytona-runner/Dockerfile \
    --tag "$image" \
    --push \
    .
fi
docker buildx imagetools inspect "$image"
```

The content ID hashes the audited image inputs, including the Dockerfile,
platform, root package/lock/build configuration, dependency patches,
`paperclip-eval-kernel`, and `paperclip-runner`. Changes elsewhere in the
repository keep the same tag and reuse the already signed image. The Git SHA is
stored separately as image provenance. CI reads that provenance back from a
reused image when it builds the controller-side provider pack, preserving the
exact manifest match required to avoid restaging the pack into Daytona.

Resolve the manifest digest and set `PAPERCLIP_E2E_DAYTONA_IMAGE` to
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:...`. The repository
workflow signs that digest with Cosign/OIDC and verifies that it is publicly
pullable, includes the provider pack, and advertises `dial_ws_loopback`,
`dial_wss`, and `listen_ws`. The GHCR package must be configured as public;
the image job deliberately fails its anonymous-pull check otherwise. Existing
content tags are never rebuilt or overwritten by the workflow.

## Evidence and cleanup

Packaged, access-controlled evidence is written beneath
`tests/runner-e2e/results/<campaign>/...`. Passing attempts include
`final-state.png`, Plan draft/revision screenshots when applicable, matcher
outcomes, sanitized fixture/API metadata, a result record, JUnit, HTML, and a
blob report. Failures additionally retain the Playwright trace/video, browser
diagnostics, failure screenshot, and sanitized Paperclip/run logs when
produced. PNG and WebM files are not pixel-inspected, so they are suitable only
for the local results directory and access-controlled GitHub Actions artifacts.
SVG is active content and is rejected from the packaged evidence entirely.

Every completed local campaign also writes
`tests/runner-e2e/results/<campaign>/dashboard.html`. The self-contained page
shows the complete profile/environment grid with screenshot thumbnails.
Expanding a case shows its matchers, pass/fail details, provider/model/runtime,
timings, token and cost accounting, and evidence links. The campaign header
aggregates input, output, and cached tokens, provider-reported LLM spend,
Daytona list-price runtime estimates, and pricing coverage. Missing provider
usage is labeled `unavailable` or `unpriced`; it is never presented as zero
cost. The CI report job stages the same portable site at
`normalized/index.html` inside the access-controlled merged report artifact.

Permanent public history has a narrower boundary. Before uploading to S3 or
packaging the optional GitHub Pages artifact, the publisher removes raster and
video evidence, archives, and the generated Playwright/blob/HTML report trees.
It then regenerates the dashboard against only the remaining allowlisted,
inert structured per-attempt evidence (`.json`, `.log`, `.md`, and `.txt`).
Per-attempt XML is excluded because browsers can process XML/XSLT. The root
`junit.xml` remains public because the report aggregator builds it from fixed
markup and XML-escaped fields. Public dashboards therefore contain results and
accounting but no attempt screenshots, videos, traces, or generated Playwright
reports.

### Billing interpretation

Each result contains raw sanitized `usage`, normalized `billing`, and
`runtimeUsage`:

- LLM token and dollar values come from the persisted heartbeat-run usage. A
  multi-turn case aggregates every selected run and records how many runs
  supplied tokens and provider-reported cost.
- Local execution records agent run time but is `not_metered` because there is
  no external environment provider charge to attribute.
- Daytona records every public-API lease window and its pinned 4 vCPU, 4 GiB
  RAM, and 10 GiB disk allocation. Its runtime dollar value is an estimate at
  the versioned public list rates in `billing.ts`, not an invoice amount.
  Credits, discounts, the storage allowance, and delayed billing adjustments
  can make the eventual Daytona charge lower.

`normalized-results.json` uses the v2 campaign schema and includes per-test,
per-suite, and overall billing. The compact `history.json` index retains the
same metrics per campaign/suite/execution, source SHA/ref, definition
fingerprints, completeness, retries, and cleanup. Trend charts compare only
complete campaigns by default; partial/manual selections remain browsable.
`summary.md` carries the current totals into the GitHub Actions job summary.

### Iterate on a published dashboard without rerunning paid tests

Download and extract the `github-pages` artifact from an existing workflow run,
then regenerate only its HTML from the retained `normalized-results.json` and
public structured evidence files. The Pages artifact has already had private
visual and generated report evidence removed:

```bash
gh run download <run-id> --repo paperclipai/paperclip --name github-pages --dir /tmp/runner-e2e-pages
mkdir /tmp/runner-e2e-site
tar -xf /tmp/runner-e2e-pages/artifact.tar -C /tmp/runner-e2e-site
pnpm test:e2e:runner:dashboard -- /tmp/runner-e2e-site
# Optionally use a downloaded history index:
pnpm test:e2e:runner:dashboard -- /tmp/runner-e2e-site --history /tmp/history.json
```

Serve that directory with any static file server. This path does not start
Paperclip, invoke an agent, create a Daytona lease, or consume provider tokens.

Before an access-controlled evidence artifact is uploaded, the launcher:

1. copies only allowlisted file types;
2. scans raw API snapshots before sanitizing them;
3. scans the closed Paperclip home/database and workspace as streams;
4. redacts loaded exact values and known provider-key shapes from text;
5. expands ZIP reports for secret scanning;
6. rejects SVG and other unsafe files and fails the cell if a leak is detected;
   and
7. verifies that a passing attempt has its final-state screenshot.

The temporary Paperclip home, embedded database, raw workspace, master key,
and unredacted logs are removed after each attempt. Daytona teardown destroys
the environment and any reusable leases through the public API; provider-side
auto-stop/archive/delete values remain as cancellation backstops.

## GitHub Actions

`Runner Full-Stack E2E` has only `schedule` and `workflow_dispatch` triggers; it
never runs for a pull request or ordinary push. Start the trusted workflow from
the default branch. A CODEOWNER can set the optional `target_branch` input to
any branch in `paperclipai/paperclip`. The authorization job resolves that
branch to one immutable commit before any checkout. A separate credential-free
job checks out the resolved commit and regenerates `pnpm-lock.yaml` once with
`--ignore-scripts --no-frozen-lockfile --lockfile-only`. It uploads that exact
lockfile under a run-attempt-scoped artifact ID and records its SHA-256.
Catalog, image, shared-build, provider-pack, and paid test jobs download the
artifact by ID, verify its digest, and restore it before setup or a frozen
install. The shared-build, provider-pack, and paid test jobs all disable
dependency lifecycle scripts, and provider secrets are introduced only in the
final test step. This permits an authorized target branch to exercise an
intentionally uncommitted workspace patch while keeping every target job on one
identical dependency resolution. The shared-build job compiles the selected
campaign's TypeScript outputs and native binaries once, then each paid cell
verifies and extracts the immutable bundle. Remote native cells similarly reuse
one verified provider pack. Report
sanitization and AWS history publication do not consume the target lockfile;
they explicitly check out and install from the trusted workflow commit. The
workflow definition, runner-group permission, and protected-environment
deployment still come from the default branch. Do not select the target branch
in GitHub's **Use workflow from** control.

Because this repository is public, manual campaigns fail before checkout unless
the trusted workflow runs from the default branch and both the original actor
and rerun actor have numeric GitHub user IDs in the non-empty JSON-array
repository variable `RUNNER_E2E_ALLOWED_ACTOR_IDS`. Keep this stable-ID list in
sync with the owners of `.github/**` in `.github/CODEOWNERS`. Usernames are
intentionally not trusted. The first scheduled attempt is trusted automation;
any human rerun of a scheduled campaign must pass the triggering-actor
allowlist.

For example, this command runs one branch cell through the trusted default-branch
workflow:

```bash
gh workflow run runner-full-stack-e2e.yml \
  --ref master \
  -f target_branch=fix/example \
  -f all=false \
  -f id=core-compatibility.runner-codex.local.message-marker
```

Create a protected `runner-e2e-paid` GitHub environment, restrict it to the
default branch, limit environment administration to trusted maintainers, and
store the four provider secrets there. This is a second authorization boundary:
the pre-check prevents unauthorized scheduling, while the environment prevents
secret release if the workflow gate is accidentally weakened. Also restrict
Actions to approved actions and require review of `.github/workflows/**` and
`tests/runner-e2e/**` through CODEOWNERS and branch protection. Manual inputs
accept comma-separated values for repeatable dimensions.

The nightly cron is `08:47 UTC`, but scheduled execution is intentionally gated
by the repository variable `RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED=true`. Set it
only after the live acceptance ladder in the architecture plan is green.
Set `RUNNER_E2E_AWS_ENABLED=true` to route paid cells to the repository-scoped
ephemeral AWS RunsOn fleet selected by
`runs-on/fleet=paperclip-public-pr-x64/env=public-ci`. Any other value uses the
proven GitHub-hosted `ubuntu-latest` target. Set `RUNNER_E2E_MAX_PARALLEL` to an
integer from 1–100 on AWS (default 100); use at least 67 to run the current
complete catalog in one wave. The fallback runner retains its 1–57 limit and
default of 32. Multi-turn steps are sequential inside their cell while
independent cells overlap. Artifacts and merged HTML/JUnit/normalized reports
are retained for 30 days.

Restrict the RunsOn fleet to this repository and independently trusted
workflows. Do not let untrusted pull-request or fork-triggered workflows target
it, and require a fresh ephemeral instance for each job so one paid cell cannot
leave state for the next. Provider secrets remain protected by the stable-ID
authorization checks and the default-branch-only `runner-e2e-paid` environment;
the fleet itself is not an authorization boundary. These external fleet controls
are as important as the workflow checks in a public repository. A CODEOWNER
dispatch is an explicit authorization to execute the selected repository branch
with the cell's scoped provider credential.

Development branch campaigns share a concurrency key per target branch and
cancel an older run when a replacement is dispatched. Default-branch target
campaigns are retained and are never auto-cancelled, preserving their audit
trail.

GitHub Actions artifacts are access-controlled 30-day operational copies, not
the permanent public history. They retain packaged PNG/WebM and generated
reports for debugging. Create a second protected `runner-e2e-history`
environment, restricted to the default branch and trusted environment
administrators, then configure these repository variables:

- `RUNNER_E2E_HISTORY_AWS_ROLE_ARN`
- `RUNNER_E2E_HISTORY_AWS_REGION`
- `RUNNER_E2E_HISTORY_S3_BUCKET`
- `RUNNER_E2E_HISTORY_PUBLIC_BASE_URL`
- optional `RUNNER_E2E_HISTORY_PREFIX` (default `runner-e2e`)

The job exchanges GitHub OIDC for short-lived AWS credentials; never add AWS
access-key secrets. Its IAM role must trust only
`repo:paperclipai/paperclip:environment:runner-e2e-history`, and permit only
Get/List/Put under the configured prefix—never Delete. Enable S3 versioning and
Block Public Access. CloudFront reads the private bucket through Origin Access
Control. Immutable campaign bundles live under `campaigns/<run-id>-<attempt>/`;
mutable `history.json`, `latest.json`, and `latest-green.json` are updated by a
globally serialized publisher. An existing campaign key with a different
bundle digest fails closed.

GitHub Pages remains the stable latest dashboard. Enable Pages with GitHub
Actions as its source and set `RUNNER_FULL_STACK_E2E_PUBLISH_PAGES=true`.
The publisher prunes screenshots, video, archives, and generated report trees,
then regenerates the public dashboard before either the CloudFront-backed S3
history or optional Pages artifact is created. Public per-attempt evidence is
limited to allowlisted inert structured text. Databases, Paperclip homes,
workspaces, raw/unredacted logs, credentials, and visual evidence are never
published. Sanitized allowlisted `.log` copies may be public only after
exact-value/key-shape scanning and redaction.

See [FIXTURES.md](./FIXTURES.md) before adding or changing a profile,
environment, task, matcher, or future Paperclip object fixture.
See [SECURITY.md](./SECURITY.md) before enabling paid dispatch, the runner
group, or permanent public history in this public repository.
