# Paid runner full-stack E2E

How to run the Product E2E harness: credentials, local commands, the Daytona
image, evidence, and the GitHub Actions workflow.

This file is the runbook for the harness as a whole. Each suite's cells,
selectors, fixtures, and limits are in [SUITES.md](SUITES.md). Add a note about
one suite there, in that suite's section, not here. See also
[FIXTURES.md](FIXTURES.md) and [SECURITY.md](SECURITY.md).

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
- `KIMI_MODEL_API_KEY` (local-only pending Kimi CLI/ACP profiles)
- `XAI_API_KEY` (local Grok API-key profile)
- `GROK_AUTH_JSON` (local native Grok subscription profile)
- `DAYTONA_API_KEY`
- `CURSOR_AUTH_TOKEN` (extended Cursor candidate)
- `COPILOT_GITHUB_TOKEN` (extended Copilot candidate)
- `GEMINI_API_KEY` (Google Antigravity API-key profile `runner-acpx-antigravity`)
- `PAPERCLIP_E2E_DAYTONA_IMAGE` (Daytona only)
- `PAPERCLIP_E2E_DAYTONA_NODE_SHA256` and `PAPERCLIP_E2E_DAYTONA_RUNNERD_SHA256` (native Cursor/Pi/Copilot Daytona fixtures; exact `sha256:...` executable digests from that image)

The image must be an immutable `image@sha256:...` reference. The launcher
reports missing variable names but never prints values. It passes raw provider
keys only to Playwright, which posts each value once to the company-secrets API.
Paperclip receives secret references in agent/environment payloads. Provider
keys, Daytona keys, `DATABASE_URL`, and `DATABASE_MIGRATION_URL` are removed
from the Paperclip child process.

Kimi keys are recognized for local catalog, schema, and isolation tests only.
Its explicit context-integrity profiles are blocked before credential loading
until runtime identity, authentication, skills, session, and billing
qualification is complete. Grok profiles are explicit-only and require their
matching API-key or subscription credential.

Never put credentials in `catalog.ts`, screenshots, fixture metadata, workflow
inputs, or a tracked env file.

## Private framework evidence

The protected TestOps reporter (`PAPERCLIP_CHAT_COMPLETION_TESTOPS=v1`) uses
Playwright's official JSON and JUnit reporters only with an approved private-cell
preflight. Other runs, including generic private full-stack runs, keep the existing
HTML and blob reporters. A setup failure can retain its SDK audit without a
framework report; a malformed present framework report still fails closed. The immutable
JSON source is retained in `snapshots/playwright-framework-original.txt` and is
parsed and deeply inspected as registered Playwright JSON, including decoded
inline text/JSON attachment bodies. The text suffix preserves source bytes; it
does not exempt the file from JSON privacy checks. Unsupported inline carriers
fail closed.

`snapshots/playwright-framework.json` preserves the report and maps attachment
paths to their owned canonical files with byte counts and SHA-256 hashes.
Original status, errors, and nested user steps remain unchanged. Sealed originals
retain all owned attachments. The final-results tree references those originals
instead of storing another copy of registered Playwright output attachments.
The downloader verifies each reference against the sealed original inventory,
then restores exact referenced bytes into the derived selected report tree.
Neither sealed inventory changes. Registered metadata and attachments are not
silently rewritten: JSON values that need privacy redaction fail closed.
Unknown, missing, changed, or foreign attachments fail validation. Native
snapshots and other unregistered evidence are not removed. The existing physical
byte, entry, archive, ZIP expansion, time, and privacy bounds remain unchanged.
A complete evidence transfer does not attest that the feature passed.

## Local commands

When the host cannot start embedded Postgres, set
`PAPERCLIP_RUNNER_E2E_POSTGRES_ADMIN_URL` to an explicitly supplied loopback
test Postgres administrator. The launcher creates a new `runner_e2e_<random>`
database per attempt; the serving app applies its migrations. This does not
reuse the administrator URL's database. The administrator variable is not
forwarded to the server or browser. The launcher checks the private ownership
receipt and deletes only its database after confirmed process/resource cleanup.
Unknown remote cleanup preserves that database and the private fixture for recovery.

