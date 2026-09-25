# Paid runner full-stack E2E

For family selection, ownership, provenance, history, and failure taxonomy,
see the [Paperclip evaluation guide](../../doc/evals.md). This README is the
authoritative runbook for Product E2E runner cells; the separate Runner Evals
protocol guide lives at
`packages/paperclip-runner/docs/runner-protocol-live-evals.md`.

This is the billable browser acceptance campaign system for Paperclip runner
profiles. It is deliberately separate from `tests/e2e`: every independently
scheduled execution gets
a fresh Paperclip home, embedded Postgres database, instance configuration,
port, workspace, company, encrypted secrets, environment, and agent.

The vocabulary is: a **campaign** is one workflow invocation against one SHA; a
**suite** is a durable testing purpose; a **matrix** is that suite's profiles ×
environments × cases; an **execution/cell** is one parallel job; and an
**attempt** is one isolated harness run, including an infrastructure retry.

The browser creates and assigns the task; fixtures use public APIs. The
`accept-while-running` case additionally holds the committed card’s creation
response in the test server until browser acceptance, to exercise real overlap.

The launcher always sets `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` for its isolated
instances so announcement panels do not obscure screenshot evidence. No shell
or workflow configuration is needed, including for Daytona cells.

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
pnpm test:e2e:runner -- --suite daytona-warm-continuity
pnpm test:e2e:runner -- --all
```

The catalog contains nine suites, including the explicit-only suites. `core-compatibility` (**Core Runner
Compatibility**) is seven major runner profiles × local/Daytona × three
workflows: 42 cells. Its cases are:

- `message-marker`: one basic visible response and Done transition;
- `plan-revise-accept`: an initial Plan, a browser-requested revision on the
  same Plan, browser acceptance of the new revision, and verified execution;
- `ask-question`: a direct answer from a task created in Ask mode.

`openrouter-model-breadth` (**OpenRouter Model Breadth**) is four qualified
models from the tracked weekly tool-capable ranking snapshot × native OpenCode
× local, with 10 supported model/workflow cells. Xiaomi MiMo V2.5 remains
recorded in the immutable ranking snapshot but is excluded from paid
qualification because its latency repeatedly exhausts the cell deadline.
DeepSeek V4 Flash remains qualified for hello and question/resume, but its Plan
cell is excluded after three successful semantic completions consistently
ignored the required exact final response. Tencent HY3 likewise remains
qualified for hello and question/resume, but its Plan cell is excluded after
two fresh attempts completed every durable Plan and finalization operation yet
consistently replaced the required exact visible terminal marker with prose.
Its cases are:

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

`daytona-warm-continuity` (**Daytona Warm Continuity**) is exactly two paid
cells: legacy Codex and Runner Codex against one reusable warm Daytona
configuration. Each cell creates a real project with a primary local-path
workspace through the API, selects it in the browser task dialog, and performs
three browser-driven turns on one issue. Every turn reads and extends the same
nonce file, verifies host copy-back, records scheduler/run/end-to-end timing,
and asserts `created`, `resumed`, `resumed` lease acquisition on one sandbox.
Runner Codex additionally proves stable native session, provider session,
runner instance, PID, and process-start identity. Each turn is bounded to ten
minutes, the cell to thirty minutes, and cleanup explicitly deletes the
sandbox rather than waiting for Daytona's idle timeout.

`agent-chat` (**Persistent Agent Chat**) has eight workflows on `legacy-codex`,
`legacy-claude`, `runner-codex`, and `runner-acpx-claude`: **28 local cells**.
They cover continuity across server restart, fresh context after `/new`,
Stop/reset/resume, draft/revise/approve/plan handoff, clarification with existing
project reuse, and a new project with two repository URLs. Each cell opens the
production chat surface and resolves the backing issue through the chat API.
The source conversation must settle to `in_review` / `waiting`; handed-off
execution tasks must finish with their initial Plan and output documents.
Reset runs are retained separately from the 76 expected run attempts in this
suite. Cancelled turns and execution-task runs remain included in billing and
cleanup. The production chat directive is injected normally; fixtures do not
replace it with completion instructions. Daytona is excluded.

The native chat profiles use production provider permission defaults, rather than
full-auto overrides, for plan handoff, task creation, and reassignment.
The native Codex and Claude profiles also cover reassignment of existing ready
and backlog tasks. The oracle verifies stable task IDs, preserved descriptions,
assignment audit evidence, exactly one successful successor run and its output
document, no backlog execution, and a usable source conversation after reload.

`agent-chat-hardening` is an explicit-only native Codex/Claude suite with
**18 cells: 12 local and six warm Daytona**. It adds startup Stop/reset,
hire/delegate/reuse, grounded blocker reporting with source-document review,
and committed-send retry. It also runs active Stop/reset and restart continuity.
Daytona selects active Stop/reset, restart continuity, and committed-send retry.
The 56 expected run attempts include cancelled attempts; synthetic resets are
recorded separately. The suite uses production permission defaults and prompts.
Only hiring and cross-task status/review enable the opt-in native API tools.
Hiring uses a personal managed AI connection and verifies the hired worker's
actual execution account. This is not an onboarding-default qualification.
The hiring checklist and review request a `Reference: ...` line. This gives the
fixture marker a neutral label instead of leaving the agent to choose credential
syntax such as `Tracking token: ...`. Exact marker, authorship, worker reuse,
and saved-output checks remain required. This case tests coordination, not
credential-redaction policy.

Stop during startup and Stop during an active response are separate boundaries.
The native active-response case requires a recorded provider turn start; generic
lifecycle/performance events are insufficient. The startup case must stop after
a process launch request but before a provider turn starts. Missing the boundary
fails the case instead of silently testing another phase.

Restart continuity requires the agent to recall a phrase after the server
restarts. The final prompt does not reveal that phrase. A generic successful
reply after restart cannot pass this check.
The browser leaves the old development client before the server stops, then
opens the canonical chat route and waits for the composer. This avoids racing
Vite's automatic reconnect navigation against the test's explicit navigation.

The blocker query requests a JSON status snapshot. It must name the current
recorded blocker and report zero active runs independently of the task's blocked
status. Mentioning the right blocker only as resolved history cannot pass.

The committed-send case drops the browser's acknowledgement after the server
saves its comment. It waits for the agent to save one backlog task, restarts
Paperclip, and replays the exact public request with the original client request ID. It
requires the original comment, task, plan, and single consuming run. This proves
HTTP request idempotency across restart, not replay safety for an ambiguous
provider tool response. Existing native tool-receipt tests cover that boundary.

`agent-chat-stories` adds six explicit-only local cells across native Codex and
Claude. `enable-disable-resume` uses the Experimental settings UI to enable
Agent Chat, starts a conversation, disables new messages, verifies the public
write endpoint rejects a send without creating work, and re-enables the same
conversation with its remembered context. The company, credential, and native
agent are fixture-provisioned. This qualifies the experimental-settings path,
not native first-run onboarding: the current production wizard offers legacy
adapters, and native API tools remain an independent opt-in.

`followup-while-running` and `revise-while-running` send a second browser message
while the provider runs a bounded command waiting for a fixture brief file.
The command publishes its own readiness file; the harness verifies the original
run is still active after the follow-up is saved, then supplies the brief.
The final reply must contain the previously undisclosed brief reference and the
new request's marker. The revision case also checks the saved plan uses Friday
instead of the original Monday. The oracle permits either steering the active
run or one queued successor, but rejects missing/duplicate comments, failed or
unfinished runs, stale plan contents, and unintended tasks/projects. This does
not qualify active-task reassignment or worker-crash recovery.
The maximum run count remains the cost estimate; the shared harness honors the
one-run minimum only for these two interruption cases. Exactly one reply may
consume the follow-up marker, and it must be attributed to the final provider run.

```sh
pnpm test:e2e:runner -- --list --suite agent-chat-hardening
pnpm test:e2e:runner -- --id agent-chat-hardening.runner-codex.local.stop-startup-new-resume
```

Each hardening oracle has positive and plausible-negative calibration tests.
The review grader parses the worker's saved JSON and compares both source values
and the consistency verdict. Hiring requires one identity, correct reporting
line, managed credentials, and real task execution; chat claims cannot pass it.

```bash
# Run these after deterministic checks, with the required provider keys set.
pnpm test:e2e:runner -- --id agent-chat.legacy-codex.local.continuity-restart
pnpm test:e2e:runner -- --id agent-chat.legacy-claude.local.continuity-restart
pnpm test:e2e:runner -- --suite agent-chat
```

The regular browser suite has deterministic process providers in
`tests/e2e/fixtures/agent-chat.mjs`. It exercises the real queue, APIs, database,
MCP project tools, and shared task UI without provider billing. Only upstream
GitHub discovery is simulated, scoped to a fixture-only credential; repository
permissions and mutations remain real. Run it with:

```bash
pnpm --filter @paperclipai/ui build
pnpm test:e2e tests/e2e/agent-chat.spec.ts
# Against a dedicated authenticated test instance configured per that suite:
pnpm test:e2e:multiuser-authenticated --grep 'agent chats'
```

Both suites save and restore experimental settings. Browser E2E always starts a
throwaway instance; never point the authenticated suite at the running demo.
Missing provider credentials fail paid preflight and are not passing coverage.

The default `--all` selection is 171 cells (148 local and 23 Daytona) and 371
expected paid agent turns. The explicit-only everyday suite adds 38 catalog cells
and chat hardening adds 18; chat stories adds six. All three are excluded from
`--all`. The full catalog has 239 cells.
Follow-up steps remain ordered within their cell; all other
cells are independent. Narrow selectors are strongly recommended while
developing fixtures.

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

### Match the local controller package to the Daytona image

Native ACPX (including Claude) and OpenCode Daytona cells also require
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` on the controller. The package and
the image must come from the same verified build. Equal provider version numbers
are insufficient: verification compares the complete manifest, source revision,
Node executable, lockfile, and built bridge hashes. An independently rebuilt
package can fail that comparison and trigger a large upload before any model
work begins.

