# CI timing in Honeycomb

CI CODEOWNER PRs send their CI timing to Honeycomb in two ways:

| | Sampled (always on) | `profile-ci` label |
| --- | --- | --- |
| Which runs | One `PR` run in ten, by run number | Every run while the label is on |
| CI scope | Whatever the PR normally runs | All lanes of the main PR suite |
| Trace detail | Workflow, jobs, steps, outside checks | The same, plus test files and tests |
| Sample rate on spans | 10 | 1 |

Both are exported by the **CI profile** workflow after the `PR` run finishes,
to the `paperclip-ci` dataset. Outside contributors' PRs are never exported.

## Sampled runs

A `PR` run is sampled when its run number ends in 0. Sampling keeps or drops a
whole run: a sampled trace has every job and step. Each span carries a sample
rate of 10, so Honeycomb's counts and sums scale back to all runs, and duration
percentiles need no correction. `ci.profile_source` is `sampled`, and
`ci.pr_number` identifies the PR. Sampled runs change nothing in the PR jobs
and write no timing artifacts; job and step times come from the GitHub API.

A particular PR's run is in Honeycomb only if it was sampled. To inspect one
PR, add the label.

## Outside checks and total time

Every trace also has one span for each check on the PR's head commit that is
not a job of the `PR` workflow:

- `ci.kind=external_check`: reviews and scans from other apps, such as
  Greptile, and commit statuses (`ci.check_app=commit-status`).
- `ci.kind=workflow_check`: other workflows the PR started, one span each.

The root span has two totals. `ci.workflow_ms` is the `PR` workflow, from run
creation to its last job. `ci.all_checks_ms` runs from the same start to the
last check of any kind, and `ci.last_to_finish` names it. `ci.slowest_check`
and `ci.slowest_check_ms` name the longest outside check.

If an outside app's check is still running when the `PR` workflow finishes,
the exporter waits up to 15 minutes for it. It does not wait for other
workflows. Checks still running at export have no span; they are counted in
`ci.pending_check_count` and listed in `ci.pending_checks`, and
`ci.all_checks_ms` excludes them. Checks that started more than a minute
before the run, such as those from a push before a later label event, are
counted in `ci.earlier_check_count` and left out. Reruns carry no outside
checks. A workflow's completion time is its last update in GitHub.

## Profile the complete PR suite

Add the `profile-ci` label to a PR authored by a CI CODEOWNER. Adding the label starts a fresh `PR` workflow
run. Further pushes while the label remains also run with profiling enabled.
The run is named **CI profile · PR #number**. It runs all lanes of the main PR
suite, including middle-of-stack and release-notes-only PRs that normally skip
most lanes.

After the run finishes, open its Summary and follow **Open the Honeycomb
waterfall**. The separate **CI profile** workflow exports the trace after all
jobs finish. Its summary has the exact time range, job/span counts, and coverage
warnings. Keep the label on the PR and its head unchanged until export finishes.
Remove the label to stop profiling subsequent pushes. To profile the same
revision again, remove and re-add the label or rerun all jobs.

The PR author, original workflow actor, and rerun actor must all be individual
users in the trusted `master` branch's `.github/**` CODEOWNERS rule. GitHub user
IDs are resolved from that rule; PR edits to CODEOWNERS cannot grant access.
A label on an outside contributor's PR does not enable profiling, even when a
maintainer applies it. The PR still runs normal CI and needs no Honeycomb
access. Failed identity lookups disable profiling.

Ordinary PRs do not write timing artifacts. The exporter job is skipped for
ordinary run names unless the run is sampled. Adding another label does not run
the CI matrix.

Profiling preserves the existing trusted AWS runner routing. Eligible PR jobs
use `paperclip-public-pr-x64`. The synchronized maintainer admission roster
places the metadata gate on the reserved `paperclip-ci-routing-x64` AWS fleet.
The gate checks current CI CODEOWNERS before authorizing any PR code on AWS;
PR edits cannot grant access. A stale roster can allocate only the bounded
metadata gate. Normal base-branch advancement does not change an authorized
run's placement. See [Trusted PR Workflow](DEVELOPING.md#trusted-pr-workflow)
for the admission settings and immutable merge validation.
The existing fail-closed GitHub-hosted fallback still applies if AWS routing
cannot be authorized. The separate post-run Honeycomb exporter also uses
`ubuntu-latest`; it is outside the measured PR suite.

## Read the waterfall

The workflow root measures elapsed time from run creation to the last job's
completion. For reruns, it starts at that attempt's `run_started_at` instead of
the original creation time. Every job is a child on the same wall clock, with
its steps and available test details beneath it. Labelled runs use a sample
rate of one. There is no sampling within the selected attempt. For a compact Gantt view,
open a job row's menu and choose **Collapse spans at this depth**. Expand an
individual job to inspect its steps and test files.

The expandable hierarchy is **workflow → job → step → test filename → tests**.
Vitest, Playwright, and Node file rows use repository-relative filenames, also
available in `test.file`. Separate files retain their own children even when
individual test names repeat across files.
Honeycomb shows only the 32,000 spans closest to the root in a very large trace.
All file rows are near the root, but the chart can omit some individual test
rows. Use **View events** to query all recorded test spans. Test names are
limited to 256 characters in the trace; file paths remain intact.

