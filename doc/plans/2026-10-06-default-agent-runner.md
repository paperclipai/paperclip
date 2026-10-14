# Runner defaults: staged delivery

Updated 2026-10-13 UTC.

## Fresh cloud onboarding remains unqualified

The source audit found two ordinary-use gaps in the dependent release. Codex
onboarding resolves Auto from saved environment facts before setup testing.
The normal setup path does not perform the saved environment platform probe.
An immutable OCI environment without prior facts therefore creates a Legacy
agent. Existing managed E2E fixtures explicitly probe first; those fixtures do
not prove fresh onboarding. A private UI correction is being tested against
the existing onboarding suite. It uses the existing permission-gated saved
probe on explicit Connect, refreshes company-scoped discovery, then tests the
selected runtime. Creation and discovery still allocate nothing. Probe errors
must stay actionable, and permissions must not broaden.

Cloud master `23531d729756ab0461a53f9358beb8df5c1781ed` distributes named
Daytona snapshots. Its recorded runtime image digest identifies the app copied
into that snapshot, not the final boot image. Current source does not bind a
fresh company's qualification to a verified boot identity. The pinned official
Daytona SDK accepts snapshot IDs, but does not guarantee a boot-verified digest.
A read-only lookup of the existing snapshot was rejected before execution by
automatic approval review because direct credential authorization was missing.
The exact limited authorization is now requested. No key was read or request
sent. Source audits and CLI version probes do not close live cloud acceptance.

These are release blockers for the Codex-default and actual Cloud distribution
stages, not new runtime changes in this prerequisite. No source is merged or
production-ready. The original budget holds, local preview, existing runners,
remote-build boundary and no-production-deployment boundary remain intact.

## Held-authorization fixture correction

The ordinary reconciliation candidate `dae808fe02694d13d322c535944910813b21f6d6`
has fresh Greptile 5/5, all four resolved threads, passing isolated native
compilation and the required browser aggregate. Its runner shard passes both
previously corrected cases, but fails a different `authorize_before_bootstrap`
cell: the same implicit one-second polling deadline expires before the fixture
installs its release callback. The shard records 1,672 passes, one failure and
three skips. The exact failure and gate receipt remain:
`/private/tmp/ci-final-dae808-ci-review-failure-receipt.json`.

The existing fixture now signals actual entry after installing the release
callback in the exact before-bootstrap authorization hook. Race that signal
against the original recovery request under the unchanged five-second bound.
All authority, stage, denied-work, command queue, process, provider-state,
durable-byte and cleanup assertions remain. On canonical Node 24, controlled
1,250 ms scheduling delay reproduces the old undefined-callback assertion and
passes after correction. An injected early recovery error surfaces unchanged.
The original hosted cause remains inconclusive; this proves fixture weakness
and preserves the next diagnostic. These are historical-mock-binary controls,
not final installed runtime qualification. Matching-source independent review
is clear. Receipts:
`/private/tmp/ci-final-dae808-held-authorization-signal-receipt.json` and
`/private/tmp/pr2-dae808-held-authorization-independent-review.json`.

The already-running package campaign
https://github.com/paperclipai/paperclip/actions/runs/38342104102
is immutable to literal `dae808` throughout: daemon, assembly and installed
consumer checkouts use its explicit 40-character SHA, while the tooling checkout
uses the captured workflow SHA. Publishing this test-only correction cannot
change that run's source. Let it finish without rerun or cancellation, keep its
receipts literal and overlap fresh current-head CI with its remaining steps.
No new package campaign starts until the existing one is terminal.

Both worktrees and root's test-drive data stay preserved. Its loopback health
is OK at literal `fe1ecf1c34`, recovery ready, zero active runs; a sandbox-blocked
read was corrected with the authorized read-only loopback path, without restart
or build. Root HEAD stays `1a0ca662`. Codex and Claude reconciliation/acceptance,
normal code-owner approval, private Cloud composition and production baseline
remain pending. No merge/deployment/default promotion, paid provider call,
new paid host or local native/Docker build occurred.

## Final CI fixture corrections and current master

