# Cloud build readiness

The `Cloud readiness` workflow starts for every master push. Its versioned
`Cloud deployable v1` job succeeds only after all three prerequisites succeed:

- The existing `Release Verify` workflow checks that exact commit, including
  typecheck, builds, general and serialized tests, and Runner verification.
- The reusable `Docker cloud` workflow builds and verifies its Linux AMD64
  image, including Sentry resolution and orphan reaping, then publishes the
  full-SHA cloud tag. Cloud readiness owns the master trigger so there is one
  cloud build per push. Release tags and manual Docker runs retain their callers.
- The full-SHA image and both exact-source npm packages are visible. The
  packages are `@paperclipai/shared` and `@paperclipai/db` at
  `0.0.0-preview.g<FULL_SHA>`, published through the migrator-only release lane.
  Registry metadata must match the full commit, and the database package must
  pin the matching shared package.

Verification and image building run concurrently, outside the full npm release's
concurrency group. Different commits have independent groups. Source verification
is initially duplicated with the normal npm release: this spends existing hosted
runner capacity to avoid waiting behind an older release. No verification gate is
removed from npm publication. Watch organization-wide runner queues when measuring
the result.

The artifact wait runs for up to 30 minutes and reports what is missing. Only
an HTTP 404 means publication is pending; authorization errors, upstream outages,
and identity mismatches fail the job. A failed, cancelled, or skipped prerequisite
cannot produce a successful readiness job. Retry the failed publication or build,
then rerun the failed readiness workflow jobs to check the same commit again.

## Consumer contract

`Cloud deployable v1` is a source-and-artifact readiness signal. A deployment
consumer must still resolve and pin the image digest and npm integrity/lockfile,
validate migration contents and compatibility, and apply its target health gates.
The check creates no release record and deploys no instance. A full-SHA tag by
itself, or a successful migrator dispatch, is not this readiness signal.

For automatic selection, accept only a successful job named exactly
`Cloud deployable v1` in the latest attempt of a successful
`.github/workflows/cloud-readiness.yml` run in `paperclipai/paperclip`, with
event `push`, head branch `master`, and the expected full head SHA and repository.
Do not trust a similarly named check from another workflow or a manual branch run.
Order candidates by master ancestry, not job completion time: an older commit
finishing late must not roll a fleet backward. Fail closed on API errors.

Existing npm canary discovery is unchanged by this producer workflow. Consumers
can adopt the versioned signal separately after the workflow has landed and
successfully verified a real master commit.

## Timing and rollout

Measure the complete path from a master merge to a healthy target running that
exact commit. Keep readiness and deployment as separate milestones:

| Milestone | Evidence | Elapsed time starts at |
| --- | --- | --- |
| Merge | Merged PR timestamp and full merge commit SHA | Merge |
| Image available | Successful full-SHA image publication and verification | Merge |
| Cloud deployable | Successful `Cloud deployable v1` job in the accepted push run and attempt | Merge |
| Canary healthy | Deployment consumer's canary health gate confirms the target commit | Merge |
| Fleet complete | Campaign succeeds for all eligible targets at that commit | Merge |

Record the source SHA, workflow run ID and attempt, readiness job completion
time, and deployment campaign identity together. Verify the run against the
consumer contract above. A manual dispatch can test wiring, but its timestamp
does not measure automatic merge-to-deploy latency. A preparation-only run
resolves artifacts without deploying a target and must not be counted as a
successful deployment.

Record queue time and the image, source-verification, and artifact-wait durations
separately. The slowest prerequisite determines readiness; shortening an already
faster prerequisite may have no effect on the total. After readiness, measure
consumer discovery delay, artifact resolution, canary health, and fleet rollout.
An automatic consumer that still waits for the full npm canary publication has
that queue on its critical path even if cloud artifacts are ready earlier.

For a target health measurement, confirm the deployed source SHA as well as
service health. A proxy health response alone may describe the control plane
while the tenant still runs the previous image. Report the eligible target count,
excluded or sleeping targets, retries, and failures with the fleet result. Record
runner queue conditions and cache state; one warm or cold run is a sample, not a
latency guarantee.

Land full-SHA image publication, independent cloud builds, and migrator-only
publication before enabling this workflow. Until those producers are present,
the artifact wait cannot succeed. A manual dispatch on master can verify the
wiring, but automatic consumers should use push runs. Source verification and
registry checks can be rerun without deploying or changing mutable npm channels.

When reverting this workflow, restore the master push trigger in
`docker-cloud.yml` in the same change so master images continue to build.