Install dependencies and Chromium once. Native local cells also need the local
runner binaries:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm --filter @paperclipai/paperclip-runner run build:runner-binaries
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
with `PAPERCLIP_E2E_MAX_PARALLEL`). `--max-automatic-retries <0|1>` controls the
launcher retry budget (default 1). Set it to 0 for a single-attempt comparison;
it suppresses both transient-infrastructure and provider-variance retries while
preserving the original failure classification. Headed/UI/debug runs are forced
to one worker.
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

The unit command removes ambient `NODE_PATH` and `NODE_OPTIONS` when it starts
the actual Vitest and Node test processes. It invokes Vitest's JavaScript entry
directly so pnpm's generated bin shim cannot inject `NODE_PATH` again. Installed
CLI guards still reject ambient injection and repository-only resolution. Test
file filters and Vitest options can follow `pnpm test:e2e:runner:unit`; the Node
prerequisite tests still run after Vitest succeeds. Missing dependencies or an
unavailable/terminated test process produce a `launcher/environment failure`
diagnostic and exit 2. Assertion failures retain the test runner's exit status
and output; assess installed-product failures from those assertions separately.

Each Vitest file runs in its own isolated worker, so every file loads its
imports again. The suite is CPU-bound on the 4-vCPU CI runner, so it keeps
Vitest's default of one worker fewer than the CPU count. A fourth worker raised
load enough to fail a process-tree cleanup test. The unit command sets
`NODE_COMPILE_CACHE` to `<tmpdir>/paperclip-runner-e2e-compile-cache` unless it
is already set, so workers and the Node processes that tests start reuse
compiled code for dependencies such as `@playwright/test`. Node checks each
cache entry against the source and recompiles on a mismatch. Set
`NODE_DISABLE_COMPILE_CACHE=1` to run without it. Keep work that runs when a
module loads small: about 140 test files load `catalog.ts` and about 230 load
`chat-feature-cases.ts`, so a cost at load is paid once per file.

PR CI runs `pnpm test:e2e:runner:unit` as the required "Runner support suite"
job in `pr-trusted.yml`. It runs when server, CLI, package or UI source
changes, and on every full CI run. The suite pins workflow security policy,
evidence oracles, profile versions, suite hashes and dated fixtures. When a
change to one of those is deliberate, update the pin in the same pull request
and name the reason. Do not weaken a security check to make it pass.

The OpenRouter ranking snapshot is tracked in `openrouter-models.json`; nightly
runs never mutate it. Refresh it deliberately, review the source/capture/hash
diff, and rerun credential-free checks:

```bash
pnpm test:e2e:runner:models:update
```

## Daytona image

The image builder retains only its stripped Runner executable and portable
provider pack. The dependency install and pack build share one layer so the
workspace and package store can be removed before export. Source-provenance
changes can repeat the dependency install; this bounds retained builder disk
at the cost of install-cache granularity. The build reports workspace and pack
sizes, and final runtime and CLI checks still execute in the published image.

Build speed comes from two layout rules. The revision-metadata step sits above
both `COPY --from` steps, so the cached base and CLI layers download while the
builder stages compile. Both copies use `--link`, so they do not wait for that
download. The Rust build keeps no dependency layer: retaining Cargo's target
and registry trees (about 1.2 GB) exhausted the builder disk during the
default-branch cache export.

To publish only the image for a branch, without a paid gate, dispatch with
`image_only`. Authorization, target resolution, catalog validation and the
signed, verified image publication run unchanged; every campaign job is
skipped. Keep a selector that includes a Daytona cell:

```bash
gh workflow run runner-full-stack-e2e.yml \
  --ref master \
  -f target_branch=fix/example \
  -f all=false \
  -f id=core-compatibility.runner-codex.daytona.message-marker \
  -f image_only=true
```