Published prerequisite `16a53254c495f3e49a28cc911f5dcd60c41779fc`
has fresh Greptile 5/5 and all four review threads resolved. Full CI records
52 successful checks, four conditional skips and two failures: the runner
Vitest first shard and its aggregate. The actual failing shard passes 1,671
cases and skips three; its two failures remain recorded in
`/private/tmp/pr2-16a532-runner-vitest-failure.log`.

The durable-resume case exceeded its outer five-second test envelope. Reuse
Claude owner's existing correction from `c60bf4b6`, changing only that case's
outer limit to 15 seconds. On canonical Node 24, controlled 3,800 ms fake
latency reproduces the old outer timeout, while corrected and ordinary cases
pass. Internal 500 ms/5 second turn deadlines, distinct attempts, same thread,
effect deduplication and the complete usage assertions remain unchanged.
Receipt: `/private/tmp/pr2-16a532-durable-resume-correction-receipt.json`.

The warm-recovery callback fixture polled callback installation with Vitest's
implicit one-second wait, despite its existing five-second request bound.
Replace polling with actual callback-entry notification raced against request
settlement under that same bound. Controlled 1,250 ms scheduling delay fails
the original assertion and passes the correction; an early recovery error now
surfaces unchanged. All fence, snapshot, retry and side-effect assertions remain.
The original hosted request outcome was hidden, so its underlying cause remains
inconclusive until fresh hosted CI. These controls use recorded historical mock
binaries and do not qualify a final native package. Receipt:
`/private/tmp/ci-final-16a532-warm-callback-signal-receipt.json`.
Independent matching-source review of both test-only changes is clear:
`/private/tmp/pr2-16a532-fixture-corrections-independent-review.json`.

Current master `e168512f7bdbb6af6ea01954c6d7ed80b91e903e` merges cleanly.
Runner/surfaces/server/E2E no-emit checks pass on the composed source. Maps
remain aligned at 35 areas/171 IDs and token gates pass. Master changed three
activity/inbox/recovery recipes without synchronizing 25 catalog fingerprints.
Independent inspection verifies those entries are exact inherited master drift;
all 92 declared non-map story/component/wrapper/fixture inputs are unchanged.
Only their guarded fingerprints and a source-only review note are synchronized.
Existing 24 unreviewed/one current classifications, IDs, fixtures and INDEX stay
unchanged. The catalog check passes 223 files/2,210 stories. No new live or
visual coverage is claimed for the inherited backend requirements.

The exact `16a532` remote package campaign is
https://github.com/paperclipai/paperclip/actions/runs/38338806076.
The campaign completed successfully. All four native producers, public Linux
package assembly and the Apple Silicon, Intel Mac and Linux ARM64 installed
consumers pass. The earlier Intel timeout remains a separate failed receipt;
this success does not establish its cause or a diagnostic-code fix.
This remains literal source evidence after the current master/test changes.
No queued job is rerun or obsolete package result relabeled.

Next action: preserve the completed package result, publish this ordinary master
reconciliation with both scoped fixture corrections, require fresh full CI and
review, and qualify the final package source. The prerequisite remains draft,
auto-merge off, and actual code-owner review is pending. Codex stays `1a0ca662`
until actual prerequisite merge and source reconciliation; the Claude owner
retains its branches and separate $50 allowance. Final immutable managed QA,
actual private Cloud distribution, warm/cold signup and backward-image or
forward-recovery evidence remain required. Production Admin sign-in is pending.
Nothing is merged, deployed or production-ready. The idle root test-drive and
its data are preserved. Paid holds remain $248.179254104/$250; no provider turn,
new paid host, local native/Docker build, rollout or default promotion occurred.

## Master reconciliation and installed-package checkpoint

The published prerequisite `64c074fb8da1b31f8d6042c4fef48dc4164e759b`
passes 54 current-head checks with four conditional skips and fresh Greptile 5/5.
All four review threads are resolved. The actual hosted transport suite passes
246 tests and startup trust passes 22; this closes the earlier local fake-binary
limitation at that literal source. Full workspace checks, Linux DB controls,
Rust suites, isolated native compilation and all eight browser shards pass.
Receipt: `/private/tmp/pr2-64c074-full-ci-review-0144-receipt.json`.

