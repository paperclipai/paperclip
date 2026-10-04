# Pi production readiness — 2026-10-02

The release target is Pi 1.0.0 through the native Runner. Readiness is a finite
set of release gates. Pi remains a candidate until every required gate passes.
Do not expand this work to additional models, widgets, images, Cursor or Copilot
qualification. The existing draft stack must be reviewed in dependency order.

## Frozen target

- Pi: `@earendil-works/pi-coding-agent@1.0.0`.
- Wrapper: `pi-acp@0.0.33`; ACPX: `0.13.1`; Node: `24.21.0`.
- Pi profile: 14. Model: `openrouter/deepseek/deepseek-v4-flash-0731`.
- Profile 14 binds the corrected outbound ACPX client patch. Profile 13 remains
  historical evidence. Cursor 11 and Copilot 15 also bind that shared patch;
  both remain pending and receive no new paid qualification in this work.
- Reasoning: native-confirmed `low`. No silent model or thinking fallback.
- Exact source, suite definition, installed package integrity, runner digest,
  environment and cost evidence must accompany each attempt.

## Release gates

| Gate | Acceptance evidence | Current result |
| --- | --- | --- |
| Runtime identity and admission | Exact runtime/profile/model; verified effective thinking; startup below the 60-second admission limit; unsupported configuration fails before a prompt | Frozen shipping source `0bd040093` passes normal public CLI/server installation, Pi setup and credential-free profile-14 admission on ARM Mac (7.921 s), Intel Mac (31.692 s), and native Linux in Daytona (8.699 s). No prompt, credentials or binary override is used. The local Rosetta handshake failures remain failed evidence. |
| Live lifecycle | Pending native question survives controller restart in the original process; one creation and resolution; stale answer after provider death rejected; Stop retires owned processes; three warm turns keep process identity | Frozen shipping source `0bd040093` passes local Stop, steering, controller restart, native questions and three-turn continuity. Daytona lifecycle qualification remains open; its Stop cell retains both the missing-companion setup failure and the later unanswered-bootstrap-read failure. |
| Product workflows | All 26 explicit Pi Product E2E cells (13 local, 13 Daytona); screenshots, public state, independent artifacts, terminal and cleanup evidence | At frozen shipping source `0bd040093`, all 13 local cells are attempted: 11 pass; agent-files and file-edit remain failed. Eleven Daytona cells are attempted: hello-complete, question-resume, plan-approve, structured-question restart/resume and corrected warm continuity pass; Stop, native-questions, native controller-restart, agent-files, provider-death and file-edit remain failed. The corrected warm attempt passes nine matchers, all stable native identities and cleanup in 298 seconds; its original Mac setup failure stays failed. Steering and human-denial remain unattempted, held for the restrictive bootstrap/oracle gap. Original grades and exact-source evidence are preserved. |
| Runner protocol | Pi roster passes through the native packaged runner and authenticated mock control plane; lifecycle/denial/control cases remain distinct from Product tests | All seven cases are attempted at `0bd040093`: five pass; context-before-action retains its 120-second terminal timeout, and finish-task retains use of the advisory report without the required task mutation. One context/document workflow retry passes only after verified protection against the recorded host sleep; its original failure stays unchanged. The seven `b148b73ea` passes remain historical. |
| Installed distribution | Public CLI/server tars on ARM Mac, Intel Mac and Linux; normal Pi setup; exact Linux companion and immutable Daytona image imported without binary override | Exact-source public CLI/server installation and normal Pi setup pass on all three platforms. Public immutable image `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:342f1fd5cb8cabfa2242f38f4f686608b28b6536aa879c54b0cb0da6fba9ef47` imports into native Linux Daytona and passes closed admission. Temporary sandbox cleanup passes. Image jobs 37102904889, 37106313185 and 37110683910 are terminal/cancelled. |
| Governance and spend | Company isolation, human-only permission, duplicate/stale answers, Stop and budget hard stop; pricing estimates never become claimed bills | 58 focused governance/cost/session invariants pass at `f5f57e380`. Live pending-permission Stop passes at `03dd6ef93`. The qualification key cap is not proof of Paperclip budget enforcement. |
| Integration and rollout | Review each prerequisite; final-head typecheck, tests, build and CI pass; no unresolved review; exact artifacts; rollback recorded | Verified head `e90143a5c` has 53 successful CI checks, two skips, a completed Greptile 5/5 and no unresolved root review threads. Each subsequent head requires its own completed CI and review. Predecessor `82ee4ec91` has the same CI count and no unresolved root review thread after one permitted rerun; its original browser failure stays retained and its nondeterministic cause is unproven. Shipping inputs remain equivalent to `0bd040093`. The earlier complete native Linux command fails six suites after normal npm is restored after disk drops below the unchanged 256 MiB workspace reserve. Reclaiming only the unused owned pnpm store restores 2.75 GiB free; all six failed suites (75 tests) then pass unchanged. The next full repeat passes typecheck and the complete test command: 29,447 tests pass with 69 skips, including all 149 serialized suites. The command still fails when build lacks the Node headers required for SO_PEERCRED. A checksum-verified complete Node 24.21.0 distribution with identical executable bytes repairs headers in the owned tools. That corrected build retains exit 137 and the sandbox OOM counter at its 8 GiB limit; the resize endpoint returns 404. Full native Linux CI job 111317358779 independently passes the same `pnpm build` across all 35 build projects, with Node 24.21.0 and Rust 1.97.1. Its checkout tree exactly equals `e90143a5c`. Typecheck, the complete tests and the full CI build now pass on proven equivalent executable inputs. The failed Daytona wrapper and both failed builds stay failed. Every original failed command stays failed. Four prerequisite findings have downstream corrections; upstream review threads and standalone prerequisite CI remain open. Production stays held until all 33 cases pass. No merge or release. |

## Bounded execution

Run one explicit failed lifecycle cell after a specific source correction, with
zero automatic retries. Keep each failed attempt, its machine grade and its
cause. Do not regrade a failed attempt as a pass or rerun an unchanged failure.
After restart and warm continuity pass, run the remaining exact cells against
the fixed candidate. Use the canonical Product E2E and Runner report pipelines.

Pi paid qualification uses the existing dedicated OpenRouter key with a $5
lifetime credit limit. Do not reset the limit or fall back to an account key.
Check remaining credit and that BYOK usage stays zero before and after each
attempt. API key deltas are provisional billing observations. Pi model-catalog
prices are estimates. Unpriced usage must stay unpriced in the ledger and UI.

## Qualification snapshot — 2026-10-03

