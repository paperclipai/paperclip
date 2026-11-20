# CI workflows

How pull-request CI is routed and trusted, who owns the lockfiles, and how the typecheck and retry lanes work.

## Dependency Lockfile Policy

GitHub Actions owns every managed pnpm lockfile:

- `pnpm-lock.yaml` at the repository root
- `scripts/typecheck-sandbox-providers/pnpm-lock.yaml`, for the sandbox providers
- `packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml`

`LOCKFILES` in `.github/scripts/lockfile-trust.mjs` lists them.

- Do not commit any of them in pull requests. Only the lockfile refresh workflow
  and verified Dependabot commits may change them.
- Pull request CI validates dependency resolution when manifests change. A stale
  lockfile is resolved in place for that run.
- Pushes to `master` run `.github/workflows/refresh-lockfile.yml`. It regenerates
  each lockfile with `pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile`
  and opens one `chore/refresh-lockfile` pull request for all of them. See
  `doc/RELEASE-AUTOMATION-SETUP.md` for when the bot merges it.
- A local `docker build` installs the Runner with a frozen lockfile. When the
  root `pnpm-lock.yaml` is behind the Runner's manifests, run that same command
  in the checkout before the build, and do not commit the result. See "Runner
  image" in `doc/DOCKER.md`.

The Pi and Kimi distribution lockfiles under `packages/paperclip-runner/scripts/`
are not on this list. They hold attested provider pins, so change them by hand
(see `rules/acpx-profile-identity.mdc`).

## Trusted PR Workflow

The PR caller uses `paperclipai/paperclip/.github/workflows/pr-trusted.yml@master`.
The AWS runner group `paperclip-public-pr` must allow
`paperclipai/paperclip/.github/workflows/pr-trusted.yml@refs/heads/master`.
New workflow versions merged into master then receive runner access without a
separate SHA allowlist update. Dependabot leaves this first-party reference on
master.

Runner selection calls `ci-routing.yml@master`. Allowlisted maintainers use the
reserved `paperclip-ci-routing-x64` AWS fleet for this bounded metadata job;
other callers use GitHub-hosted capacity. The gate never checks out or executes
PR code. The author, event sender and rerun actor must each be both
in `AWS_CI_TRUSTED_USER_IDS` and a current owner of `.github/**` in CODEOWNERS.
The resolver and CODEOWNERS are read from the same protected master revision;
PR edits cannot change the trusted owner list. Documentation-only owners,
unsupported owner rules and failed identity lookups do not authorize AWS.
Repository, head and merge validation also apply. The gate validates this run's
immutable event merge, including its PR head and a base snapshot between the
event's base and the current branch tip. Normal base advancement and regeneration
of GitHub's live merge ref do not move an authorized run to GitHub-hosted CI.
Stacked synthetic bases must contain a validated base snapshot. Rewritten base
history, changed PR heads and unverifiable ancestry still deny AWS execution.
Missing or malformed settings
and unverifiable authorization use GitHub-hosted runners. A maintainer rerunning
an outside contributor's PR does not grant it AWS access.
Both `full-ci` and `profile-ci` label events use this same authorization path.
The labels request CI scope; they do not grant AWS access or move an authorized
CODEOWNER run to GitHub-hosted capacity. Other label events do not request CI.
Authorized test jobs and the final `verify` and `e2e` aggregates use the selected
AWS fleet. A stale admission roster can allocate only the short metadata gate;
the fresh CODEOWNERS check still denies PR execution for a removed owner.

AWS runners are sometimes lost mid-job. `ci-runner-loss-rerun.yml` re-runs the
failed jobs of a PR's first CI attempt once when every failed or cancelled job
lost its runner. A spot reclaim often ends the job, and the run, as
`cancelled`. A lost runner is recognized by the check-run annotation "lost
communication with the server" or "received a shutdown signal". When a job has
the annotation "The operation was canceled." or "A task was canceled.", the job
log is checked for the same messages. This evidence counts even if the job also has other error
annotations, so a test that really failed just before a reclaim gets one
wasted re-run. A cancelled job without this evidence, such as a job a person
cancelled, counts as a real failure. The `verify` and `e2e` aggregates are not
counted. Any other failure, a failed or cancelled routing gate, or a PR whose
head has moved prevents the automatic re-run. The head check runs before any
job is classified, so a run cancelled by a newer push costs no log reads. It
runs again just before the re-run, because a re-run of an old run joins the
PR's `cancel-in-progress` concurrency group and would cancel the newer CI. The
workflow job summary lists each failed or cancelled job and its evidence. Like a maintainer's "Re-run failed jobs", the re-run reuses the
gate's successful outputs, including its AWS admission. Attempt 2's
triggering actor is `github-actions[bot]`, so `profile-ci` does not export
that attempt. Later attempts are never re-run automatically.

