# Profile the complete PR suite

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

Ordinary PRs do not write timing artifacts or export traces. The exporter job is
skipped for ordinary run names. Adding another label does not run the CI matrix.

Profiling preserves the existing trusted AWS runner routing. Eligible PR jobs
use `paperclip-public-pr-x64`; the routing gate uses `paperclip-ci-routing-x64`.
The existing fail-closed GitHub-hosted fallback still applies if AWS routing
cannot be authorized. Only the separate post-run Honeycomb exporter uses
`ubuntu-latest` directly; it is outside the measured PR suite.

## Read the waterfall

The workflow root measures elapsed time from run creation to the last job's
completion. For reruns, it starts at that attempt's `run_started_at` instead of
the original creation time. Every job is a child on the same wall clock, with
its steps and available test details beneath it. All spans use a sample rate of
one. There is no sampling within the selected attempt. For a compact Gantt view,
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
the current label, repository, and exact tested PR revision before reading
artifacts or sending data. Its credential is sent only in an HTTPS header to
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
workspace configuration, patches, the cache planner and audited root installer, Node version/ABI, platform,
architecture, libc, pnpm version, store location, and physical checkout path.
The current root installer only links the excluded plugins to the workspace SDK.
Its exact reviewed source hash permits unrelated repository scripts to change
without discarding installed dependencies. A changed or missing installer
restores the conservative key that includes every repository script. Review its
complete inputs before updating that source hash. A new workspace lifecycle hook
still disables reuse. The v2 dependency key requires a new canonical master entry;
an older v1 entry is never restored under the narrower contract.
There are no prefix restores. An input change takes the normal install path.
A stale lockfile uses the existing resolution fallback but cannot publish an
entry. An additional workspace install/prepare hook disables materialized reuse
until its inputs are modeled. Shared/SDK build outputs have a separate key that also includes both
packages' source/configuration and the build verifier. The existing verifier
checks source and output fingerprints and rebuilds incomplete or changed output.
Tests and their results are never cached or omitted by this mechanism.

For a local experiment with an oversized Runner test file, first run the unchanged
file with Vitest's JSON reporter. Then, from `packages/paperclip-runner`, run:

```sh
node ../../scripts/run-vitest-case-shards.mjs src/live/runnerd-codex-transport-settlement.test.ts 4 /tmp/runner-settlement-profile
```

The launcher dynamically collects the expanded parameterized cases, distributes
literal full names across isolated Vitest processes, and retains each log and
JSON report. Cases within each process remain serial. Duplicate titles stay
together. Every assigned case must actually pass; missing, extra or skipped
cases fail qualification. This is only suitable for files whose cases already
own their fixtures and clean up their state. It does not change timeouts, use fake
timers, or edit assertions. The receipt includes collection and process startup
time. It does not measure CI setup, scheduling or the complete workflow.
Run baseline and candidate without another benchmark competing for the same host.

The CI case partition applies to transport, deadline, and OpenCode driver files.
Settlement remains in the ordinary whole-file partition. Its release-binary
qualification passed all 19 cases serially but exposed failures with both grouped
and per-case parallel processes; neither grouping is accepted as a CI speedup.
Keep the complete serial regression until a narrower change proves it safe.

The `general-workspaces-b` lane overlaps at most two project invocations. Each
keeps its own temporary home, configuration and instance identity. Their combined
Vitest worker limit stays within the detected CPU capacity or the explicit
`VITEST_MAX_WORKERS` budget. A configured shared test database or a single worker
keeps project execution serial. All projects finish before a failure is returned.
The UI/CLI and database lanes retain their existing scheduling.

The PR and canonical release-verification workflows set `CARGO_PROFILE_DEV_DEBUG=0`
before restoring the shared Rust cache. This omits debug symbols from the debug
helpers used by TypeScript integration tests. It preserves development-profile
optimization, debug assertions, overflow checks and every test. Developer builds
keep their normal defaults. Both cache readers and the writer use the same
setting; the pinned Rust cache action hashes all `CARGO*` environment variables,
so the first run uses a separate cache entry and builds normally on a miss.
Release-profile optimization and checks are unchanged. Both workflows also set
`CARGO_INCREMENTAL=0`, matching the pinned Rust cache action before any restore.

Build, Canary, and Typecheck first restore the small, exact-key Runner release
artifact. A v2 entry includes a producer receipt written only after the canonical
master Rust lane cleans and builds the workspace crate. The receipt binds the
executable checksum to the compiler, checkout, all modeled inputs, compiler
dep-info, and declared build-script environment dependencies. Changed inputs,
custom Cargo/compiler configuration, unsupported build inputs, incomplete
entries, or failed verification use normal dependency restoration and compilation.
Failed verification removes only the restored workspace-crate artifacts so Cargo
cannot accidentally retain the rejected executable.

On a verified hit, the reader copies the executable into a private temporary
snapshot. Each `build:binary` invocation rechecks its source/environment/compiler
and checksum before using the usual atomic staging and macOS signing path. These
three jobs can then omit the large mixed debug/release dependency cache: they
only consume the self-contained executable. Rust and protocol test lanes retain
their dependency caches, normal compilation, and every test. Readers never save
an entry, use a prefix match, or accept a v1 entry under this stronger contract.
The first canonical master run must populate v2. `record-artifact` and
`prepare-artifact` expose their decisions in the job log; a miss is not a speedup.

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

The PR Runner matrix has eight file shards. When
`PAPERCLIP_RUNNER_CASE_SHARDS=true`, each shard excludes the four files listed in
`packages/paperclip-runner/scripts/run-pr-case-shard.mjs` from its ordinary file
run and then runs its assigned cases from those files. Every lane dynamically
collects the same inventory, keeps duplicate titles together, and checks actual
results against its assignment. A missing, failed, or skipped assigned case
fails the lane. All eight lanes are required. The server native-runner group
still runs only on the final lane. Without the opt-in, the wrapper retains its
complete ordinary file run, including on older PR heads that lack the new
helper. This preserves coverage while trusted workflows advance on master.

Each case file uses one Vitest process per lane, with up to four files active
within the CPU budget. Cases remain serial within that process. The OpenCode
fixture is made executable before each case because filtered runs cannot rely
on an earlier case setting its permissions. Its file must not run in multiple
processes sharing one checkout: its final cleanup resets the shared fixture's
permissions. CI lanes have separate checkouts. Deadline cases retain their
real lease expiry waits. This adds six Runner jobs; include their setup,
collection, and runner-minutes when measuring the whole workflow. A shorter
case phase alone does not establish a faster complete workflow.

Release planning fetches only stable, canary, nightly, and beta tags. It does
not need the remote's development branches or preview tags. Existing release
tags are never overwritten or removed, and the exact remote-tag existence
check still runs before a release. A paired shallow-checkout experiment against
the same public remote took 15.35 seconds for all branches and tags, versus
7.72 seconds for release tags only. All 1,781 release tag object IDs matched;
repository data was 424 MB versus 248 MB. These are local fetch measurements,
not a measured reduction in complete CI wall time.