The ephemeral Daytona fixture requests a 60-minute wall-clock lifetime at creation.
The provider destroys each sandbox at that expiry in any state. This bound includes
room for each declared attempt and the acquisition budget. It supplements the
fixture's inactivity cleanup and remains in force after a controller crash.
The provider must confirm the expiry before setup can use the sandbox. Cost reports
still require lifecycle evidence and preserve uncertain cleanup or charges.


Use the immutable digest printed by the `Publish verified Daytona image` job,
or publish the current source locally:

```bash
content_id="$(pnpm --silent test:e2e:runner:image-id)"
source_revision="$(git rev-parse HEAD)"
lock_sha="$(shasum -a 256 pnpm-lock.yaml | cut -d ' ' -f 1)"
image="ghcr.io/paperclipai/paperclip-daytona-runner:e2e-content-${content_id}"
if ! docker buildx imagetools inspect "$image" >/dev/null 2>&1; then
  docker buildx build \
    --platform linux/amd64 \
    --build-arg "PAPERCLIP_RUNNER_CONTENT_ID=${content_id}" \
    --build-arg "PAPERCLIP_RUNNER_SOURCE_REVISION=${source_revision}" \
    --build-arg "PAPERCLIP_RUNNER_LOCK_SHA256=${lock_sha}" \
    --file docker/daytona-runner/Dockerfile \
    --tag "$image" \
    --push \
    .
fi
docker buildx imagetools inspect "$image"
```

The Dockerfile has no lockfile digest default: every build passes the SHA-256
of the `pnpm-lock.yaml` in its build context, and a missing or malformed value
fails before installation. Build from a clean checkout of the source revision
so the content ID, provenance, and lockfile digest describe the same tree.

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

When the controller runs on macOS or another platform different from the sandbox,
set `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` to a verified Linux amd64
`paperclip-runnerd`, such as the binary copied from `/usr/local/bin/paperclip-runnerd`
in the pinned image. The controller must have these exact bytes for its artifact
identity check. A local macOS runner cannot substitute for the Linux binary,
even when the sandbox image contains a compatible runner. This also applies to
native Codex cells, which do not otherwise need the remote provider pack below.

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

For native matrix campaigns, set `PAPERCLIP_RUNNER_E2E_RESULTS_ROOT` to a
dedicated normalized absolute directory outside the checkout, for example
`/private/tmp/paperclip-product-evidence`. Final attempt packages, campaign JSON,
and dashboards are written there directly, so removing a checkout does not
remove their evidence. The default remains `tests/runner-e2e/results`.
Empty/relative paths, traversal, filesystem/home/checkout roots, and symbolic-link
paths are rejected before credentials load. The output root is owner-only.
Use a distinct `PAPERCLIP_E2E_CAMPAIGN_ID` for each invocation to preserve earlier
attempts. This changes storage only; required evidence, redaction, grades, and
temporary-instance cleanup retain their existing checks. Provider-connection,
GitHub-review, and product-journey launchers retain their separate output contracts.

The standard task and chat evidence collectors read durable run events through the paginated
public API, including completion events beyond the first 1,000 rows. It rejects
missing, repeated, or out-of-order sequence numbers and fails capture after
100 full pages instead of grading a truncated stream. Original incomplete
captures remain failed evidence; qualifying a fix requires a new live attempt.

Every standard runner attempt automatically captures `taskChat` before fixture
teardown, including failed attempts. Test details show each task's saved brief,
full comments, question/approval prompts and recorded answers in a chat layout,
plus native agent progress when available. Delegated tasks have their own
threads; standing chats remain included after a journey restores the Agent Chat
setting. Comments are paginated and message bodies are retained without display
truncation. Missing reads, repeated pages, and capture limits are labeled partial
or unavailable without changing the workflow's grade. Browser-only attempts with
no tasks show no chat section. Existing reports without `taskChat` continue to
render normally; screenshots cannot reconstruct a historical conversation.