The routing workflow also selects the CI scope. Middle PRs in a stack and PRs
whose diff changes only release notes (`releases/v*.md` or
`releases/beta/v*.md`) skip the build, test, and e2e lanes. The `policy` job
and the `verify` and `e2e` aggregate checks still run. The release-notes check
reads the diff between the event's base and head commits. If that lookup
fails, or the diff is empty or may be truncated, the PR runs full CI. A
notes-only PR stacked above other PRs also runs full CI, because its own diff
does not include the lower PRs' code.

For ordinary full-scope PRs, the routing job further selects affected suites
using `turbo.json` and `.github/ci-task-matrix.json`. It downloads the planner
and its helpers and definitions from one canonical master revision, without executing PR
code. It fetches the exact tested merge commit and its parents into a temporary
bare Git repository, validates the PR head, and compares the merge tree against
its first parent. The event's base SHA can be stale. Git tree comparisons have
no GitHub compare-API 300-file cap. Renames count as deletion plus addition;
failed, empty, or malformed comparisons select the full suite. Unclassified files also select full CI. Stack verification retains the
existing scope policy and runs all suites whenever that policy requires them.
Changes to global inputs, including the task graph, package scripts, workflows,
and execution helpers, force full execution and disable result-cache restore and
save for the entire PR diff. Later pushes cannot reuse results created under
changed cache definitions.

The repository variable `CI_INCREMENTAL_MODE` accepts `enabled` (the default),
`shadow` (report selections but execute everything), or `full`. Add the `full-ci`
label to force all checks on one PR. Authorized `profile-ci` runs also execute
everything. Forced and shadow runs disable local and remote task-result cache
reads and writes. Every routing run
with a valid plan publishes affected and scheduled job counts with input reasons
in its job summary. Required aggregates reject failed, cancelled, and unexpectedly
skipped selected suites; the verify aggregate includes serialized tests and the
canary dry run.
The uncached typecheck job also runs the repository-wide CLI guidance safety
guard. It still scans UI changes when unrelated server shards are omitted.

The shared policy in `.github/scripts/ci-inputs.mjs` exempts only audited prose:
`doc/DEVELOPING.md`, `doc/DATABASE.md`, and Markdown under `doc/plans/`.
The first two still select the uncached typecheck/guidance lane; historical plans
need only the always-running policy checks. These inputs do not widen product
test selection or enter product task cache hashes. All other docs, bundled
skills, fixtures and unknown paths keep their existing conservative coverage.
A source change plus exempt prose remains graph eligible. When adding a reader
of exempt prose, update this policy as well as the task inputs.