Prefer the hosted workflow: it builds the image and controller package together,
and uses the image's recorded source revision when reusing an image. For a local
run, use the immutable image from the campaign for the code under test and copy
its exact package. Do not copy credentials or change manifest fields to force a
match. Docker must be running; the temporary container below is never started.

```sh
(
  set -eu
  : "${PAPERCLIP_E2E_DAYTONA_IMAGE:?Set the verified immutable image digest}"
  case "$PAPERCLIP_E2E_DAYTONA_IMAGE" in
    *@sha256:*) ;;
    *) echo "Use an immutable image digest" >&2; exit 1 ;;
  esac
  docker pull --platform linux/amd64 "$PAPERCLIP_E2E_DAYTONA_IMAGE"
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-e2e-provider-pack.XXXXXX")"
  container_id="$(docker create --platform linux/amd64 --network none \
    --entrypoint /bin/true "$PAPERCLIP_E2E_DAYTONA_IMAGE")"
  trap 'docker rm "$container_id" >/dev/null' EXIT
  docker cp "$container_id:/opt/paperclip-runner/provider-pack/." "$pack_dir/"
  test -f "$pack_dir/provider-pack.json"
  printf 'Set PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to: %s\n' "$pack_dir"
)
```

Export the printed path in the shell that launches the eval. Runtime verification
still checks all package artifacts. The run log must show
`using manifest-matched provider pack from the sandbox image`; after reuse it can
instead show `reusing manifest-matched provider pack from the workspace`. A setup failure before provider
execution does not measure Claude recovery. Keep cold-upload coverage separate
from the recovery test, and retain mismatched or failed attempts as evidence.