`taskChat` is a closed, credential-redacted public projection in the normalized
result, so local, CI, regenerated, and published dashboards share the same
recording. It contains visible conversation text, not raw run logs, reasoning,
tool arguments or provider/session metadata. Collection uses the public API,
has a 30-second request-admission budget, and caps task/comment discovery at
100 pages; incomplete collection is never labeled complete.

Every completed local campaign also writes
`tests/runner-e2e/results/<campaign>/dashboard.html`. The self-contained page
shows every selected execution with screenshot thumbnails, grouped by suite and case.
The history homepage and campaign report render their campaign summaries as
selectable HTML text, with suite links, pass counts, status, and timing.
Campaign reports render only selected executions, including selected cases with
missing evidence or startup failures. Search and feature/suite/profile filters
sit alongside a folding suite/case sidebar scoped to the current campaign.
Global Overview, Campaign history, and Needs attention pages have no suite tree.
All results is one continuous report with an overview and all execution previews.
Suite links jump into the report; sidebar case links open a focused case view
with a configuration picker. Clickable Campaign / Suite / Case breadcrumbs
return to the report and preserve its reading position. Suite contents also link
to execution previews, with a return to the overview and a bottom-right Back to top.
Cases appear once in the index across agent/environment configurations; links prefer
a result matching the active filters and clear conflicting filters when needed
to reveal their destination.
Case links show a green status dot when all matching configurations passed,
red when any failed, and amber for incomplete or missing results. Their tooltip
summarizes the configurations behind the status; red links prefer a failing
result. The status follows the active filters, falling back to the whole case
when none of its configurations match.

`journey-features.ts` associates exact suite/case identities with the stable
capability IDs from `maps/feature-map/`. The feature selector uses the map's
existing sections and titles. The expandable Feature coverage view separates
capability associations, linked test outcomes, gaps, and unmapped journeys.
These display-only associations do not change prompts, graders, definitions,
or retained results. Historical reports use the current associations, not a
claim that those annotations were recorded by the original run. A linked,
passing scenario does not establish complete capability coverage. Extend the
associations only after inspecting the journey's assertions; unknown cases stay
unmapped rather than inheriting coverage from a similarly named suite.

Passing cards emphasize screenshots and show checks and duration beside a
single Test details disclosure. That disclosure holds billing, evidence links,
execution identity, and diagnostics; failed and incomplete results keep their
explanations visible. Screenshots open the gallery, which also links to the
original image. A floating Back to top control returns to the report heading
without clearing filters.

Expanding Test details shows matchers, pass/fail details, provider/model/runtime,
timings, token and cost accounting, and evidence links. The campaign header
aggregates input, output, and cached tokens, provider-reported LLM spend,
Daytona list-price runtime estimates, and pricing coverage. Missing provider
usage is labeled `unavailable` or `unpriced`; it is never presented as zero
cost. A known subtotal from a partially priced run stays in campaign spending,
with a partial-amount label and incomplete billing coverage. The CI report job stages the same portable site at
`normalized/index.html` inside the access-controlled merged report artifact.

Campaign billing retains a separate numeric receipt for each attempt, including
failed retries. The selected result still controls the grade and result card.
Copies of the same attempt do not add another charge. The supervisor stamps a
campaign/attempt identity; CI cells share `PAPERCLIP_E2E_ACCOUNTING_CAMPAIGN_ID`
while retaining their separate artifact directories. Report regeneration keeps
these receipts and their totals. A later cleanup update replaces an earlier
observation of the same attempt; contradictory costs at the same timestamp are
rejected instead of silently choosing one.

The report shows missing attempt receipts and artifacts excluded from another
campaign. Legacy CI evidence can be grouped by workflow run URL. Unscoped local
artifacts cannot establish campaign membership, so only the selected result is
used. Older normalized bundles without receipts are labeled `selected_results`;
rendering them again cannot recover lost retry costs.