For ordinary source PRs (including the audited prose inputs above), a separate `Select Vitest files` job refines the
general and serialized test lanes before their runners are allocated. It runs
on the gate-approved test fleet, loads the real Vitest projects, and follows
imports across workspace packages. Every project in the coarse plan is assessed,
including unchanged consumers. Projects without affected tests drop out of the
matrix; an unchanged directory alone does not prove independence. Filesystem, subprocess, network, CommonJS,
dynamic-loader, unresolved, and unapproved external-package consumers are
retained conservatively, including indirect consumers through local helpers.
Module-relative filesystem reads add explicit dependency edges when the path and
read API can be resolved without running code. This includes directory listings
and transitive helper reads. Dynamic paths, writes, escaped filesystem APIs,
mutable or shadowed bindings, generated inputs and paths outside the checkout
remain opaque. Setup-file reads invalidate the whole project when their input
changes. Object-valued constants, including URL objects, remain opaque even without
an observed mutation; inline URL construction and immutable string constants can
be resolved. Symlink reads track both the checked-in link and its physical target.
Missing inputs retain coverage.
The selector explicitly tracks setup/configuration dependencies as well as test
imports. Ordinary source names such as `session-config-metadata.test.ts` or
`setup-state.ts` remain eligible; the words `config` and `setup` alone do not
force full CI. Conventional Vite/Vitest config and setup files remain broad
inputs. Other resolved setup/config dependencies invalidate their entire project.
The small pure-dependency allowlist lives in
`scripts/ci/vitest-selection-graph.mjs`; new external packages remain opaque
until reviewed. This is deliberately broader than `vitest related` alone.
The reviewed Drizzle SQL/schema entry points have no ambient repository inputs.
Their full import closures are content-hashed in
`scripts/ci/reviewed-test-dependencies.mjs`; changed installed contents revoke the
exception. CommonJS and dynamic loaders reject a fingerprint rather than leave
unhashed children outside the closure. Database drivers and migration readers remain opaque. OS information,
in-memory streams, timers and compression do not read repository files themselves;
filesystem or process operations using their outputs retain their normal guards.
The syntax audit distinguishes data keys and erased types from runtime globals.
It examines the called member, not string arguments earlier in a chained call.
For conservative retention, explicit complete local mock factories cut the
mocked implementation's I/O edges. Partial mocks, spies, automocks, mock bypasses,
and dynamic or escaped mocking APIs do not. Edits to a mocked module still use
Vitest's unmodified related-file graph. Non-isolated projects run in full.
Literal Vite globs use Vite's expanded dependency edges, including newly added
members. Consumers of generated or untracked modules remain in the conservative
set because the import graph does not describe their build inputs.
The server's temporary-home and Supertest setup has a reviewed, content-hashed
exception. It still follows local helper imports. Any change to the reviewed
contents disables the exception until reviewed again; setup dependency changes
invalidate the whole project. Unreviewed setup I/O uses the full task plan.

Selected files are repartitioned within their existing owners using the current
per-runner budgets and server timing weights. Small selections allocate fewer
jobs; empty lanes allocate none. Serialized files remain serialized, and chat's
line shards, native Runner lanes, Rust, builds, typechecking and E2E retain their
existing selection/execution rules. The job summary reports files and jobs
selected per lane, and the `vitest-selection` artifact records the manifest and
dependency audit, including file-read edges and the first opaque dependency that
retained each test. Selected jobs execute exact Vitest test specifications, so
similarly named `.test.ts` and `.test.tsx` files cannot overlap between shards.
The wrapper consumes and validates the selection before launching Vitest, then
removes selection environment variables from the test process. Nested runner
fixtures therefore use their own checkout and test inventory.

Missing/deleted/renamed source files, non-exempt non-source inputs, unrecognized graph inputs,
setup/config changes, failed dependency installs, graph errors and timeouts use
the complete original task plan. Source mutations during dependency setup also
disable narrowing. A published manifest must match the checked-out
merge SHA and parent diff, its plan hash and the expected shard/project ownership. Missing or
invalid manifests fail selected jobs and the required aggregate; they cannot
turn reduced matrices green. Failed-job retries download the original artifact
ID saved with the plan, even when GitHub increments the run attempt. Turbo hashes the selected file assignment through
`PAPERCLIP_CI_SELECTION_HASH`, so a passing subset cannot satisfy a full run or a
different selection.

Graph discovery runs at most two isolated Node processes concurrently. Each
project retains its own Vite configuration, aliases and module graph. Any worker
error or timeout rejects the whole refinement and retains the original task plan.
The selector checkout needs only the merge commit and its two parents, not the
repository's complete history.