- Compare the jobs that finish last (`ci.finishes_last`) with other overlapping
  work. A long job that finishes early is not necessarily delaying CI.
- Expand setup, dependency installation, cache restore, Rust compilation, builds,
  and tests to find repeated or slow work.
- `ci.execution_ms` measures a job's execution. `ci.start_offset_ms` shows when
  it started relative to the whole run. Do not add parallel job durations to
  calculate elapsed time.
- Waiting spans cover job creation to runner start. Dependency waits can occur
  before GitHub creates a job, so they appear as gaps from the workflow start.
  GitHub does not expose a separate ready timestamp; do not interpret every gap
  as runner queue time or claim this is a computed dependency critical path.

GitHub job/step timestamps have second precision. Vitest and Playwright record
test timestamps at the runner. Node's test reporter records completion receipt
time and duration (`test.clock=reporter-receipt`); buffered IPC delivery can shift
those small test spans. Vitest file spans include its test/hook execution and
carry collection/setup durations as fields. Playwright file spans cover the
first through last test attempt in that file. Rust and standalone script checks
retain their full job/step timings; stable libtest does not expose per-test wall
timestamps. The trace is CI timing data, not application tracing.

Scope includes all main PR lanes: policy, typecheck/release registry, general and
serialized tests, Runner checks, Docker context checks, build, canary dry run,
browser E2E, and aggregate checks. Separate Storybook, image, deployment, release,
and live-provider eval workflows are outside this trace.

## Failure, coverage, and reruns

The exporter uses GitHub's attempt-specific job API and paginates jobs and
artifacts. It includes failed and cancelled jobs and uploads available test
timings with `always()`. A force-cancelled or failed setup job may leave no
artifact. Coverage warnings and `ci.profile_complete=false` make missing
artifacts, interrupted reporters, rejected data, and absent test details visible.
Test launchers write an expected-invocation record before starting each Vitest,
Playwright, or Node process. Each reporter must write matching start/end records,
so a missing reporter cannot hide behind another successful invocation in the
same job. Direct package scripts can start a reporter without the launcher;
their start/end pair proves collection. Compare `ci.expected_invocations` with
`ci.reported_invocations`.
Failed or cancelled workflows are conservatively incomplete because a failed
command can prevent later tests or steps from running.

Each attempt gets a different trace ID. Rerunning failed jobs alone produces an
attempt trace for those jobs; it does not replay completed jobs. Reruns are marked
`ci.partial_rerun=true` conservatively. Use a fresh label-triggered run for an
unambiguous full-suite baseline. GitHub may carry earlier successful jobs into
the new attempt's job inventory. Jobs completed before the new attempt started
are excluded and counted in `ci.carried_job_count`.

The exporter sends bounded batches with pauses and retries only events that
Honeycomb rejects temporarily. If export still fails, inspect **CI profile**
before rerunning it. A partial HTTP export may already have sent some spans;
reruns use the same IDs but the Events API does not promise deduplication. Timing artifacts
remain available for 14 days. Invalid/oversized artifacts stop export instead of
silently truncating the suite. No logs, environment dumps, error messages, stack
traces, or credentials are included in the exported field allowlist.

## Operator setup and activation

Use the existing Honeycomb `paperclip` team, `test` environment, and a separate
service dataset named `paperclip-ci`. Create GitHub environment `ci-profiling` with **Selected branches and tags**:
allow only the branch `master`, with no PR-ref or tag patterns. Store environment
secret `HONEYCOMB_CI_API_KEY` with a dedicated ingest-only key for the Honeycomb
`test` environment. Do not create a repository- or organization-level secret of
that name: the environment restriction prevents in-repository PR workflows from
requesting the key. Tests still execute the PR branch; only the separate exporter
runs from `master`. It needs event
ingest permission; dataset creation permission is needed only if the dataset
has not been created yet. Do not store the environment configuration key in CI.
Create the repository label `profile-ci` if it does not exist.

`ci-profile.yml` runs from the trusted default-branch revision. It checks out only
the exporter, installs no dependencies, and parses PR artifacts as bounded JSON
without extracting or executing their contents. The PR jobs never receive the
Honeycomb key. The exporter independently verifies CI CODEOWNER identities,
the repository, the exact tested PR revision and, for labelled runs, the
current label before reading artifacts or sending data.

The export job's condition is a first filter, evaluated before a runner starts
or the environment is entered. It requires the main `PR` workflow on a branch
of this repository, an actor and rerun actor on the `AWS_CI_ROUTING_USER_IDS`
maintainer roster that CI routing uses, and a labelled or sampled run. A fork
PR, or a run started or rerun by anyone off the roster, skips the job. The
roster only filters: the CODEOWNERS check in the exporter decides. If the
roster variable is empty, nothing is exported. Its credential is sent only in an HTTPS header to
`api.honeycomb.io`; redirects are rejected. Exported fields are allowlisted.
`CODEOWNERS` also covers `scripts/ci-profile/**`, so changes to the privileged
exporter require infrastructure-owner review.