The current ledger has 21 passes, ten failed cells, two unattempted cells and
zero running cases across the required 26 Product and seven Runner gates.
The original failed warm attempt remains preserved. No production admission
is claimed. No automatic paid retry, fallback key, model change, workflow edit,
or lockfile commit occurs.

Normal installed Mac-to-Linux authority now passes the documented
`paperclipai runtime import-remote` path. The companion comes from immutable
image `sha256:342f1fd5cb8cabfa2242f38f4f686608b28b6536aa879c54b0cb0da6fba9ef47`,
contains 24,352 inventoried entries, and has manifest SHA256
`2c9d337c7d3753db6b8c44c5b347e195a2544b574670af7f32e5dfaffc0b4017`.
The installed runtime selects its exact Linux daemon/provider pack without
binary or pack environment overrides. Extraction never starts its container;
import and selection make no provider calls. This qualification copy is not
release publication: retain the companion and trusted manifest digest with the
release as described in `doc/architecture/runner-pi-capabilities.md`.

Remaining corrections and evidence:

- Local agent-files and Runner context-before-action reach successful tools,
  then exceed the unchanged 120-second terminal bound. No supported product
  correction is identified yet; both paid failures stay held. A fresh
  read-only power-log audit places the original Runner context timeout between
  a full wake and the next sleep, with no state event during its 11:54–11:57 UTC
  attempt. The separate workflow-context/document sleep correction does not
  establish a correction for this failure.
- Runner finish-task reports the run through `paperclip_finish` without invoking
  the advertised `finish_task` mutation. Preserve the mock authority distinction
  and the failed behavior grade. The actual failed attempt advertises and
  authorizes `finish_task`; runtime instructions already explain the distinction.
  A missing-tool or permission-denial correction is not established.
- Local file-edit edits, validates and publishes the correct downloadable bytes,
  but an extra shell command obtains artifact metadata. The frozen exactly-one
  native validation-execution gate fails. Do not relax that gate or retry without
  a correction.
- Daytona Stop initially lacks the controller companion. After normal import,
  one explicit corrected retry starts Pi but waits on permission to read the
  operator setup file. Restrictive native-read delegation is deliberate. A
  scoped bootstrap operator approval must preserve the pending write and all
  original Stop assertions; production permissions must not be broadened.
  Steering and human-denial first attempts are held for the same known setup
  gap. Both Stop failure grades remain; their sandboxes are separately retired.
- Daytona native-questions fails a remote command transport/deadline during
  observer setup with the existing unrestricted fixture policy. Canonical
  cleanup passes. Preserve this separate failure; investigate remote command
  readiness before another paid attempt or remaining first-attempt dispatch.
- A credential-free diagnostic executes the exact frozen observer readiness RPC
  against the immutable image three times in 0.48–0.64 seconds, within the
  unchanged 12-second RPC budget. Its sandbox is deleted. This proves current
  transport availability; it does not regrade or authorize a retry of the failed
  native-questions case.
- Daytona hello-complete passes its canonical grade, public native state,
  screenshots and cleanup. The next controller-restart first attempt fails the
  observer receipt deadline after a long preparation gap; its public cancel
  request also exceeds its bound. That canonical cleanup failure stays failed.
  Its separately identified sandbox is subsequently deleted. Normal installed
  companion selection verifies all 24,352 entries in 34.6 seconds in a free
  measurement; this does not prove the cause of the original longer gap.
- Daytona question-resume, plan-approve and structured-question restart/resume
  pass their canonical grades, native profile-14/low checks, hash-bound
  screenshots and cleanup. These are first attempts with the frozen installed
  runtime/image and unchanged Product definitions; the descendant harness at
  `6cc13a7f3` differs only in the recorded documentation and two ordinary test
  files. They do not regrade the separate native controller-restart failure or
  authorize a retry of any failed case. The subsequent key snapshot reports
  $4.8004 remaining with zero BYOK usage; billing deltas remain provisional.
- Daytona warm continuity fails in 8.780 seconds before a browser test worker
  starts: the fresh installed Mac controller cannot initialize PostgreSQL. No
  native run or API-state snapshot is produced; canonical cleanup is
  `not_started`. The absent initdb stderr leaves the underlying cause
  unclassified. Preserve this failed grade. Prepare a separate owned native
  Linux installed controller and prove credential-free health/UI/admission
  before a paid correction attempt. Do not infer a Pi continuity failure from
  this controller-startup failure.
- A separately installed native Linux controller passes normal public Pi
  admission in 6.702 seconds. Its image-derived companion retains every file
  byte and link target across 24,352 entries. Linux symlink modes differ from
  the recorded Mac copy, so its normal native companion uses its own manifest
  digest `0907c5be08ed804e4a02b0016703d261a4142c21db6e66f3a01dcca6e775b0cc`;
  the original Mac digest remains unchanged. Normal import passes. Preserve
  both explicit `ERR_PNPM_ENOSPC` dependency failures at the 10 GiB limit.
  Removing only unused owned staging and failed tool dependencies permits
  the smaller unchanged-harness dependency installation and normal Chromium
  setup. A later credential-free startup identifies a skipped standard
  PostgreSQL lifecycle: required native library links are absent and initdb
  exits 127. Standard `npm rebuild @embedded-postgres/linux-x64` repairs those
  links without changing archived bytes. The real installed launcher then
  passes health/UI with zero companies, zero provider calls and full scratch
  cleanup in 12.101 seconds. Strict complete installed audits pass 101,213
  controller files and 16,356 plugin files; the importer authority receipt is
  validated exactly. Normal CLI/plugin admission and all 13 Daytona catalog
  configurations pass with frozen profile 14/model/low. This prepares a
  healthy controller; it is not a paid qualification pass. Fresh BYOK/billing
  guards and an explicit one-case Linux execution phase remain required.
- Daytona agent-files retains two failed setup attempts: collection initially
  cannot resolve the declared shared helper, then the one corrected attempt
  cannot resolve the declared Daytona SDK. Source-only dependency links to the
  reviewed installed shared package and SDK 0.203.0 repair both resolutions.
  All 13 unchanged Daytona cases collect, and the SDK constructor passes without
  credentials or provider calls. Automatic approval review rejects a further
  agent-files attempt because the proposed retry guard exceeds the bounded
  correction authorization. That attempt is held pending human approval; no
  key is read or remote work dispatched by the rejected action.
