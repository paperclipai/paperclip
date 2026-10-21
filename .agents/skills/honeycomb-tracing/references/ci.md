# Profile the full PR suite

Use [doc/ci-profiling.md](../../../../doc/ci-profiling.md) as the maintained
operator runbook. This path exports recorded CI timing through Honeycomb's Events
API; it does not require application OTLP settings or an application run UUID.

## Select one complete attempt

1. Confirm the intended PR and head. Profiling is opt-in through `profile-ci`.
   The PR author, original workflow actor, and rerun actor must be individual
   users authorized by trusted master's `.github/**` CODEOWNERS rule. Applying
   the label to an outside contributor's PR does not grant profiling access.
2. When asked to profile that PR, add the label. It starts a fresh
   **CI profile · PR #number** run of the main `PR` workflow. The label forces
   all main lanes even for stack-middle or release-notes-only changes. Further
   pushes also profile while it remains present.
3. Record run ID, attempt, tested revision, and job inventory. Keep the label
   and head unchanged until the separate **CI profile** exporter completes.
   Use a fresh label-triggered run for an unambiguous whole-suite baseline.
   Rerunning only failures does not rerun the successful jobs.
4. Open the Honeycomb waterfall from the run/exporter's Summary. The project
   destination is team `paperclip`, environment `test`, dataset `paperclip-ci`.
   Verify the displayed root and representative file spans; a generated URL
   or green test workflow is not proof that export succeeded.
5. Remove the label after a one-off profile unless ongoing profiling was requested.
   Re-adding it starts another complete attempt. Report any remaining label so
   future pushes do not unexpectedly keep profiling.

The main suite preserves existing AWS routing (`paperclip-public-pr-x64`, with
`paperclip-ci-routing-x64` for routing) and its authorized hosted fallback.
Inspect actual runner assignments if AWS placement is part of acceptance. The
separate exporter uses `ubuntu-latest` and is outside the measured suite.

## Read and qualify the result

The hierarchy is **workflow → job → step → test filename → tests**. Collapse
spans at the job depth for a shared wall-clock view; expand slow jobs and search
for a known `test.file` to prove filename-level detail arrived.

- Root elapsed time runs from workflow creation to the last job completion;
  reruns start at that attempt's start. Do not sum concurrent job durations.
- Use `ci.finishes_last`, `ci.execution_ms`, and `ci.start_offset_ms` to find
  late-finishing work, then inspect setup, caches, compilation, builds, and tests.
  A long job that ends early may not delay the suite.
- Waiting spans start at job creation. Dependency waits before job creation
  appear as gaps; GitHub does not expose a separate ready timestamp, so those
  gaps are not proven runner-queue delay or a computed dependency critical path.
- Vitest, Playwright, and Node supply file/test detail with different timestamp
  semantics. GitHub steps have second precision; Node test spans use reporter
  receipt time. Rust and standalone scripts retain job/step coverage.
- Scope is the main PR workflow. Separate Storybook, image, release, deployment,
  and live-provider eval workflows are not included.

Inspect `ci.profile_complete`, coverage warnings, expected versus reported
invocations, file/test counts, `ci.partial_rerun`, and `ci.carried_job_count`.
Failed/cancelled attempts can omit downstream work; carried jobs completed before
the new attempt are not fresh measurements. Compare the trace inventory with
GitHub's attempt-specific jobs and retained timing artifacts.

Honeycomb's waterfall displays at most 32,000 spans, prioritizing those closest
to the root. Missing deep test rows can be a display limit rather than missing
ingest. Check **View events** and coverage evidence before claiming data loss.
See the [provider's large-trace limit](https://docs.honeycomb.io/troubleshoot/common-issues/data-in-honeycomb/#your-very-large-trace-displays-only-32000-spans).

## Credentials and export failures

`HONEYCOMB_CI_API_KEY` is a dedicated ingest-only **environment secret** in
GitHub environment `ci-profiling`, restricted to `master`. Only the trusted
default-branch exporter reads it. PR tests still execute the PR branch and never
receive the key. Do not move it to repository/org secrets, put a configuration
key in CI, execute downloaded artifacts, or switch trusted workflow refs to a PR
head for convenience. Ordinary CI must work with profiling disabled and no key.

The exporter checks each batch response, paces uploads, and retries only
transiently rejected events. If it fails, inspect its logs and saved artifacts
before retrying: partial export may already have sent spans, and the Events API
does not promise deduplication on resubmission. Timing artifacts are retained for
14 days. Preserve incomplete-export evidence even if a later upload succeeds.

For local reconstruction without uploading, use the existing exporter:

```sh
node scripts/ci-profile/export.mjs --run-id=RUN_ID --attempt=1 --historical --dry-run --output=/tmp/ci-trace.json
```

Replace `RUN_ID` and attempt with the recorded values. This needs authorized
GitHub read access. Historical reconstruction can recover job/step timings, but
cannot invent file/test timings that were never recorded. It does not prove the
live label-triggered journey. A real historical upload is a separate authorized
action using the ingest key, not a necessary part of diagnosis.

When changing CI tracing, use the runbook's focused exporter, routing, reporter,
and workflow checks. For a whole-suite tracing acceptance, return the exact
GitHub attempt and Honeycomb links, elapsed time, coverage and export status,
runner placement if relevant, and the late-finishing jobs/file timings that
justify the next optimization.