Server test costs are recorded in CI with tests, hooks, collection, setup and
environment preparation included. The weekly **Refresh CI test durations**
workflow opens a timing-only PR. It reads the general server weights from the
`General tests (server)` jobs of the two newest successful `PR` runs of merged
PRs, pinned to each PR's final head. Each run must have the full shard count in
`.github/ci-task-matrix.json` and cover at least 90% of the lane, so a run that
selected a few files does not count. These jobs run files three at a time, and
their contention changes relative file costs. Measured against two other PR
runs, Cloud readiness weights placed the slowest of 12 shards at 1,748-1,770 s of
summed file time, against a 1,595 s mean; PR-run weights placed it at 1,684-1,702 s. The
serialized weights still come from two successful protected-master Cloud
readiness runs. It never executes code from logs, changes test selection rules,
or grants AWS access. GitHub may require a maintainer to approve the bot PR's
workflow runs; the refresh never merges itself. An outstanding refresh PR pauses
new refreshes. Both timing manifests include source runs and measurement coverage.
The refresh requires at least 90% coverage of each current lane and uses median
measurements; missing files retain their old weights. Historical logs can bootstrap
test/hook costs until structured loading/setup measurements are available.

To reproduce a refresh from a full checkout with GitHub Actions read access:

```sh
node scripts/ci/refresh-test-durations.mjs [master-run-id ...]
node --test scripts/ci/test-selection-timing*.test.mjs
```

Set the repository variable `CI_VITEST_SELECTION=off` to disable file selection
while keeping the existing task-level optimization. Empty or `enabled` enables
it; other values disable it. `full-ci`, profiling, and task-level `full`/`shadow`
modes also bypass file selection. Qualification uses real Vitest graphs and real
Turbo cache entries, including a filesystem contract omitted by the raw graph:

```sh
node --test scripts/ci/test-selection*.test.mjs scripts/ci/cache.integration.test.mjs
```

General and serialized test suites and the standalone Rust suite use Turbo's
content-addressed cache. An execution adapter maps selected lanes to the existing
package scripts and their declared inputs. It selects tracked and non-ignored
source files, so generated build outputs do not invalidate later task results.
The test scripts keep responsibility
for their build prerequisites. GitHub Actions stores
these results in the PR's own cache scope, so a later push can reuse unchanged
tasks without giving PRs write access to master caches. Input hashes include
the relevant source trees, fixtures, scripts, manifests, resolved lockfile,
environment, toolchain, and checkout path. Unclassified tracked file contents
also enter the execution key, including changes inherited from a newer base.
Revision-stamped builds, registry smoke tests, browser suites, and Runner lanes
that perform integration checks retain their original uncached commands. The
post-merge release verification workflow continues to execute the full suite.

Inspect a proposed selection locally with `node .github/scripts/ci-plan.mjs origin/master HEAD`.
Run the planner and workflow-contract tests with
`node --test .github/scripts/tests/ci-plan.test.mjs`, and the real cache proof
with `node --test scripts/ci/cache.integration.test.mjs` after installing dependencies.
The separate Incremental CI qualification workflow exercises candidate changes
on GitHub-hosted runners before the trusted master workflows adopt them.

When a suite starts reading another package, asset, or runtime prompt, update
its inputs in `turbo.json`. This includes filesystem reads as well as imports.
Server tests inspect selected UI files, shared tests inspect UI logos, and Runner
static/Vitest lanes include server integration tests. Keep those dependencies
explicit. When changing shard layout, update `.github/ci-task-matrix.json` and
the full fallback matrices in `pr-trusted.yml`; the contract tests require them
to agree. Add new cache-affecting environment settings to `globalEnv`.

The `paperclip-ci-routing` runner group must allow
`paperclipai/paperclip/.github/workflows/ci-routing.yml@refs/heads/master`.
Keep `AWS_CI_ROUTING_USER_IDS_SOURCE` equal to the exact JSON value of
`AWS_CI_TRUSTED_USER_IDS` and `AWS_CI_ROUTING_USER_IDS` as its delimiter-wrapped
numeric IDs (for example, `|34892728|139239|`). Missing or mismatched admission
settings use GitHub-hosted capacity for the gate. Current CODEOWNERS remain
authoritative for PR execution regardless of these admission settings.
A maintainer's manual dispatch of `ci-routing.yml` on master exercises the AWS
metadata gate without launching the test matrix; its non-PR event returns the
hosted test-runner output.

GitHub starts a limited number of hosted jobs per hour for this repository, and
every hosted job waits in one first-come queue. Two settings keep community PRs
from delaying CODEOWNERS work in that queue:

- A PR run on GitHub-hosted runners queues at most four jobs per test matrix
  (`max-parallel` in `pr-trusted.yml`). It runs the same jobs; the rest wait
  inside the run instead of in the shared queue. AWS runs are not limited.