- Daytona provider-death reaches a real unanswered native question, then fails
  its exact-child fault observer receipt. Canonical independent retirement and
  cleanup pass; provider-loss and stale-answer assertions are not reached.
  The unchanged Linux fault calibration passes all nine tests, including a real
  pidfd signal. A separate free image inspection finds raw metadata file hash
  `a82188d45ef98396c50880c1352a0dc77e81283ccaefe587156b3468d34e8c0b`,
  while admitted profile 14 pins the canonical entries hash
  `2957c0ec20ca1ace64d1a2b10c4a99f47f59e0c5c33a89161c1d5b48341c2b25`.
  The unchanged production parser accepts all 15,671 entries in that exact
  image-derived metadata. The fixture incorrectly compares the raw file hash
  to the canonical entries pin, so its closure check rejects correct metadata.
  The image's closure is valid; the fixture's hash representation needs repair.
  The original observer error masks its
  specific internal cause; this diagnosis does not regrade that failure.
  An unapplied private correction passes 14 free Linux tests: nine exact-child
  ownership/pidfd calibrations and five actual-metadata, formatting and negative
  pin regressions. A fixture correction remains held for workflow-scope
  clarification; those free tests do not qualify the failed paid case.
- The unrestricted Daytona file-edit first attempt edits and publishes the
  correct file and passes cleanup, but performs extra native shell executions.
  It fails the unchanged exactly-one validation-execution gate. Both platform
  failures remain held without a supported correction; supplied artifact hashes
  and the exact validation command were already included in the request.
- One explicit warm-continuity correction attempt now uses the proven native
  Linux controller after normal PostgreSQL lifecycle repair. The frozen
  runtime, profile/model/low, image and matchers stay unchanged. The phase permits
  only one correction after the one original failed attempt, with zero automatic
  retries and fresh BYOK/billing guards. The attempt passes all nine canonical
  matchers and cleanup in 298 seconds. Three turns preserve the native session,
  Runner instance, provider session, Runner PID and process-start identity;
  lease acquisition is created/resumed/resumed with one provider lease and
  execution workspace. All three retained event streams independently confirm
  the native session and Runner instance. The retained API snapshot has fewer
  full native run records, so retrospective reinspection of the other identity
  fields is limited to the live canonical checks. Removing only its unused
  owned pnpm store restores 1.65 GiB
  free after checking all 1,181 symlinks and finding no installed reference into
  the store. Installed graph identities and all original evidence are preserved.
- A free counterexample with the unchanged controls oracle proves that an
  approved bootstrap read followed by the pending write creates two permissions
  and is rejected. An external approval alone cannot repair the gate. Scoped
  Product E2E fixture/oracle changes require clarifying the user prohibition on
  workflow edits; GitHub Actions and production permissions need no change.
- The previously unexecuted workspace-A group passes 7,176 tests and fails one
  save-navigation assertion. The API update is already observed, but navigation
  follows asynchronous query invalidation. Waiting for the same form-close
  assertion corrects the test race; all 32 targeted tests and token gates pass.
  The corrected full UI suite then passes all 7,177 tests. Workspace A reaches
  the CLI suite, which passes 505 tests and fails one archive-inflation test at
  its unchanged five-second limit. That suite passes all 17 tests in isolation.
  Workspace B passes shared (836 tests) and skills catalog (20 tests), then
  fails the database recovery-migration case with an explicit System V
  `shmget` allocation error (`No space left on device`, 56-byte segment). This
  proves host shared-memory exhaustion for that new failure; it does not
  retrospectively classify the earlier stderr-free initdb failure. Subsequent
  projects and serialized groups remain unexecuted. Use an isolated test
  environment rather than repeating database checks on the exhausted host.
  Every original failed grade and the full-command failure remain unchanged.
- The protected full local command passes 15,018 tests, but one suite hook cannot
  initialize embedded PostgreSQL after five attempts. Its 31 tests then pass in
  isolation. Host shared-memory usage is near its 32-slot limit; missing initdb
  stderr prevents proving the original cause. Do not regrade the full command,
  change host limits, or stop unrelated servers as part of that inference.

The next work is to finish fresh CI/review for this documentation update;
correct the diagnosed remote fault fixture and restrictive
bootstrap only within clarified workflow scope; and find concrete corrections
for the remaining failed behavior and observer cases. CI at `e90143a5c` passes
53 checks with two skips. Its completed Greptile review scores 5/5 and all root
review threads are resolved. Each subsequent head requires its own completed CI
and review before handoff.
The two restrictive Daytona first attempts
remain held for the identified bootstrap/oracle constraint. All failed paid cases
require a concrete correction before retry. Keep
rollout held until every original release gate is proven.

## Evidence so far

- At `dc2b053f3`, the fresh installed profile-14 steering journey receives a
  canonical pass in 52 seconds, including cleanup. It proves the exact browser
  comment, one acknowledgement, denial of the original native write, the hidden
  instruction in the persisted final comment, succeeded/Done, process retirement
  and continuous no-effect evidence through cleanup. The original failed grades
  stay unchanged. No automatic retry or fallback key occurs.
- Final controls definitions advance to version 6. Steering now requires both
  linked control-plane records, the matching accepted result, and succeeded/
  completed/done terminal values. Stop keeps its separate cancellation contract.
  Missing, foreign, duplicate, premature and contradictory records fail. All
  129 controls/flow/catalog tests and Product E2E typecheck pass. The successful
  installed receipt also passes this stricter replay, with no provider call.
  The version-5 canonical pass remains version-5 evidence; the full final-source
  matrix remains a release gate.

- At `603ad3726`, the installed steering journey posts Steer (HTTP 200) and
  Deny (HTTP 202) to the original request. The provider consumes the hidden
  instruction, produces its exact final marker, and reaches succeeded/Done.
  Its canonical grade remains failed: the oracle rejects the legitimate
  `run.result.accepted` and `run.terminal` control-plane records as non-runner
  events. All seven journalled provider processes retire with no target effect.
  The corrected oracle validates those two records against the same run, turn,
  session and linked control producer, after the one native terminal. It still
  rejects foreign, duplicate, reordered and premature records. All 121 controls,
  flow and catalog tests pass, as does Product E2E typecheck. Replaying the exact
  retained public evidence passes the corrected oracle; replay does not regrade
  the original attempt or prove a fresh cleanup receipt. Controls definitions
  advance to version 5. A fresh installed journey remains the qualification gate.
- At `603ad3726`, public profile-14 setup passes on ARM and Intel Mac. The
  first ARM closed-admission probe rejects with `provider_lifetime_owned`;
  a separate credential-free diagnostic with retained state passes in 35.0
  seconds. Preserve both observations; ownership contention remains unclassified.
  Intel closed admission passes in 54.1 seconds. Neither host submits a prompt.
- Full workspace build passes at `3728bb45f`; only the tested UI request-order
  correction changes executable code afterward. Workspace typecheck and UI
  build pass at `603ad3726`. All 282 UI/projection/performance tests and token
  gates pass. Core native tests pass 333 cases. The broader local native
  integration run fails one Codex interrupt recovery case with `provider startup
  ownership remains unadmitted`; isolated diagnosis reproduces it. Do not count
  that broader run as passing.
