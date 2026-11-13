# Chat implementation landing checkpoint — September 9, 2026

This working note can be deleted after both landing PRs merge and the remaining
live hardening is represented by its own follow-up PR.

## Durable snapshot

- Snapshot revision: `007399bcd207f33aee7b62d14cf7a854cb979eca`.
- Snapshot tree: `5ba0226bedf205102b01ab7fae5d8bdf98cb832f`.
- Immutable local recovery branch: `codex/chat-adapters-snapshot-20260909`.
- Parent: `9afdf3232d2ac781ce4af05350129a6a8c7e2eb2`.
- Captured all 29 modified/new implementation and qualification-document paths
  using an alternate Git index. All 29 working-file hashes matched the snapshot.
  The original checkout's HEAD and empty staging area were unchanged.
- Landing worktree: `/Users/dotta/paperclipai/branches/chat-adapters-landing-20260909`.
- Initial landing branch: `codex/chat-adapters-landing-20260909`.
- Origin master at snapshot: `5acf56658bff7eeb12438a6fdcae5f4d2fe1e90e`.
- Ignored live runtime, credentials, databases, generated packages, and the
  protected runner binary were not added. Changed/new files passed the scoped
  credential-marker scan. This is not a claim of a full repository secret audit.

## Separate lanes

The user explicitly authorized the separate landing worktree and superseded the
earlier no-new-worktree/no-PR-tending constraints for this lane. James owns
reconciliation, exactly two coherent stacked PRs under 500 changed files each,
fresh exact-head Greptile 5/5, required checks, and dependency-ordered merges.
The existing PR is https://github.com/paperclipai/paperclip/pull/13038; it had 526
changed files and conflicts at this checkpoint. Preserve its review context
where practical. Do not merge based on old review scores or narrow local tests.

James exclusively owns remote `codex/chat-adapters` updates while reorganizing
that PR. The original local branch must not push over the landing heads. Do not
modify the original checkout or live runtime from the landing worktree.

The root, Epicurus, and Boole continue live stress qualification and subsequent
hardening in the original checkout. Changes after the snapshot remain separate.
After both merges, reconcile the ongoing branch with merged master, preserve
newer fixes, and open a follow-up PR without reintroducing landed changes.

## Verification boundary

Snapshot evidence: Board attachment cohort 417/417; blocked-continuation cohort
36/36; Rust durable-runner cohort 36/36; plain server/UI/runner TypeScript checks
passed; token gates clean. The full transport cohort was still running. These
are focused checks, not current-head full repository or landing CI verification.

Server 78 remained running on port 3137. Its loaded version was
`2026.831.0+623.git.ea528f44c`; a dynamically read Git HEAD is not proof that newer
source was deployed. No live restart or protected binary replacement occurred
while creating the snapshot. Historical quarantined recovery evidence remains
untouched.

## Subsequent checkpoint — 13:52 UTC