- With `AWS_CI_SHORT_JOBS_ENABLED` set to `true`, the `commitperclip PR Review`
  job and the `PR merge review notification` job for a CODEOWNER's own
  same-repository PR use the reserved `paperclip-ci-routing-x64` fleet. Both
  run only master's scripts, never PR code, and use the same admission
  variables as the gate. Check-run and commit-status notifications carry no
  verifiable author and stay GitHub-hosted, as does every community PR.
  Before setting the variable, allow
  `paperclipai/paperclip/.github/workflows/commitperclip-review.yml@refs/heads/master`
  and
  `paperclipai/paperclip/.github/workflows/pr-merge-review.yml@refs/heads/master`
  in the `paperclip-ci-routing` runner group. A job routed to a group that
  does not allow its workflow stays queued.

Keep the `.github/**` rule in `.github/CODEOWNERS` and the active master ruleset's
code-owner review requirement enabled. This covers the caller, the trusted
workflow, and CODEOWNERS itself. Existing administrator pull-request bypasses
remain governed by the repository ruleset.

When changing the workflow path or branch, authorize the new reference before
updating the caller. Retain older authorized SHA references while queued runs or
supported reruns still use them.

General server shards run at most three test files at a time in separate Vitest
forks. Each file retains its own home, config and process state, and its test
cases run serially. An explicit `PAPERCLIP_*_TEST_DATABASE_URL`, including
`PAPERCLIP_TEST_DATABASE_URL`, keeps those shards serial because the database
is shared. Native Runner suites use four isolated file workers. Their long
lease, preparation, disk-loss and checkpoint tests have separate files so real
observation windows can overlap. Issue recovery suites split by producer and
recovery behavior for the same reason. Unsharded local tests and route/authz
lanes retain their existing file concurrency. Maintenance server cases overlap
two owned server/database fixtures within their file; an explicit shared
maintenance database keeps them serial. Sharded chat jobs run
three independent partitions, each with its own embedded PostgreSQL, home and
config; an explicit shared test database retains one partition per job. The
partitions keep each source line whole and balance by the recorded time in
`scripts/chat-shard-durations.json`; entries without a record take the median.
Collected-case counts were a poor proxy because one `it.each` line can run many
cases: one of six count-balanced partitions recorded 532 s of test time against
a 377 s mean. To refresh the weights, add the `profile-ci` label to a PR, download
the `ci-profile-*` artifacts of its three chat jobs into one directory, and run
`node scripts/ci/refresh-chat-shard-durations.mjs --source=<run URL> <directory>`.
Stale weights change only the balance, never which tests run. A chat job
collects the suite once, then validates its three partitions' filters at the
same time; each partition still checks that its filters select exactly its
assigned tests.
The Runner transport lease-expiry and cold-admission regressions live in their
own file so those real-clock waits overlap other files in the existing pool.

Exact-source release verification uses the post-merge AWS fleet on the first
attempt. Reruns of its verification and chaos jobs use GitHub-hosted runners.
Exact-source cloud-migrator planning and package builds use the same policy.
This gives interrupted jobs an independent recovery path. It keeps the same
source, commands, assertions and required gates. A failed test still needs a fix;
a successful rerun does not explain an earlier failure.

The PR Runner Vitest jobs separate package tests from native server tests.
Three `--package-lane=K/3` jobs each run one duration-balanced partition of the
package inventory, and one `--native-server` job runs the complete native server
group. `run-pr-vitest-lane.mjs` asks `vitest list` for the inventory, so it
follows the `vitest.config.ts` includes. It partitions the files with the general
server partitioner, using the weights in
`packages/paperclip-runner/scripts/vitest-lane-durations.json`. Files missing
from that manifest get the median weight. The legacy `--shard=1/2` and
`--shard=2/2` commands keep their earlier PR behavior: the first runs the whole
package inventory and the second runs the native group. Other workflow names and
shard counts keep their existing coverage. Every lane still prepares debug
binaries. A separate exact-key debug cache holds
the workspace library and every Cargo binary target. Its key includes source,
protocol and fixture content, Cargo configuration, compiler flags, toolchain
and checkout path. Only the Rust lane of a verified master push saves it.
PR jobs only restore it; a missing or incomplete entry rebuilds normally.