- At `603ad3726`, 52 CI checks pass and Greptile is 5/5 with both findings
  resolved. Linux Canary is the one failed check: `session_handshake_timeout`.
  The local exact-source Linux build compiles but exceeds its fixed 30-minute
  deadline during image import. It produces no verified usable image. Its
  task-owned builder is stopped, its cache and failed receipt remain, and no
  provider credentials or calls occur. Linux and Daytona remain held.
- At `342287678`, installed steering proves delivery and one acknowledgement,
  but the UI marks the still-pending permission cancelled and hides Deny. The
  correction uses whole-run lifecycle state, carries pending cards to the live
  tail, and leaves closed cards at their original position. Older carried cards
  precede newer requests. The real widget regression clicks Deny for the
  original run, request and provider turn. The paid failure stays failed.
- At `36e712104`, installed steering returns HTTP 200 and the native command
  journal records accepted delivery. The public API retains the correct
  correlation-bound acknowledgement at source sequence 65 and also a
  rehydrated transport echo at 66. The exact-one acknowledgement gate rejects
  that duplicate before permission denial. A regression using the actual
  rehydration function reproduces both items; suppressing the transport echo
  retains the one authoritative item. The interrupted attempt remains failed.
- The shared ACPX patch also requires portable hunk metadata and new byte-bound
  identities. Pi advances to 14, Cursor to pending 11, and Copilot to pending
  15. Historical fixtures remain immutable, and old installed identities fail
  closed. The corrected patch passes all 16 packaging checks; identity and
  steering regressions pass 244 tests. No other provider qualification expands.
- The credential-free Intel public installation at `36e712104` passes closed
  admission in 44 seconds. Its Greptile review is 5/5, but CI is held by the
  stale patch-bound profiles, portable patch metadata and Linux admission.
  The paid attempt and task-owned Linux build were stopped when that identity
  mismatch was found. Their evidence is retained; the owned server and database
  processes are retired. Qualification must use newly installed profile 14.
- At `4237bc369`, the native turn-binding correction advances the steering
  journey past `steering_stale_turn`, but the provider boundary still rejects
  delivery. The real patched ACPX client lacks `requestExtension`: its types
  and runtime callers declare it, while its implementation omits it. A real
  package regression fails with that exact TypeError before the correction,
  then passes steering and follow-up during an unanswered prompt afterward.
  This is a separate runtime correction and needs a fresh installed journey.
- The corrected Intel public package at `4237bc369` passes credential-free
  closed startup in 37.8 seconds. Its CI typecheck, build, native tests and
  browser shards pass. CI retains two failures: a resumed durability test
  inherits the deliberately killed attempt's 500 ms timeout; the Linux public
  Pi probe reaches `session_handshake_timeout`. The former gets an explicit
  resumed-turn bound. The latter remains an admission blocker; accepting a
  timeout as successful installation would weaken the release gate.
- The local Linux image build at `4237bc369` fails before a provider starts
  because the committed lock does not match the source patch configuration.
  The official image workflow already regenerates its private build lock;
  local builds must do the same and record that resolved lock's digest.
  No repository lockfile or workflow changes are required.

- `2b50801b2`: installed restart failed before native answer delivery. The
  durable request turn ID differs from the provider turn ID. The browser's
  issue-identifier route also differed from the matcher's UUID route.
- `780471702`: the exact retained browser answer was delivered and the original
  run reached Done with the correct independent file. The attempt still failed
  because recovery emitted a second `runtime_request.created`. The oracle
  correctly requires one creation. The next change restores the ledger without
  repeating its creation event.
- `f5f57e380`: the fresh installed restart journey passes all six matchers,
  including one native creation/resolution, the original process and turn, exact
  browser answer, independent file and cleanup. The revised three-turn warm
  journey also passes all nine matchers with the same native process/session.
  Earlier failed attempts remain unchanged.
- The full workspace typecheck, 332 native core tests and 58 focused governance,
  cost and session tests pass. The PR's Linux timestamp precision finding is
  fixed with positive and negative calibration and the real process fixture.
- Credential-free ARM startup through the installed CLI, server and database
  passed. Normal Pi setup verifies the profile-13 closure. Full transport and
  recovery regressions at `780471702` passed 216 tests.
- At `f5f57e380`, the explicit Runner `get-task-context` case passes. The next
  case, `context-before-action`, times out after 120 seconds: four context tools
  succeed, but the requested progress mutation and terminal do not arrive.
  Its canonical timeout grade remains unchanged; no automatic retry occurred.
- The local pending-permission Stop attempt at `f5f57e380` fails. Retained
  Product events contain the native write and pending permission. The oracle
  incorrectly rejects legitimate earlier null paths while arguments stream,
  so it never sends Stop. The correction admits those partial rows only until
  the same execution proves the exact path. Missing/conflicting/lost paths and
  foreign executions still fail. All 66 control calibrations pass; the failed
  paid attempt stays failed and requires a fresh journey after the correction.
- The public-install verifier now packs the public CLI as well as the server,
  runs normal explicit Pi setup in its isolated consumer, then proves closed
  startup offline. Its standalone ARM probe passes in 7.9 seconds with no
  credentials, prompts, binary override or borrowed workspace package.
- Draft #14956 at `2b3d7ff0a` has a fresh Greptile 5/5, the Linux finding is
  resolved, and its CI checks pass. Subsequent changes require a fresh review.
- At `03dd6ef93`, fresh pending-permission Stop passes: the original callback is
  cancelled, a stale decline is rejected, the owned processes retire and the
  continuous watcher records no file effect. The subsequent steering attempt
  retains its failed grade. Its browser successfully posts one queued comment,
  but the oracle compares plain input with the editor's Markdown-escaped body
  and never clicks Steer. The correction binds to the exact browser POST body;
  67 calibrations include escaped content and rejection of an altered queue.
- The `03dd6ef93` full build passes. The broad unit run reports 14,984 passes
  and one HTTP socket failure; all 12 tests in that unchanged suite pass in
  isolation. Fresh review is 5/5. CI's public installer reaches Pi setup but
  exhausts its 256 MiB scratch mount. Pi assembly now gets at most 2048 MiB,
  retaining the same unprivileged, read-only sandbox and 3 GiB memory limit.
  All seven sandbox checks pass. CI's separate legacy signoff browser failure
  received one diagnostic shard rerun; it is not counted as passing yet.
