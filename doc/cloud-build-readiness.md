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

The Cloud workflow builds the image with `USER_UID=1001` and `USER_GID=1001`,
matching the managed runtime. This avoids a startup user remap, which can walk
the mounted home and delay health checks. Before publishing the full-SHA tag,
the workflow checks the baked identity without running the entrypoint, then
checks the normal entrypoint's effective user and writable home. Volume ownership
repair still runs when needed. The Dockerfile defaults remain `1000:1000` for
self-hosted builds, and runtime identity overrides remain supported. The first
build with the new identity must rebuild layers that depend on the base image;
later builds can reuse those layers.

Verification and image building run concurrently, outside the full npm release's
concurrency group. Different commits have independent groups. The npm canary
release reuses `Cloud source verified v1` for the exact master push instead of
starting a second copy of `Release Verify`. This source-only job depends on every
source check but does not wait for Docker or migrator publication. npm canary
publication remains possible when source verification passes and an image build
fails. Stable releases and candidate-branch betas still run full verification.

The canary consumer requires the expected workflow ID and path, upstream source
repository, master push event, full SHA, and a successful job in the latest run
attempt. It checks the run again after reading the jobs to reject a concurrent
rerun. Missing proof waits for up to 45 minutes; failed, skipped, cancelled,
ambiguous, or mismatched proof cannot authorize publication. API failures fail
closed. If a source check fails, fix it and rerun Cloud readiness before retrying
the release. Use **Re-run all jobs** when a later attempt did not rerun the source
proof; an earlier attempt's successful job is not accepted. This avoids duplicate
test jobs on standard runners. Measure queue time to assess the timing gain.

Release verification spreads the general server suites across ten standard hosted
runners, with the long chat suite split separately across three jobs. Each server
job still runs one test worker. The partition covers every suite exactly once;
normal PR and local test groups keep their existing shape. More jobs increase
concurrent runner demand, so compare queue time as well as test duration.

All release verification installs, including the Runner scorer and chaos evals,
allow pnpm to refresh an outdated lockfile. Contributor PRs leave lockfile updates
to the separate refresh bot, so a dependency-changing master commit can arrive
before that bot's PR merges. Verification must install and test that commit
without waiting for another merge. The generated lockfile stays in the job's
workspace; these checks do not commit it back to the repository.

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

The reusable Runner chaos workflow scopes concurrency to the caller workflow
and source ref. Cloud readiness, stable verification, and standalone evals can
verify the same commit at the same time. They must not cancel each other's
required test job.

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

## Reserved AWS verification capacity

`AWS_POST_MERGE_CI_ENABLED=true` routes cloud source verification, artifact
waiting, readiness signals, and exact-master migrator preparation to the
`paperclip-post-merge` runner group. The separate Fleet label is
`runs-on/fleet=paperclip-post-merge-x64/env=public-ci`. Its 36 reserved slots use
the same four-vCPU, 16-GiB machines as approved PR jobs. PR capacity is reduced
to 64; image capacity stays at eight. The total ceiling remains 108 runners.
This keeps PR bursts from consuming every post-merge verification slot.

Every selector checks the canonical repository name and ID, master ref, and a
push or manual event. Reusable verification also requires `inputs.ref` to equal
that event's `github.sha`. The migrator route requires `cloud-migrator` and
`inputs.source_ref == github.sha`. Branch/tag refs, PR events, arbitrary preview
sources, and missing or disabled switches use GitHub-hosted runners. If another
merge lands before a migrator dispatch resolves master, the older source uses
GitHub-hosted runners too. npm publication always remains GitHub-hosted to keep
its trusted-publisher identity.

Before enabling the switch, deploy the separate Fleet and restrict its GitHub
runner group to repository ID `1170821064` and these workflows at
`refs/heads/master`: `cloud-readiness.yml`, `cloud-artifacts.yml`,
`release-verify.yml`, `runner-chaos-evals.yml`, and `release.yml`. Do not authorize
PR-controlled workflow versions. PR placement retains its independent pinned
workflow and six-account author/actor allowlist.

Disable the switch and rerun the whole workflow to restore GitHub-hosted
placement. Assigned jobs keep their original runners. Readiness requirements,
source checks, and npm integrity checks are unchanged.

## AWS cloud build routing

`AWS_CLOUD_BUILDS_ENABLED=true` routes the Docker cloud job to the
`paperclip-cloud-build-x64` RunsOn Fleet for canonical `paperclipai/paperclip`
master pushes and manual master runs. Forks, pull requests, and release tags
retain GitHub-hosted runners. The separate `AWS_CI_ENABLED` and
`AWS_CI_TRUSTED_USER_IDS` variables control PR routing.