## Evidence and cleanup

Packaged, access-controlled evidence is written beneath
`tests/runner-e2e/results/<campaign>/...`. Passing attempts include
`final-state.png`, Plan draft/revision screenshots when applicable, matcher
outcomes, sanitized fixture/API metadata, a result record, JUnit, HTML, and a
blob report. Failures additionally retain the Playwright trace/video, browser
diagnostics, failure screenshot, and sanitized Paperclip/run logs when
produced. WebM files remain limited to the local results directory and
access-controlled GitHub Actions artifact. Declared PNG screenshots are also
published with permanent campaign dashboards; fixture authors must therefore
keep credentials and other private data out of every captured UI state. SVG is
active content and is rejected from the packaged evidence entirely.

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

The trusted publisher discovers display-only entries for selected execution IDs
absent from its local catalog, so branch-only suites remain visible in the
dashboard, filters, gallery, and summary image. It validates execution identity
and escapes display text without loading target-branch executable code. Unknown
suite cardinality is not treated as proof of full-suite coverage.

Permanent publication uses two explicit bundles. Both retain only normalized
result PNG files with the explicit `public-runner-fixture` publication marker,
including marked `failure.png` captures, so every campaign dashboard has its
screenshot thumbnails and gallery. The capture helper adds this marker only
for the reviewed runner fixture and blocks public capture outside the exact
issue route for the fixture that the harness created. A blocked failure capture
remains private. The CloudFront-backed S3
history also contains one publisher-generated
`public-images/campaign-summary.png`.
Trusted publisher code renders it offline from fixed catalog labels and
sanitized status/count/duration fields; provider output, error text, comments,
and target-produced pixels are never inputs. The PNG must pass a 12 MiB bound
and signature validation before entering the immutable manifest. S3 also
retains allowlisted inert per-attempt evidence (`.json`, `.log`, `.md`, and
`.txt`); `.log` copies have already passed exact-value/key-shape scanning and
redaction. The GitHub Pages bundle is regenerated separately with the same
declared-screenshot boundary.

Publication fails if any declared public screenshot is missing from the bundle.
The evidence packager explicitly retains `chat-plan-draft.png` and
`chat-plan-revised.png`; arbitrary chat-prefixed files remain excluded.