- Earlier evidence in `doc/architecture/runner-pi-capabilities.md` is historical
  and must not be counted as qualification of a new source revision.
- At `2a6107c04`, normal public Pi setup and closed admission pass on ARM and
  Intel Mac (7.5 and 29.5 seconds). Intel uses a fresh compiled x64 daemon,
  packaged before installation through the normal public CLI/server graph.
- The fresh steering attempt at `2a6107c04` reaches the real public Steer API
  but receives `409 steering_stale_turn`. Rust checks the durable command ID
  against the live provider turn even though the facade supplies a separate
  `providerTurnId`. The correction uses that explicit provider binding, rejects
  malformed bindings without fallback and keeps the existing live-turn fence.
  All 333 core tests and 68 control calibrations pass. The browser fixture now
  ends immediately on a rejected steering POST before sending any denial.
- Linux CI now completes normal Pi setup with bounded larger scratch space.
  Its offline launch probe still returns an unclassified startup rejection;
  the verifier gives that launch's private runtime snapshots the same bounded
  scratch capacity. This is not counted as a passing Linux receipt yet.

## Resumed goal — 2026-10-02 21:50 CDT

- Current-head `6cfc79b50` CI completes with two failures: Linux Canary
  admission and a 15-second issue-document route test timeout. Runner, build,
  typecheck and the browser shards pass. The prerequisite stack remains open.
- The Linux admission failure is reproduced through normal public packages.
  Pi setup verifies profile 14, then admission times out in 37.3 seconds.
  A credential-free direct native RPC response arrives in 2.4 seconds.
  The actual Docker scratch mount reports `noexec`; executing the verified
  snapshot fails with `EACCES`. The offline runtime probe now uses executable
  scratch. Lifecycle and download probes explicitly retain `noexec`.
  The same installed Linux packages then pass the unchanged public admission
  assertions in 17.2 seconds, with clean Runner exit and zero prompts.
  This receipt uses historical shipping source `dc2b053f3` and native inputs
  from `3728bb45f`. It diagnoses and validates the sandbox correction; it does
  not qualify the new native source or the final Daytona image.
- A provider-free regression proves that receipt-limit deadline settlement
  attempted to restart the provider when polling terminal evidence. The run
  now closes permanently at that deadline. Existing startup admission fences
  remain intact. All 333 native core tests and all 90 enabled native provider
  integration tests pass after the correction; two pre-existing tests remain
  ignored. The accepted-deadline fixture now expects the closed lifecycle and
  checks that polling from both controllers adds no provider resume. The core
  regression also retains unacknowledged terminal evidence across reconnect.
  The earlier broader failure and its stale lifecycle assertion remain in
  private evidence; they are not regraded.
- Runner progress evidence contains four successful reads and continued model
  output before the 120-second cutoff, including unrelated fixture notes.
  Bounded direct-eval instructions now ask for the minimum context needed,
  the requested action, then turn completion. Case assertions and timeout
  stay unchanged. All 35 Runner session-contract tests and TypeScript
  typecheck pass. The retained paid failure remains unchanged. Fresh exact
  source packaging and profile-14 eval definitions must precede a paid retry.
- No paid call, key reset, fallback credential, workflow change, lockfile
  commit, merge or release occurs in this resumed diagnosis.

## Qualification update — 2026-10-02 22:50 CDT

- All 55 CI checks pass at `df424c902`. Linux Canary proves normal public
  CLI/server installation, profile-14 setup and credential-free closed admission
  in 8.036 seconds, with clean Runner exit. ARM public admission passes in
  7.988 seconds at the same source. Intel public admission passes in 34.059
  seconds at `666cb3ecc`; the next commit changes only Rust test formatting.
  These receipts do not prove the immutable Daytona image or the full matrix.
- Installed Runner qualification uses exact source `df424c902`, private eval
  definitions `a9e0e7e0`, frozen Pi profile 14, the exact model and low thinking.
  Context-before-action, get-task-context, create-task-document, finish-task,
  request-human-confirmation and workflow-context-document-progress all pass.
  Each has one attempt and zero infrastructure retries. Original failures
  remain unchanged.
- Workflow-governed-wait creates its requested approval and wake and completes
  the provider turn without finishing the mock task. Its canonical grade is
  `infrastructure_failure`: cleanup never proves durable Runner suspension.
  Retained stderr proves provider drain and semantic tool settlement, with zero
  pending provider events; suspension alone fails. The owned Runner is killed.
  The eval program deletes its temporary workspace, limiting further diagnosis.
  No paid retry is authorized by an unchanged failure; investigate and correct
  the close boundary first.
- The two #14924 notice findings are reproduced and corrected downstream.
  Error severity retains the Error label even with informational status.
  Distinct notices share one compact category so work and a later error remain
  visible. All 44 focused UI tests, token gates, isolated UI typecheck and UI
  build pass. Root UI dependency links point to a different frozen checkout;
  validation uses this task's own dependency-complete private source.
- The existing image-only run 37092761291 remains queued for EC2 job
  111116414966. It uses no provider credentials or prompts. Do not dispatch a
  duplicate on an observation timeout. Its authorization binds `df424c902`;
  source changes require new exact-source qualification evidence.
- The dedicated key's latest API observation is $0.092409367 lifetime usage,
  $4.907590633 remaining, and zero BYOK usage. The $5 lifetime cap and $100
  campaign limit remain. Billing observations are provisional, not invoices.
  Paid work is held until a concrete governed-wait correction and fresh
  exact-source packaging. The full 26 Product cells remain required.

## Idle suspension correction — 2026-10-03 00:05 CDT

- The original governed-wait failure remains unchanged. A credential-free,
  digest-bound native fixture reproduces a close-budget defect: `turn.stop`
  reports an idle Pi provider already settled, leaving an eight-second RPC close
  for a suspension phase that reserves only 2.5 seconds. The original regression
  fails after 8.55 seconds. The corrected regression passes in 0.62 seconds.
- Close preparation now stops idle Pi through its exact native process owner.
  Native code rejects an active turn or pending callback on the idle path, proves
  release of the original inherited lifetime fence, and retains the attested
  identity. Drain and suspension still require their durable receipts. Native
  suspension and the TypeScript checkpoint gate both reject unconfirmed exits.
  A held-quorum regression verifies the non-reusable boundary and unchanged
  state after polling. Remote Pi uses the same native guard before checkpoint.
- The complete native suite passes with no failures and two pre-existing ignored
  tests. All 236 transport and eval-session tests pass; Runner typecheck passes.
  Earlier test failures remain in private evidence, including a corrected
  negative-test expectation: safe polling returns no events and preserves the
  unconfirmed state rather than requiring an exception.
