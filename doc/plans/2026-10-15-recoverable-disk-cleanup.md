# Recoverable disk cleanup — delivery state

## Outcome and boundaries

Automatically expire reproducible skill caches and finished isolated Git workspaces,
then restore them through normal use. Deliver two reviewed slices and verify actual
reclamation plus restoration on `paperclip.staging.paperclip.app`. Keep the current
storage architecture, unique work, and recovery data. Git restoration may depend
on upstream availability; skill restoration must use saved database bytes alone.

Apply dotta-kickoff, goal-poteto-style-definition, shorten-feedback-loop,
paperclip-feature-to-production, and test-it-for-real. Retain one deployment owner.

## Acceptance matrix

| Case | Required outcome |
| --- | --- |
| Old skill version, upstream unavailable | Identical restored bytes and executable modes |
| Current/active/unsettled skill version | Preserved through concurrent preparation and cleanup |
| Finished Git workspace/base, upstream advanced | Reopen at recorded commit and perform subsequent work |
| Unique files, live consumers, pending recovery | Skip cleanup |
| Restart/concurrent reopen/interrupted deletion | Recover safely and preserve lifecycle fencing |
| Upstream failure/cross-company access | Explicit failure or skip; no fallback or access widening |

## Delivery slices

1. Skill `__versions__` cache: one-hour inactivity, current/in-use protection,
   persistent access records, cross-process exclusion, hourly batches of 50.
2. Owned isolated Git workspace/base caches: 24-hour terminal-tree cooldown,
   verified exact-commit recipe before deletion, safe on-demand restoration.

Each slice gets focused tests, required repository checks, review, single-workspace
deployment at an exact SHA, dry-run inspection, measured reclamation, and ordinary
product acceptance. Rollback disables deletion and retains restoration support.

## Current delivery state (2026-10-17)

The earlier fixture acceptance proved recovery, but did not reclaim the real backlog.
The Oct 16 recurrence measured 129 GiB used and 8.24 GiB free. Nested project copies
accounted for 21.31 GiB; 36 fully finished task trees held 9.23 GiB of candidate
nested copies. Those are candidate bytes, not reclaimed bytes. Runner backups and
legacy skill-run pinning remain separate follow-ups.