The [existing final package campaign](https://github.com/paperclipai/paperclip/actions/runs/38332921463)
completed on literal `64c074`. All four native producers, public Linux package
assembly, Apple Silicon and Linux ARM64 installed consumers pass. Intel Mac
fails during initial `npm install --ignore-scripts --omit=dev`, with `ETIMEDOUT`
after the existing 10-minute bound. It never reaches lifecycle or native runtime
assertions. The log establishes an installation timeout, not its network/host
cause and not a runner failure. Intel installed execution remains unqualified.
Keep the failed receipt; do not relax assertions or relabel the successful
platforms as a complete campaign. No automatic retry was dispatched.

Master then advanced to `f329b24ee12496e710ad17377ec7716e0eee22ef`, adding
separately merged durable task workspaces. It conflicts only in the test-home
helper/test and the Storybook review record. Both independent additive resolution
proposals are preserved. The cleanup keeps guarded read-only permission recovery
and its unrelated-ENOTEMPTY negative, adopts master's POSIX error assertion,
and retains master's new isolated-home identity/symlink protections byte-for-byte.
Both source-only Storybook review appendices remain; the catalog merges without
new story/fixture edits or changed review classifications. The task-workspace
migration and runtime changes come from master, not this PR's feature scope;
final image/migrator and backward-image proof must include them.

The composed worktree passes six existing home controls, with zero failures or
skips, plus runner/surfaces/server/E2E TypeScript checks, token gates, both map
checks (35 areas/171 IDs) and Storybook structure (223 files/2,210 stories).
Only scratch-local TypeScript preparation ran; root's idle test-drive and data
stay unchanged. The contribution check has no below-1,000-to-above-1,000 code
crossing. The two whitespace lines already in master's unrelated privacy test
are not modified; the PR diff against master is clean. The review remains 63
files. These composed checks have their working-tree source identity and are not
claimed as execution of the old published commit. Receipts are
`/private/tmp/pr2-f329-uncommitted-home-controls-receipt.json` and
`/private/tmp/pr2-f329-composed-source-checks-receipt.json`.

The existing Mac installer now retains bounded npm timing/progress diagnostics
in its already-uploaded receipt path before cleanup. Only allowlisted metadata
is retained; argv, URLs, environment, raw stderr and exception text are omitted.
At most two 16 KiB file tails and 32 entries per tail are read. Symlink exclusions
and the original exception identity remain. Failure is explicitly FAILED,
unqualified and runtime-not-attempted. The existing 10-minute deadline and all
package, lock, payload, lifecycle and startup oracles are unchanged. Three narrow
cases extend the existing suite; all 24 pass on canonical Node 24, and independent
matching-source review is clear. This adds diagnostics, not an installation
success or explanation of the old timeout. Receipts:
`/private/tmp/pr2-mac-initial-install-diagnostics-repair-receipt.json`,
`/private/tmp/ci-final-mac-install-diagnostics-independent-review.json` and
`/private/tmp/pr2-f329-install-diagnostics-node24.log`.

Next action: publish the ordinary master-reconciliation commit, require fresh
full CI/review and exact-source package qualification, then normal code-owner
review and merge. Prior `64c074` CI/install receipts remain literal after this
source change. The Claude owner is waiting for the exact canonical parent before
its next composed campaign; keep all its Claude fixes and separate $50 allowance.
Codex remains `1a0ca662` until actual prerequisite merge and reconciliation.
Final immutable OCI QA onboarding/task/follow-up, private Cloud composition,
warm/cold signup and backward-image or forward-recovery proof remain required.
Production Fleet Admin sign-in and code-owner approval are still pending.
No slice is merged or production-ready. Paid holds remain $248.179254104/$250;
no new paid/provider action, local native/Docker build or rollout took place.

## Production readiness: owned startup correction

The human requests production readiness; preparation and normal sequential
merges remain authorized. Production deployment and provisioning-default
promotion remain separate actions. Nothing in this checkpoint is merged or
deployed, and the stack is not production-ready.

Runtime prerequisite behavior is `ce23716503a2c9158b5a7ab74ab61571ff4ee7a3`
on `codex/runner-native-platform-prerequisites`, in
[#16028](https://github.com/paperclipai/paperclip/pull/16028). Final qualification
reproduced close returning before credential preparation drained, followed by
registration and launch. Both direct close and real driver cancellation failed
on literal `5a9ce11`. The initial shared repair from Claude commit `463ebb` is
reused, with independently identified duplicate-admission, shutdown-readiness and
resume ordering corrections. All five source findings are closed in matching
source review. Absolute cleanup deadlines, primary cancellation errors,
unauthenticated-process protection and existing agents' runner choices remain.

The existing suites pass 32 credential-free controls across three files; both
canonical runner TypeScript no-emit checks pass. No new suite, local Rust/Docker
build, provider call or credential-content read was used. Actual daemon
readiness/recovery controls remain **hosted-CI required**: local worktrees lack
the existing fake-Codex/fake-harness executables. The failed local native attempt
never reached the readiness assertion and is not qualification. Receipts are
`/private/tmp/pr2-463ebb-owned-startup-review-closure-receipt.json` and
`/private/tmp/ci-final-owned-startup-five-gap-closure-review.json`.

Normal automatic merge is disabled and the prerequisite is draft while this
correction receives fresh full CI, package qualification and 5/5 review.
Earlier green checks at `5a9ce11` remain historical. Actual code-owner approval
is still required; no protection is bypassed. The updated runs/adapters map pair
records source-only scope, bringing the prerequisite review to 63 files after the required Storybook
catalog review below.

Codex remains `1a0ca66242121e39d88455aa2b52a07acc4a07d9` in
[#15683](https://github.com/paperclipai/paperclip/pull/15683), based on the previous
prerequisite. The Claude owner retains its branches, cached guided-setup fix,
verification and separate $50 allowance. Coordinate reconciliation of the common
repair before rewriting those branches; don't duplicate it in a leaf slice.

The idle [local preview](http://127.0.0.1:3125/COD/agents/all) still serves literal
behavior `fe1ecf1c34`, recovery ready and zero active runs. Its four saved
legacy/native configurations and two historical native records remain preserved;
it has not been refreshed to this new runtime. Final local/managed acceptance
must use the tested source, independent file checks and follow-up continuity.

The prepared private execution checklist reuses existing evals, installation,
Cloud composition and campaign paths. Required holds are final source/image/
migrator, the actual verified-master private distribution, pinned QA onboarding,
warm/cold signup, production baseline and previous-image compatibility. Production
Fleet Admin sign-in is pending. Current paid holds remain $248.179254104 of $250;
unknown/cleanup holds stay reserved, and the unstarted managed envelope is $2.50.
No new image, paid resource, rollout or default promotion was dispatched.

Master reconciliation uses `4b958ecbd8f33a7782fe6f29ec825f80f636b833`.
The new contribution rules are satisfied: 157 added comment annotations were
removed from 35 files, with identical executable JavaScript/TypeScript emission,
parsed workflow values, 77 action pins and shell commands. No code file crosses
from below 1,000 lines to above that limit. Final focused checks pass 248 tests
(107 workflow/package, 54 runner, 42 server, 45 E2E support). Both runner no-emit
checks and the canonical server/E2E no-emit checks pass with isolated matching
workspace dependencies. Only JavaScript/TypeScript preparation ran locally;
root preview links and data stayed unchanged. The earlier linked-source failures
remain recorded and are superseded only by the new canonical check receipt.

The existing Storybook catalog has 21 source-review fingerprint updates because
its declared runs/adapters map input changed. All affected stories, subjects,
wrappers and fixtures remain byte-identical to master. Review classifications
stay unchanged. The catalog check passes 223 files/2,210 stories; this is
structural/source evidence, not visual or live proof. Source receipts are
`/private/tmp/pr2-9f59-comments-cleanup-receipt.json`,
`/private/tmp/pr2-storybook-owned-final-receipt.json` and
`/private/tmp/pr2-frozen-canonical-noemit-receipt.json`.

Next action: publish this reviewed prerequisite correction, require fresh hosted
gates, reconcile Codex and Claude with its actual source, then resume the existing
remote package/immutable preview and dedicated staging qualification. Merge ready
slices normally in the agreed order; actual production readiness requires the
private distribution and rollback/forward-recovery evidence afterward.

## Final review checkpoint: shared fixes and sandbox qualification

The user authorizes normal sequential merges after the applicable gates pass.
Runtime prerequisite [#16028](https://github.com/paperclipai/paperclip/pull/16028)
and Codex defaults [#15683](https://github.com/paperclipai/paperclip/pull/15683)
remain draft. Their pre-fix sources are `00ac509b0a` and `8de43be4cd`.
The shared SSH argv and verified cold-resume corrections are already composed.
Six argv controls, fourteen recovery controls, and actual SSH subprocess checks
pass. The separate Claude owner reports real ARM and Linux x64 task/follow-up
pairs across controller restarts on its literal installed-package overlays;
those results do not qualify an unmodified final Codex package.

The Mac test-drive serves `8de43be4cd` at port 3125. A read-only restart comparison
preserves four full legacy/native execution configurations and two historical
native runs with the deprecated native flag false. Zero provider turns and
zero local native/Docker builds were used. The canonical server no-emit passes
on the composed root and actual prerequisite worktree.

Both shared fixes are implemented and frozen. The actual workflow selector
rejects candidate execution/output injection in real Git fixtures. Its full
existing release-workflow suite passes 70 tests; existing target assembly passes
7 tests. Registration passes 15 focused controls and canonical runner no-emit.
An independent scoped review confirms bounded teardown and retained private
state on unconfirmed release. The first broader local workflow attempt failed
only because mock loopback listeners were sandbox-blocked; its loopback-enabled
rerun passes. No daemon/provider execution was used by these controls.

The generic sandbox qualification support passes 30 existing probe and route
controls plus the canonical server no-emit command. It accepts only OCI digest
images, checks the returned cleanup receipt, and reports conditional-update races
without claiming a record. Mutable or name-only configurations retain existing
connection behavior and receive no native compatibility credit. The default
consumer and explicit-permission/import controls are being composed next.

Fresh review found four source defects: candidate-code execution during CI runner
selection, unbounded registration teardown, a lost explicit Codex permission
setting on automatic Legacy selection, and missing sandbox platform/libc facts.
Existing subagents own narrow fixes in parallel. Use inert target data and
workflow-owned public labels; preserve primary failures and private state on
unconfirmed cleanup; preserve explicit permissions; and use server-measured
sandbox qualification bound to its effective image/config and company scope.
The existing explicit environment-probe/setup flow owns qualification. Saving
and discovery must not provision resources or accept client-authored evidence.
Unknown targets retain automatic Legacy with an actionable explicit-native error.
No new product API or database migration is planned.

Preview runs [38303434211](https://github.com/paperclipai/paperclip/actions/runs/38303434211),
[38304889308](https://github.com/paperclipai/paperclip/actions/runs/38304889308), and
[38306885592](https://github.com/paperclipai/paperclip/actions/runs/38306885592)
were cancelled as shared source defects changed their candidates. They are
excluded from final qualification. Preserve historical evidence and all cost
and cleanup holds. The next action is to finish the four fixes, run affected
controls, obtain fresh exact-source checks/review, then build the final immutable
preview and matching DB/shared pair remotely for the pinned QA tenant.
Managed Codex retains its $2.50 setup/task envelope and $2 cleanup within the
original $250 ceiling. Claude retains its separate $50 ceiling. No merge or
production deployment has occurred.


## Latest checkpoint: runtime prerequisite and authorized merges

The user authorizes preparing and merging ready PRs in dependency order.
Production deployment and provisioning-default promotion remain separate actions.
The Codex-default candidate is preserved at
`bb7591dfd0c4c8569e2a0b4303ff06de8ca3e9e2`; its running test-drive remains at
[3125](http://127.0.0.1:3125/COD/agents/all). No existing agent changes runner.

Its qualification work grew the review to 135 files. Extract the independent
runtime, installed-package and hosted-build changes onto
`codex/runner-native-platform-prerequisites`, based on master
`7d9b93aee2b79b2f035c5838741ce0b94168ec83`. This prerequisite contains 39 source
files and this record. Creation policy and experimental gates remain identical
to that master. README activation text and eight existing default-selection
controls stay in the dependent [Codex PR #15683](https://github.com/paperclipai/paperclip/pull/15683),
whose expected review is 98 files. Preserve all work and both branches.

The isolated extraction passes 276 existing focused controls. Runner no-emit
passes. The standard server no-emit initially finds a linked dependency-output
skew: the new master's ACP constants are absent from the old checkout's compiled
adapter-utils. A source-aware diagnostic passes; canonical verification remains
pending until its matching JavaScript dependency is prepared. Full hosted CI,
native compilation and fresh review are still required for the extracted head.
Do not count the diagnostic as a passing standard command.

Retained qualification keeps literal identities: four producers and Linux x64
and both Mac consumers pass at `a200495`; installed ARM native startup passes
with scoped stock Ubuntu prerequisites in
[38291535914](https://github.com/paperclipai/paperclip/actions/runs/38291535914).
Those artifacts are not relabeled as the extracted source. The Linux baseline
is GNU libc 2.39+, on x64/AArch64. Windows and Alpine remain deferred.
Cargo caches and overlapping JavaScript/native preparation use existing hosted
workflows. No local Docker/Rust builds or bundled Codex payloads are introduced.

Merge order is runtime prerequisite, Codex defaults, then the existing Claude
[protocol #15994](https://github.com/paperclipai/paperclip/pull/15994),
[default #15993](https://github.com/paperclipai/paperclip/pull/15993), and
[platform #15997](https://github.com/paperclipai/paperclip/pull/15997) PRs.
The authorized Claude chat owns its verification and fixes; this task coordinates
normal squash merges after applicable gates. The older Grok Cloud PR is an
independent lane, with its own missing snapshot-cleanup access and live proof.

Next action: open the extracted prerequisite, compose the preserved default
branch on it, require current-source CI/review, and remotely prepare the exact
Codex staging image and DB/shared pair. The existing QA tenant remains pinned to
old `2dbe43a4`. Managed Codex retains its $2.50 setup/task envelope and $2 cleanup;
historical unknown holds remain within the original $250 ceiling. Claude has
its separately authorized $50 ceiling. Missing live proof remains unresolved.

## Outcome and ownership

Users choose a harness. New agents use Paperclip Runner where the harness and
execution target are qualified. Existing agents keep their recorded runner.
The task owns implementation, verification, review fixes, and reviewable PRs.
Merging and deployment require separate authorization.

The original implementation is preserved on `codex/default-agent-runner` at
`171d841295808ca185a258aaeb10b3dee68bb2b9`. Its public review is
[PR #15422](https://github.com/paperclipai/paperclip/pull/15422).
The user approved splitting that work into four useful steps:

1. Packaged runtime reliability and Codex prerequisites, without changing defaults.
2. Codex defaults across creation, onboarding, hiring, imports, and the UI.
3. Claude defaults and authentication.
4. The remaining supported harness defaults and provider-specific fixes.

## Current slice

Canonical branch: `codex/runner-packaging-prerequisites`.
Frozen master base: `1881894973a2b25838d8abed9bd8aeebc3af4441`.
Canonical PR: [#15555](https://github.com/paperclipai/paperclip/pull/15555).
Its [checks](https://github.com/paperclipai/paperclip/pull/15555/checks) and
[commits](https://github.com/paperclipai/paperclip/pull/15555/commits) record the
final candidate. Hosted results and review disposition belong to that exact
candidate; earlier green checks do not qualify a later revision.

The user requested a smaller PR on 2026-10-08. This slice now covers Codex
executable resolution, native-free npm packaging, the installed JavaScript
dependency graph, and the sandbox resource lookup required by that npm layout.
It retains focused tests and extends the existing public npm consumer verifier.
It does not add a workflow, change Docker or Git installation, change shared
login HOME or working-directory behavior, or transfer runner release assets.
Agent defaults, saved runner choices, UI, schema, and provider qualification stay
unchanged.

The broader prerequisite implementation is preserved on the pushed branch
`codex/runner-packaging-full-snapshot` at
`6f3060beaa842ffcee21af058370d3cab5f571e9`. Its Git staging, extra login isolation,
release pipeline, Docker materialization, and unrelated test-fixture changes
remain outside this PR. Release and platform packaging must be qualified in a
separate slice before enabling new-agent defaults.

### Retained behavior

Ordinary native Codex startup, direct evals, and browser login prefer the
installed dependency. They accept usable older or newer CLI versions. If the
dependency is absent, use the selected host's PATH. Explicit commands and recorded
sessions retain precedence. Real protocol/login failures remain actionable;
there is no silent runner fallback. Release pins and the separate ACPX artifact
qualification stay unchanged. Linux ARM64 keeps its existing legacy login path.

Final review found a relative PATH regression in the retained resolver. Resolve
relative and empty PATH entries against the selected provider working directory;
retain installed-dependency preference. Extend the existing fresh-process fixture
and qualify the resulting commit separately from the green `cb5948e` candidate.

Paperclip npm tarballs retain the patched JavaScript graph and strip Codex native
payloads. The published server declares official optional host packages. npm
installs them for the consumer's OS and architecture. This avoids collisions with
the legacy adapter's separate Codex version. The server owns the bridge dependency
used by its vendored runner. Sandbox reads remain confined to the selected native
vendor resources; package identities and path containment still apply.

Browser login keeps master's provider-specific credential directories, ambient
HOME, and working directory. Only executable selection and safe errors change.

## Evidence and gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Preserve original and broader work | Passed | Pushed branches and revisions above |
| Narrow scope against current master | Passed | Installed Codex/npm scope only; no workflow, Docker, Git installer, or unrelated fixture diff |
| Focused packaging and installed-consumer controls | Passed | 24 packaging tests with actual offline npm tarballs; 9 existing consumer assertion tests |
| Login controls after narrowing | Passed | 13 existing tests; HOME/config-directory/spawn semantics match frozen master |
| Codex selection, protocol, sandbox, and ACPX integrity | Passed locally | 21 selection/security/transport/eval tests; 4 npm layout integrity controls; runner TypeScript no-emit |
| Full checks and fresh review | Pending for relative PATH fix | `cb5948e` passed all 47 CI jobs and its clean Linux npm consumer; qualify the final fix with new CI and fresh 5/5 review |
| Previous broad candidate | Historical | 47 ordinary CI jobs passed at `6f3060b`; not proof for the narrowed candidate |
| Existing old CLI protocol proof | Historical | Official Codex 0.156.1 completed startup handshake; scope must be matched to retained sources |
| All-harness live onboarding and cloud qualification | Deferred | Later defaults slices; authentication probes and CI cannot close live journeys |

Use Node 24 and one worker for focused local checks. Keep heavy builds in hosted
CI. Do not build Docker images or Rust locally. Do not author a lockfile change.
No provider-backed runs or new disposable environments are needed for this
prerequisite slice. Incremental provider spend for narrowing is $0. The original
$250 ceiling and cleanup obligations remain for later live qualification.
Existing credentials and user previews remain untouched.

Next action: commit and push the narrowed candidate, rerun its checks and fresh
review, then update the PR and existing evidence report. Start the Codex-default
slice after the user chooses to proceed. Merging and deployment remain outside
this task.

### Occupied credential fixture follow-up — 2026-10-12

Current-head `021df207` Runner Vitest 2 failed during fixture preparation with
`EADDRINUSE`, before credential staging. Reused the shared correction from
`50e7554069a31af72069e7632e9ae6151019f449`: prepare a fresh home with two
deliberately occupied candidates, preserve the foreign listener, and retain the
actual staging denial and unchanged auth-file assertion. The three-line code
annotation was removed to follow CONTRIBUTING; its explanation lives here.

Only fixture preparation retries, up to eight fresh homes. It releases only its
owned partial or unselected listeners, then runs credential staging once. A bind
race during that production call remains a visible failure and receives no
retry. No production credential or permission behavior changed.

A controlled occupied-port baseline reproduces the old setup failure. All 42
existing credential controls pass on Node 24 with isolated synthetic data and
zero provider calls or native builds. Comment-only removal preserves the tested
executable structure; the suite was not repeated. Evidence is recorded in
`/private/tmp/ci-final-021df2-shared-credential-quorum-receipt.json` and its
comment-closure receipt. Fresh published-head CI and review remain required.