- Typed native suspension failures now retain allowlisted command/lifecycle/
  identity diagnostics in eval artifacts and stay non-retryable. Diagnostic
  collection reuses the barrier observation without extending the close bound.
- All 55 CI checks and Greptile 5/5 pass at `00c7a4510`, with no new finding.
  The subsequent native correction requires fresh-head review and CI. The
  superseded image run 37092761291 is terminal/cancelled; its queue state and
  cancellation reason remain. No duplicate or replacement image is dispatched.
- The paid campaign remains held for fresh exact-source packaging. Its launcher
  now rejects a mismatched or dirty harness and unpinned definitions before any
  provider call. Only the recorded private resolved build lock may differ.
  The next paid call is one explicit governed-wait retry after this correction;
  the original failure is not regraded. All seven final-source Runner cases,
  all 26 Product cells, platform receipts and the immutable image remain gates.

## Frozen candidate qualification — 2026-10-03 00:45 CDT

- Runtime and Product harness are frozen at `b148b73ea`. The public server build
  stamp, CLI/server package integrity, installed native digest and separate
  Runner tar are verified. The Runner tar's daemon, eval CLI and transport bytes
  equal the normal server-vendored files. Reused workspace package inputs are
  unchanged from their retained tar source. The private resolved build lock is
  recorded and is not committed.
- `3d75626bf` changes only the held-lifetime test. Linux's port-zero allocation
  can fall below the identity contract's allowed dynamic-port range. The fixture
  now reserves three valid distinct ports; it keeps the production validation
  intact. All 22 backend tests and Rust formatting pass. Shipping and harness
  inputs are unchanged.
- All seven installed Runner cases pass, including governed-wait in 35.7 s.
  The original failed attempt is preserved. Every case reports profile 14 and
  effective low thinking; all use the same package and native digests. The
  canonical scrubbed Evalbook renders seven attempts with zero rendering
  provider calls. Real Chromium verifies the report's chat, read-only controls,
  navigation, reload and narrow viewport. Its $0.008861636 aggregate estimate
  is not an authenticated bill; all seven provider-dollar receipts are unpriced.
- Normal ARM, Intel and Linux public installations pass in 8.043, 37.681 and
  5.698 s respectively. Each uses the normal installed daemon, verifies profile
  14, submits no prompt and observes clean Runner exit. Workspace build and
  typecheck pass. The broad local Vitest attempt completes with 47 failed files,
  533 passed files and 163 skipped files. Private Postgres library symlinks are
  missing, and the restricted test PATH omits macOS lsof. Both setup causes are
  corrected only in the task-owned dependency environment. The focused DB and
  process-owner checks pass 95 tests with three existing skips. The corrected
  broad run completes with 738 passed files, four skipped files, 14,984 passed
  tests and 84 skips. One native integration suite cannot start because Cargo
  is absent from the restricted PATH. With the pinned Rust toolchain added,
  that native Codex result/resume integration test passes. Both failed broad
  logs remain intact; neither is a passing full-command claim. The final-source
  run must include the pinned Rust toolchain from the start.
- The local Product controller-restart cell passes with canonical evidence.
  The next cell, warm-three-turn, completes turn 1 but fails before turn 2
  provider work: native `run.attach` reaches its 30-second command timeout.
  Canonical disposition remains `transient_infrastructure`, and cleanup passes.
  No automatic retry occurs; the campaign closes immediately. Eleven remaining
  local cells and all 13 Daytona cells are still unexecuted.
- A separate installed no-prompt warm-admission diagnostic opens Pi in 7.2 s,
  then rejects attachment with `session_resume_required`. It is not a replay
  of the completed-turn failure and does not qualify warm continuity. Its strict
  cleanup receipt fails even though native state reports suspended and Runner
  exits cleanly; both observations are retained. No model prompt is submitted.
- A free completed-turn regression proves the warm-admission mismatch. It
  finishes turn 1 through the native semantic bridge, checkpoints the sidecar,
  and delays the replacement's exact-identity admission by 32 s. The unchanged
  controller times out at `run.attach` and strict suspension fails. The corrected
  controller uses Pi's existing absolute 60 s cold-process admission budget for
  warm attachment and aborts admission on close. The same fixture then completes
  turn 2, retains one Runner, starts exactly two sidecars without a retry, and
  passes strict cleanup. TypeScript, all 201 transport tests, and 37 eval-session
  contract/entrypoint tests pass. The native 60 s bound and profile-14 bytes are unchanged.
  The paid three-turn failure remains failed. Fresh exact-source packaging and
  one explicit paid retry are still required; no live resolution is claimed.
- The corrected shipping candidate at `0d65753fe` passes full build and typecheck,
  normal public CLI/server packaging and fresh Runner pack/vendor equivalence.
  ARM, Intel and Linux public installation pass in 7.788, 31.185 and 8.071 s.
  The prior candidate manifests and Runner tar are preserved.
- All 55 CI checks and Greptile 5/5 are terminal at `96a0e329b`. Greptile is
  also 5/5 at `0d65753fe`; all 55 current-head CI checks are terminal and green. The superseded
  immutable image job 37099122706 is canceled because shipping inputs changed.
  Its one replacement, 37102904889, is authorized and queued for the corrected
  source. Track this exact handle without another dispatch. Qualification,
  prerequisites and image/companion gates still hold production.

## Qualification follow-up — 2026-10-03 02:15 CDT

- The explicitly authorized corrected-source warm retry at `0d65753fe` passes
  all nine matchers with three succeeded turns, one Runner process and session,
  exact independent file bytes, and strict cleanup. The original `b148b73ea`
  warm timeout stays failed. No automatic paid retry occurs.
- The final-source local matrix then passes controller restart,
  pending-permission Stop, same-turn steering, and native questions. Its next
  agent-files attempt fails with `native_session_interrupted` after the unchanged
  120-second bound; cleanup passes. The canonical grade remains
  `transient_infrastructure`. Retained tool outcomes prove the managed-memory
  write/read and expected cross-root denial succeeded. Completion is rejected
  because the server incorrectly recognizes these internal/negative-test
  instructions as a requested downloadable output. The provider continues after
  that rejection until the timeout. Treat the completion false positive as the
  observed product cause; preserve the machine classifier separately.
- The campaign closes after that failure. Its held coordinator is retired only
  after the provider attempt is terminal and cleanup has passed. The key keeps
  its $5 lifetime cap, zero BYOK usage and about $4.87 remaining. Its API deltas
  remain provisional. Five local passes are retained, without regrading the
  agent-files failure. No paid retry is authorized by a presentation-only change.