The cloud Fleet uses a separate runner group, `paperclip-cloud-build`, restricted
to this repository and `.github/workflows/docker-cloud.yml@refs/heads/master`.
Provision that group and Fleet before enabling the variable. The cloud runners
need at least 64 GiB free for Docker and the workspace; the initial configuration
uses 120 GiB disks with the existing 4-vCPU, 16-GiB machine size. AWS jobs have
a 40-minute workflow timeout so they finish before the 45-minute instance
lifetime; GitHub-hosted jobs retain their 60-minute timeout. Keep the registry
cache and all pushed-image verification steps enabled.

To roll back routing, set `AWS_CLOUD_BUILDS_ENABLED=false`, then rerun the cloud
workflow. Changing the variable does not migrate an already assigned job.
Check the Actions job's runner name and runner group to verify placement. Record
queue time, image verification completion, and `Cloud deployable v1` separately;
source verification and the migrator still run on GitHub-hosted runners.


### Typecheck Rust dependency cache

Source verification's typecheck job builds the native Runner binary through the
server's `prepare:runner-vendor` command. It restores and saves compiled Rust
dependencies only for canonical master pushes that verify the event's exact SHA.
The `release-typecheck-v1` cache is separate from Runner verification because
those jobs compile different profiles. The pinned toolchain is selected before
cache lookup. Workspace crates and installed cargo binaries are excluded, and
all typechecks still execute. A missing or invalidated cache triggers compilation.

### pnpm dependency store cache

The Refresh Lockfile workflow does not cache the pnpm store. Its resolution-only
command does not download packages and can save an empty default-branch cache
before full install jobs finish. The PR policy job also leaves store caching off.

PR install jobs restore the pnpm store without saving it. They hash the checked-in
lockfile before downloading the policy job's regenerated lockfile, matching the
key format used by master install jobs. A same-OS, same-architecture pnpm fallback
can reuse older package downloads when the exact key is absent. Each job still
installs with `--frozen-lockfile` against the policy artifact when one exists;
cache contents do not select dependency versions. A cache miss downloads packages
normally. New PR-only dependencies may be downloaded again on each PR run until
master populates a cache that contains them.

This avoids storing a full dependency archive under every PR merge ref. Those
copies competed with the Rust caches for the repository's storage limit. Keep
master cache writes enabled so trusted post-merge installs refresh shared stores.
After activating the new trusted workflow pin, verify cache restores and package
reuse in an allowlisted PR, and verify that no new `node-cache-` entries appear
under its `refs/pull/<number>/merge` ref. Existing copies can expire normally.

The repository cache storage ceiling is managed in GitHub Settings, separately
from this workflow. Check it with:

```sh
gh api repos/paperclipai/paperclip/actions/cache/storage-limit
```

Increasing the repository limit above 10 GB can require an organization owner to
raise the maximum in organization Settings → Actions → General first. Repository
administration access alone cannot override that maximum. Paid cache storage also
requires a payment method and sufficient Actions Cache Storage budget; see the
[GitHub cache storage documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#increasing-cache-size).
Preserve populated master pnpm and Rust caches when inspecting pressure.

After deploying this correction, remove any existing empty default-branch entry
for the current lockfile key. List cache IDs, branches, and archive sizes first:

```sh
gh api --paginate 'repos/paperclipai/paperclip/actions/caches?ref=refs/heads/master&key=node-cache-Linux-x64-pnpm-&per_page=100' \
  --jq '.actions_caches[] | {id, ref, key, size_in_bytes}'
```

Match the key and upload size against the cache-creation job's logs. The
September 11 incident was cache ID `7559920987`, a 216-byte archive. This guarded
command deletes only that observed entry. It leaves a populated replacement or
an entry on another branch untouched, and does nothing if the old ID is absent:

```sh
bad_cache_id=7559920987
bad_cache_key=node-cache-Linux-x64-pnpm-c3096ecb02a34aaa9782baaadafcb731510e1dba10dd661618c3a2ee91e58fa5
entries="$(gh api --paginate --slurp 'repos/paperclipai/paperclip/actions/caches?ref=refs/heads/master&per_page=100')"
if printf '%s\n' "$entries" | jq -e --argjson id "$bad_cache_id" --arg key "$bad_cache_key" '
  [.[].actions_caches[] | select(.id == $id)] |
  length == 1 and .[0].ref == "refs/heads/master" and
  .[0].key == $key and .[0].size_in_bytes == 216
' >/dev/null; then
  gh api --method DELETE "repos/paperclipai/paperclip/actions/caches/$bad_cache_id"
fi
```

A subsequent master install can populate the missing entry. Check the saved
archive size and package reuse in install logs; a cache hit alone does not prove
that the entry contains dependencies.