Both public bundles exclude video, archives, raw/unallowlisted logs, SVG or
other active content, generated Playwright/blob/HTML report trees, and
undeclared PNG files, and per-attempt XML. The root `junit.xml` remains public
because the report aggregator builds it from fixed markup and XML-escaped
fields. Full evidence remains available only in the access-controlled workflow
artifact.

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
In CI, its **View results** section links to the exact immutable public campaign
report, the workflow and per-cell logs, and the access-controlled report
artifacts. Each cell name links to its exact section in the campaign report.
The public campaign links become available after the history publisher
finishes. The artifact links remain available for 30 days.

For a development branch that adds a suite, the trusted default-branch dashboard
may not yet include that suite's interactive cards. Its published `summary.md`
and `normalized-results.json` still contain every selected cell. Use those files,
the GitHub job summary, or `html/index.html` in the merged Playwright artifact
to inspect branch-only results; an absent dashboard card is not passing coverage.

Case details show the overall failure reason separately from behavioral matcher
results. For first-task cases, **Read full conversation** starts collapsed and displays retained
comments, question and approval cards, card answers, and document revisions in
time order, using Paperclip chat styling: user bubbles on the right, agent replies
on the left, and separate cards for questions and documents. This presentation
is defined in the shared dashboard renderer for every campaign and regeneration,
not in a particular published report. GitHub publication uses the trusted
default-branch renderer, so renderer changes take effect there after merge.
The shared static card renderer covers `ask_user_questions` (legacy and canonical
question sets), `request_confirmation`, `request_checkbox_confirmation`,
`request_item_verdicts`, `suggest_tasks`, and `connection_intent`. Confirmation
variants include tool actions, credential bindings, and connection authorization.
Cards display saved prompts, choices, recorded selections, outcomes, and reasons;
all action controls are disabled. Multi-question forms expand every question for
review. Unsupported kinds retain their raw payload instead of invented controls.

Repeated checkpoints are deduplicated. Source links open the original
checkpoint; evidence links expose the complete result and raw run/tool-event JSON.
The transcript reflects captured checkpoints; messages from other tasks and
unrecorded intermediate document edits may be absent. It is not a live task.

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
integer from 1–100 on AWS (default 100). The 171-cell default selection takes more than
one wave at that limit; use suite selectors for smaller campaigns. The fallback runner retains its 1–57 limit and
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
The publisher creates an S3 stage with the trusted synthetic summary PNG and a
separate Pages stage. Both surfaces publish only per-result PNG screenshots
with the explicit `public-runner-fixture` marker alongside sanitized structured
evidence. The runner capture helper refuses to mark a screenshot outside the
exact live fixture issue route. Neither surface publishes video, archives,
SVG/active content, databases, Paperclip homes, workspaces, raw/unallowlisted
logs, or credentials.

See [FIXTURES.md](./FIXTURES.md) before adding or changing a profile,
environment, task, matcher, or future Paperclip object fixture.
See [SECURITY.md](./SECURITY.md) before enabling paid dispatch, the runner
group, or permanent public history in this public repository.

## Everyday user-story evals

See [EVERYDAY-WORKFLOWS.md](EVERYDAY-WORKFLOWS.md) for the explicit-only native-runner stories and their canonical Evalbook importer. These cells do not expand scheduled `--all` runs.

### Everyday hiring prerequisites and timeout evidence

The manual `everyday-workflows` / `hire-reuse` story enables native API tools in
its isolated harness and creates a personal managed AI account through the public
API. The lead uses the responsible user's default account, without adapter env
credential overrides. The hire must inherit that binding and finish a real run
attributed to the same account. The evidence records this fixture configuration.
Other suites retain their existing API-tool defaults.

A polling deadline after successful state reads is a candidate workflow failure,
not a reason to retry as infrastructure. State snapshots remain in the evidence;
the timeout message does not serialize task data into the failure classifier.
Explicit server-health waits and failed network reads retain infrastructure
classification.

The product execution prompt v3 tells agents to record child dependencies and
end the parent turn when no independent work remains. The user-story prompts
stay unchanged, so live retests measure the product guidance itself.

Delegated ZIP delivery can appear on the user-facing parent or its child task.
The grader selects the newest ZIP only within that task family; a reuse request
requires a new attachment after the request. The hired-agent execution/account
checks and independent downloaded-code checks remain mandatory.

Revision delivery checks exclude preserved originals by their content hash, even when the agent republishes an original after the revised ZIP. The browser downloads the exact selected attachment ID; its bytes still pass through the independent artifact checker.

## First-task onboarding