- The prerequisite #14921 exit/catch notice finding is reproduced through the
  actual extension-turn binding: two identical failure inputs produce two
  canonical notices. The first correction at `f62b8510a` changes the frozen
  notice-projection source hash, so its 115 focused passes do not qualify it.
  Restore that source byte-for-byte and coalesce only the board's consecutive
  identical display rows, scoped to the complete run, turn and session. Both raw
  PRP facts remain. Different reasons/severity, retry activity and later turns
  remain observable. The frozen binding/extension tests pass 11 cases (one
  optional host probe skipped); UI projection tests pass 145 cases. Token gates
  pass. No profile, wrapper, deadline, terminal or approval-authority change occurs.
- The completion regression reproduces four false positives without model calls:
  file-tool names, managed personal memory, an explicitly internal assertion
  file, and an expected denied native-write attempt. The correction preserves
  actual downloadable output requirements, mixed requests, and publication
  evidence enforcement. The first correction passes 59 tests, but fresh review
  identifies two mixed-output publication bypasses. Restrict the internal
  qualifier and denied-attempt scope; 64 tests pass. At `1a8900958`, fresh review
  identifies two valid instruction variants that this narrowing still rejects.
  Bind each file object to its own creation verb instead. An internal qualifier
  applies only to a single requested file across the preceding sentence, even
  if a later clause checks it. All 68 unit/database integration tests pass,
  including both publication bypasses and both internal/denied variants. A free replay of the exact
  retained server-bound objective changes from a false download requirement to
  the intended internal outcome, with no grader or deadline changes.
- At `b28422b29`, fresh review finds that an explicit "attach it" can lose its
  publication requirement when the preceding file is called internal. The free
  unit/database regressions reproduce that bypass. The correction preserves
  attachment/export references; 74 completion tests pass. Fresh review at
  `53923e5ad` finds that inferring publication from "return it" also blocks an
  explicit inline response. Remove that extra inference. Explicit attachment/
  export directives still require publication, while internal contents returned
  in chat do not. All 76 completion tests pass; the exact failed agent-files
  objective still needs no download. Wait for clean source review before
  rebuilding public packages again.
- At `fef9e8456`, review identifies a missing explicit "send it" delivery
  requirement. Preserve delivery references to the preceding file, including
  across sentences, while explicit inline/chat content remains inline.
  Attachment/export directives always retain publication requirements. All 84
  completion tests pass, including both delivery and inline instructions. The
  exact failed agent-files objective still needs no download; no paid retry runs
  on these intermediate candidates.
- At `062902cea`, review identifies an inline code-block response that the
  delivery rule still treats as a download. Recognize explicit response/reply,
  code-block and plain-text formats as inline content. An actual attachment
  named in that same response still requires publication. All 89 completion
  tests pass, including the database-bound reviewed example. Keep the paid
  campaign closed until clean review and fresh installed qualification.
- The subsequent download-link finding does not reproduce at `63e5d6443`.
  Its existing `download` object matching requires publication for the exact
  reported objective, even when the link belongs in a response. Free replay
  returns true and the database completion gate rejects missing delivery
  evidence. Add both as regressions: all 91 completion tests pass. No runtime
  change is needed for this finding; retain the failed review as evidence.
- The `0d65753fe` broad local suite is terminal with 736 passed files, four
  skipped files, 14,982 passed tests and three failures: a Git scan load
  single-flight count (497 versus 498) and two HTTP socket resets. One associated
  unhandled socket rejection is retained. This is not a passing full-command
  claim. The two socket-reset suites pass in isolation. The Git load failure repeats
  (496 joins versus 498). Its fixture creates 500 ephemeral listeners; the
  correction sends all 500 concurrent requests through one listening server and
  handles every rejection during teardown. The unchanged assertions then prove
  500 HTTP 200 responses, two scans, 498 joins and 2.4 ms health p99. All 138
  load/redaction/recovery tests pass. The full failed command remains retained.
- Image run 37102904889 is terminal/cancelled after the shipping source changes.
  Its successor 37106313185 remains queued and pins `f62b8510a` in its completed
  authorization job. It cannot qualify the corrected source. Retain this handle
  and supersede once the tested correction is frozen. No workflow edit, lockfile
  commit, new model, fallback key, merge or release occurs.

## Remaining work in order