Upstream PRs #16586, #16614, and #16621 now recognize managed nested checkouts,
short-circuit shared paths, and verify public Git commits without a run identity.
The remaining implementation gap is exact nested commit and local settings recovery.
Current work builds on master `1f27427ffdefaf5fb2760d1d53c0d78cb9683d4c`, branch
`codex/worktree-nested-restoration`. Serving SHA observed before work:
`27ab902d3db2770ada79c9f42a9c06e1d346f34b`. No deployment or real reclamation yet.
Review: [PR #16691](https://github.com/paperclipai/paperclip/pull/16691).
Its first head `4696ba2fd171ec3970b7e116bcb5f77fe9331785` passed CI. Greptile
found historical project-selection and failed-provision retry gaps; both now have
fixes and real lifecycle controls. The updated head still needs review and CI.

| Required outcome | Current evidence | Remaining gap | Next action / owner |
| --- | --- | --- | --- |
| Restore every nested repository at its recorded commit | Real Git/Postgres regression now restores A after upstream advances to B, before provisioning | Review and deployed proof | CI and one-target rollout / this task |
| Preserve local settings and unique work | Encrypted bytes/modes, mutation fencing, interrupted publication and retry controls pass | Review and deployed proof | CI and protected-data comparison / this task |
| Reclaim real finished backlog on staging | Oct 16 disk survey and skip reasons retained | Reviewed merge, one-target rollout, actual measured deletion | Existing deployment workflow / this task |
| Ordinary reopening and subsequent work | Prior main-repository fixture proof only | Real expired nested workspace journey plus independent inspection | Product acceptance / this task |

Retained experiment evidence: `/tmp/paperclip-disk-20261016/nested-baseline-built.log`.
After 17s dependency installation and one SDK build, the useful baseline took 12.23s
(6.91s test, 3.07s transform), using bare upstream repositories and normal preparation,
expiration, and reopening. It failed because nested HEAD became B instead of A.
Treatment passed the same recovery case in 14.44s. The affected suites passed
37 cases in 142.37s; six nested mutation/retry cases passed in 56.72s. Independent
review found interrupted hard-link publication and tracked-settings mode risks;
three added controls passed in 19.07s after fixes. The final affected run passed
55 of 56 cases in 98.38s; one fault-injection fixture used a noncanonical macOS
path and missed its intended failure. Correcting that path made the case pass
in 16.94s. All five content controls passed again after the bounded-read fix.
Full workspace typecheck and build passed. The broad local test run was stopped
after approximately 12 minutes of unrelated serial server tests; mandatory
parallel CI remains required before merge. No full-suite local pass is claimed.

Review fixes preserve saved project ref/cwd selection through normal preparation
and subsequent expiration. A separate durable contents checkpoint survives failed
provisioning and transaction rollback, and heartbeat persistence retains it. Native
cleanup locks now have persisted random ownership and atomic publication; actual
child-process exits prove worker and reopening recovery without removing foreign
locks. The integrated lifecycle file passed 42 cases in 91.66s; 46 preparation,
credential, contents, and Git controls passed in 24.41s. The final heartbeat
checkpoint persistence case passed separately in 8.17s. Server typecheck passed.
The representative crash experiment took 20.84s, mostly fixture Git/process work
(72% tests, 21% transforms); it justified the integrated regression run.

The live pre-cleanup baseline records 50 old terminal workspaces in 74.543s,
including 19 with nested copies and 21 dirty controls. Evidence is
`/tmp/paperclip-cleanup-20261017/eligible-baseline.jsonl`; no file contents or
credentials are printed. The ordinary staging UI is authenticated and reachable.
Current disk observation: 129,519,296,512 bytes used and 17,779,265,536 free (88%).

Live skip inspection found ordinary linked-worktree FETCH_HEAD files blocking
45 of 200 sampled worker events. The local baseline reproduced rejection in
8.31s; the verified-fetch treatment passed five cases in 15.23s. Unknown,
malformed, and unverified local-only fetched state stays protected.

The existing fleet campaign completed for this target during diagnosis. Current
serving SHA is `d30648dee89720358271c276b9fc28cf83f18be7`, artifact
`cloud-39088110403-1`. The target is temporarily user-managed, with no operation
lock; Git dry-run was staged for the next deployment. Fleet defaults are unchanged.
Reconcile the pin after acceptance without rolling back restoration support.
Staging read-only baseline at 2026-10-18 03:05 UTC: 127,859,752,960 bytes used,
19,438,809,088 free (87%). Only one real-company workspace had a completed
expiration record. These observations do not establish reclamation by this change.

First attempts exposed loopback sandbox denial and a missing SDK build; both setup
issues were corrected before judging behavior. Reuse this fixture for treatment.

All prior temporary SSH keys have been revoked and removed. This iteration registered
`paperclip-cleanup-20261017`, fingerprint `SHA256:h6kA+d64fu/OoA4bLNfjW0J3V5YsapuSWVbZpR+VcdA`.
Revoke it and remove `/tmp/paperclip-cleanup-20261017/railway-key{,.pub}` and
`~/.ssh/paperclip_cleanup_20261017{,.pub}` at completion. Historical details below describe prior
revisions and must not be treated as current deployment or access state.

## Historical state (2026-10-15, 19:27 UTC)


- Skill [PR #16433](https://github.com/paperclipai/paperclip/pull/16433) merged as
  `86c965ce7ab1499864f74b8dd6ed0d2d8db15197`. Git
  [PR #16457](https://github.com/paperclipai/paperclip/pull/16457) merged as
  `59a70dc9e235d6df3d7db69b3ca170196d0c749f`. Both passed exact-head CI,
  security checks, and Greptile 5/5 with resolved findings. The user explicitly
  approved the administrator merge of #16457 after the self-approval gate.
- Staging now serves full Git merge SHA `59a70dc9e235d6df3d7db69b3ca170196d0c749f`.
  Single-workspace request `8ab463d8-ec8b-49fc-a4b9-29ee7318b19d`, campaign
  `fleet-campaign-1792088485703`, Railway deployment
  `6ce6e01a-bf67-48d2-af56-c354de3d4b59` reached ready at 19:02:08 UTC.
  Skill cleanup is enabled and applying. Git worktree/base cleanup is enabled
  in dry-run mode. Fleet defaults remain unchanged.
- Live skill service proof: reclaimed 151,552 bytes from a disposable old version,
  preserved current bytes and immutable records, and restored identical saved
  hashes and 0444/0555 modes with upstream disabled. Automatic scheduler proof
  passed at 19:06:36 UTC after re-aging that restored fixture. Normal UI task
  acceptance for version 3 is queued; its disposable cache was removed at
  19:06:47 UTC, with saved hash, mode, pin, and subsequent-result assertions.
- Real Git dry run on the serving build inspected 44 workspaces in 81.116s:
  zero eligible; 16 dirty/untracked, 9 unique ignored, 15 live/unresolved,
  1 unknown worktree metadata, 3 inspection failures. No original Git data was
  deleted. Original-company skill caches remain protected by unresolved legacy
  runs without reliable pins. The original GiB estimates are not reclaimed bytes.
- Live Git fixture correctly expired its 1,069,056-byte worktree and retained
  the unique-file control, but private-base acceptance failed. Linux Git creates
  a standard empty `.git/branches` directory that the strict metadata allowlist
  rejected. Retained fixture and failure evidence; no manual base deletion.
  Follow-up branch `codex/git-cache-linux-template` allows only a real, empty
  branches directory, retains populated/symlink variants, and fixes pending-base
  dry-run inspection after the worktree is already absent. Local reproduction
  failed before the fix; lifecycle regression checks are running.
- Normal v3 skill task acceptance passed at 19:12:24 UTC on full SHA `59a70dc9`:
  run `4d7f0b23-3f4a-4de0-946f-91776d3f80c3` succeeded, task is done,
  saved result is `SAVED-SKILL-V3-20261015`, restored hash/mode and version pin
  match. Screenshot `skill-v3-user-proof.png`; evidence `ui-v3-restoration.jsonl`.
  The failed disposable Studio task was cancelled through the normal UI.
- Follow-up [PR #16476](https://github.com/paperclipai/paperclip/pull/16476)
  initially reached Greptile 5/5 after removing added comments. Before rollout,
  inspection found the Git expiration branch bypassed existing dependency/build
  compaction and replaced its startup deadline with a one-hour delay. A real Git
  and database comparison reproduced both failures in 7.67s. The fix retains
  existing guarded compaction before expiration, excludes already-closed rows,
  and preserves a pending compaction deadline. Affected lifecycle/compaction
  controls are running. The superseded preview build `38793078424` was cancelled;
  wait for the corrected reviewed candidate before the only next deployment.
- Git apply is configured for the next deployment only (`--skip-deploys`); the
  current process remains dry-run. Retained fixture baseline at 19:18:43 UTC:
  base 229,376 bytes, expired worktree 1,069,056 bytes, unique control SHA-256
  `e1f76d842fffaac2347b23932bd604fda5e22fc6c3a7df434459b416295d3ab1`.
  Let the restarted scheduler resume pending base deletion; inspect its logs,
  then reopen through the UI at A after B and perform subsequent persisted work.
- Remaining: finish follow-up review/checks/merge/deploy; automatic Git cleanup,
  ordinary reopening and subsequent work; record final usage; remove owned test
  clutter, reconcile the pin, and revoke/remove the temporary SSH key. The fleet
  default is still `95692b7785` (before both original PRs), so unpinning now would
  roll back the verified build. Do not change the fleet default.


Evidence root: `/tmp/paperclip-cleanup-staging/` locally and
`/paperclip/instances/default/acceptance/recoverable-cache-20261015/` on staging.
This is the single delivery state record.

- Prior Git lifecycle suite: 20/20 in 46.41s, 328 controls in 238.69s,
  11 reconciliation controls in 21.83s, branch-adoption case in 16.67s.
  Full typecheck/build passed. Skill 21 cases in 29.99s plus 35 controls passed.
  The hour-long mixed-revision full-suite attempt failed with IPC/capacity and
  checkout disappearance; final 103 retries and both exact-head CI suites passed.
  Reuse unaffected passing evidence; do not repeat that failed hour-long loop.
- Retain material failures: Studio skill-test mode failed before execution
  (plugin-worker plumbing and Runner unsupported mode); this is deferred.
  Ordinary v2 UI baseline succeeded on intervening fleet SHA `95692b7785`, not
  the delivered cleanup build, so it does not count as final acceptance.
- An unrelated scheduled fleet rollout interrupted admission. Target-only
  user-managed pin was set at 18:39 UTC (previous false); audit evidence is
  `staging-pin.json`. Reconcile after acceptance, checking default release first
  because clearing this pin triggers a catch-up deployment. Fleet defaults stay
  unchanged. The user's existing New Task draft and project were restored.
- Railway SSH defaults to root; service UID/GID is 1001. Root dry-run evidence
  is invalid due to Git ownership checks. All current service harnesses run as
  `gosu node`; only owned acceptance directories were corrected to service UID.
- Temporary key `paperclip-cleanup-acceptance-2026-10-15`, fingerprint
  `SHA256:belt4FaWVyB6rtM4eRr5y9M6oFdgXDPf0a1wpndlRRQ`, must be revoked and
  both local copies removed at completion. Authorized key locations are the
  private evidence directory and `~/.ssh/paperclip_cleanup_acceptance_20261015`.

## Feedback-loop evidence

| Question | Environment / loop | Elapsed / main wait | Result / next decision |
| --- | --- | --- | --- |
| Can this checkout run focused tests? | Local dependency setup | 43.2s install; later one-time Runner build took several minutes | Baseline manifest/lock drift required install without changing CI-owned lockfile. Warm builds are now reusable. |
| Can an older skill restore without upstream? | Existing service with real Postgres snapshots, pre-cleanup proof at baseline `57fa6b358d` | 4.83s warm test attempt; setup excluded as one-time above | Normal runtime path restored saved binary/script bytes and executable bits with fetch unavailable; proceed with cleanup. |
| Do the integrated safety cases hold? | Devin's `0f3adda980` plus local follow-up; real Postgres and filesystem | 49s from launch through inspected result, 47.23s runner (62% tests, 21% import) | 22 tests passed, server typecheck passed. Added deleted-skill and failure-budget review cases plus heartbeat controls. No cloud proof claimed. |

| Does Git reopening preserve A after upstream moves? | `5eb505ff5d`, local bare remote plus real runtime/service/database path | 6.398s setup/run/inspection script, about 9s launch through result review | Missing branch returned B; missing base failed. Preserve fixture for exact-commit restoration tests. |
| Does cleanup block preparation during a slow file walk? | Same checkout plus review fixes, two DB clients and a deliberately paused filesystem read | 24.94s affected suite, about 28s through inspected result | 18 tests pass; preparation completes while scan is paused and its new pin prevents eviction. |

## Deferred

Skill-version creation/deduplication, recovery retention, non-Git workspace expiry,
shared/operator checkout expiry, and moving storage off the webserver.