Affected-test selection treats Vite's exact `?raw` imports as file inputs.
Changing that file selects its consumers. Generated/untracked files and unknown
query loaders retain their consumers conservatively. Other filesystem, process
and network effects keep their existing fallback.

One in ten CI CODEOWNER PR runs sends its job, step and outside-check timings to
Honeycomb. For a full wall-clock profile of all main PR CI jobs, add `profile-ci` to the PR.
See [CI profiling](ci-profiling.md) for the Honeycomb waterfall, coverage,
operator setup, and activation requirements.

## PR Vitest retry

PR CI retries a failing Vitest case once, so a single contention flake does not
force a re-run of the whole workflow. `scripts/ci/vitest-retry.mjs` owns the gate.
The default is one retry when `GITHUB_ACTIONS=true` and `GITHUB_WORKFLOW=PR`.
Reusable workflows inherit the caller's name, so `pr-trusted.yml` gets the retry
through `pr.yml`. Release, release verify, cloud readiness, master and local runs
keep zero retries. `PAPERCLIP_VITEST_RETRY` overrides the default in any context.
For example, set the `CI_VITEST_RETRY` repository variable to `0` to turn the retry
off, or set `PAPERCLIP_VITEST_RETRY=1` locally to reproduce the CI behavior.

`scripts/run-vitest-stable.mjs` passes `--retry` to every `vitest run`. This
covers the general, workspace, chat, native Runner and serialized lanes and the
selected-file path. The Runner package config sets `retry` itself, because its
lane runs Vitest directly. A test that passes only on a retry is still a flake.
`scripts/ci/retry-reporter.mjs` adds a `Flaky test passed on retry` warning
annotation for each such test, and a row to the step summary with the file, test,
retry count and job. Fix a test that this reporter reports. Do not treat the
retry as the fix. Playwright retries stay at zero.

## Typecheck lane in CI

The required `Typecheck + Release Registry` job runs one command:

```sh
node scripts/ci-typecheck-lane.mjs [--concurrency <n>]
```

It first runs the steps that write shared outputs, one at a time:

1. Link the workspace packages and build the plugin SDK.
2. Build the server with `PAPERCLIP_TSC_EMIT_ONLY=1`, then check that the
   server runtime assets are in `dist`. The server build no longer checks types
   here: the server layers check the same files, and the `Build` job runs the
   full `pnpm build`. The full program peaked at about 13.5 GiB, which left this
   16 GiB runner swapping.
3. Install the sandbox providers for the test programs
   (`typecheck-test-programs.mjs --prepare-only`).
4. Typecheck the Runner. Its typecheck rebuilds the eval kernel, which other
   checks read, so it cannot run beside them.
5. Run the CLI guidance test. It runs here, before the parallel checks, because
   one of its cases took 17 seconds beside them against a 15 second timeout.

Then it runs the remaining checks in parallel, as many as the machine has CPUs
(default) or `--concurrency`. Each `tsc` uses one thread. The server
declaration layers start first, because the test layers and the test projects
read them. The test programs and the other build-gap workspaces run at a lower
CPU priority, so they use only the CPU that the server layers and the release
registry tests leave free.

A passing check prints its output in a collapsed log group. A failing check
prints its output in full, between `=== FAILED ...` and `=== end of ...`
lines, with an error annotation. When the server declarations fail, the test
layers and test projects are reported as skipped. The lane ends with a table
of each check's start time, duration and result. If a preparation step fails,
nothing else runs.

To add a check to the job, add it to `planLane` in the script.

PR runs take the workflow from `master` but check out the PR's merge commit. A
stacked PR, whose base is another branch, can have a merge commit without this
script. The job then runs the six earlier commands one after another instead.

## Node version policy check

Run `pnpm check:node-version` to validate first-party Node version policy.
The check excludes the generated third-party distributions under
`packages/paperclip-runner/provider-assets/`, not other directories named
`provider-assets`. These assets appear after generation or build; a source-only
checkout may not contain them. Run
`node --test scripts/check-node-version-policy.test.mjs` for the isolated
synthetic vendored-manifest regression.