The new trusted workflow and routing definitions must merge to master before
the label-triggered journey is active. A PR uses `pr-trusted.yml@master` and
`ci-routing.yml@master`; do not change those trust references just to test this
feature before merge.

## Local qualification

```sh
node --test .github/scripts/tests/ci-profile.test.mjs .github/scripts/tests/ci-routing.test.mjs
node --test scripts/ci-profile/reporters.test.mjs
actionlint .github/workflows/{pr,pr-trusted,ci-routing,ci-profile}.yml
node scripts/ci-profile/export.mjs --run-id=RUN_ID --attempt=1 --historical --dry-run --output=/tmp/ci-trace.json
```

`--historical` is local-only and permits a deliberate export of an existing
unlabeled run. It has complete GitHub job/step timing but cannot reconstruct
test details that were never recorded. Omit `--dry-run` and supply
`HONEYCOMB_CI_API_KEY` to send the selected baseline to Honeycomb. It is labeled
as historical/incomplete test coverage; it is not proof of the label-triggered
workflow.

References: [Honeycomb trace fields](https://docs.honeycomb.io/get-started/best-practices/organizing-data/),
[Events API](https://docs.honeycomb.io/api/events/create-events),
[large trace display limit](https://docs.honeycomb.io/troubleshoot/common-issues/data-in-honeycomb/#your-very-large-trace-displays-only-32000-spans),
[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

## Qualify reductions in CI work

For changes to the stable test launcher, dependency setup, or the large Git and
readiness fixtures, `profile-ci` also runs **CI work benchmark**. It uses one
GitHub-hosted runner without secrets or AWS access. It compares the unchanged
PR base and candidate sequentially. It records complete command times, test
inventories, revisions, and failure logs in the `ci-work-benchmark` artifact.
The complete general-server shard must retain the same cases. The fixture comparison retains
the database contract and splits large Git scanning from bounded staging.
These command timings exclude queue time and setup; use the full Honeycomb
waterfall to assess the complete CI critical path.

The benchmark also exercises cold dependency setup and a real materialized
cache restore after removing the installed directories. Its two qualification
entries are scoped to the PR merge ref and a separate checkout path. They cannot
populate master's caches. Normal PR lanes restore only; the exact canonical
master push in release verification is the normal cache writer.

Materialized dependency keys include every tracked package manifest, lockfile,
workspace configuration, patches, repository scripts, Node version/ABI, platform,
architecture, libc, pnpm version, store location, and physical checkout path.
There are no prefix restores. An input change takes the normal install path.
A stale lockfile uses the existing resolution fallback but cannot publish an
entry. An additional workspace install/prepare hook disables materialized reuse
until its inputs are modeled. Shared/SDK build outputs have a separate key that also includes both
packages' source/configuration and the build verifier. The existing verifier
checks source and output fingerprints and rebuilds incomplete or changed output.
Tests and their results are never cached or omitted by this mechanism.

Serialized shards share one Vitest controller with `forks`, `isolate`, one
worker, and file parallelism disabled. Each file gets a separate process and
test home/configuration. The isolation regression runs files in both orders and
checks process IDs, environment, globals, fake timers, and filesystem state.

The readiness regression uses a real one-second PostgreSQL idle timeout and
verifies that the backend connection changes while the parent write can commit.
Its configured readiness window stays long. The Git regression keeps all four
filename lanes above 32 MiB, while the staging case transfers and deletes 4,000
files whose filename list exceeds 2 MiB. It still checks every staged file,
unusual names, snapshot ownership, cleanup, and bounded command lengths.

The Linux public-install check serves metadata read from the actual packed
archives through a temporary loopback registry inside its download container.
This avoids npm's file-spec manifest extraction of every archive before the
real install. npm still verifies each archive's SHA-512 and installs the same
packed bytes into an empty consumer. Other dependency metadata redirects to
the public npm registry; public tarball URLs remain unchanged. The temporary
registry closes before the existing offline lifecycle rebuild and runtime
probes. No lifecycle, network-isolation, lock-preservation or provider checks
are skipped. Native ARM and Mac qualification keep their existing file installs.

The Linux verifier also shares `PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE` with the
producer installs that prepare bundled dependencies. These run after the existing
cache warm-up and reuse its downloaded archives instead of populating a second
host cache. Each producer still installs into a separate empty directory, applies
the release patches, and packs fresh output. npm resolution and integrity checks
remain enabled; cache misses download normally. Without an explicit shared cache,
producer installs keep their normal npm cache configuration.

After the offline lifecycle finishes, Pi setup runs in its own download sandbox
while the independent Codex/Grok probes run offline. Pi admission still waits
for successful setup and an unchanged consumer lock. The setup container has a
unique verifier-owned name and is removed on early failure as well as completion.
`pi_setup_prefetch_ms` measures setup wall time; `pi_setup_wait_ms` measures only
the remaining wait after the other probes. These overlapping durations must not
be added when interpreting total verification time.
