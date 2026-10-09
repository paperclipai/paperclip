# Runner defaults: staged delivery

Updated 2026-10-09.

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

## Completed prerequisite

[PR #15555](https://github.com/paperclipai/paperclip/pull/15555) merged at
`6f9d0a56ba3c2f0059a723b7de434320eed7eb22`. Its final candidate `dde37d7`
passed 47 ordinary CI jobs and fresh 5/5 automated review. The actual clean Linux
npm consumer checked all 17 tarballs for absent Codex native payloads and official
npm host dependencies. Actual Codex 0.156.1 startup passed on macOS ARM64.
[Bot lockfile refresh #15673](https://github.com/paperclipai/paperclip/pull/15673)
is merged. These checks did not qualify onboarding or cloud rollout.

Removed prerequisite work remains on `codex/runner-packaging-full-snapshot` at
`6f3060beaa842ffcee21af058370d3cab5f571e9`. Do not restore its release workflows,
Docker materialization, Git installer, or extra login isolation wholesale.

## Current slice: Codex defaults

Authorized 2026-10-09. Canonical branch: `codex/codex-runner-default`.
Integration base: master `2dd9811e8be1dab59cccd86cdb25e8953b02fe07`.
Canonical PR: [draft #15683](https://github.com/paperclipai/paperclip/pull/15683).
Last pushed candidate: `ad5d8826ad18f72d672fcafbdd9fec24ef8c9fef`.
It integrates the current agent lifecycle boundary. The next narrow follow-up
restores the native Codex sign-in action and settles an existing chat test's
canonical lookup before interaction. The PR remains under 100 files, with no
workflow, lockfile, or database migration changes. Fresh final-head CI and
review are required after that follow-up.
Preview: [isolated Codex QA](http://127.0.0.1:3125), normal dev supervisor,
separate database. Hosted Linux live onboarding passed at `38199ea8`; it remains
historical proof after the lifecycle integration. UI has separate revision-bound proof.
Attended local subscription and managed staging journeys remain unverified.

New Codex agents select Paperclip Runner on qualified Linux x64 targets. Users
choose Codex, with Paperclip Runner or Legacy runner inside Advanced. Other
harness defaults stay unchanged. Existing legacy/native agents and ordinary
edits retain recorded execution; explicit runner changes use revisions/session
invalidation. No database migration or permission-policy change.

Resolve before validation/auth/instructions/skills at the common creation
boundary. Cover direct/API/CLI creation, onboarding seeds, hires, frozen
approvals, built-ins, plugins, and import/export. Unsupported platforms or active
external overrides retain legacy selection. Missing dependencies, invalid models,
authentication failures, and incompatible settings remain actionable errors,
without silently choosing another runner. Native Codex bypasses the experimental
gate; other native providers retain their existing gate.

Finish line: one narrow reviewable PR, affected regressions and required checks
passing, useful Codex tasks plus follow-up and independently checked artifacts,
onboarding and existing-agent preservation verified locally and on qualified
managed staging, and inspectable evidence. Human merge and production deployment
remain separate actions. Actual production composition remains a post-merge gate.

## Coverage and execution ownership

Reuse Product E2E profiles, fixtures, graders, reports, and installation checks.
The `first-task` native Codex case now inspects the wizard's saved default directly
with the experimental flag disabled. The legacy control selects its override
before authentication. Each isolated onboarding company has a $5 task budget;
setup probes require their own reserved allowance.
Claude's explicit native fixture is unchanged until its later default PR.

| Area | Owner | Current state |
| --- | --- | --- |
| Shared contract, server resolution, setup readiness | Core worker | Integrated lifecycle: 210 core cases, 109 connection cases and five affected refresh controls pass; server noemit passes; counts overlap |
| Production create/edit/onboarding UI and stories | UI worker | 171 fresh focused cases, 30 desktop/10 mobile captures and six keyboard checks; built-in follow-up passes 15 cases, UI typecheck and token gates |
| Built-ins, plugins, approvals, imports/exports, CLI | Creation-path worker | Integrated lifecycle: 105 portability, eight approval and three asset cases pass; 73 DB cases skipped on macOS; final Linux checks required |
| Execution/dev gate, E2E gaps, packaging, live journeys | Lead | Selected Linux onboarding case passes all 13 assertions, actual task/artifact/follow-up and cleanup; 149 public-projection/support cases pass |
| Full CI and final review | Lead | Integrated head: 49 checks pass, three fail, four skip; native auth action finding and existing chat readiness fixture fixed locally; fresh combined-head checks/review required |
| Local subscription task + follow-up | Lead | Embedded-browser Codex sign-in and first-agent creation completed; saved codex_local is expected on macOS; useful task/follow-up still pending |
| Managed staging API/subscription onboarding | Lead | Fleet Admin sign-in completed; dedicated tenant exists, active/awake and pinned to old release; scoped one-hour QA owner access approved; final serving revision/snapshot/runtime/cleanup qualification pending |
| Shipped npm/Docker/cloud artifacts | Lead | Integrated-head clean Linux npm consumer passes: 18 packages, no Codex payloads, host dependency from official npm; immutable staging preparation reports missing matching DB package; actual cloud composition is post-merge |

Keep CPU-heavy Rust/Docker builds in hosted CI. Use Node 24, bounded workers,
conservative provider turns/timeouts and existing QA accounts. Login interactions
use the embedded browser. Do not change user preview services or production.

The original $250 ceiling remains. Historical receipts include unknown-charge
reserves; the latest retained ledger holds $248.18 in costs/reservations and
reports $1.82 unallocated, not a certified invoice balance. Reconcile unstarted
reservations and current resource/credential state before paid runs. Do not reset
the ceiling or treat missing charges as zero. The single new Linux campaign has
four ready rate-card estimates totaling $1.265460800; its entire $12 hold remains
reserved. Keep exact source/artifact/runtime identities and failed attempts in the
existing report pipeline; mocks and passing CI do not close live acceptance.

Integration found and fixed an import preservation gap: same-harness model edits
must retain the package's explicit runner or the existing agent's runner. Native
setup reuses production remote artifact preparation and verifies the actual
app-server/model path; a version number alone does not reject installed Codex.
Known unsupported local/SSH platforms retain legacy defaults. Sandbox support
does not infer an image architecture; setup verifies its actual artifacts.

Public package audit found flat Linux x64 daemons in current stable and canary
server tarballs. Normal release builds stage only the build host's daemon; the
multi-platform assembly helper has no release caller or macOS artifact producer.
Automatic macOS/Windows/Linux ARM defaults therefore remain legacy in this slice.
Existing explicit native agents remain usable with their installed runtime.
macOS runner artifact assembly is a separate prerequisite for its default.
Codex setup required three small Rust seams: read-only probes, observed model
reporting, and reasoning effort. Old cached daemon bytes do not verify these.

Local startup hit the macOS shared-memory ID limit. One detached 56-byte segment
was released only after zero attachments and exited owners were verified. No
running server or database file was changed. The separate QA server is healthy.

Next action: verify the final candidate through existing Linux CI/install checks,
fresh review, and bounded actual journeys. Preserve
failed attempts and costs. Unrelated findings and remaining harness qualification
belong to later slices.

Post-rebase UI checks pass (126 cases, typecheck, token gates). Product E2E
catalog/onboarding support passes (122 cases), plus 47 confirmation fixture
checks and E2E noemit. Existing Pi companion/executor controls pass (26 and 34
cases); core selection/setup passes 87 cases and transport passes six.
Production Storybook build and 26 desktop/six mobile captures were completed
before the Pi rebase; they are component evidence, not live execution proof.
Both final integration gaps are implemented: discovery resolves the selected
environment through the same helper as saving, and explicit native export/import
profiles remain valid on macOS while new automatic defaults stay legacy.
Scoped discovery/authorization passes 63 checks. UI context and recovery checks
pass 280 cases plus three final regressions. Missing discovery metadata shows
loading or the server error with Retry; explicit Legacy remains available.
Final portability checks pass 105 cases; approval, built-in asset and CLI unit
controls pass eight, three and three. The 72 skipped DB cases still need Linux.
Candidate `b7194275e` completed 38 CI checks but failed 14, including aggregate
checks. Its fresh review reported three P1 findings. The fixes preserve explicit
legacy sandbox policy, return refreshed unmanaged subscription credentials to
their authorized source account, and restore gated experimental native choices
for other providers under Advanced. Actor restrictions now run before harness
translation and again on the resolved configuration. Existing route fixtures
use the real resolver; legacy execution controls request Legacy explicitly.
Capability drift was fixed by preserving existing documentation heading anchors,
without changing generated contracts. The retired Codex flag control now uses
an experimental OpenCode profile; all 45 corpus regressions pass locally.
Core regression checks pass 394 cases, with 147 final guard/inheritance controls;
server noemit passes. UI checks pass 212 cases, typecheck and token gates. The
original touch/wheel journeys pass two cases against the isolated preview.
Final desktop/mobile/keyboard captures and the Advanced experimental story are
being checked against the frozen UI tree. Earlier 26 desktop/six mobile/three
keyboard checks passed on the previous UI revision. The built-in regression
checks nondefault settings through runner-only switches in both directions.

Exactly $22 of documented unstarted staging reservations were reassigned to
Codex-only proof: $12 Linux onboarding (one existing campaign, at most two
attempts), $5.50 managed onboarding, $2.50 attended local proof, and $2 incremental
compute/cleanup. The attempted $5 staging setup envelope remains an unknown-cost
hold. Aggregate costs/reservations stay $248.179254104 under the original $250
allocation; no historical unknown or cleanup hold was released. This is not an
invoice-certified balance. No new paid provider task has run in this slice.

Attended local Codex login is unfinished in the embedded browser; its old device
code expired. Staging Fleet Admin requires fresh attended sign-in. The dedicated
QA stack `stack-pool-d06dca5eafe7` and its old immutable environment are identified
historically; current access, serving revision, retained snapshot and physical
cleanup must be verified before reuse. Old archived probe resources and missing
compute billing remain unresolved. Do not substitute old artifacts or passing CI
for these live gates. The next candidate must pass fresh CI and review before
merge sign-off; actual private cloud composition remains post-merge work.


### 2026-10-09 Codex-only candidate qualification update

Frozen execution candidate `38199ea8e6a276eecd35084ad84d691322aba9f4` is rebased
onto master `835a022936ddc7a152b9feab0c0420d02249a6d1`. Its CI completed
48 passing, four failing and four skipped checks. The two substantive failures
are test fixtures: legacy skill expectations on Linux and a credential probe
that depended on a developer daemon. Their narrow corrections pass locally:
77 native/legacy/onboarding skill route cases and the selected-login refresh
regression. The earlier Node 26 skill run ended without a result; it is not proof.
Build, workspace typecheck, all browser E2E shards, policy checks, native
compilation, and the clean public npm consumer pass. The consumer checks all
18 packed packages contain no Codex payload and acquires host Codex from official
npm. The merge and generated-lock CI stamps are recorded separately from source.

The existing Linux Product E2E campaign [37950165589](https://github.com/paperclipai/paperclip/actions/runs/37950165589)
passed its only selected case on attempt one, without a retry. The ordinary
onboarding picker saved `paperclip_runner` / `codex`. All 13 assertions passed,
including an independently checked nonce-bearing document and follow-up with
recorded native execution and the same workspace. Four runs succeeded with
observed model `gpt-5.6-sol`; cleanup passed. Target source is exactly `38199ea8`.
The workflow deliberately applies its verified resolved lock; the source receipt
is dirty and must not be described as a pristine checkout. The report selected
one of 52 catalog cases; it is not the entire catalog qualification.

The final run ledger contains four ready rate-card estimates totaling
$1.265460800 (openai-standard-2026-09-30). Production pricing and accounting
settled. The existing E2E numeric-only cost summary omits decimal-string
costUsdExact and incorrectly reports unpriced/zero; this is a reporting follow-up,
not a production pricing failure. The full $12 campaign hold remains reserved for
setup and invoice uncertainty. Estimates are not provider invoices. No further
paid campaign was dispatched.
The existing public report includes private session identifiers in its result
summary. It is withheld from broad linking while an allowlisted public projection
is added at the existing result seam. Private artifacts and behavioral grading
remain intact. This is an evidence-publication correction, not new eval machinery.

Fresh review scored 3/5, verified the previous three fixes, and found three UI
edge cases: preserve original native setup-link intent on unqualified hosts;
retain built-in settings on runner-only changes; and record an explicit choice
when clicking the displayed automatic default. These fixes pass 171 focused UI
checks, typecheck and token gates. A fresh static build passes; affected visual
proof is in progress. Existing UI verification passed 28 desktop/eight mobile
renders, six keyboard/footer cases and two touch/wheel journeys. Final CI/review
must run after this combined follow-up is frozen.

The isolated preview uses [3125](http://127.0.0.1:3125/COD/dashboard).
Its supervisor uses the correct port and the prior backend restarted at
`2026-10-09T15:28:08.305Z`. No user preview or the separate OAuth proxy was stopped.
The owned supervisor/backend were gracefully paused during lifecycle integration;
restart and serving-source verification are required before another live journey.
The first-agent name draft survived reload. The cached local daemon is not proof
of the new native Rust seams; Linux hosted build/live execution supply that proof.
Attended subscription login and current access to the dedicated managed staging
stack remain unresolved. Canonical issue coordination is unavailable because the
original test-drive service is offline; no unrelated company was used for updates.

Public-evidence projection is complete and passes 149 existing and new support
checks. The private behavioral grader and raw evidence remain intact. Replaying
the retained result removes all 12 known private identity values and preserves
the original revision and all 13 assertion verdicts. Publication needs a new
presentation identity and operator access; the existing protected workflow has
no report-only replay input. It cannot overwrite the prior immutable report.
The prior exposed report also needs operator removal/cache remediation. No
provider rerun is justified to publish repaired evidence.

At `1be8502f`, fresh review confirms all six previous fixes and reports one more
built-in setup issue. A built-in that still needs setup must submit its displayed
configuration to complete setup even when the model is unchanged. Already
configured agents must still preserve the full saved configuration during a
runner-only edit. Both native and legacy regressions reproduced before the fix.
All 15 focused cases pass after the fix, including definition-model fallback and
ready/paused settings preservation. UI typecheck and token gates pass. Rendering
is unchanged, so existing revision-bound visual evidence remains applicable.
Native compilation passes; the main CI cleared its allocation delay and is
running, with no test failure observed yet.

Next action: freeze the built-in setup follow-up, require green
exact-head CI and fresh 5/5 review, and publish sanitized retained evidence when
operator access is available. Complete the attended and managed staging journeys
when their remaining resources are ready. The PR stays
a draft and is neither merge-ready nor production-ready yet. Merge and production
deployment remain outside authorization.

### 2026-10-09 Current-master lifecycle integration

Master merged [#15631](https://github.com/paperclipai/paperclip/pull/15631) during
qualification. GitHub blocked the new candidate on nine real merge conflicts.
The integration preserves master's agent lifecycle ownership. Common runner
resolution now runs in `prepareAgentHire`; approval activation retains the frozen
reviewed runner, responsible-user identity and credential restrictions. Existing
agent updates keep their saved execution. Obsolete source edits were removed,
and redundant generic API prose was dropped while the agent-creation skill and
its reference retain the complete runner contract. The diff remains 99 files.

Focused integration checks pass: 210 core, 109 connection, five affected refresh,
105 portability, eight approval and three built-in asset cases. Counts overlap.
Server noemit and the existing lifecycle-boundary scanner pass. Shared, DB and
plugin SDK JavaScript outputs were refreshed without migrations, Rust or Docker.
The 73 DB-heavy cases were skipped on macOS and require hosted Linux proof.
The full local route-fixture attempt was interrupted and is incomplete evidence;
loopback restrictions were identified before its bounded affected-case rerun.
That unrestricted rerun passes all 61 selected cases; 108 unrelated cases were
excluded and remain part of required full hosted CI.

The human completed Fleet Admin sign-in. The dedicated QA stack exists and is
active, awake, healthy and user-managed, so ordinary fleet rollouts skip it.
It still serves historical Core `2dbe43a4`, not this candidate. The human approved
one hour of scoped owner access for this QA tenant through the audited admin flow.
No release change, provider task, new image or fleet-wide action has run here.

Next action: freeze/push the integrated candidate,
require exact-head CI and fresh 5/5 review, restart the matched local preview and
qualify the dedicated managed target against that candidate. The previous Linux
run is retained evidence; it must not be relabeled as the new live measurement.

### 2026-10-09 Integrated-head qualification and final corrections

At `ad5d8826`, all checks completed: 49 pass, three fail and four skip. Required
verification, workspace typecheck, build, Linux server/DB suites, native
compilation and the real clean 18-package consumer pass. The consumer contains
no Codex payloads and selects its owned official-npm Codex dependency despite a
different outer version. CI merge and generated-lock identities remain separate
from the PR source. Applicable code-owner approval is still unproven.

The only browser failure is the existing selected-run denial case, whose fixture
uses the process adapter. Its URL becomes canonical before its agent query
settles. The test now waits for the successful company-scoped canonical response
and verifies its complete agent identity before clicking. All nine existing
retry cases pass against the real isolated preview with their exact request and
denial assertions unchanged. A supporting query lifecycle control reproduces
lost mutation feedback during a remount; the CI cause remains an inference,
because the controlled early-click browser reproduction did not activate.

Fresh review scored 4/5 and found one native Codex onboarding defect: an
authentication error lacked the shared check that displays the sign-in action.
The missing check reproduced before the fix. The correction retains the native
diagnostic, failed result and explicit runner choice. All 174 readiness, registry
and production-form render cases pass, including selected-environment login and
negative model/dependency controls; server/UI typechecks pass. The agent creation
skill retains the full API contract and CLI equivalents in one place, avoiding a
redundant reference edit and keeping the PR at 99 files.

The attended embedded-browser Codex sign-in succeeded, and first-agent onboarding
created the isolated Mac agent as `codex_local`, as expected on this platform.
The ordinary first-task interaction is open; task, artifact and follow-up are
not yet proven. No task provider call was made during these corrections.

The dedicated staging tenant's old release remains unchanged. Read-only
immutable preparation [37959487896](https://github.com/paperclipai/paperclip-cloud/actions/runs/37959487896)
matched the intended QA target and reported a matching DB package/migrations
artifact gap. Rollout and serving verification were skipped. Build the frozen
candidate's isolated preview image and packages through the existing trusted
remote workflow; never substitute an older image or claim private Cloud
composition from the Core-only preview. Keep the pin and provisioning default.

Next action: push these narrow corrections, run fresh full CI and review, build
matching immutable preview artifacts in hosted CI, then qualify the one QA tenant
after those gates pass. Retain all historical cost and cleanup holds. The draft
remains neither merge-ready nor production-ready.

At correction `f6a15200c`, fresh review passes 5/5 with all eight threads resolved,
and the previously failing retry E2E shard passes. One unchanged auth-signal
fixture exceeded its 15-second test deadline during a cold route import; its
previous exact version passed on the integrated head. Imports now run in the
existing setup hook after the same resets, keeping the 15-second assertion
deadline and all actor/response checks. All 127 affected auth/form/model cases
pass. A temporary 100ms assertion deadline also passes while setup takes about
six seconds, confirming the separation. Keyboard coverage moved intact into
the existing form suite; the PR stays 99 files. This correction changes only
tests and this record, with the production runtime byte-identical to `f6a15200c`.
Three hosted server shards were interrupted after passing progress and remain
incomplete evidence. The new test-only head requires fresh completed CI.

The frozen `f6a15200c` preview image is building remotely; exact-source shared/DB
preview packages are published and their source metadata verified. The isolated
local preview restarted at `2026-10-09T16:46:58.859Z`, serving that version with
startup recovery ready and no pending migrations. Its existing worktree execution
preference was off; activating it allowed the queued user onboarding response
to run. The actual legacy Codex task completed and its independently read file
contained the exact two requested lines. The same-task follow-up is running.
No second task, agent hire, or automatic runner conversion was used.
