# Runner evidence retention scheduling

Slice 65, parent slice 64 (#17923) at
`d2ccbcdfc9118b8841299da65e94e487807e73ab` before its review repair.
This slice owns archived runner evidence. Native-harness backup expiration is a
separate remaining duty, although the old implementation inspects both in one loop.
The default branch was observed at `50b932a142216331b8d476042b454bc123739c40`.
The stack's pinned integration baseline remains `8548173fc9efdc0fa07644fb92dcc0b6851a95e5`;
the later default-branch changes require final stack integration and verification.

## Obligation and existing persistence

Continuity-break archives and identity quarantine directories preserve evidence
from a retired native session. Their names contain the creation timestamp. The
existing retention service falls back to mtime for a timestamp in the future,
preserves cleanup-source quarantine archives, refuses symlinks, checks session
activity twice before removal, and moves eligible evidence to a unique expired
name before recursive removal. Interrupted expired directories are recovered.

These filesystem facts already persist the retention obligation. There is no
reason to add a database table. No database work is needed for evidence inspection.
The existing hourly tick still invokes the backup-expiration path, whose eligibility
also depends on issues, runs, finalizations, and leases. Moving those two duties
independently keeps each PR's trigger and correctness claim reviewable.

## Triggers and module ownership

- Startup reconstructs evidence once using the existing bounded session/archive/
  quarantine continuation state.
- `quarantineRunnerdStateRoot` publishes `noteNativeRunnerEvidence` after the
  quarantine rename. `archiveContinuityState` publishes the same signal when it
  creates the continuity archive, before it moves the retired state. The saved
  retention deadline is days later; the signal does not authorize immediate
  deletion or claim that the archive's write is complete.
- A publication adds its timestamp to the existing earliest evidence deadline and
  wakes the registered worker. Earlier deadlines continue to win. The next due
  inspection reconstructs all retained evidence, including multiple writes.
- A recent item contributes its saved creation time plus the configured retention
  window and one millisecond, because the existing protection comparison is
  inclusive at the window boundary.
- Busy sessions, incomplete scans, and failed inspection/removal retain actual
  recovery obligations. Bounded continuations run after one second. Concrete
  failed or busy evidence retries use a one-hour worker retry; an earlier saved
  expiry or new publication can still wake the worker sooner.
- Empty evidence, ignored cleanup-source archives, and fully processed history
  leave no evidence deadline or recurring filesystem/SQL calls.

The existing retention owner exposes `nextEvidenceAt()` and a per-instance duty
selection. Legacy callers that omit the selection keep combined behavior. Startup
selects `backups` for the existing backup timer and registers an `evidence` instance
with the delivery coordinator. The shared scheduler/coordinator owns overlap,
admission, drain, retries, deadlines, and shutdown. No feature logic moves into
`index.ts`. The worker's first promise stays tracked without delaying readiness;
shutdown unsubscribes the local signal before stopping/joining delivery work.

The backup interval remains deliberately visible for the next independent slice.
This PR removes evidence from that interval; it does not claim that the instance
as a whole is idle while backup and other recurring duties remain.

Supported publication is the existing server-owned session executor in one
process. Unrelated filesystem writers need an explicit signal/ingress contract.
Startup reconstructs restart state; it is not cross-process live notification.
Cloud sleep gates and external alarm coverage are unchanged. Expiration can wait
for a supported host wake when compute is stopped.

## Failure record and local evidence

Two regressions failed before repair: the saved deadline was one millisecond
before the first removable instant, and an EACCES reading an archive directory
was treated as an empty directory and disarmed retention. Missing paths remain
quiet; other inspection failures now retain recovery.

A further controlled EACCES at the session root reproduced a lost cursor: retry
continued after the failed scope and left its evidence behind. The owner now
records that concrete failed inspection for a new full evidence pass. Healthy
scopes continue, and the failed scope is revisited after the bounded retry.

An intermediate full run exposed a compatibility regression in the existing
manual dry-run notification case. The publication timestamp's original due
semantics were restored; the inclusive boundary adjustment applies to the
observed recent item's next inspection. The old test and deletion protections
were preserved rather than weakened.

Final local acceptance: 158 cases pass across native-harness/evidence retention,
retention configuration, and startup. The retention suite uses a guarded isolated
PostgreSQL database; all selected cases execute. Tests measure quiet filesystem
and SQL behavior, saved deadlines, local publication, restart, busy/failure retry,
first work during drain, one-entry continuation, absence of backup SQL in the
evidence worker, disabled registration, and tracked startup after HTTP readiness.
Existing backup, manifest, lease, issue, dry-run, symlink, and cleanup-archive
cases still pass. Server TypeScript checking and the full server build also pass.
Remote review/CI and whole-stack acceptance remain pending.

## Ponytail repair: quiet handled retries, summaries, and publication boundary

Controlled tests reproduced a busy archive causing whole-tree inspection every
thirty seconds, that overdue retry masking another archive's ten-second saved
expiry, missing deletion/byte summaries, and a publication deadline one millisecond
before the first removable instant. All four fail before this repair.

The evidence-only owner now records an hourly retry for handled busy/inspection/
removal failures. Genuine earlier saved expiries remain the minimum deadline.
One-second truncated continuations remain independent. Unexpected state-base
inspection failure is also retained as an hourly worker retry; a new publication
can reactivate it immediately. Admission/drain reconciliation still uses the
coordinator's existing short memory-only retry. Legacy combined/manual callers
retain their original explicit-tick behavior.

The worker again logs candidate, removal, reclaimed-byte, failure, and dry-run
summary fields when it processes candidates or failures. Publication now schedules
the first removable instant in evidence-only mode; the old manual notification
case is unchanged. An added base-directory fault test proves five minutes of quiet
before a publication resumes processing. Final owning acceptance passes 162 cases
across retention, configuration, and startup, plus server typechecking. Earlier
receipts remain tied to their recorded heads; integrated verification follows the
parent skill-retention repair.

## October 29 master reconciliation and current acceptance

This existing archived-evidence slice was reconciled with the qualified retention
parent through normal merges. The expiration service now exposes both the new
saved evidence deadline and the parent's separate startup checkpoint methods.
The finite checkpoint failure budget remains intact. The native retention fixture
keeps its explicit external-database override and migrations while using the
parent's fresh recovery-database helper by default. Identical logger/coordinator
imports introduced by automatic composition were deduplicated. Every other path
matches the automatic merge, and packages remain byte-identical to the parent.

Current local acceptance is **285 passing unique cases across 11 complete files**,
without skips. The original combined run passed 283 cases but failed two new
startup fixtures because their mocked service omitted the preserved
`registerCheckpointExpiration` method. Production startup correctly called that
method. The fixture repair supplies the actual API and adds explicit assertions
that enabled and disabled evidence configurations retain checkpoint registration,
including while evidence reconstruction is held after HTTP readiness. The full
100-case startup file then passed in 7.55 seconds, without weakening any prior
assertion or timeout. The other ten complete files passed 185 cases and their
source remained unchanged. Accepted source after that fixture-only repair is
`da44dea2f3cd86cc72a25f2a419c63acafda1f7a`.

Coverage includes real archived-evidence expiry, filesystem and path safety,
inclusive retention boundaries, retry and paged continuation, preserved finite
checkpoint startup work, backup cleanup/configuration, server wiring, shared
deadline/coordinator and idle-work behavior, plus retained skill-cache behavior
and its own-company expiry regression. Database build, production server
typechecking/build, module boundaries, target migration order and Runner profile
identity passed before the fixture-only correction; runtime source did not change
afterward. Two fresh PostgreSQL 17 schemas plus per-file fixtures applied all 412
journal entries through index 413. All temporary local fixture imports were
restored exactly, and every selected test hash is bound in the acceptance record.

The archive worker uses the evidence duty and performs no backup SQL. The backup
duty and startup checkpoint owner remain distinct. Saved publication/retention
boundaries and one-hour busy/failure retries retain nearer expiries and bounded
one-second continuation pages. Unsubscription still precedes coordinator stop.
Publication must adopt the actual merged skill-retention prerequisite and obtain
fresh exact-head CI/security and reviews. No full local repository-suite, live
provider, external wake, measured instance/database suspension or fleet-cost claim
is made. Historical results and limitations above remain tied to their revisions.

## Requalification with later upstream changes

Normal reconciliation preserved the final skill-retention repair and all 95
unrelated master paths from the actual timer squash, task activity index and task
read changes. On source `2fa458833fa43b47eddc728a5e57f5ffcf5fa3e4`, all **285
cases across 11 complete files passed together**, with no skips, in 47.26 seconds.
This fresh full selection includes the preserved checkpoint APIs and their
repaired startup fixtures. Database build, production server typechecking/build,
module boundaries, target migration order and generated TypeScript/Rust release
profile consistency passed. Fresh PostgreSQL 17 schemas applied all 413 journal
entries through index 414. Every selected source hash and temporary fixture import
restored exactly. The final parent audit was then adopted through a doc-only
normal merge without changing any accepted runtime/test/package tree.

The inherited upstream Copilot source-identity failure is recorded in the
[parent retention audit](2026-10-27-skill-version-retention-sleep-audit.md#final-current-master-qualification-before-publication).
This slice leaves its release attestation and all identity inputs unchanged.
Generated admission still matches the active release manifest; the separate
source-identity computation is an explicit inherited exception, not a pass or a
claim of new live-provider qualification. Required fresh exact-head CI/security
and reviews remain merge gates. Actual parent squash adoption is still required
before publication; any new upstream behavior must remain preserved and receive
appropriate combined-context checks.

## Workspace-seed upstream composition

The next upstream merge (`27fbdb2a74e13141065555b6a2fa5acdd8da7964`)
optimizes verified workspace seed reuse. It is preserved by a normal merge,
including its adapter implementation, tests and native workspace history. On
combined source `a288a58287047193774eda54601ac9eda732d2e8`, **321 cases
across 14 complete files passed together**, without skips, in 95.73 seconds.
This includes the previous complete 11-file retention selection and the full
workspace-seed reuse, GitHub launcher and native workspace-history files. These
results replace, rather than add to, the earlier 285-case acceptance total for
this combined source. Adapter/database builds, server typechecking/build, module
boundaries, target migration order and generated release profiles pass. Every
selected source hash and temporary fixture import restores exactly. Provider
identity inputs remain unchanged; the inherited exception above still applies.

Actual skill-retention squash adoption remains a publication prerequisite. If
its tree carries only these already accepted upstream changes, tree identity
will prove that adoption changes no accepted runtime. Any additional behavior
will receive scoped combined-context validation before publication.

## Runner-authority upstream qualification

Master `27be8590442fc02d29a6c257a4e9dbe5bbbd66d2` then introduced Runner
authority for runtime activity and updated provider manifests. Normal composition
through `b80eee32f344ae0218d8b791c14f2ea174da09cc` preserves its complete
package tree byte for byte, the accepted workspace changes and the parent browser
readiness repair. The server retention implementation is unchanged.

On that combined source, **652 TypeScript cases across 22 complete files passed**.
These include the complete 14-file evidence-retention/workspace selection (321
cases) and eight affected Runner files (331 cases). One actual closed Pi snapshot
launch is intentionally skipped because its external distribution root is not
provided; this is not a live-distribution qualification. **29 Rust cases passed**
in the full native-backend target (26), full runtime-notification target (one),
and both configured-environment unit cases. Adapter/Runner/database builds, Runner
and server typechecking, Rust formatting/workspace checking, server build, module
boundaries, migration order and generated TypeScript/Rust profiles all passed.
Fresh PostgreSQL 17 schemas apply all 413 entries through index 414. All selected
source hashes and temporary imports restore exactly. These fresh counts replace
rather than add to the prior selections.

The new upstream manifest uses Copilot profile 81, but its separate source-identity
check still fails: the active fixture's `configuredEnvironmentRustSourceSha256`
differs from the actual merged Rust file. Every bound source and the entire
package tree equal master. This preserves the earlier inherited OpenCode-key
identity drift through the upstream profile update; no retention edit causes it.
Grok's separate identity check passes. The Copilot exception remains explicit,
and no release attestation is regenerated or new live-provider qualification
claimed. Required fresh exact-head CI/security and reviews remain merge gates.

Actual parent squash adoption remains necessary before final publication. The
new parent browser-repair commit and its original assertions are carried exactly;
the browser gate itself must still be green on the final published head.

## Actual prerequisite adoption for final publication

The skill-retention prerequisite [#17923](https://github.com/paperclipai/paperclip/pull/17923)
merged at `b06ea111a254c62e0a55199b010d82e0adb33bf0`, after all 58 current
checks were clean and the exact reviewed head `269935f6ccd7685866fd94bea66f7f803c48058d`
had Greptile and Ponytail 5/5. Its separate, evidence-supported failed-job retry
passed; no failing gate or required review finding was waived.

This last slice adopts that actual squash through normal merge
`3c40eaad954f7705144e6f378d93be2adff0c54a`. Duplicate ancestry conflicts were
resolved to the proven composed tree. The complete pre-adoption held tree is
unchanged, including the 652-case TypeScript and 29-case Rust accepted sources,
all selected tests and the parent's browser-readiness repair. Package, UI, E2E
and map trees equal the actual prerequisite. The final diff has eight owned
paths. This adoption changes ancestry rather than runtime behavior, so accepted
checks are not repeated; this paragraph and the PR body only record provenance.
The original remote head remains an ancestor, and no history is force-pushed.

Fresh required CI/security, exact-head Greptile 5/5 and any actionable Ponytail
findings are still gates on this slice's final publication. The inherited source
identity exception and all bounded-acceptance limitations above remain explicit.

## Final outage-journey readiness repair

The first final publication, `762d48605f93351e47f9fd1249d9293625834242`,
received exact-head Greptile 5/5 and Ponytail 5/5 with no actionable findings.
Its required checks completed cleanly except the second browser shard and its
aggregate. The title-outage journey reached the 60-second global test timeout;
its failure artifact still shows the original title, and no issue write was
observed. The same file then passed that case locally but reproduced a timeout
in the failed-session startup case (four passing cases and one failure). These
failures and the original assertions remain recorded; no failing gate is waived.

A visible initial task heading alone does not establish that the conversation
layout has settled after the upstream loading changes. The test now requires
visible conversation history before the ordinary title-edit flows, including
the cached offline task switch. Four additive readiness assertions are the only
spec changes. Removing those four lines reproduces the exact prior file bytes:
all original recovery assertions, outage controls, and timeout budgets remain.
The deliberately held first-session-lookup case retains its original pre-auth
readiness, so it still queues a write before the owner is known. An initial
broader readiness attempt blocked that intentional startup state; that extra
condition was removed rather than changing the scenario.

All **five complete outage-recovery browser journeys pass** afterward on a new
isolated PostgreSQL 17 database. They still verify failed-save retention, actual
retry after recovery, separation of two offline drafts, delayed owner binding,
comment replay idempotency and failed-session retry. The accepted 652-case
TypeScript and 29-case Rust runtime sources, all prior sleep regression files,
packages and UI are unchanged. The final nine-path diff adds this spec-readiness
repair to the eight-path feature. Fresh exact-head CI/security and reviews are
required after publication; older-head review passes are not reused.