`first-task` is a suite in the main Runner E2E catalog. A full
`pnpm test:e2e:runner -- --all` run (or an unfiltered full GitHub Actions campaign)
includes its 52 executions alongside the other suites in one shared dashboard,
campaign result bundle, and history entry. Suite/profile selectors narrow that
same harness; they do not invoke a separate onboarding reporting program.

`first-task` uses the production onboarding wizard, creates the first agent,
keeps its default persona/model/permissions/skill assignments, and answers the
seeded opening question in the browser. The suite does not install the generic
Runner QA persona or replace the hidden `/first-task` invocation. Profile IDs
select the Codex or Claude adapter family; **the production onboarding model
default is retained**, even when it differs from that profile's normal harness
model. Configured and provider-observed model identities are reported separately.

There are thirteen cases on `legacy-codex`, `legacy-claude`, `runner-codex`, and
`runner-acpx-claude`, local only (52 cells). Native profiles complete the same
production wizard using their legacy provider, then change only the agent's
runtime configuration via the public API before its first task. The wizard does
not currently offer native Runner. Persona, managed instructions, skills, seeded
question, and task invocation are preserved. Explicit model choices are retained;
an unset model resolves through the production runtime-switch defaults. The
production switch removes the legacy Paperclip operational skill because Runner
supplies its control-plane contract through its protocol; other assigned skills,
including `/first-task`, are retained. Native runtime permissions come from the
existing qualified profile. Evidence labels
this setup `post-onboarding-runtime-switch`; it does not claim a native wizard
path exists. Legacy setup is labeled `production-wizard`.

| First response / control | Complete journey |
| --- | --- |
| `interview-first-response` | `interview-plan-accept` |
| `clear-task-first-response` | `task-card-accept` |
| | `accept-while-running` |
| `ambiguous-task-first-response` | `task-reply-accept` |
| `plain-message-first-response` | `clarify-propose-accept` |
| `plan-first-response` | `revise-accept` |
| `ordinary-task-control` | `reject-no-execution` |

The ordinary control creates a separate, normally assigned task for the same
onboarded agent without invoking `/first-task`. Fixed garden-club facts and a
per-attempt marker drive all conversations. Clarification supplies facts only;
acceptance is a separate explicit user reply or browser-approved confirmation.
The harness waits for a new user comment to persist before recording a reply
checkpoint; the composer clearing is only optimistic UI state.
The interview journey requests a saved plan. Execution journeys require exactly
one correctly parented/assigned subtask and its completed output document.
Rejection and revision must not execute the rejected/superseded scope. Closing
an unexecuted task after rejection is allowed. A completed onboarding parent
without the approved child is graded as a behavior failure, not retried as an
infrastructure timeout.

`question-choice-options` fails any recorded single-select or multi-select
question with fewer than two distinct, nonempty options, including one-option
"I'll describe it" forms. It checks every captured card presentation, including
later and superseded cards, and reports the question ID, prompt, option count,
and checkpoint. Canonical `answerMode: "text"` questions are valid without
options. A text field or implicit Other fallback does not add a choice to a
canonical select question.

The first-task suite does not scan private instance homes or workspaces for
credential persistence or use that check to override behavioral results.
Credential persistence is evaluated elsewhere. Evidence redaction and public
artifact checks still apply.

Behavioral checks inspect persisted comments, interactions, tasks, documents,
agent counts, creation timestamps, and terminal runs. Planning and clarification
are allowed before acceptance. Premature durable work fails immediately. The
suite checks persisted Paperclip effects; it does not claim to prove the absence
of arbitrary external side effects from a provider process.

```bash
pnpm test:e2e:runner:unit
pnpm test:e2e:runner:typecheck
# Two paid smoke cases, after keys are available:
pnpm test:e2e:runner -- --suite first-task --profile legacy-codex --case clear-task-first-response
pnpm test:e2e:runner -- --suite first-task --profile legacy-claude --case clear-task-first-response
# Expand after reviewing the smoke evidence:
pnpm test:e2e:runner -- --suite first-task
```

Default concurrency is one. Each case has a fifteen-minute attempt budget;
individual response/outcome waits stop after five minutes. More than twelve
company runs fails the case. All company runs (including delegated/child-agent
work and failures) are retained for cleanup and billing. The existing failure
classification separates transport/credential failures from behavior failures.
First-response cases stop when the first provider turn settles.

`snapshots/first-task.json` contains full managed instruction/skill snapshots and
SHA-256 source hashes (plus separate display hashes when redaction applies), the actual hidden invocation and seeded greeting/question,
source SHA/ref and dirty state, runtime settings, observed models, checkpoints,
and check results. `first-task-run-evidence.json` retains run logs/events. The
normal screenshots, sanitized evidence packaging, dashboard and publication
commands apply. Dashboard task/document links target retained evidence because
isolated instances are removed after each attempt.