1. Preserve the completed full native Linux typecheck, test and build evidence.
   Keep the original Mac command failures and the unclassified
   OAuth socket failure. The first Linux command compiles the Runner but fails
   staging because the check wrapper sets Cargo's target outside the staging
   script's expected path. Correcting that owned check environment permits one
   credential-free repeat; it does not change source or regrade the failure.
   That command passes typecheck, server (15,054 tests), UI (7,177), CLI (507)
   and shared (836), then fails the skills-catalog pack test because npm is
   absent from the closed PATH. Restore the immutable image npm path and
   preserve that failed command. The next repeat fails six suites after free
   disk drops below the unchanged workspace reserve. Reclaiming only the unused
   owned pnpm store restores 2.75 GiB; all 75 tests in those six suites pass
   unchanged. The current full repeat passes typecheck and all tests: 29,447
   passes and 69 skips across 164 groups, including every serialized suite.
   Build then fails immediately on missing Node headers. The complete official
   Node 24.21.0 archive verifies against its checksum and contains the identical
   pinned executable. Installing it only in the owned build tools supplies the
   matching headers without changing the sealed provider pack. The corrected
   build then exits 137; the kernel records one OOM kill and a peak at the
   8 GiB cap. The resize request fails with an unavailable API endpoint.
   The full native Linux CI build independently passes `pnpm build` across all
   35 build projects using Node 24.21.0 and Rust 1.97.1. [Job 111317358779](https://github.com/paperclipai/paperclip/actions/runs/37162051919/job/111317358779)
   checks out `5e36276bd`; its complete Git tree exactly equals PR head `e90143a5c`.
   Shipping inputs also match the frozen artifacts. This proves the required
   full build command without regrading either failed Daytona build or claiming
   a passing combined Daytona wrapper.
   Normal ARM/Intel/native-Linux installation and immutable Daytona import now
   pass; retain their exact-source receipts and original failures.
2. Complete all seven Runner cases and all 26 Product cells on the frozen
   shipping artifacts. Product has 16 passing and eight failed cells, with two
   restrictive Daytona cells unattempted. Runner has five passing and two failed
   cases; none are unattempted. Thus 21 of 33 required gates pass, ten remain
   failed, two need a first attempt and none are running.
   Run each explicitly with zero automatic retries.
   Every failed paid case remains held until a concrete correction addresses
   its observed failure. Neither a documentation change nor the unrelated
   fixture correction permits retry.
   Reuse only evidence whose executable inputs and recorded source match.
3. Finish prerequisite dispositions and latest-head CI/review. Four findings
   have downstream corrections; premature production admission remains held
   until all 33 cases pass. Preserve the original Codex interruption failures
   and corrected integration evidence. Apply the recorded operator rollout
   only after qualification. No merge or release is authorized here.

## Rollout and rollback

These are operator instructions for a later authorized release. Production
remains held until all 33 qualification cases, integration checks and prerequisite
reviews pass. This goal does not publish, merge or deploy the candidate.

1. Record `paperclipai --version`, the prior CLI/server package versions, the
   current company configuration and the exact retained package set. Run
   `paperclipai db:backup --json` against the intended instance. Retain the
   reported backup path and size. Record the backup file SHA256 before updating.
2. Use the exact qualified published version. For a managed npm installation,
   preview and apply the pinned update below. The operator must supply
   `PI_RELEASE_VERSION` after publication. Keep the default pre-update backup.
   A managed Git installation follows its recorded Git reference; use its
   separately reviewed install procedure rather than this npm version command.

   ```sh
   paperclipai update --version "$PI_RELEASE_VERSION" --dry-run --json
   paperclipai update --version "$PI_RELEASE_VERSION"
   paperclipai runtime setup pi
   ```

3. For Daytona, select the qualified immutable image digest above. Obtain the
   matching Linux companion and its trusted `companion.json` SHA256 from the
   same release. The operator must supply both values below. Use the normal
   import path; retain its receipt. The importer validates the server build,
   profile and complete inventory. The qualification copies and their
   platform-specific manifest digests are evidence, not published release assets.

   ```sh
   paperclipai runtime import-remote "$PI_RELEASE_COMPANION" --sha256 "$PI_RELEASE_COMPANION_SHA256"
   ```

4. Begin with one operator-owned Pi company using profile 14,
   `openrouter/deepseek/deepseek-v4-flash-0731` and explicit low thinking.
   Check normal startup, one question and answer, Stop, three warm turns,
   terminal task state and usage visibility before expanding. Preserve the
   existing company permissions and budget hard stop. Record the installed
   package, runtime, companion and image identities with each canary run.

On any failed qualification gate, keep admission held. On a rollout regression,
stop new Pi dispatch and retire active work through the control-plane Stop path.
For a managed installation, verify that the preview names the recorded prior
payload before applying rollback:

```sh
paperclipai update --rollback --dry-run --json
paperclipai update --rollback
```

The CLI restores the retained prior managed payload and restarts an active
managed service. It does not reverse database migrations. If the prior version
cannot use the current database, stop the service and restore the verified
pre-update backup through the instance's database recovery procedure before
resuming. Preserve post-backup run evidence separately. Non-managed installations
must restore the recorded prior published CLI/server set through their install
method; `--rollback` is supported only for managed installations.

Restore the recorded company configuration and verify service health before
enabling dispatch. Reopen incompatible sessions. Do not replay uncertain provider
actions or present expired callbacks as live questions. Preserve run history and
all failed release evidence.

## Native image and frozen-artifact qualification — 2026-10-03 07:16 CDT

- Shipping artifacts remain frozen at `0bd040093dd33b5a31cd0ecd1f170f0d94600fce`,
  with profile 14, the same model, and native-confirmed low thinking. Documentation
  and fixture-only follow-ups must record their exact diff and prove shipping
  inputs unchanged. They do not relabel artifacts or permit an unchanged failed
  paid-case retry. Any shipping-input change needs fresh package/image evidence.
- The local direct registry export publishes the exact-source immutable image
  listed above. Anonymous inspection verifies its source/content labels, digest
  and Linux AMD64 platform. Actual Daytona import, normal public CLI/server
  installation, Pi setup and closed admission pass in 8.699 seconds. The Linux
  daemon is `sha256:af4bb4b2934c01891f7f916e0f33bcce4fac2d59ee7d74c8e832ef8720154938`.
  All 18 archive integrities pass. The derived server archive changes only the
  public Linux binary; normal repacking omits six bundled changelogs. All other
  retained files match byte-for-byte. Public-source provenance and credential/
  user-state exclusion are checked before upload. The sandbox is deleted.
- Public graph audits pass 722 CLI packages and 79,360 files, the 150-package Pi
  closure, and 191 Daytona plugin packages with 16,356 files. The separately
  packed Runner matches all 1,330 vendored distribution files. Installed browser
  startup passes health/UI with zero companies, credentials or provider calls.
- The local AMD64 Docker admission failures persist across bind-mounted and
  native-volume installs. The process observer sees Rosetta executable ownership.
  Native Linux succeeds with the exact-source image. Rosetta is a supported
  diagnostic explanation to investigate, not a regrade of any failed attempt.
- The latest local agent-files failure completes bash and native memory write,
  but neither native read nor finalization. Its earlier completion-publication
  rejection is absent. No supported product correction is identified from this
  attempt yet. Its cleanup passes, and the original failure remains unchanged.
- Two first-attempt Runner cases use the frozen installed package and definitions
  `a9e0e7e025152e9941cca08e54d97c54f6490908`: get-task-context passes;
  context-before-action times out after successful context and progress tools.
  Native config/process metadata confirms low thinking, and Runner exits cleanly.
  There is one attempt per case and no automatic retry. The sequence stops.
  The strict shipping ledger is one pass, two failures and 30 unexecuted cases.
- The first full local command fails a comment-wake timeout and setup-token
  socket hang-up. Both suites pass all 58 tests in isolation. The controlled
  repeat fails a close-progress reaction assertion and an OAuth socket hang-up;
  its earlier failures pass. Each command stops in the first server group with
  737 suites passed, four skipped, 15,026 test passes and 83 skips. Neither is a
  complete workspace test pass. Seven selected cases then pass in isolation;
  instrumented diagnostic copies of both suites pass all 1,431 tests.
- A controlled deferred-worker fixture reproduces the close assertion with one
  late removal belonging to `setup-follow-up`, not the working message. The
  correction settles that exact setup receipt before measuring working-run
  removals. All four prompt/state cases pass under the same deferred-worker
  condition, and all 28 close-progress cases pass with normal scheduling. The
  original assertions and production worker code remain unchanged. A complete
  local command with this fixture correction remains required; the OAuth socket
  cause is unproven, and no speculative socket workaround is added.
- The key retains its $5 lifetime cap without reset or BYOK; its last pre-Runner
  snapshot has $4.862597588 remaining. Immediate usage deltas remain provisional.
  All 72 account BYOK provider rows are unconfigured. The campaign retains its
  $100 budget, frozen model/profile and failed-case holds. Recorded rollout/rollback
  remains conditional on every release gate passing.