Billing reads decimal `costUsdExact` receipts and separates model estimates
from provider-reported amounts. Explicit zero usage differs from a missing or
unfinished receipt. Coverage is limited to captured usage. It does not certify
setup probes, subscription allocations, external tools, CI, storage, or provider
invoice reconciliation. These require separate receipts. Do not use the current
numeric report subtotals as an enforced spending limit.

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
and unredacted logs are removed after confirmed cleanup. If process or remote
cleanup is unconfirmed, the harness retains the owner-only temporary root and
its recovery database for reconciliation; that private state is never packaged
as public evidence. Daytona teardown destroys
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
one verified provider pack. Report sanitization and AWS history publication
explicitly check out the trusted workflow commit. The report applies the
reviewed, hash-pinned `report-lock.patch` to the committed lock before its
frozen install. It does not resolve registry versions at run time or accept a
worker target lock. The patch changes existing package patch identities and
links the already declared yaml dependency; existing package tarball integrity entries
stay unchanged. The correction adds exactly yaml@2.9.1 with pinned integrity. The
trusted authorization job rejects unknown locks before paid work. Manual history
publication uses the same reviewed correction. Qualification image builds apply
it only to a target equal to the workflow revision; other targets keep their own
lock. An already-reviewed output lock is used unchanged. Unknown lock contents fail before installation. The
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

The same trusted workflow can run the standing **Product regression — core
workflows** TestOps plan. Bootstrap one actual case with `-f testops_case=66`
(message-marker), or select the complete plan with `-f testops_case=all`.
Leave the ordinary `id`, `suite`, `group`, `profile`, `environment` and `case`
selectors empty in this mode. TestOps dispatch supplies `ALLURE_JOB_RUN_ID` and
`ALLURE_USERNAME`; the requested test-plan selection overrides the bootstrap
case. All 20 imported case IDs and full names remain stable. The lane uses the
existing native Codex/local cells and the existing native OpenCode/local
task-workspaces cell. It does not qualify the historical 355-result snapshot.

The sibling **Reliability — staging soak** plan runs the seven staging-soak
reliability cases through this same lane: six on native OpenCode with DeepSeek
1017, and `queue-steer` on steering-capable native Codex.
Bootstrap it with `-f testops_plan=reliability -f testops_case=all` (or one case);
a TestOps launch names its plan through its case IDs. A launch never mixes the
two plans, and each keeps its own full-plan denominator. Its TestOps identities
come from the trusted `runner-e2e-testops-registration.yml` workflow; until they
are committed, selection fails closed. See
[the Reliability plan](EVERYDAY-WORKFLOWS.md#testops-reliability-plan).

The protected `runner-e2e-testops-reporting` environment supplies `ALLURE_TOKEN`.
Only default-branch selection and reporting code receives this token. The
ordinary paid provider jobs, their authorization and their evidence paths stay
the same. Selection binds the job run, launch, source and workflow revisions.
Reporting parses the retained normalized campaign, publishes original attempts
and assertions, and makes an absent result explicitly broken. It verifies the
uploaded case IDs and verdicts before finishing the original TestOps job run.
No bootstrap or synthetic control result contributes to the pass count. Tag
only a complete 20-case attempt `full-run` and `test-plan-2`; omit `full-run`
from focused reruns. Inspect the linked launch and the retained report for
acceptance. A local projection test does not establish a live product pass.

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

## Local report design preview

Iterate on the public history and individual campaign reports with retained real
data, without starting Paperclip, loading credentials, or calling providers:

```sh
node --watch --import ./cli/node_modules/tsx/dist/loader.mjs tests/runner-e2e/preview.ts
```

Open `http://127.0.0.1:4317/runner-e2e/`. The preview uses the production
`history-index.ts` and `dashboard.ts` renderers. Changes restart the preview
and reload the browser. Every history link opens a locally rendered report;
normalized results, public screenshots, and other manifest-listed public evidence
are downloaded on first access and cached under the ignored
`tests/runner-e2e/results/design-preview/` directory. Original grades, billing,
timestamps, and source provenance are retained. No results are republished.

Use `--port 4320` for another port, `--refresh` to refresh the history snapshot,
or `--offline` to require cached data. Offline mode supports reports and assets
already visited; it reports uncached artifacts explicitly. The preview contains
only published evidence, not private Playwright traces or videos.