### Optional quality post-processing

Quality is informational. It cannot turn a behavioral failure into a pass.
The five anchored 1–5 dimensions are question relevance, use of facts, proposal
usefulness, clarity, and low friction. Every score must cite a recorded
checkpoint. The judge reads only recorded conversation/state, has no tools,
and never participates as a simulated user.

Run judging on each **upload-directory `result.json` before normalization and
publication**, with `OPENAI_API_KEY` in the shell:

```bash
pnpm test:e2e:runner:judge-first-task -- --result tests/runner-e2e/results/CAMPAIGN/EXECUTION/attempt-1/result.json --max-dollars 0.50
```

Use the actual upload path printed by the launcher. The judge uses the pinned
`gpt-4.1-2025-04-14` snapshot, temperature zero, and at most 1,800 output tokens.
The configuration, rubric, hash, evidence hash, usage, price estimate, and full
reservation are recorded. Rates are pinned at $2/M input and $8/M output tokens
([model documentation](https://developers.openai.com/api/docs/models/gpt-4.1)).
A conservative UTF-8-byte token bound checks the per-call spending cap before
sending. Oversized evidence is rejected, never truncated. An exclusive adjacent
`result.json.judge.json` ledger prevents concurrent/repeated spending; failed or
interrupted requests retain their reservation and are not retried. Unknown
usage is not reported as free. Judge spend is shown separately and included in
total estimated spend when known; provider/child usage stays in the run ledger.

Regenerate normalized reports with the existing report command, pointing
`PAPERCLIP_RUNNER_E2E_REPORT_ROOT` at that campaign,
`PAPERCLIP_RUNNER_E2E_REPORT_OUT` at a fresh output directory, and
`PAPERCLIP_RUNNER_E2E_EXPECTED_IDS` at the JSON array of selected execution IDs.
Then use the existing dashboard/history publication workflow. Merely running
`test:e2e:runner:dashboard` reads the already normalized bundle; it never calls
a judge or refreshes results from outside that bundle. Published campaign
bundles remain immutable; judge them before publishing.

### Comparing skill revisions

Use separate campaigns for each skill revision and three repetitions per
case/provider (144 executions per revision), keeping source environment,
provider/default model, credentials mode, case facts, and judge configuration
matched. Set distinct `PAPERCLIP_E2E_CAMPAIGN_ID` values such as
`first-task-skill-a-r1` through `r3`, and repeat for skill B. Review actual model
identities and instruction hashes before comparing; dirty working trees are
explicitly marked. Do not pool results with mismatched configurations or treat
infrastructure failures as behavioral successes. Daytona,
simulated-user models and prompt optimization are intentionally deferred.


`accept-while-running` clicks a confirmation as soon as its source run exposes
one, without the usual wait for that run to settle. It retains the normal
acceptance, child-task, duplicate-work, and durable-output checks. The additional
`accepted-while-running` matcher compares the persisted card resolution time
with the source run's start and finish times. If the model finishes before the
click lands, the case is unexercised, never a passing concurrency regression.
Provider-free route tests also hold a real child process open to exercise this
interleaving deterministically for confirmations, checkbox approvals, and answers.

### Task continuation

The `continuation` suite is included in full (`--all`) campaigns. It adds five
local cases for Legacy Codex, Legacy Claude, Runner Codex, and Runner ACPX Claude
(20 cells): authenticated answers changing scope, clarification without approval,
scope revision preserving approval, untrusted handoff text read through a real
tool, and completed child-task reuse across a server restart.

```sh
pnpm test:e2e:runner -- --suite continuation --profile runner-acpx-claude
```

User requests and replies are fixed; the driver submits them through the task UI.
The fixtures use production completion/tool instructions, not fixture-specific API
recipes. Deterministic checks inspect saved documents, child IDs, statuses,
attachments, and settled approval checkpoints. `continuation.json` records each
checkpoint and matcher; private `continuation-run-evidence.json` contains the
recorded provider logs and events. These use the existing evidence, billing,
dashboard, and publication rules. Raw logs remain private.

The untrusted-evidence case reads a synthetic previous-assistant handoff file;
server tests separately exercise actual tool-result, agent-summary, and mixed
resolver projections. This is a regression sample, not an exhaustive injection
or authorization evaluation.

The native-only `question-tool-documentation` case adds two cells (Runner Codex
and Runner ACPX Claude), for 23 continuation cells total. It asks for a clickable
Morning/Afternoon question, followed by an open text question, then a saved note
using both real answers. The user prompt contains no tool names or payload recipes.
Checks inspect actual forms, ordered UI answers, the saved document, and every
recorded native task prompt: the short routing sentence must remain, while the old
question section and detailed tool-format instructions must be absent. Server
contract tests separately verify that the advertised tool carries the documentation
for fresh and resumed native executions. This tests the current documentation
placement; it is not a statistical comparison with the former prompt arrangement.

Continuation screenshots wait for the correct task heading and fully revealed
conversation before capture. A loading screen or wrong task fails capture.
Browser-only regressions exercise delayed rendering without provider calls:

```sh
pnpm test:e2e:runner:browser-support
# To use an installed Chrome instead of Playwright's Chromium:
PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e:runner:browser-support
```

### Native provider continuity

The first-task `task-reply-accept` and `task-card-accept` journeys also verify that
ordinary native follow-ups retain the parent task's workspace, native session,
and provider session identities. A generic `sessionReused` flag is insufficient.
The check excludes child runs and applies only to native profiles.

For ordinary native comment and child-completion wakes, a verified provider resume
receives only new attributed messages, the current authenticated interaction result,
actual task edits, child results, and completion-report identifiers. The provider
retains conversation history. Paperclip retains task state and authorization. A new
or replacement session still receives the full bootstrap; specialized recovery,
review, external-chat and planning paths retain their existing context. Legacy
adapter prompts are unchanged.

The ACPX Claude-only `provider-question-bridge` case exercises the provider’s built-in question tool, verifies that its card appears in Paperclip, answers it in the browser, and requires the same paused run to finish with the selected fact. The `accept-while-running` fixture holds the committed card’s creation response until browser acceptance, making the overlap deterministic without changing production behavior.

Local Legacy Claude cells qualify Claude Code `2.1.277` before starting the server.
If the ambient CLI differs, the harness installs the exact version under the
attempt's temporary root and prepends that private bin directory to the server's
PATH. It does not change the developer's global installation. The old workflow
pin, `2.1.19`, did not discover `.claude/skills` supplied through `--add-dir`;
a provider-free CLI probe reproduced the missing skill on that version and
confirmed discovery on `2.1.277`. The workflow pin and local qualifier are checked
together. This change applies to local cells; Daytona images remain separately pinned.
Continuation question flows also wait for the submitted interaction's durable
`answered` state before considering the next checkpoint ready.

### Worker prerequisites

The trusted default-branch workflow provisions the local Codex sandbox for both
native Codex and ACPX Codex. It prepares the pinned Python artifact oracle only
for everyday stories that execute a downloaded ZIP; skill creation and service
questions do not need that oracle. Catalog coverage tests keep this list aligned
with the test flow. Native provider runs do not require an unrelated host
`claude` or `codex` CLI for version probing.

Changes to privileged worker setup must reach the default branch before a
branch-targeted paid campaign can exercise them. The report job resolves its
lockfile from its own trusted checkout, never from the tested branch.

### Injected interruption diagnostics

The restart supervisor starts Paperclip with the TypeScript loader in the same
Node process it owns. A forced stop therefore cannot leave an old controller
alive to stop the embedded database after the replacement starts.

Everyday restart and Stop scenarios exempt only their recorded cancellation,
graceful-shutdown interruption, or process-loss outcome. A later adapter error
on that same run still fails immediately and fails the lifecycle grader. The
run ID alone is not an exemption from recovery failures.

The review-handoff case also requires proof that the parent was blocked before
the review wake. When all tasks finish and persisted timestamps prove that the
accepted review started before any parent run finished, the harness fails
promptly with an unexercised-boundary diagnostic. Missing evidence in separately
fetched snapshots does not trigger this rejection. Successful work alone does
not prove that this recovery path was tested.

The native `agent-chat.create-backlog` case saves a plan and assigned backlog task, then asks for its status. It checks the original creation audit, absence of all task runs, plan persistence, and exactly one task, so creating runnable work and correcting its status afterward fails the eval.

### Remaining native Agent Chat qualification

`agent-chat-qualification` is an explicit-only, local suite with six cells:
`active-reassignment`, `worker-crash-retry`, and `grounded-answer-quality`, each
on native Codex and native Claude. Run with
`pnpm test:e2e:runner -- --suite agent-chat-qualification`.

Active reassignment waits for a real worker to save a draft and enter a bounded
file wait. The lead then transfers the same task through Agent Chat. The oracle
requires cancellation with `issue_reassigned`, no overlap with the successor,
one successor run, unchanged scope and plan, retained draft, and a completed
successor-owned document. It budgets three provider runs.

Worker recovery requires Linux with Python pidfd support (as on the CI workers).
It kills only the exact running native worker PID from the public
run record, after verifying its command-line run ID, process start identity, and isolated
local workspace. The signal uses an owned pidfd so PID reuse cannot retarget it.
The UI must preserve the plan and withhold generic Retry while cleanup remains
quarantined; the public retry API must return 409 without admitting another run.
The fixture then releases the read-only brief wait and sends a new chat message
that records the known saved-plan and interrupted-command outcomes. The server
must verify that the recorded worker and provider process groups stopped before
admitting exactly one successful fresh session. The answer must contain the
reference supplied only after the crash, and the saved plan must remain unchanged. The old quarantined run must not regain
a misleading Try again control after the fresh turn succeeds.
This qualifies **explicit conversation continuation after local worker loss**.
It does not qualify replay of uncertain actions, automatic recovery, remote worker
loss, or exact-session resumption. It budgets two provider runs. Unexpected
failures remain fatal; only the positively identified injected-fault run is exempted.

Answer quality uses two read-only turns over public fixture tasks and conflicting
historical comments. Exact structured propositions grade current blockers,
backlog versus active work, stale claims, and unknown facts. The written answers
and source records are retained for separate semantic review of factual grounding,
correction, uncertainty, usefulness, and clarity. Deterministic facts do not certify
all prose quality. This case explicitly enables the existing experimental API
context tools; the two recovery cases use the default native tool surface.

All cells have a 15-minute deadline. Evidence includes boundary and final run
records, documents, source facts, chat comments, and screenshots. Gates are
released on failure and normal isolated-instance cleanup removes the workspace.
The usual provider billing and partial-attempt reporting apply. No production
prompts, onboarding defaults, or provider permissions are changed.

For pre-default native onboarding qualification, select all `first-task` cases
with profiles `runner-codex,runner-acpx-claude` (26 cells). The existing public-API
runtime switch occurs after the real wizard creates its first agent and before
any provider work. It preserves the wizard's model, persona, skills, and task.
This tests the native first-task process in advance of the UI/default rollout;
it does not certify a native option in the wizard, which is not offered yet.

Current proof and remaining decisions are recorded in
[the 21 September qualification report](QUALIFICATION-2026-09-21.md). In particular,
the original worker-loss attempts quarantined both providers. The version 9 crash
eval requires a usable fresh conversation after verified cleanup. A passing
quarantine guard alone is not a recovered workflow.

### Blank-page investigation

Private `browser-diagnostics.json` includes the final document readiness, whether
`#root` mounted content, whether a service worker controls the page, outstanding
script/style paths, and recent module 304/error statuses. These fields contain no
response bodies, headers, or query strings. A 304 is ordinary cache validation;
recording it does not change the grade or retry the page. The public report still
uses the existing evidence allowlist.

The provider-free `tests/e2e/task-reload.spec.ts` regression opens a persisted task
with the production service worker, navigates to the same URL, and reloads it. It
requires the saved content and usable composer to remain visible. Run it with the
standard `tests/e2e/playwright.config.ts`; no provider or Daytona credentials are
needed. Browser-support tests separately exercise blank-root/pending-module
failure evidence, so a future blank page is distinguishable from a loaded task.

The HTML entry also supplies recovery before React mounts: a failed module shows
`Reload page`; a startup with no rendered root for 30 seconds offers the same
manual retry. Late successful startup removes the notice. It never reloads
automatically, and the notice lives outside `#root`, so it cannot satisfy an
app-readiness assertion. The saved-task regression interrupts the built bundle,
clicks retry, and verifies the original task, persisted comment, and composer.
`pnpm test:e2e:runner:browser-support` also tests failed and stalled imports,
evaluation errors, service-worker-controlled retry, repeated offline retries, and
cleanup after startup. The worker returns a static, uncached HTML retry screen
when a navigation fails offline; it never embeds or caches task content.

These fault-injection tests prove recovery from interrupted startup. They do not
establish the cause of the historical intermittent Vite module-graph stall;
ordinary 304 responses and successful reruns alone are not evidence of that cause.

### Grok branch qualification on EC2

The trusted default-branch workflow can run the explicit `grok-qualification`
suite from a selected target branch. Store `XAI_API_KEY` only in the protected
`runner-e2e-paid` environment. The paid step delivers it only to a profile whose
credential name is `XAI_API_KEY`. The Grok `build-revise` cells prepare the same
pinned Python artifact verifier used by Everyday Workflows, before credentials
are exposed. Local Grok cells also run the checksum-verifying binary installer
before receiving credentials. With `RUNNER_E2E_AWS_ENABLED=true`, the controller, browser and
artifact verifier run on the existing EC2 fleet; no developer laptop Docker
service is required. Set the optional `max_parallel` dispatch input to `1` for
keys with low request limits. It can only lower the configured campaign limit.
Keep subscription qualification separate from API-key results.