Base PR [#13092](https://github.com/paperclipai/paperclip/pull/13092) is open
with 45 changed files. Master reconciliation has exposed additional native
goal/integrity and PRP-v2 warm-authorization/state-retention defects. James owns
their landing-only regressions; neither the initial PR head nor historical
Greptile reviews certify the corrected head. The current-master warm-upgrade
compatibility boundary must be explicit, not hidden by a fail-closed test.

Root's test-only `5232fb22b` is available for the second PR. The new Board
uncertain-write and late-semantic-result hardening remain post-snapshot work.
A newly observed live Discord close/recovery loop must be fixed and qualified
before the experimental connector PR merges; it is not cosmetic follow-up.
Maya is temporarily paused to contain that loop. No deployment occurred.

## Subsequent checkpoint — 14:02 UTC

The base is now 47 files at `3e7289cd4` (James owns publication and exact-head
checks). Its prior head's Greptile 5/5 does not certify this head. Full workspace
build passed in the isolated landing worktree; full tests/checks remain pending.
The post-snapshot semantic-result fix is included in the base via its exact
four-file delta, not a duplicate cherry-pick of the full snapshot-containing
commit. Root's local commits are `c76988f93` (runner) and `ae21fd9e2` (Board).

The real process-replacement test proves a **v2-capable current artifact** first
leased as v1 can retire its exact owner and negotiate v2 on fresh bootstrap,
preserving native cached state before a warm attach. It does not prove an old
binary upgrade: the existing restart closure retains its original artifact.
Same-lease reconnect remains v1; adopted owners have no automatic upgrade path.
Do not advertise this internal recovery proof as a new operator upgrade API.

Board qualification finished 350 focused units and 11 actual browser journeys.
Runner release qualification finished 27 composed tests, in addition to 227
serial source tests. The close/recovery defect has two clean failing regressions
and remains a merge gate for the top PR. All live runs remain deliberately
paused. The original live binary and lockfile are unchanged.

## Subsequent checkpoint — 14:35 UTC

The current published base is `46ef7ef03ca35a47d6ac2be9e2dd497b137d3b70`,
44 changed files. Its exact-head Greptile score is 3/5; the prior 5/5 scores
do not satisfy the merge gate. James is addressing the concrete review
findings and current-master compatibility fixtures in the landing worktree.
The full runner suite at that head was 1,881 passed, six failed, ten skipped;
focused corrected fixtures do not replace the required fresh full-suite run.
Master has advanced through `35fdc0c66`, including durable task recovery work
that the top PR must preserve rather than overwrite with the older snapshot.

The original checkout's full chat integration suite is now **860/860 passed**
on fresh database `chat_snapshot_full_20260909_root06`, through test/copy fixes
in `02dc80d1e`. This is not a landing exact-head or full-workspace result.
All earlier failed runs remain recorded in the qualification notes.

The last close/recovery crash window has a genuine failing regression:
restoring the old blanket native-recovery exemption dispatches one provider
attempt after a committed close, where zero are allowed. The replacement
records exact-run `required`/`admitted` admission evidence in the server-owned
runner profile and preserves historical, already-admitted recovery behavior.
Nine focused cases pass; the final full recovery suite and final review are
still pending. These tests compose real native preparation and the actual
restart classifier, not an operating-system process crash.

Server 78 remains unchanged and Maya remains paused. The qualified release
runner has been copied to a private, read-only QA path but has not been
activated. A fresh database backup and controlled cutover precede the next
live question/form/close and attachment-fallback qualification.

## Subsequent checkpoint — 15:18 UTC

Base `335b2ee52709afb3885d4d6ebb2a3ece4b5864d6`, 47 changed files,
received a fresh Greptile **5/5**, clean security review and fully successful CI
run `34367194680`. Its complete local runner suite passed **1,888 tests**, with
10 preexisting skips. The whole release Rust workspace passed with serial test
scheduling and unchanged deadlines. A default-parallel attempt still exceeded
the descendant-lineage fixture's five-second deadline under load and remains
recorded; it was not hidden by the isolated or serial pass.

Master subsequently advanced to `82f662656` (#13093–13095, #13097). The base
now has a runner-transport merge conflict. The landing agent will finish
collecting its running broad 335 test result before changing source, then
reconcile and requalify the new head. The 335 approvals/checks do not authorize
merging a later head without fresh verification.

Top reconciliation must preserve master's execution recovery ordering and the
snapshot's physical-owner/usage fences. In particular, a Board reconciliation
on a chat-bound task cannot create both a generic pending successor and a
separate authorized failed-chat retry. The proposed typed single-owner receipt
keeps current chat source/access checks and existing idempotent retry identity;
non-chat behavior stays unchanged. Joined regression evidence is required.

Root deployed server 79 from local `3f2387073` and resumed Maya. Discord's
native question/choice/free-text flow passed live; Slack's true queue and native
Stop/fresh-follow-up passed. Fresh Discord close exposed an old-definition
registration incompatibility; GitHub's private-file Board fallback exposed an
unwanted passive-wait continuation and a misleading already-bound-file send
error. Repairs and final tests are in progress in the original checkout and
have not been pushed over the landing branch. Exactly two coherent PRs under
500 files and dependency-order landing remain the required structure.

## Subsequent checkpoint — 17:39 UTC

The user merged runner prerequisite [#13092](https://github.com/paperclipai/paperclip/pull/13092)
and explicitly required **two remaining chat PRs**; the runner does not count
toward those two. The chat foundation is [#13100](https://github.com/paperclipai/paperclip/pull/13100),
143 files at `1c3c34c9b5d8dcc0a732beefcb683712b1d9bf8b`. The integration remains
[#13038](https://github.com/paperclipai/paperclip/pull/13038), 370 files at
`21d3f81f990e419634df765043795e328dd8f6b9`, stacked on the foundation. Neither
has merged. The foundation does not mount routes or activate providers.

Foundation exact-head CI `34381883937` is fully green, including required
`ci / verify` and `ci / e2e`, build, release canary, workspace/general suites,
and serialized server suites. The exact isolated local workspace typecheck
also passes; its full local test/build chain is still running. Earlier
historical-migration fixture failures are preserved in the evidence ledger;
the corrected four-file database cohort passes 27/27. Tenant/delete/drift
matrix passes 2/2 and runtime/adapter lifecycle tests pass 119/119. Fresh
exact-head Greptile review is still missing after manual requests; resolved
prior findings and the old score do not satisfy that gate.

Integration CI `34381886310` passed every job except general-server shard 2/5
and its dependent aggregate. That shard passed 2,615 tests and failed four
warm-session checkpoint fixtures. The actual failure was an exact-value
assertion: the rejected persisted checkpoint is `null`, not `undefined`.
The assertion exception entered failure projection against a partial mock
database, masking itself as `runner.insert is not a function`. A temporary
diagnostic service mock exposed the original assertion and was then removed.
Landing-only test commit `66f16f244` changes only that refusal assertion and its
explanatory comment. The focused matrix passes 28/28, complete executor file
313/313, and plain server types pass; production authority is unchanged.
Both failed logs remain available in the ignored qualification directory.

Master advanced to `8cfd30fb0`, including composer Stop and task-control
simplification. An isolated three-way composition preserves those changes
alongside awaited Board submissions, retained uncertain drafts, exact private
comment attribution, and cache invalidation. Shared build, UI types and six
affected UI suites pass 395/395 on that preview. It is not yet the remote
integration head or full integration qualification. The final integration
must be updated after foundation merge and receive fresh gates again.

Both current chat PR file lists were checked: no wireframe images or HTML
galleries remain. The integration includes only three production provider
brand SVGs. Separately, a delayed first-seen pre-close source admission path
is under bounded service investigation in the source checkout; integration
merge is held pending that result. Historical live and full-service passes
do not certify that new edge, and no live checkout, dependency, runner binary,
or provider configuration was modified by this landing work.

## Subsequent checkpoint — 18:15 UTC

Foundation remains 143 files at `1c3c34c9b5d8dcc0a732beefcb683712b1d9bf8b`.
Its required exact-head CI is green, but the only current Greptile status still
says the 143-file change exceeds the automatic 100-file limit. Manual review
requests at 17:16 and 17:30 have not produced a fresh review. The historical
3/5 on `29c48d25` is not current approval; no merge or repeated request spam
has bypassed the gate.

The isolated exact-head local monolithic run stopped at a database fixture's
embedded-Postgres initialization failure: 107 database tests passed, 25 were
skipped by support probes, and one failed during initialization. The unchanged
full database cohort then passed 133/133 with serial file scheduling. The
resumed Codex adapter suite found a separate fixed-run-ID temporary-directory
collision (expected one staged home, found four). Its unchanged focused test
passes in a fresh owned temporary directory with a Git-discovery ceiling.
The first temporary-directory-only retry inherited the enclosing repository
and failed a Git fetch; that unsuccessful harness attempt is retained too.
Other workspace groups pass; serialized local suites and build are still
running. None of these resumed checks relabels the original monolithic run
as green. Logs are retained under the ignored `foundation-verify-PqC0e6`
qualification directory.

The integration privately includes root's `752d52a00` intake guard and
`d6724e057` shared chronology repair, including exact JavaScript-trim parity
for accepted commands. Its file count is now 371 against the foundation.
The root's final full-service and browser repeats remain separate pending
gates; earlier live or full-service passes do not certify the new chronology
edge. No wireframe images or HTML galleries were added; the only changed
image assets remain three production provider-brand SVGs. Historical
wireframe generator source and its archive note are not image artifacts.

The physical master-UI composition passes all 5,853 UI tests, in addition to
the previously recorded 395 affected tests and UI types. Its initial browser
cohort passed 32 chat cases but failed the unchanged process-adapter composer
Stop case. An owned SIGTERM exit had `exitCode: null`, which the executor
treated as zero while cancellation was still awaiting termination. The run
could therefore become Succeeded before the cancellation compare-and-set.

The narrow fix applies only to the process adapter. Overlapping Stop calls
join one owned in-memory attempt; executor settlement waits until that attempt
and its cancellation write settle. Failed-attempt evidence separately prevents
a graceful SIGTERM handler's zero exit from being called success, while a
later Stop can retry a still-owned live child. Existing terminal database
winners remain authoritative. Native adapters and other legacy adapters are
unchanged; this adds no durable cancellation or provider authority.

Actual-process tests cover signal and graceful exits, adapter exceptions,
termination/write failures, duplicate callers after child-map removal, delayed
results, a first failed Stop followed by a successful retry, and independent
clean-completion winners. Two graceful-failure counterexamples were retained
as genuine REDs before repair. The final selected Stop/paused-wait cohort
passes 29/29. The preceding full recovery run passed 246/248; its two paused
fixtures mixed PostgreSQL microsecond defaults with a later rounded JS run
clock, making the supposed source occur after admission. Explicit ordered
fixture timestamps preserve all production guards and negative assertions.
The final full recovery file passes 252/252 (124.53s) on a fresh database,
and plain server types pass. Independent review is clear at source SHA
`f23b50982a750a0fd8cfe1c79cf40eaeca7afa3456d377098d9aa20c5bf975d5`.

The final unchanged process browser journey passes 1/1 (50.1s test, 1.0m total)
on isolated port 3233: queued comment, actual composer Stop, refresh and
maintenance hold, explicit resume, subtree pause/cancel, and an unaffected
completed child. The inspected screenshot shows Cancelled and Stopped, with
the queued comment retained. This is deterministic process-adapter proof,
not the optional native fake-Codex case or a live-provider Stop claim.
The process fixture has no assistant transcript, so its Waiting for transcript
copy is not evidence about a model conversation. Mis-selected zero-test grep
attempts and a pre-test shared-memory allocation failure are retained as
harness failures, not product REDs or passes. Only positively owned retired
fixture clusters were restarted and normally stopped to reclaim their own
IPC segments; database directories remain, all other clusters and global
settings are untouched. Detailed logs and the final trace/screenshot remain
in ignored `integration-master-ui-Joeb8O` qualification artifacts.

### Foundation merged; integration final-base qualification

Foundation #13100 merged at 18:49:13 UTC as
`6abeb67334348dcb6fde2d591a27ffc7efc7118d`, after required exact-head CI,
current approval, resolved prior threads, and a fresh Greptile 5/5 explicitly
naming `1c3c34c9b5d8dcc0a732beefcb683712b1d9bf8b`. Its isolated full build
also completed successfully. Serialized local coverage completed across
144 files and 2,179 tests: the retained OpenCode environment timeout passes
unchanged with an owned empty XDG configuration; the remaining 24 files
pass 297/297. These resumed runs do not erase the earlier monolithic failures.

Integration head `ac71491df` received an exact-head 4/5 review. Its only
finding alleged same-agent unrelated-run toast suppression. The actual
producer includes `runId`; the suppression helper returns exact run membership
before its agent-only fallback, and the toast builder requires `runId`.
Greptile explicitly withdrew the finding after this call-chain evidence.
Six mounted WebSocket-to-cache-to-toast regressions on unchanged production
source pass, with both LiveUpdatesProvider files 53/53 and UI types passing.
The first added-test attempt was 52/53 because it incorrectly expected a
success toast; existing policy deliberately excludes successful-run toasts.
That fixture expectation was corrected without changing notification policy.

The ac714 CI Build job failed during runner verification before building:
1,897 tests passed, three failed, and three existing tests were skipped.
One retained-maintenance case hit the fixed terminal-result ACK deadline
with an older durable event backlog. Two later cases inherited that failed
fixture's intentionally sticky cleanup quarantine because their backend
domain names were shared. A causal regression reproduces that contamination;
unique immutable per-row fixture names let an independent case start while
the original domain remains quarantined. Its focused test and runner types
pass. No production quarantine reset or deadline relaxation is introduced.
The original ACK timeout remains a separate unresolved gate at this checkpoint.

The second chat PR is being rebased onto the actual merged foundation and
newer master changes. The shared transport union must retain `chat_sdk`, and
the deferred-wake test import union preserves both upstream and chat cases.
The post-base head still requires complete CI and a fresh exact-head 5/5;
neither this foundation merge nor the withdrawn finding authorizes the
integration merge.

### Final-base component qualification — 19:38 UTC

The private integration candidate is
`090cde5144b2eb5119d91336263bd462fe28d98e`, 379 changed files against
merged foundation/master `6abeb67334348dcb6fde2d591a27ffc7efc7118d`.
Its production bytes match `66cab99df`, whose isolated physical checkout
passed the full workspace build. Only reviewed portable test fixtures and
qualification records changed afterward. The protected original checkout,
lockfile, installed dependencies, runner binary, and live server were not
changed. Neither chat PR contains generated wireframe images or HTML galleries;
the three integration image paths are production provider-brand SVGs.

The primary ACK-loss repair now passes the actual delayed-fsync counterexample,
19 retained-maintenance cases, 80 controller cases, and package types. It
replays only an exact completed terminal receipt within the same owned
maintenance invocation. It joins retired connection processing before reading
evidence, rechecks authority after retirement, and cannot launch a provider.
The earlier same-domain fixture quarantine cascade is independently fixed by
unique per-row fixture identities, not by resetting production quarantine.

The first complete post-base runner attempt used the local default 17 Vitest
workers and retained 14 failures, 1,890 passes, ten existing skips, and five
reported unhandled errors. Two repeated failures were Darwin path aliases in
fixture expectations and filesystem hooks. Canonical fixture paths preserve
the original integrity and failure assertions. A separate fixture port
collision is handled only during bounded, ownership-safe preparation before
staging once. The two unchanged startup/installed-dependency timeout cases pass
in isolated files; their original exact scheduling causes remain unproved.
No timeout was increased and no assertion or security gate was skipped.

The subsequent exact-source check used `VITEST_MAX_WORKERS=1`. All 38 Node
contracts, 1,906 executed Vitest tests, and replay goldens passed; Vitest took
325.96 seconds total (308.75 seconds tests). Its ten unchanged exclusions are
three opt-in benchmarks and seven Linux-only executable/guardian cases. This
is explicit local isolated qualification, not a claim about GitHub's worker
count or default-CI behavior.

That same command then stopped with a Rust failure under the original default
Rust test concurrency. The descendant-lineage fixture missed its first
five-second completion check. Its retained state had processed 255 of 300
descendants, still active, before the terminal event. Two bounded 128-event
polls account for that prefix; persistence includes file/directory fsync.
No restoration or capacity assertion had yet run. The unchanged complete test
passes alone in 3.64 seconds. This demonstrates progress at the limit, not a
uniquely identified storage or scheduling bottleneck. All Rust source and test
files are byte-identical to merged master, and an earlier instance of this
deadline failure was already recorded above.

The entire unchanged release Rust workspace then passed with explicit
`--test-threads=1`: 533 top-level tests plus two executed subprocess-helper
checks, with no failures. The two helper declarations are ignored in the
parent harness because their owning tests invoke them explicitly. The
conformance check passed 1/1, replay parity passed 11/11, and the required
actual runner-to-HTTP authority suite passed 870/870 across three files.
These resumed component passes do not turn the original halted `check:all`
invocation into a pass. Its failed log remains alongside all subsequent logs
in the ignored `integration-base-verify-YAhDBQ` stage.

The isolated checkout stayed clean, its lockfile retained SHA-256
`822ecb8c7463689b2b6a09f5d262b85ae99a39b06e6461813e14410e62b2b8b6`,
and its privately built runner retained SHA-256
`ea9b3abfe98b5ba752ad492a1a6e413e4f6afd1e8b5da812902999e334f1452e`.
The next remote update must obtain its own required CI and fresh exact-head
Greptile 5/5 before integration merge. The previous 4/5 finding was withdrawn;
that withdrawal is not a fresh 5/5 for the new head.
