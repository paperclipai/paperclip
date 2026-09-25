# Cloud build readiness

The `Cloud readiness` workflow starts for every master push and retains the
versioned `Cloud source verified v1` job. It calls the full `Release Verify`
workflow for that exact commit, including typecheck, builds, general and
serialized tests, and Runner verification. The source proof depends on every
source check and fails closed if verification fails, is cancelled, or is skipped.

The recurring public `-cloud` publisher and its `Cloud deployable v1` gate are
retired. The workflow no longer builds a legacy image or waits for one.
Keep its filename and source-proof job name stable: npm canary publication and
downstream image composers consume that exact contract.

Standard images still publish independently through `docker.yml`. The
`cloud-migrator-artifacts.yml` workflow still publishes signed exact-source
migrators independently. A downstream composer must verify those artifacts,
build and test its own image, and record separate deployment readiness.

Verification runs outside the full npm release's concurrency group. Different
commits have independent groups. The npm canary release reuses the source proof
for its exact master push instead of starting another `Release Verify` run.
Stable releases and candidate-branch betas still run full verification.

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

## Consumer contract and retirement boundary

Accept `Cloud source verified v1` only from the latest attempt of the canonical
`cloud-readiness.yml` master push for the expected repository identity and full
source SHA. Check the job itself and reject failed, skipped, cancelled, or
ambiguous proof. This signal verifies source only. It creates no release record,
certifies no composed image, and deploys no instance.

Downstream deployment consumers must separately verify the standard image's
immutable digest and attestation, the exact-source migrator's signature and
integrity, migration compatibility, their own image composition, and target
health. Order automatic candidates by master ancestry, not completion time.

Merge this retirement only after all active automatic deployment consumers use
the standard-image composition contract. A consumer still selecting
`Cloud deployable v1` will stop advancing at the last legacy-ready commit.
Do not rename the source proof to the old readiness name or weaken a consumer
check to hide that dependency.

Existing release records, immutable image digests, migrator artifacts, and
registry tags are retained for rollback. No registry deletion or live deployment
is part of this change. Explicit `release.yml` preview requests still use the
legacy `cloud` Dockerfile target for a specified source commit. They do not
restart recurring legacy publication. Keep that compatibility path until its
operator consumers migrate separately.

The old `nightly-cloud`, `beta-cloud`, `latest-cloud`, and `canary-cloud` aliases
stop advancing. Self-hosted standard release aliases continue unchanged. A
rollback to an already published image needs no rebuild; restoring recurring
legacy publication would require reverting the publisher retirement.

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
| Source verified | Successful `Cloud source verified v1` job in the accepted push run and attempt | Merge |
| Composed image ready | Downstream composition verification and publication succeed | Merge |
| Canary healthy | Deployment consumer's canary health gate confirms the target commit | Merge |
| Fleet complete | Campaign succeeds for all eligible targets at that commit | Merge |

Record the source SHA, workflow run ID and attempt, readiness job completion
time, and deployment campaign identity together. Verify the run against the
consumer contract above. A manual dispatch can test wiring, but its timestamp
does not measure automatic merge-to-deploy latency. A preparation-only run
resolves artifacts without deploying a target and must not be counted as a
successful deployment.

Record queue time and the image, source-verification, migrator, and composition durations
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

## Reserved AWS verification capacity

`AWS_POST_MERGE_CI_ENABLED=true` routes cloud source verification and
exact-master migrator preparation to the
`paperclip-post-merge` runner group. The separate Fleet label is
`runs-on/fleet=paperclip-post-merge-x64/env=public-ci`. Its 36 reserved slots use
the same four-vCPU, 16-GiB machines as approved PR jobs. PR capacity is reduced
to 64; the separately provisioned image capacity is unchanged by this retirement.
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
`refs/heads/master`: `cloud-readiness.yml`,
`release-verify.yml`, `runner-chaos-evals.yml`, and `release.yml`. Do not authorize
PR-controlled workflow versions. The direct migrator producer always uses
GitHub-hosted runners and needs no AWS runner-group authorization. PR placement retains its independent pinned
workflow and six-account author/actor allowlist.

Disable the switch and rerun the whole workflow to restore GitHub-hosted
placement. Assigned jobs keep their original runners. Readiness requirements,
source checks, and npm integrity checks are unchanged.

## Retired AWS cloud build routing

`AWS_CLOUD_BUILDS_ENABLED` and the `paperclip-cloud-build` runner group no longer
route a public image job after this retirement. This source change does not
delete runner groups, Fleets, credentials, registry images, or cache tags. Review
shared infrastructure ownership separately before removing those resources.

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
