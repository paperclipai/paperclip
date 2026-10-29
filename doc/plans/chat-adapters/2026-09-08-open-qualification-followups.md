# Temporary chat qualification handoff

Delete this note when the remaining items are fixed or moved into permanent
verification documentation. It is not a release-completion claim.

Updated September 10, 2026. Older scratch checkpoints are preserved in Git at
`f66bedd63`; they are intentionally not repeated as current work here.
The [permanent qualification log](2026-09-08-chat-queue-and-webhook-repair.md)
contains the chronological evidence and failed attempts. The
[browser runbook](2026-09-04-chat-adapters-browser-e2e-runbook.md) remains the
provider acceptance checklist.

## Updated landing direction — September 9, 16:03 UTC

The user merged runner PR #13092 as `fac07b42ad41cf24ee1d9de6837567607746daf2`.
The landing lane verified the merge and fetched that current master. The
remaining chat changes must now be split into **two chat PRs**, each strictly
under 500 files; the merged runner PR no longer counts toward the two. This
supersedes the earlier runner-base/chat-top plan below. A coherent dependency
split is being prepared in the separate landing worktree, with production
GitHub tool behavior and default-off experimental chat preserved. PR #13038
is provisional until recomposed; its automatic retarget briefly exposes old
stack ancestry. Neither the provisional count nor prior-head review is final
verification. Root continues live qualification in the original worktree and
does not push the remotely coordinated branch.

## Current work — September 10, 13:12 UTC: real-runner durable receipt boundary

The same `a8a32c60d` CI run now proves the corrected Discord fixture under Linux:
full chat integration passes **995/995** in 657.63 seconds total. Build exposes
another failure: the real-runner kill/resume test's two-second checkpoint poll
does not observe its expected effect. Its snapshot contains only the initial
open-run state; this does not identify where the CI process spent that time.
The case passes unchanged locally in 4.67 seconds. No local reproduction of
the exact CI failure or production regression is claimed.

The test's poll starts before workspace admission, but the provider's two-second
turn deadline starts afterward. Replace the independent polling assumption
with an exact real-store save-completion signal, racing actual turn failure
and test abort. Keep the provider's two-second limit, the case's thirty-second
limit, real filesystem persistence, explicit process kill, thread recovery,
and duplicate-effect assertions. A controlled premature acknowledgement fails
the held-save assertion; the corrected focused cohort passes **5/5**, and the
full affected runner suite passes **35/35** in 24.70 seconds with no skips or
retries. Negative controls reject wrong identities, missing effect/process
evidence, failed persistence, turn failure, and test abort. Plain runner types
pass and independent frozen-source review is clear. The route-module setup
correction below is also committed locally; both test-only fixes will receive
fresh CI and review together. The full PR is 400 files. No live deployment or
provider testing resumes before this merge lane is clear.

### Prior checkpoint — September 10, 13:08 UTC: cold route-module setup

The Discord fixture successor is published as
`a8a32c60d2034e7b0efb4eb7d1dde585a75c509b`. Exact-head Greptile review finishes
**5/5** at 13:00:16 UTC, with no actionable findings. Fresh CI exposes a
different test-harness failure: the first agent-skills route test exceeds its
existing ten-second body deadline while loading the cold module graph; all
35 following cases pass. This test file is byte-identical to current master.
The head must not merge while that required check fails.

A bounded local phase probe measures the first module import at 4.529 seconds,
app construction at 7.466 milliseconds, and its HTTP request at 8.600
milliseconds. The second import takes 127.798 milliseconds. Local tests pass;
this is phase evidence, not a claimed local timeout reproduction. The original
CI failure remains the failed-run evidence. The correction moves actual module
imports into the existing per-case setup, after each module reset and all mock
defaults. Each case still applies its own overrides before constructing a fresh
app and exercising the real routes. No production code, timeout, mock-isolation
rule, or response assertion changes. All **141/141** cases pass in five separate
cold Vitest forks: skills 36, permissions 63, cross-tenant authorization 13,
adapter authentication 14, and adapter routes 15. No cases are skipped or
retried. Plain server types pass, and independent frozen-source review is clear.
The full PR is 399 files. Fresh exact-head CI and review remain required after
publication. The original checkout and live server remain untouched.

### Prior checkpoint — September 10, 12:44 UTC: exact Discord modal race fixture

The conflict-free reconciliation is published as
`102fa25b87b70d6346d569a5bef7553a4b980185`, 398 files. Exact-head Greptile review
finishes **5/5** at 12:34:58 UTC, but fresh CI fails two of 995 chat integration
cases before the intended Discord modal race mutation. This is a merge hold.

The fixture starts its default one-second lock wait before a database-wide
sequential reconciliation reaches the target. It also accepts any blocked
backend; earlier Discord command authorization can take the same connection
lock, so that observation does not establish the intended modal boundary.
Production and test files are unchanged from the previous qualified head.
No production regression is established by this pre-mutation assertion failure.

Replace that timing assumption with an exact modal prepared-query/PID gate:
let reconciliation reach that statement, take the real connection row lock,
release the statement, prove that precise backend is blocked, then apply the
test mutation. Production code, provider calls, deadlines, and final negative
assertions remain unchanged. A stronger exact-boundary assertion fails all
three old-fixture variants; the corrected focused cohort passes **8/8** and
plain server types pass. Independent final review is clear. Full chat
integration passes **995/995** on a fresh database in 287.16 seconds, with no
skips or retries. The test hash remains frozen and production is unchanged.
The earlier CI attempt passed 22 jobs; only the chat shard and required
verification aggregate failed. Publish one test-only successor, then require
fresh exact-head CI and review before normal merge. No blind rerun, timeout
increase, or bypass.

### Prior checkpoint — September 10, 12:19 UTC: queue admission reconciliation

The user asks to fix the new merge conflicts and merge PR #13038. Published
`e02a63d462ce5d47433b0aeb632bb6fd20aab1ba` passed all 24 CI jobs and exact-head
Greptile review at 5/5, but normal merge still required CODEOWNER approval.
Master has since advanced to `2a05b5ed3457ea33efd6895520447d1d97fe98d8`, adding
the queue-admission extraction, simplified queue ports, test TypeScript
configuration, and a separate runner-verification CI job. Those changes cause
six conflicts. Earlier-head results do not qualify this new composition.

Keep the new host/transaction split and admission module while carrying exact
durable receipts, current actor boundaries, and non-coalescing dedicated
answers through the extracted ports. Preserve failed-chat retry authority,
retired question-source suppression, generic recovery denial after fresh input
gets its promotion opportunity, and the existing Stop-registration barriers.
The original checkout and live server remain untouched; unrelated provider
qualification stays paused. Auto-merge is temporarily disabled so a successor
cannot land before fresh exact-head checks and review.

UI types and all 24 workflow/module-boundary tests pass. The initial boundary
run failed on an upstream application-layer import; removing its no-op wrapper
around a fresh normal-model context preserves the exact context and restores
the enforced boundary. No scanner exception or test deadline changed. Fresh
database recovery/batching/queue/control verification passes **308/308** in
139.98 seconds. The four queue-module suites pass **89/89**, plain server
types pass, and all four actual local process/ACP browser paths pass in
**1.4 minutes**, without skips or retries. The final screenshot shows Cancelled,
a paused subtree, retained input, and no error toast. Independent final source
review is clear. Full chat integration passes **995/995** in 249.35 seconds on
its fresh database. All final source hashes match the reviewed freeze. Publish
the single 398-file successor and require fresh exact-head CI and Greptile
review, then attempt normal merge. CODEOWNER approval remains independently
required; no bypass or self-approval.

### Prior checkpoint — September 10: deferred-wake extraction reconciliation

Published `7c6d36e0d7d343709f10b533a0c29dc2409f7b2b` passes all 24 jobs in
[fresh CI](https://github.com/paperclipai/paperclip/actions/runs/34434501548).
Greptile reviews that exact head at **5/5**, without actionable findings.
The normal exact-head guarded squash merge then fails because master advanced
to `6dd48cad4` (the deferred-wake module extraction) during the checks.
No merge or policy bypass occurred. The three conflicts are being reconciled
in the existing isolated checkout; no new worktree or live changes.

Preserve the upstream module boundary and the previously established chat
guards: exact retry promotion authorization, retired native question-source
suppression, and denial of description-only generic recovery for failed chat
work. That final deny applies after independent deferred messages are drained,
not as a blanket refusal of fresh input. Existing batching-test bytes remain
intact; the two new upstream cases are added. Focused issue-update checks pass
19/19 and the initial pure module cohort passes 37/37. The final composition
passes **307/307** recovery/batching/queue/control tests, **995/995** full chat
integration, **49/49** module tests (including eight PostgreSQL adapter cases),
plain server types, and all four actual local process/ACP browser paths.
No retries or skips in these final local cohorts. Source hashes stay frozen
and independent review is clear. Publish the single 397-file successor, then
obtain fresh exact-head CI and review. All unrelated live qualification stays
paused until normal merge succeeds.

### Prior checkpoint — September 10: Stop-registration review correction

Master reconciliation is published as `a95d42e58afa35cf4ecf1a39cbd96f06523b90ec`.
Its complete [CI run](https://github.com/paperclipai/paperclip/actions/runs/34433249742)
passes all 24 jobs, including both required aggregates, at 03:42 UTC.
Greptile's exact-head review is **4/5**, with a confirmed Stop-registration
race. This is a merge hold, not permission to merge because CI is green.

An in-flight Stop can capture no adapter owner and then wait for its terminal
database write. Meanwhile a newly registered adapter can read the earlier
running state and start after Stop returns. The correction fences readiness
behind every earlier no-owner Stop for the same run, before publishing a
joinable control. Single Stop and agent pause release their barriers in
`finally`; registered cleanup, native cancellation, and plain-process behavior
retain their existing owners. No cancellation receipt is fabricated.

Both real-service regressions fail against the exact published source and
pass with the correction. The full recovery/control cohort passes **265/265**
(259 recovery and six control cases), and plain server types pass. A stricter
post-drain equality assertion then passes both affected service cases again
on a fresh database. All four actual local process/ACP browser paths pass in
1.3 minutes, without skips or retries; this is not live-provider qualification.
Publish one successor, obtain fresh exact-head CI and Greptile review, then
use normal GitHub merge policy without bypass or self-approval. The PR remains
below 500 files. Live qualification remains paused and no live binary changed.

### Prior checkpoint — September 10: final master reconciliation

The published head `3e4e1c1cee05737fd5193e141ccd52f8815c7854` passes its
complete [CI run](https://github.com/paperclipai/paperclip/actions/runs/34415826820),
including Build and both required aggregates, at September 9, 23:28:50 UTC.
The previously failing ambiguous-replacement and descendant-lineage cases
both pass under Linux CI's unchanged default concurrency. This does not erase
the recorded earlier failures.

The user's three-hour merge target elapsed during the interrupted work. The
PR is not merged. New master `018ca5da…` now conflicts with the integration:
upstream changes add verified ACP Stop, mobile task layout, runner packaging,
and the official lock refresh. Reconcile those changes without reverting
experimental chat gating, native cancellation authority, or dedicated chat
answer continuations. All unrelated live-provider testing is paused until
this PR is merged. The existing live QA server and runner remain unchanged.

The inherited lock installs frozen without regeneration. The unchanged
adapter cohort passes 186/186 and packaging checks pass 11/11; adapter/shared
types pass. The first adapter attempt had three timeouts during a confirmed
290-second macOS idle sleep, not assertion failures. Its logs remain retained;
the repeat uses a temporary sleep guard without changing tests or deadlines.
Final merged-code verification now passes: full recovery **257/257**, adjacent
queue/control **24/24**, focused UI **448/448**, and four browser flows in
1.4 minutes with no retries or skips. Plain server/UI types and token gates
pass. Two actual-service regressions first fail in both adoption directions;
the fix preserves dedicated donor context and non-coalescing recipient input.
The fixed four-case cohort also preserves ordinary upstream adoption and
verified adapter Stop. Independent server and UI reviews are clear.

Publish this single master reconciliation, then obtain a fresh exact-head
review/check cycle. Use GitHub's normal merge policy, without bypass or
self-approval. The four browser cases use actual local process/ACP fixtures
and a fresh database; they are not live-provider qualification.

### Prior checkpoint — September 9, 23:10 UTC

The resource audit is published at `36143409…`, still **388 files**. Its CI
run `34412429534` completed **red**: Build failed one Rust ambiguous-replacement
case, so the required verification aggregate failed. All other independent
jobs passed, including every browser and server shard. The isolated chat
shard passes **995/995**, no skips, in 591.09s total. No review was requested
for this intermediate head. The push had completed before a new UI hold
arrived. Do not merge or blindly rerun this head.

The Rust failure is `ambiguous_replacement_turn_adopts_one_later_completion_identity`:
the malformed-error case did not observe its expected replacement completion.
Its file is identical to incorporated and current master; this establishes
source provenance, not a cause. A controlled actual-reader regression now
proves premature exit before a held terminal frame is delivered. The unchanged
original test also passes alone; that isolated pass does not erase CI's failure.
The preceding runner TypeScript suite passes **1,944** cases with three existing
benchmark guards, but later build stages did not run after the Rust failure.

The hold exposed a separate real Settings bug: each toggle submitted the
entire cached resource inventory. A stale page could revert another page's
grant or revocation, and 501 discovered resources exceeded the 500-update
request limit. Three actual browser regressions failed on those exact old
behaviors. The narrow fix sends only the selected `{ id, enabled }` and keeps
the full server response as the cache refresh. Same-destination last-write
semantics, pending controls, and error handling remain unchanged.

Root's fixed browser cohort passes **9/9**: five provider management journeys
and four new regressions. The final stronger error-opacity check passes a
separate **4/4** repeat. The composed candidate `fee3e9c6…` repeats those four
cases on a fresh fixture database in **49.2s**, no retries or skips, and passes
**64/64** UI units, plain UI types and token gates. The inspected screenshots
show unchanged unchecked state while pending, a readable opaque error after
rejection, and only the selected destination enabled after explicit retry and
reload. These pages use a mock control plane; this is not live provider or
database-transaction concurrency proof. A full transition or accessibility
audit is not claimed.

After the UI fix, private commit `3bb4716f…` changes two existing Rust files to
remember reader EOF and drain the current process's tail before certifying exit.
The existing shutdown grace bounds the wait, including a descendant that keeps
writing. An undrained exit cannot certify success or safe reconciliation, but
already-recorded terminal authority is not erased. All six focused controls
pass; independent review is clear. The candidate is now **390 files**. The
locked serial Rust workspace passes 546 top-level tests plus two invoked
helpers. The new isolated artifact passes all **171/171** transport and
**870/870** API-authority cases, conformance **1/1**, replay **11/11**, and plain
runner/server types. Its staged SHA-256 begins `5ba0b273…`; the permanent log
records the full hash. No live binary or tracked lock was changed.
The default-concurrency Rust attempt retains one unchanged lineage-fixture
failure: 255 of 300 events persisted before its first completion deadline,
matching the earlier pre-repair local boundary. The same new-release case
passes unchanged alone in 3.51s. The explicitly serial full-Rust run is green;
fresh Linux CI remains the default-concurrency gate.
The full **995/995** server and four-case Settings qualifications remain exact
for their unchanged source bytes, not substitutes for those new runner gates.
Publish one consolidated successor to existing #13038. It needs fresh
exact-head CI, one Greptile review and human
CODEOWNER approval. No third chat PR, live deployment or new image asset.

### Prior checkpoint — September 9, 22:27 UTC

The landing lane composed only the seven-file resource-audit and Discord-copy
delta onto the qualified 2148 head. Application source is frozen at
`3afad5f3e42810bc433b5337c2063c3bc88d7001`. The successor changes **388 files**:
two existing foundation files now have a real copy/test change. The newer
landing fixes, official lock, runner artifact and UI remain unchanged. The
root feature checkout and Live83 were not changed by this composition.

Fresh full integration passes **995/995**, with no skips or retries, in
289.48s total / 280.58s tests. The retained database is
`chat_close_receipt_20260909_full_resource_audit01`. Its read-only observer
recorded four ordinary lock waits and no `40P01` or observer errors. Source
hashes stayed unchanged. The composed native-command/runtime cohort passes
**100/100**; adapter and default-off route checks pass **82/82**; CI partition
checks pass **28/28**. Plain server typecheck and diff checks pass.

This is local successor qualification, not a fresh CI or review result.
Publish one update to existing #13038 to retain the two-chat-PR split. The
successor still needs exact-head required CI, Greptile 5/5 and actual human
CODEOWNER approval. The historical 2148 gates below cannot approve new bytes.
Neither follow-up is deployed to Live83; the new audit UI remains live-unqualified.

### Prior checkpoint — September 9, 22:16 UTC

Published integration PR #13038 at `2148ea2f…` has **386 files**. Fresh CI
`34407804049` completed successfully at 21:53 UTC: all **24 jobs** passed,
including the required verification and browser aggregates. The isolated chat
suite passes **985/985** in a 10m55s job; the slowest general shard completes
in 14m53s without changing the 20-minute job limits. Exact-head Greptile
completed **5/5** at 21:41 UTC. The PR is open and mergeable, but still needs
human CODEOWNER approval. Review requests are not approvals; no bypass or
self-approval is permitted. The published head remains unchanged while the
new follow-up below is developed locally.

The user's Telegram login enabled three real-client follow-ups:

- A one-second synthetic silent MP4 was sent through native Telegram, inspected
  by the **native Codex Luna** runner, and returned once as an attachment. The
  received source and current-run return binding both contain the exact 997
  bytes; the returned native video opens to the expected teal frame. The input
  client presents this silent MP4 as a GIF/animation, so this is not proof of
  every Telegram video/audio subtype. Click-to-file was **64.699s**, of which
  60.669s was agent execution; it was not a minute waiting in the chat queue.
- An explicit Board **Send to channel** of exactly 100,000 JavaScript characters
  published once in **1.195s** as a Markdown file. The actual downloaded file
  is 100,009 UTF-8 bytes and matches the saved source's complete SHA-256,
  including Unicode and beginning/middle/end markers. The provider reader was
  inspected, and no agent run was created. Publishing an already-existing
  comment is a separate live-unqualified API path, not silently substituted by
  sending another new comment.
- Telegram's real native Stop button was observed and clicked on a second
  bounded draft attempt. The permanent final still appeared: the endpoint's
  subsequent webhook arrived after publication. This does **not** qualify
  pre-final suppression, nor prove the exact callback kind from redacted logs.
  No artificial delay, deleted final, forged callback or third blind retry.

Discord's existing QA thread passed a real **status → channel disabled → private
denial → channel restored → status** journey. The original channel access was
restored and verified after reload; other channels, DMs and the linked owner
were unchanged. Both successful statuses privately identified the same CHA-43;
the denial created no task, run or publication. This is current destination
reach, not a role-revocation, provider-403 or in-flight race qualification.

That journey exposed two concrete follow-ups. Resource changes have no
actor-and-before/after activity history, despite their successful HTTP logs.
The generic denial also tells an already-linked owner to link their account.
A local atomic audit repair passes **13/13** focused integration checks: ten
new audit cases and three existing authorization/resource-revocation controls
on a fresh fixture database, with 972 cases not selected. The new real-route
regression genuinely failed before the repair. Exact actor and net before/after
state persist together; no-op retries create no audit, failed transactions
publish no event, and concurrent saves retain consistent history. Injected
lease-guard failures distinguish precommit rollback from a committed change
followed by an outer guard failure; they are not actual lease takeover proof.
Independent source review and final server typecheck pass. The fixed generic
denial now asks an operator to
check chat access without revealing the internal rejection reason; its real
discord.js boundary regression genuinely failed first, then **100/100** focused
native-command/runtime tests passed, repeated on the final local source.
Neither repair is deployed to Live83 or
included in the reviewed `2148ea2f…` yet. Preserve the current server and
credentials; transfer only the qualified follow-up diff to the landing lane.
If #13038 is still open, fold the repairs into it to retain the two-chat-PR
split, then run full composed integration, fresh CI and exact-head review.
The earlier 2148 CI/review cannot qualify changed successor bytes.

Teams still needs an eligible work tenant and bot installation. Telegram
native Stop suppression and the remaining media/permission variants remain
explicitly unqualified. The permanent log below records exact evidence and
limitations; these results are not a blanket production-readiness claim.

### Prior checkpoint — September 9, 21:34 UTC

Published integration head `ed1b6a6e…` remains **384 files**. Its fresh Greptile
review completed at 21:11 UTC with **4/5**, identifying the tracked lockfile's
missing `smol-toml` resolution. Official master `7cf9a377…` already contains the
CI-generated lock refresh. Private merge `672366e0…` adopts precisely that
official lock, with no other tree delta from ed1 and no PR three-dot lockfile
change. Actual `pnpm --frozen-lockfile --ignore-scripts` succeeds across all 36
workspaces with no regeneration or fallback. This was an existing dependency
stage, not a clean-room lifecycle installation.

CI run `34405038082` is **not green**: its last general-server shard exceeded
the unchanged 20-minute job limit during cleanup. Its test step finished with
**123 files / 2,972 tests passed**, plus five existing guards, in 1,144.21s;
the chat suite passes **985/985** with no observed `40P01`. All other jobs,
including all browser shards, types, release registry and workspace build,
are green. Neither root nor the landing owner cancelled the job. The landing
lane reproduced the missing duration measurement: the 985-case chat suite
received a 1,307ms median estimate instead of its observed 645,354ms serial
cost. One measured-weight entry makes the unchanged scheduler place it alone
on an existing shard. The complete 603-file general partition and separate
144-file serialized partition remain unchanged in coverage, with no deadline,
algorithm or workflow changes. A genuine missing-entry regression fails before
the fix; all **35/35** CI-script tests pass afterward, independently repeated
by root. The resulting successor is **386 files**. Observed-cost replay
predicts a longest shard of about 780s; that is an estimate, not a new CI pass.
Passing assertions do not override the failed required CI gate.

The user completed login to a separately staged, officially signed Telegram
Desktop **7.2.7**. Its actual native UI is open to the verified QA bot. The
original macOS Telegram app and its profile were not replaced or imported.
Native draft Stop still awaits a real click and authenticated receipt. Ordinary
agent replies generally edit the existing working message and do not take the
new-draft path. One real **Send to channel** action saved a 2,791-character
Board update on CHA-50 and published it once in 1.463s, with durable draft ID 3,
no new run, and unchanged task/conversation state. The native observer started
1.330s after publication had completed; it missed the opportunity and later
lost window access. This is **not** a Stop pass or evidence that the client
does not support Stop. No artificial stream delay, `/close`, or hidden provider
call was used. Native availability/synchronized observation needs a bounded
follow-up; the current gate remains explicitly unqualified.

The earlier local qualification below remains valid for its identified bytes.
The next head still needs fresh CI, exact-head Greptile 5/5 and actual human
CODEOWNER approval. Live83 is unchanged, and Teams work-tenant installation
remains unqualified.

### Completed local qualification — September 9, 21:05 UTC

The final process browser test now waits for the exact newly resumed child's
real retryable cancellation delivery before asserting zero notifications and
taking its screenshot. Two fresh-database runs pass **1/1** each (1.3m total
each), and root plus the landing owner independently inspected both clean final
screenshots. Final spec `4fa2eac8…` preserves the effective 120s test deadline,
actual status sweep and unrelated-run controls. The earlier passing assertions
with visible child toasts remain recorded as failed UX acceptance, not successes.

A separate controlled provider-effect reply settlement reproduces PostgreSQL
`40P01` with a duplicate admission waiting at the same unique-index INSERT seen
in CI. Endpoint-before-delivery lock ordering fixes that concrete cycle. Final
success, authentication failure and unavailable-resource branches pass **3/3**;
the broader unchanged-webhook/adjacent cohort passes **14/14**, with types and
independent review clear. Service `0a45a0c4…` and test `a3af6d99…` are frozen.
This is provider-effect reply settlement, not reaction cleanup. The original
ordinary-message CI trace still lacks its opposing SQL statement; matching a
reachable cycle does not prove that unrecorded attribution.

The related-master candidate is now clean `2175d352…`, based on `3b550c80…`
(#13108 and #13110), **384 files**. It preserves incoming provider completion,
trust/history and retained-close fences. A fresh private runner `9e87775a…`
and fake providers are built; focused Rust checks pass **9/9**, server executor
**313/313**, runtime/backend/driver **289/289**, UI **329/329**, and UI/server
types plus token gates pass. Additional focused release-gate checks pass **29/29**:
default-off hides chat while production GitHub tool setup stays available.
No wireframe images returned. Full transport passes **171/171** on the fresh
runner in 230.36s, followed by plain runner types; all requested local gates
are now green. The landing owner will append this final evidence and publish
one consolidated update, without changing the qualified production bytes.

Fresh full chat integration passes **985/985**, zero skips/retries, 421.61s,
on retained `chat_close_receipt_20260909_full_3b01`. The observer captured two
ordinary lock waits and no `40P01`; service/test hashes stayed unchanged.
This full pass does not identify the original CI opposing SQL retroactively.

The direct/remote usage edge is genuinely reproduced and repaired: same-run
recovery retains runDelta 40 instead of overwriting it with cumulative 140.
The final two-file repair passes its **77/77** focused cohort, types and review;
that cohort overlaps the broader driver tests rather than adding unique coverage.
No runnerd authority or live provider failure is inferred from the accounting bug.

No successor push or second chat merge is claimed. Fresh exact-head full CI,
Greptile 5/5 and actual human CODEOWNER approval remain required. Foundation
#13100 is already merged. Live83 and original protected artifacts are unchanged;
Teams work-tenant installation and Telegram native draft Stop remain unqualified.

### Safe retry routing and completed CI — September 9, 20:42 UTC

The safe status-routing correction passes **40/40** server recovery tests and
**72/72** UI tests, both typechecks and independent review. The strengthened
real-process browser journey passes **1/1** (59.9s total) on a fresh database;
both root and the landing owner inspected a clean final screenshot. An additional
exact final-generation retry observation is being added before that screenshot,
since the first run observed earlier-generation retries but ended before the
final resumed child's next retry delivery. Existing effective test timing stays
unchanged. These five files are locally committed by the landing owner; no push.

Full 892 CI completed at 20:34:41 with two failures: the known browser toast and
a separate real PostgreSQL `40P01` deadlock on a duplicate Slack webhook insert.
The latter is not the previously fixed reaction assertion race. Chat integration
is 981/982; the full server shard is 2,968 passed / one failed / five existing
guards. The opposing SQL statement was not retained in available CI artifacts.
A deterministic lock-interleaving regression and source audit are in progress;
no speculative lock change or retry-until-green qualification is being used.

All other independent jobs, including complete runner verification and the
workspace build, pass. The next update remains held for both fixes, final browser
evidence and a consolidated qualification note. Fresh successor-head CI and
Greptile 5/5 remain required. Live83 and the original protected artifacts are
unchanged; separate human CODEOWNER and Teams/Telegram live gates remain open.

### Uncached-child browser finding — September 9, 20:31 UTC

Both subsequent real-process browser runs pass the existing assertions but
their final rendered screenshots still show a child-run cancellation toast.
The root-only run is 1/1 (1.2m total); the combined known-history run is 1/1
(57.9s total). Neither is a clean UX acceptance result. Trace inspection shows
the child was never opened and had no per-issue linked-history request, so the
known-cache fixes cannot reconstruct its membership after live state clears.

The browser spec now asserts zero notifications at the final screenshot too,
with no relaxed assertion or deadline. A narrow server fix is underway to retain
the exact safe task association on retryable status deliveries, without exposing
provider output, errors or the complete run context. It will be covered by
redaction/retry tests and a mounted never-visited-child case, independently
reviewed, then run through the strengthened browser journey. The prior fixes
and 70-case proof below remain valid for their narrower known-history cases.

### Reproduced task-alias defects — September 9, 20:29 UTC

Integration #13038 head `89270d75fab79a7ffe6bda19e826fab26d4ec169`
has a fresh exact-head Greptile **5/5**, but its full CI is not green. Browser
shard 1 fails the real-process composer Stop journey: after successfully
stopping the subtree, a redundant parent-run cancellation notification appears.
The run is being allowed to finish so additional failures are not discarded.

This is a reproduced UI product defect, not another fixture timing repair.
The visible identifier route missed canonical UUID-keyed run history after
the first terminal event evicted live membership. A later retryable status
without `issueId` then appeared unrelated. An ordered mounted regression fails
with the same informational, bodyless toast. A second regression separately
reproduces the analogous descendant-history gap after its execution lock clears.

The frozen two-file correction reads exact run IDs through known root aliases
and current descendants only. It preserves notifications for unrelated runs,
explicit other-task events, background pages, and removed descendants. Final
production `9c3621eb…` / mounted test `9bd4fa6a…` pass **70/70** focused tests,
UI types, scoped formatting, diff checks, token gates and independent review.
The unchanged real-process browser journey is still being qualified against
the exact final patch; no browser success or successor-head CI is claimed yet.

Root is holding this documentation for one combined landing-owner update.
Fresh exact-head CI and Greptile 5/5 will be required for the successor, and
existing human CODEOWNER requests are not approvals. No original-worktree
rebase, live83 deployment, second chat merge, or resolution of the separate
Teams work-tenant / Telegram native draft Stop gaps is claimed.

### Latest-master reconciliation — September 9, 20:13 UTC

Master advanced to `5cb4f061dd185955255099ae95348b3d4a16d7c0` (#13109).
The landing lane preserved its provider-notice text/display and hidden
completion calls alongside our accepted-response-wake behavior. Composed
candidate `90e72524…` is clean and remains 379 changed files. Independent runner
and UI-boundary reviews found no recovery or publication-authority conflict.

The rebuilt private runner `895a20cd…` passes all three corrected ACK-loss
cases on the exact final test (20.34s), plus 11 Rust and 25 TypeScript
provider-event cases and runner types. The combined UI/response-wake/boundary
cohort passes **257/257** across five files; token gates are clean. The older
171-test result stays attributed to its older artifact, not this rebuild.
The reaction fixture remains qualified by its 32-case fresh-database pass.

The landing owner is appending this evidence for one consolidated PR update.
Fresh exact-head full CI and Greptile 5/5 remain required; no second chat merge
or human CODEOWNER approval is claimed. Original source/artifacts and live
server83 are unchanged. Teams work-tenant installation and Telegram native
draft Stop still require separate live qualification.

### Qualified CI fixture corrections — September 9, 20:07 UTC

Both CI-exposed fixture corrections are now qualified. The reaction race has
a genuine held-provider-call RED on a fresh database, including CI's later
mutated error output. The corrected test preserves that held boundary, proves
close publication finishes while removal is processing, then releases it and
waits for the exact durable action and original provider effect. The three
affected Telegram/Slack/Discord positives and adjacent close cases pass
**32/32** on a second fresh database (21.33s); types, diff checks and independent
review pass. Integration test SHA is `9bd5f108…`; service `b9ad5151…` is unchanged.

Together with the runner **171/171** and exact final **3/3** results below,
this is ready for the landing owner to compose one successor to 585. Only two
existing test files and qualification documentation have changed since that
head. Fresh full CI and exact-head Greptile 5/5 remain mandatory. No new live
deployment, completed human CODEOWNER review, or second chat merge is claimed.

### Additional completed-CI failure — September 9, 20:04 UTC

The complete 585 CI run revealed one additional failure in server shard 4:
Telegram close-owned progress checks a reaction-removal array before its
asynchronous owner finishes. The shard is 2,968 passed, one failed and five
existing skips; chat integration is 981/982. Publication intentionally schedules
non-critical reaction cleanup after committing the reply. A subsequent sweep
skips a fresh processing action, so awaiting that sweep is not a completion
barrier. The exact expected removal appears later in CI's error formatting.

The next push is held for a deterministic held-removal regression and an exact
durable-action completion wait. Independent adjacent review found the same
assumption in Slack and Discord close-working positives; other reviewed cases
already control scheduling correctly. No production change is established or
authorized merely to make these test assertions synchronous. The runner fix
below is complete and locally committed; none of these new changes is pushed.

### Qualified terminal-loss fixture — September 9, 20:01 UTC

The deterministic ACK-loss fixture is frozen and qualified: **171/171** actual
transport tests, including all 19 maintenance scenarios, pass in 227.68s against
the current-base staged runner `ea9b3abf…`. After normal formatting, the exact
final test `0792548d…` passes the three affected real-runner cases again in
20.24s. Types, diff checks and independent final review pass. The full-suite
source differs from the final source only in formatting; canonical formatter
output and independent comparison both verify that boundary. Production remains
`266dfb99…`; there are no deadline, epoch-limit or recovery-permission changes.

The landing owner is composing this one-test-file correction and the evidence
notes for one new head of #13038. Fresh CI and Greptile 5/5 will be required;
the failed 585 CI and successful 585 review below do not qualify that successor.
Existing human CODEOWNER requests remain, with no administrative bypass.
Live server83 and the original protected artifacts remain unchanged. Teams
work-tenant installation and Telegram native draft Stop remain unqualified.

### Fresh CI failure and causal reproduction — September 9, 19:55 UTC

Foundation #13100 is merged as `6abeb67334348dcb6fde2d591a27ffc7efc7118d`.
Integration #13038 head `585be75a2fe6380ec91ff3ddca44eec3896bfa8a` has
379 files, no wireframe images, and an exact-head Greptile **5/5** summary at
19:44:26 UTC. Its fresh CI is **not green**: Build reports 1,911 TypeScript
tests passed, two failed and three existing benchmark skips. Both failures
are the newly added terminal-ACK-loss fixture, whose guessed 20ms-per-save
delay did not actually establish the expected lost acknowledgment on CI.

Root reproduced both exact CI failures locally by removing only that fixture's
20ms delay in a process-scoped diagnostic preload: two failures in 18.44s,
including the same missing timeout diagnostic and unexpected legitimate proof.
No source bytes, real runner deadline, binary or live process changed. The
test lane is replacing timing guesses with an authenticated-wire interruption
armed at the exact durable suspend-result boundary. Independent source review
is clear; actual-runner qualification is pending. No production defect has
been established by these two CI failures. Original failed logs are retained.

The landing owner will publish only after the corrected fixture qualifies,
then require fresh exact-head CI and Greptile again. The current 585 review
does not qualify any successor. Existing CODEOWNER review requests remain;
no administrative merge bypass is permitted. Live server83 is healthy and
unchanged. Teams work-tenant installation and Telegram native draft Stop
remain unqualified.

### Completed local components — September 9, 19:38 UTC

The frozen post-foundation candidate `090cde514` is 379 changed files and has
completed all local check components. Full workspace build and types pass;
runner TypeScript passes **1,906 tests** with `VITEST_MAX_WORKERS=1`, plus 38
Node contracts and replay goldens. The 10 existing TypeScript skips are seven
Linux-only cases and three opt-in benchmarks. Full release Rust passes 533
top-level tests plus two executed subprocess-helper checks with explicit
`--test-threads=1`. Conformance (1), replay (11) and actual runner-to-HTTP
API-authority (870) checks also pass. These explicit local worker settings are
not claimed to match CI.

The original `check:all` attempts remain RED in the evidence. The first exposed
stale copied dependency bytes and macOS fixture path/port defects, now corrected
with causal regressions and no production integrity or deadline changes. The
next passed all TypeScript checks but hit the already-documented Rust lineage
test's five-second window under default parallel scheduling. Its saved state
shows two acknowledged polling batches and 255 of 300 descendants; the unchanged
case passes alone in 3.64s, including restoration and capacity assertions. All
Rust source is unchanged from merged master. The full serial Rust and remaining
checks completed separately after that halted chain; do not relabel the original
command as successful or claim the exact contention bottleneck was measured.

The landing owner will append this documentation and publish one consolidated
integration head. Fresh exact-head CI and Greptile 5/5 remain required before
the second chat merge. No wireframe images remain; the only new image assets
are three production connector icons. The original live server83 and its binary
remain unchanged. Teams work-tenant installation and Telegram native draft Stop
remain unqualified.

### Completed focused recovery work — September 9, 19:11 UTC

The terminal-backlog repair is now frozen and passes **19/19** real maintenance
cases (111.22s), **80/80** control-plane tests, package types and independent
review. Root repeated the unchanged holdSpawned fixture with the same extra
10ms per private control-plane fsync: **1/1**, 16.67s test time, with 525
instrumented fsyncs totaling about9.383s. No timeout or epoch limit changed.

The fix replays only the exact completed receipt of the same invocation's
previously proven retired runner. An explicit queued-processing drain prevents
old callbacks from writing state after that retirement. Reauthorization after
the retirement callback, including post-await abort/failure/deadline checks,
closes two separately reproduced authority gaps. Unknown ownership, initial
copied receipts, altered evidence and repeated ACK loss remain denied. This
repair is not installed in live server83; its original source/binary are intact.

The previous integration CI completed **982/982** chat integration tests and
all other jobs except the runner failure and its dependent verify gate. The
post-foundation composition passes workspace-wide types and **40/40** latest
master queue/batching tests. Those tests needed exact fixture-only cleanup of
runtime state and company skills left by a real process; strict cleanup now
preserves all assertions and the fixed company prefix. Intermediate cleanup
REDS are retained. The landing owner is composing these verified deltas onto
the actual merged base, then running full runner checks before a single remote
update and fresh exact-head review. No second PR merge is claimed.

Frozen runner source: transport `266dfb99…`, transport test `60adbfb4…`, core
`88cbe405…`, core test `f4779869…`. The earlier checkpoints below are historical,
not qualification of later source. Teams work-tenant installation and Telegram
native draft Stop remain unqualified.

## Foundation landing and reproduced failures — September 9, 18:55 UTC

Foundation PR #13100 merged at 18:49:13 UTC as
`6abeb67334348dcb6fde2d591a27ffc7efc7118d`: 143 files, current human approval,
required CI green, and Greptile's explicit 5/5 on exact head `1c3c34c9`.
The dashboard's targeted Re-review action successfully queued that review;
no review configuration or permissions were changed.

Integration PR #13038 remains open. Its pushed `ac71491df` composition was
393 files with no wireframe images, and default-off chat/GitHub tool behavior
passed an independent exact-file audit. GitHub automatically retargeted it to
master after the foundation squash, temporarily exposing 511 files and an
ancestry conflict. The landing agent owns rebasing the composed tree onto the
actual merged base, preserving upstream changes and restoring the bounded PR
diff before another review. Root must not push or rebase the original worktree.

Greptile's single ac714 notification finding was explicitly withdrawn at
18:48:57: retryable events carry `runId`, exact run membership precedes the
agent fallback, and the toast builder rejects events without a run ID.
The unchanged production code passes 53 notification tests including six new
mounted event-handler regressions; a fresh final-head review is still required.

Integration CI has a genuine runner RED: 1,897 passed, three failed, three
skipped. One retained-cleanup fixture timed out waiting for the exact terminal
receipt after a retained event backlog. Two later cases then correctly hit the
first case's intentionally sticky quarantine because they shared its domain.
Per-row fixture identity isolation has a causal RED-to-GREEN regression; no
global quarantine reset or deadline relaxation is permitted.

The primary timeout reproduces in an isolated physical test copy with unchanged
production/test source: the focused case passes normally and with zero-delay
instrumentation, but fails twice when only private fixture control-plane fsync
calls receive an extra 10ms. It retains a completed suspend's unacknowledged
receipt and event suffix. This proves storage-latency sensitivity, not the exact
CI host's bottleneck. A narrow TypeScript maintenance repair is in progress:
reconcile only a proven same-invocation completed terminal receipt without a
provider launch, preserving all authority, retirement, deadline and epoch
limits. It is not yet qualified or installed into live server83. All previous
chat/live results below remain valid for their stated source, not for this
upcoming runner repair. Teams work-tenant and Telegram native draft Stop remain
unqualified. The live server and original runner artifact remain untouched.

## Completed live pass — September 9, 18:35 UTC

Final root14 integration is **975/975**, no skips (422.95s), plus the unchanged
**43/43** browser pass and **82/82** focused/types gate. Server **83** is now
running from `0c7f29207` on loopback 3137 (PID 2295), with the qualified private
runner unchanged. Backup verified; no migrations applied. The audited pause,
restart and paused maintenance cycle preserved all four exact passive waits.

Actual Discord and Telegram closes replaced their owned working messages,
cleared reactions and suppressed the old runs' external finals; both runs
finished internally with zero authored comments. Fresh requests answered once:
Discord stayed on CHA-43; Telegram created CHA-50. Slack and GitHub short
requests also answered once. Short ingress-to-final times were 13.336–21.654s.
Every live83 run records native `codex_app_server` and execution-input model
`gpt-5.6-luna`.

This pass also achieved real local queue overlap in Slack and GitHub. Each
follow-up arrived while its first run was active, showed a durable queued
notice, started only after that run completed and answered once. The deliberate
700-word first turns took 56.743/91.234s; the queued short replies took
14.775/13.144s once started. GitHub's first final safely deferred once before
provider I/O when authorization was busy, then succeeded on attempt 2; no blind
unknown-delivery replay. All scoped publications/actions settled and reactions
cleared. Live receipts: `.paperclip-runtime/chat-adapters-live/live83-final-receipts.json`.

The landing agent owns the consolidated current-master candidate (393 files),
including the separate process-Stop fix qualified by 252 recovery tests and a
real-process browser pass. Root will hand off this evidence before its single
remote update. Foundation CI is green but fresh exact-head Greptile review is
still absent; no chat PR has been merged. Teams work-tenant installation and
Telegram native draft Stop remain unqualified. Earlier failures below are
preserved history, not the current final test result.

Full root13 completed **970/975** in 452.06s. The five failures are the older
provider-timestamp binding fixture's positive expectations after inserting a
bare published control, without its authorization or source receipt. That is
not sufficient proof under the new strict reader. The test lane is checking a
truthful correction without inventing a supported Teams native `/close` or
weakening provenance/current-authority negatives. No production change has
been justified by these five failures. Fresh root14 is being prepared;
server82 stays live until a full repeat is green.

The test-only correction passes **82/82**: the previous 71 cases plus all 11
provider-timestamp cases (60.99s total), with server types green. It explicitly
checks the absent authorization and keeps actual SDK clocks/markers and
ordinary no-control presentation intact. Test SHA `ddab3667…`; all production
hashes remain unchanged. Fresh root14 started at 18:20:15 UTC and is pending.

Final focused/adjacent qualification is **71/71** (43.01s total), plain server
types pass, and independent source review is clear. Both the confirmation-gap
and accepted-newline-control regressions are green without relaxing current
permissions, causal batch checks, or server admission chronology. The exact
SQL/JavaScript trim parity check also passes. Frozen production: helper
`ed01066a…`, service `836d899c…`, issues `65d79903…`; test `e17162c4…`.
Fresh full root13 and browser final10 started at 18:09:44/45 UTC. Browser
final10 completed **43/43**, zero retries, in 5.3 minutes against the unchanged
frozen source. Full root13's failed result is recorded above. Server82 remains
live; no server83 cutover yet.

New confirmation-gap regression reproduced after the frozen guard: a native
Discord message sent 1ms after its close command but first received after the
close confirmation is admitted correctly, yet the older presentation check
compares its provider time to confirmation time and withholds the reply. The
one-case `control-confirmation-gap-red01` is genuinely red; it is not covered by
the 64 green cases below. A shared read-only chronology proof is being extracted
for intake and presentation, with stricter complete published-control proof
required for affirmative presentation. All current source/run/batch/permission
and server-ingress-after-every-confirmation guards remain required. A known
control must never mask an unproven published control in that grant.
The shared implementation now passes **69/69** on fresh
`chat_control_chronology_shared_20260909_green02` (42.83s total), server types,
and independent source review. The original gap is green; a source actually
received before confirmation and mixed proven/unproven published controls are
still denied. An earlier 68/69 run failed solely while constructing an invalid
null issue ID; the corrected negative uses another real same-company issue.
A separate Teams native-thread `/close` probe did not reach this authorization
path because that text is not a supported native-thread control. No production
route relaxation is justified by that failed premise. The final newline case
proved an actual mismatch with PostgreSQL's space-only trim; the exact ECMAScript
whitespace set now preserves that accepted control.

Root12 finished **964/968** (452.85s), exactly the four already-corrected fixture
failures below and no additional failures. Browser final09 is **43/43** (5.8m,
zero retries) against production SHA `979be218…`. Root13 and browser final10
are now testing the final shared proof; the preceding results do not qualify
that newer source. Server82 remains live pending those gates.

New explicit-control intake defect reproduced after the green baseline: six
first-seen Slack/Telegram requests sent before a committed `/close` or `/new`
were admitted when first delivered afterward. Telegram same-second lower
message IDs are included. Two no-control delayed-backlog positives pass.
The narrow fix must reject crossing that explicit control before creating any
task/generation/comment/wake, preserve legitimate delayed backlog, use real
provider chronology (including Telegram sequence ties), and recheck under the
existing authoritative endpoint lock. Operator-confirmed control completion
also counts. A second agent is independently reviewing the proposed guard.
No arbitrary age cutoff, ordinary newer-message supersession or Stop policy
change is intended. Integration PR merge is held; foundation can proceed.
The 941-pass suite below is the pre-fix baseline, not qualification of new code.
The initial cohort is now 8/8 green. Expanded tests also cover operator-confirmed
completion without an outbound message ID, a control committed while old intake
waits before its endpoint transaction, missing provider-clock provenance, fresh
authenticated Slack slash controls, and preservation of already committed work.
Independent review caught two ordinary-history cases now fixed:
paused duplicate delivery redaction must not erase a completed control boundary,
and a Teams regional service URL change must not hide that boundary. Final
focused/adjacent qualification passes **64/64** on fresh
`chat_first_seen_control_20260909_final02` (48.10s total), with server types and
independent source review clear. The first 60/64 attempt is retained as red;
three fixtures lacked actual provider chronology and one incorrectly bypassed
publication FIFO. Their test-only corrections preserve those contracts.
Actual live82 Discord and Telegram control records also satisfy the new exact
history joins read-only. Full root12 (older test snapshot) and browser final09
are complete as recorded above; final root13 is prepared. No server-83 cutover yet.

Foundation #13100's exact-head required CI is green. Fresh Greptile review is
still absent after the bot's documented manual override was requested; an older
score is not a substitute. Integration CI found four warm-checkpoint test
assertions expecting `undefined` where an explicit recovery refusal returns
`null`. The landing lane's test-only correction passes 313/313 plus server types.
Its physically isolated composition with newer master UI passes the full
5,853-test UI suite (574 files, no skips, 67.28s), the focused 395-test affected
cohort and UI types, preserving upstream Stop behavior and our uncertain-send/
receipt guards. This preview excludes the in-flight intake guard.
These local corrections have not yet replaced the published integration head.
The composed-master browser run passed all 32 chat cases but failed the separate
upstream process-adapter Stop case. The process executor could incorrectly
commit success on SIGTERM before cancellation committed. Its narrowly scoped
settlement barrier now also covers graceful exit, failed Stop persistence, and
retrying a still-alive child after a failed Stop. The landing lane reports
29 focused tests plus types and independent review clear; its final full
recovery and real-process browser repeat remain pending. Two older full-file
failures came from fixture source/run timestamp ordering and are corrected
without weakening production source chronology. No native/live Stop proof is
implied by these process-adapter fixtures.

## Earlier live checkpoint — September 9, 17:26 UTC

Server **82** is running from `d3a648139`, ready at 17:09:36 UTC. The safe
pause/restart preserved four exact passive waits, with no new runs/comments/
wakes. The old CHA-40 Telegram link now opens the bot without rewriting its
stored URL. Actual Telegram and Discord active closes edited their exact
working message, cleared owned reactions, and suppressed old external finals
while runs finished internally. Fresh Telegram created CHA-48; fresh Discord
continued CHA-43; both answered once in roughly 16/22s ingress-to-final.

Slack's first source eventually arrived on normal retry 3, **7m36.484s late**,
then answered once in a 14.525s Luna run with exact eyes cleanup. A later
mention and unmentioned follow-up had already completed. All observed local
responses were 200; prior `http_error` attempts never reached the local proxy.
No blind replay or configuration change was needed, but the upstream cause
is still unproved. GitHub C/D were sent during overlapping provider-side work,
yet D took **54.296s** to reach the proxy and arrived after C finished. Both
answered once, but neither A/B nor C/D qualifies as a local queue-overlap pass.

The final full service repeat is **941/941**, zero skips, on fresh
`chat_snapshot_full_20260909_root11` (327.62s) at `bc70b12e9`. Earlier 934/941
and 940/941 runs remain documented as red; their test-only corrections preserve
the exact authorization and held-lock assertions. Runtime119, focused close32,
provider-date23, lock/adjacent11, experimental UI154 and full browser43 remain
their exact scoped green gates. No broad workspace pass is inferred.

Current published heads: foundation #13100 `1c3c34c9…` (**143 files**), then
integration #13038 `21d3f81f…` (**370 files**). Fresh required CI and exact-head
Greptile reviews remain pending. No chat merge is claimed. Teams work-tenant
installation and Telegram native draft Stop still lack live qualification.

Slack's optional Delayed Events remains off. Official documentation describes
hourly retries for 24 hours and admitting events more than two hours late, but
the current ordinary-message path has no general first-seen stale/superseded
source rejection. Endpoint/source deduplication and current permission checks
do not solve a never-before-received old prompt waking a newer task generation.
Before enabling it automatically, define and test a policy for unseen old
messages after newer work or `/new`, across restart, while preserving already
admitted work and exact-duplicate idempotency. No documented manifest field was
found; do not invent an API field or use a bot token for full app-config updates.
Enabling this option is not evidence that the missing Slack A would be recovered.

GitHub D's delay is now explained more precisely by provider records: the first
attempt was classified `failed to connect to host` (recorded code 502, empty
response), then Paperclip's existing scheduled recovery requested the successful
redelivery. The roughly 60-second detection cadence accounts for most of that
wait, not model execution. Faster failure recovery remains a performance followup
requiring actual App API-budget/backoff qualification; do not simply multiply
all polling traffic or claim a particular upstream emitted the recorded 502.

## Previous verification checkpoint — September 9, 17:09 UTC

Server 81 remains live while the next cutover is prepared. Final runtime/adapters
pass **119/119**, close-owned integration **32/32**, corrected provider-timestamp
fixtures and adjacent cases **23/23**, and full deterministic browser **43/43**
(6.2 minutes, zero retries). The latest full service repeat was **934/941**;
seven fixture failures are documented in the permanent log and corrected without
changing production behavior. A fresh final-source full repeat is next; do not
report the previous full run as passing.

Foundation PR #13100 now has **142 files** at `691ec3f92fb248c814f768a96fb43857d06bf784`.
Fresh CI and Greptile review were requested. Integration PR #13038 still needs
the final deltas and exact-head verification. Root does not push either branch.
The next live cutover must verify paused passive waits, the untouched CHA-40
legacy Telegram task link, and active-close progress/reaction retirement.

## Previous live checkpoint — September 9, 16:46 UTC

Server **81** loaded clean local `439e8472a`, ready at **16:15:43.931 UTC**,
with the same qualified private runner, a verified quiescent backup and no
migration or historical owner reset. Actual Discord close→fresh reopen now
returns its exact answer once (14.923s run) and clears eyes. Fresh GitHub
answers once (13.859s) and removes its exact bot-owned reaction. A new Discord
image/TXT round trip passed after reopening: accurate facts, actual image
viewer/document preview, byte-identical received versus prepared output
assets, 53.970s run; provider downloads were not independently hashed.
Fresh Slack after restart returned once in 12.285s, no old checklist or eyes.
Telegram's fresh post-close message started CHA-47, a new conversation generation,
and returned exactly `TG81-NEW-READY` once. Its run took 20.298s; durable provider
publication completed about 24s after the source message, not 20s end-to-end.

Remaining: the Telegram task-binding URL repair separately passed its real
route regression and types but awaits the next cutover. Maintenance pause
caused existing recovery to mark valid waiting tasks blocked; the narrow
durable-receipt fix passes 45/45 focused cases and awaits live deployment.
Registry replacement/shutdown races pass 112/112 runtime/adapter tests after
six genuine baseline failures. The four-file experimental visibility/tool-route
cohort passes 154/154. Closing an active Telegram conversation exposed a stale
working placeholder: a cross-provider cleanup fix passes its initial 35-case
cohort, and independent review is extending unknown-consumer guards before
the combined suite and next cutover. Telegram native draft Stop remains
unobserved, and Teams still needs a work-tenant/admin installation.

Two actual chat PRs now exist, in dependency order:
[foundation #13100](https://github.com/paperclipai/paperclip/pull/13100),
136 files at `29c48d25…`, then
[integration #13038](https://github.com/paperclipai/paperclip/pull/13038),
366 files at `f9250078…`. Checks and fresh reviews are pending; no merge is
claimed. Later live fixes must be included and exact-head gates renewed.

## Previous live checkpoint — September 9, 15:57 UTC

Server **80** is running from local `9531f6e38`, ready at **15:23:42 UTC**,
with the same qualified private native runner. Maya was resumed through the
audited Board API. The quiescent pre-80 database backup is retained (gzip
verified; restore not exercised); no migration, secret rotation, historical
owner reset, protected binary replacement, or root remote push occurred.

- Discord's refreshed native command menu shows “Close the current chat
  conversation.” A fresh actual `/paperclip close` produced a private receipt
  and a public terminal confirmation at 15:29:40.680. CHA-43's conversation
  became completed; no new run appeared before a fresh explicit follow-up.
  The old server-79 failed command remains visible as historical evidence.
- GitHub's retained rejected send now reconciles using its original key,
  persists the exact negative result through reload, and supports explicit
  correction without losing the message. A fresh copy of the synthetic
  152-byte TXT and a new send key produced one Board comment, one GitHub text
  comment and one authenticated task-link file fallback, each publication on
  its first attempt. The original attachment binding was not changed.
- A new GitHub mention naturally reopened the existing CHA-45 task, with a
  13.961-second Luna run and the exact requested response. A fresh private
  Board file request then passed in 28.039 seconds: correct facts, one private
  answer, task still in progress, no automatic successor or outbound leak
  more than 71 seconds later.
- **Discord defect, fix committed but not yet deployed:** a fresh message after close correctly reopens the
  same task and completes a 13.328-second run, but creates no working/final
  publication. The user sees only eyes. Exact fresh-source publication
  authorization is fixed in local `69710d5fd`: exact admitted batch,
  unchanged source, post-control provider chronology and current permissions
  are required. Fresh final command tests pass 36/36, server types pass, and
  two independent reviews are clear. Related 194/194 tests passed before a
  semantic-neutral candidate-dedup optimization. Real reply retest awaits cutover.
- Refresh exposed a duplicate private Board answer: the UI ignored persisted
  `createdByRunId` when no comment activity row existed. This is fixed and
  verified in the actual browser. A second fix refreshes canonical comments
  at terminal status; a fresh 15.854-second private reply appeared once with
  Copy/feedback controls without reload. A third, separately reproduced slow
  fetch race now retires the live activity tail when the settled answer exists.
  These are UI-only changes, with no external-presentation authority added.
- GitHub receipt-eye cleanup is under final qualification. Deadline-expiry
  and malformed-rate-limit-response regressions were caught and corrected
  before deployment. The live provider still runs the previous backend.
  Telegram draft Stop remains unqualified; Teams still needs an eligible work
  tenant/admin installation. None is covered by the preceding successes.

The latency audit attributes selected short native replies to 14–18 seconds
end to end, chiefly provider execution. The longer queued Slack reply waited
behind the preceding run. No model/effort or FIFO change is justified by that
sample; the permanent log records exact boundaries and a trace-label caveat.

## Latest full-suite result

At 16:07 UTC, combined source `19ebc99e7` passed **898/898** on fresh
`chat_snapshot_full_20260909_root08` (480.77s tests, 491.03s total), with
no failed or skipped cases. The full deterministic browser cohort passed
**43/43** on fresh `board_receipts_browser_20260909_final05` (6.1 minutes).
The focused UI cohort passes **324/324**, UI and plain server types pass,
and independent reviews are clear. The later timestamp-provenance hardening
for Teams/Telegram is not covered by this frozen run. Its final targeted
cohort separately passes **35/35** on a fresh database, with plain server
types passing; the other 874 cases were filtered. Raw provider timestamps
now require explicit provenance after a published close/new boundary, while
ordinary no-close admission is unchanged. Original protected binary and lockfile hashes
remain unchanged; the provider-connected backend is server 81.

Previous exact-source result:

At 15:22 UTC, fresh `chat_snapshot_full_20260909_root07` passed **866/866**
chat integration tests (246.33s tests, 254.40s total), including Discord command
compatibility and durable rejected-send receipts. The final passive Board-wait
slice passed **217/217** recovery tests, **94/94** adjacent tests and **23/23**
final focused cases, with independent review and server types clean. UI/page/
OpenAPI passed **148/148**; UI types and token gates passed. The complete
deterministic chat/Board browser run passed **43/43** on fresh
`board_receipts_browser_20260909_final04` without the first attempt's transient
formatter compile error. Provider calls in that browser run are fixtures;
live provider retests remain separate. This source was subsequently deployed
in server 80 as recorded above.

Earlier full-suite evidence:

Fresh `chat_snapshot_full_20260909_root06` passed **860/860** chat integration
tests (177.16s tests, 185.33s total), including the accumulated fixture and close
copy fixes through `02dc80d1e`. UI and shared TypeScript checks passed. Earlier
RED attempts remain preserved; this is one actual full run, not a sum of
focused results. The final recovery file, including the crash-window admission
marker, passed **194/194** on fresh `chat_close_recovery_20260909_full02`.
Adjacent pure tests passed 87/87, queue/batching 38/38, and an isolated PostgreSQL
repeat 19/19; plain server TypeScript passed. The prior combined adjacent run
timed out in embedded database setup before those 19 assertions and is retained
as a failed run.

At the earlier checkpoint, server **79** was live from `3f2387073`, ready at **14:42:46 UTC**, with the
qualified private runner artifact and rebuilt TypeScript. Maya was resumed
through the audited Board API. The quiescent database backup is retained;
historical quarantined owner state was not modified. Original closed CHA-41
has admitted no new runs since the cutover.

## Live 79 checkpoint — September 9, 15:09 UTC

- **Discord:** native question → Evening choice → follow-up free-text form →
  `Amber Lighthouse 79` answer all worked in the actual signed-in guild UI.
  Four runs took 12.7–15.8 seconds each. `/paperclip close` then hung after
  deferral: an older registered command description made the current receipt
  parser reject initialization, leaving the SDK without a callback. The fix
  passes 47 real-PostgreSQL composed tests, 76 focused helper/wire/parser tests
  and server types. It is **not yet deployed or live-retested**.
- **Slack:** five native Luna turns completed without duplicate messages.
  D/E genuinely overlapped; E queued for 43 seconds, began 485 ms after D
  finished, and both final responses replaced their own progress messages.
  Short replies took 13–16 seconds; 120–220-word replies took 32–60 seconds.
  Queue correctness is verified; model-response latency still needs work.
- **GitHub:** fresh issue #5 correctly reported the private TXT unavailable
  and supplied a working stable Paperclip task link. Uploading the exact
  152-byte file through the actual Board UI produced the correct fields.
  However, a passive `response_wake` triggered an unwanted continuation that
  marked CHA-45 done despite “keep open.” A durable passive Board-wait fix
  has genuine failing and passing joined tests; broader controls remain in
  progress. Nothing from the private Board conversation leaked to GitHub.
- **Explicit Send to channel:** selecting that already-bound file returned
  409 before publication, but the UI mislabeled it uncertain and offered an
  unchanged retry. Root is fixing request-scoped durable rejection recovery
  and attachment-cache invalidation. This send has **not succeeded** and has
  not been blindly retried.
- **Telegram:** fresh `/new` and a long reply completed, with overflow moved
  into a provider-delivered Markdown attachment. This did **not** test Stop:
  the native draft Stop applies to a new draft presentation, not cancellation
  of an agent run or replacement of an existing progress message.
- **Teams:** only the personal account is available; eligible work-tenant
  installation and admin approval remain an external qualification gap.

The two landing PRs are still separate from this running checkout. Base
`335b2ee52709afb3885d4d6ebb2a3ece4b5864d6` has fresh Greptile **5/5** and one
full runner result of **1,888 passed / 10 preexisting skipped**. Required CI,
full build/repository checks and top-PR reconciliation remain in progress.
Neither full-current-head landing completion nor all-provider acceptance is
claimed. The older checkpoints below describe historical state only.

## Latest verification checkpoint — September 9, 14:02 UTC

Maya remains paused; server 78 and its protected binary have not changed.
The close/new recovery defect now has two clean failing PostgreSQL regression
tests: both improperly enqueue one run despite the exact inbound source and
authorized, published task-control receipt. The fix is in progress. Preserve
fresh explicit Board work and bare-completed-conversation recovery; stop only
the causally proven closed external source and its automatic descendants.

- Board upload/uncertain-write fixes are committed locally as `ae21fd9e2`:
  350 focused unit tests and all 11 actual browser journeys passed on fresh
  isolated PostgreSQL. UI types and token gates passed. Both native and legacy
  composers were exercised. The accepted-but-response-lost case preserves the
  draft across reload, blocks blind retries, refreshes the actual conversation,
  and offers explicit local discard. It does not claim server idempotency or
  cross-tab atomicity. Previous failed tests and setup attempts are retained.
- Runner drain/late-semantic-result fixes are committed locally as `c76988f93`.
  The exact release binary passed 27 composed tests and strict codesign;
  source passed 227 serial tests. Release SHA256 is
  `6844f20ee4a5fb7f7963117263a384f520054b4bd1e0f812fc58a4f34808b503`.
  The earlier parallel 220/227 result remains a documented two-second
  maintenance-ACK deadline risk. No timeout or assertion was weakened.
- Full chat run03 again finished 859/860. The raw-webhook test passed unchanged;
  this time the competing Slack receipt-worker fixture's global lease-token
  counter observed three tokens instead of two. Its new barrier tracks each
  of the two workers' async call chains separately and still requires one
  unique lease token per worker, one provider lookup, and one durable attempt.
  The raw-webhook fixture now owns one ready loopback listener for both reads.
  Both focused tests passed on a fresh database; full run04 is in progress.

Update at 14:10 UTC: run04 finished 859/860, with both earlier fixture fixes
passing. A third Telegram first-page assumption failed in the unknown
subscription/restart test; it now uses the same bounded first-attempt helper.
The Telegram draft Stop group passed 34/34. `e67df56fa` commits the other fixture
fixes and accurate close/conversation copy (62 focused units, six PostgreSQL
control tests, token gates passed). The causal recovery fix remains separate
and is not deployed or complete.

These are local qualification results, not deployed provider acceptance or
full-current-head landing verification. James owns the separate landing lane.

## Earlier safety checkpoint — September 9, 13:52 UTC

Maya E2E (`31f56712-3944-423e-b7c7-404bb8fbb993`) is **paused** through the
audited Board pause API; the last read confirms no queued/running agent runs.
This deliberately stops all new live provider runs while the close/recovery
bug below is fixed. Server 78, its loaded source, and the protected runner
binary remain unchanged. Do not resume the agent merely to repeat a passing
text test. Preserve the failed guild form and historical quarantined epochs.

Discord DM CHA-41 passed fresh new/status and true FIFO A/B/C. C began 102ms
after B finished; all three responses updated their own single bot message.
However, `/paperclip close` only completed the external conversation. It
confirmed “This task is closed” while the Paperclip task remained in progress.
Generic productive-run recovery immediately restarted that task, lost its
external-chat wait context, and began a roughly 30-second response-wake loop.
The pause contains the loop, not fixes it. Epicurus is taking the source-bound
close/recovery regression after finishing Board attachment qualification.
Clawd's temporary Direct Messages setting was restored to **off**; activity
sharing and joining settings were left unchanged. No additional login needed.

Post-snapshot Board work now preserves uploads and uncertain comment writes
across reload in both composers, blocks blind retries, offers real conversation
refresh and explicit local-draft discard, and permits removing failed/pending
legacy uploads. It has 350 focused unit passes and clean UI types/token gates.
Final 11-journey browser qualification is still pending: one prior observer
was incorrect and two fresh embedded PostgreSQL initializations failed before
the app started. Use a fresh isolated database on local PostgreSQL for the
final rerun; do not call those setup failures browser passes.

Boole's exact-source runner/control-plane cohort is 227/227 with file-level
parallelism disabled. The concurrent attempt was 220/227, exposing a legacy
2-second maintenance ACK deadline under load and its fail-closed quarantine
behavior; retain that risk. An isolated release binary is built, but composed
qualification is still running. No live cutover yet.

Landing runs independently: base PR #13092 has 45 files. Exact-current-head
reviews/checks are not yet complete. Upstream PRP-v2 composition exposed real
warm-authentication and state-retention issues; James is fixing them. The
second PR will reuse #13038. Neither may merge based on historical scores.
Root committed the bounded Telegram test corrections as `5232fb22b`; focused
23/23 passed, full chat run02 was 859/860 (one raw-webhook socket hangup), and
an unchanged fresh full run03 is in progress. No full-repository green claim.

## Earlier live checkpoint — September 9, 13:12 UTC

This section supersedes the older locked-Mac and 290-run checkpoint below.
The Mac is unlocked and Eigenjoy's Discord login is restored. Root is using
the signed-in in-app browser; server 78 is still loaded at `ea528f44c`.
Do not ask for Discord login again unless the actual provider page requires it.

- Slack fresh thread `1788957912.689909` is CHA-37. Text A/B/C passed, with C
  genuinely queued behind B; C started 54 ms after B finished. Source-to-final
  times were 29.147s / 17.914s / 23.945s. Fresh PNG and TXT returned as actual
  visible attachments, with correct image description and text facts. Returned
  bytes match Slack's stored source bytes; Slack had changed the PNG bytes
  before ingestion, so this is not an exact-local-PNG claim. Both files were
  delivered by 66.789s, including 56.099s native execution. Root clicked the
  actual native Stop on a later deliberate long response; UI changed to
  “stopped at your request” and cleared the working state/reaction. A new
  follow-up returned `SLACK78-RESUMED`. The exact cancellation audit confirms
  only the selected run was cancelled, 157ms after the durable Stop action;
  its receipt cleared and the successor succeeded independently.
- Discord fresh thread `1547228059797561475` is CHA-39. A replied successfully
  in 13.782s from ingestion. Registered status/new/close appear in the native
  picker. Status and guild-new guidance were invoked and visibly private
  (“Only you can see this”); status caused no run or public publication.
  Fresh PNG/TXT returned with usable image and document previews and correct
  source facts. Actual Morning/Evening buttons worked: choosing Evening
  updated the card and returned `Evening DISCORD78-CHOICE`. The next native
  free-text form failed before presentation: run `4e200a4d…` exhausted resume
  retries because the prior question's completed semantic result event had
  not drained before suspension. Boole owns the causal Rust/transport fix and
  isolated tests; never discard the old event or stage an unqualified binary.
  DM-new and bound-thread close remain open.
- Telegram actual `/new` completed generation 10 without replaying its failed
  work. Fresh generation 11 is CHA-40; A returned in 21.388s from ingestion.
  A new photo and a separate TXT follow-up returned actual media/documents
  and correct facts. The second delivery arrived after the first run ended,
  so this is not a loaded FIFO test. Telegram recompressed the input photo;
  compare against received JPEG bytes, not the original local PNG. Root saw
  a remaining eyes reaction after the document final. Cleanup fix `9afdf3232`
  is committed/pushed with 20/20 focused tests and plain server types, but is
  not deployed. It includes final/add/restart/generation/retry fences and skips
  eyes for command-only acknowledgements. A real synthetic Board publication
  completed before a native draft Stop could be observed: mark that race
  unobserved, not passed.
- GitHub disposable issue 4 maps to CHA-38. A and unmentioned B passed in
  19.538s and 18.926s from source time. The fresh unavailable-file response
  contradicted its own appended task link. Minimal native guidance repair
  `d399d7a41` is committed/pushed, with 58/58 focused tests and plain server
  types; it is **not yet deployed or live-retested**. Root clicked the actual
  task link, reached the correct company/task, and uploaded the fresh 152-byte
  TXT through its chooser. Scoped stored bytes match the original SHA256.
  However, the subsequent internal Board run could not read the attachment;
  an unnecessary continuation then repeated the old root marker and marked
  the task Done despite the keep-open request. Internal text did not leak to
  GitHub. Epicurus is implementing explicit uploaded IDs through the UI into
  atomic comment binding (including reassignment). James is implementing the
  no-speculative-continuation rule and a transactionally current-source-fenced
  legacy recovery guard. Both have genuine RED and focused GREEN evidence;
  final combined verification and live repetition remain open.
- Teams still needs an eligible Microsoft 365 work/school tenant/admin path.
  Personal Teams login and deterministic fixtures do not qualify it live.

Next: fix the two concrete Board/native failures, deploy coherently only after
active work drains, repeat the entire GitHub fallback, and finish current
Discord/TG interactions and media/Stop evidence. Preserve historical failed
recovery records; fresh successful tasks do not establish their recovery.

## Goal and working boundaries

Finish production-quality Slack, GitHub, Microsoft Teams and Telegram chat,
plus the user's explicitly added Discord connector. Test real conversations,
files/images, interactions, races, queues, reactions, retries and the quality
of the experience. External chat is transport; Paperclip owns tasks, runs,
permissions and audit. Do not narrow completion to whichever tests pass.

- Live stress work stays in `/Users/dotta/paperclipai/branches/chat-adapters`,
  branch `codex/chat-adapters`. Preserve user changes and protected runtime.
  The user explicitly authorized a separate landing worktree on September 9;
  this supersedes the earlier no-new-worktree/no-PR-tending restrictions for
  that lane. See [the immutable snapshot and landing boundary](2026-09-09-stacked-landing-checkpoint.md).
- James owns the separate landing checkout and remote PR heads: exactly two
  coherent stacked PRs under 500 files, fresh exact-head Greptile 5/5 and
  required verification, then authorized merges in dependency order. Root must
  not push the original development branch over those heads. The wireframe
  images have already been removed; do not recreate them.
- Root owns the live server, runner cutover and signed-in browser. Parallel
  agents continue post-snapshot hardening. After both merges, reconcile ongoing
  development with master and open a separate remaining-hardening PR.
- No filesystem/command approval requests. Only real login, MFA, CAPTCHA,
  tenant/admin or unavailable-secret gates need the user.
- Use the signed-in in-app browser for live provider accounts. A mocked browser
  or successful API response does not establish a good live experience.
- Never export raw reasoning, tool arguments, private logs, credentials or
  private source-file URLs. Never replay `delivery_unknown` without its
  explicit audited resolution.
- One endpoint is one provider bot identity bound to one immutable agent;
  one external thread maps to one task. Recheck current source, reach,
  generation, identity and permissions at every consequential boundary.
- Use a fresh PostgreSQL fixture database for each full integration rerun.
  Never use a test to repair live records or manufacture recovery authority.

## Current deployment

Implementation `ea528f44c` is pushed and deployed, including Slack rendered
stream bounds/partial-delivery safety (`977d9923f`), durable Telegram private
draft Stop (`8de18acf6`) and its confirmed-subscription gate. It retains earlier
rich input, private callbacks, source-bound media and native recovery repairs.
Server **78** is running. Automatic Telegram subscription maintenance succeeded
on its first live attempt, committing the exact current subscription receipt
at `09:18:29.075 UTC` without reconnect, token rotation or dropping queued
updates. This proves the managed provider upgrade, not the native client Stop
walkthrough. The final fresh combined regression passes after four test-harness
failures were diagnosed and repaired.

| Field                 | Verified value                                                          |
| --------------------- | ----------------------------------------------------------------------- |
| PID / tool handle     | `49120` / `63670`                                                       |
| Listener              | `127.0.0.1:3137`                                                        |
| Loaded server version | `2026.831.0+623.git.ea528f44c`                                          |
| Process start / ready | `09:18:24` / `09:18:30.541 UTC`, September 9                            |
| Native runner SHA256  | `6279d39ac731e4565a638b64c93673b8ca23e6dfbc0870e24d48422497f1826d`      |
| Live DB               | `chat_adapters_live_3103` on local PostgreSQL `55439`, role `paperclip` |
| Last checked runs     | 290 terminal: 262 succeeded, 26 failed, 2 cancelled; zero active        |
| Last new run          | September 9, `02:15:47.812 UTC`                                         |

Both loopback and private Tailscale health returned 200/ready. Public Funnel's
Board-health GET remains 404. Discord Gateway reconnected bot
`1546330979860221952`. Automatic registration committed a processed/registered
receipt for command `1547131713472430131` at `06:29:05.036 UTC`; the active
endpoint now has both slash-command and ephemeral-message capability. This
proves live provider registration, not invocation or private-response UX.
The health response's Git commit is dynamic; use loaded version and process
start to identify deployed code. Server 78 loaded a clean committed checkout.

Server 77 exited cleanly at `09:17:58 UTC` after a fresh zero-active-run check
at `09:17:51.382`; graceful drain interrupted zero runs. Its private stopped-DB
backup is `pre-78-backup.3Vhbek/pre-server-78-20260909-041811.sql.gz`
(8,876,485 bytes, directory 0700/file 0600, gzip verified, restore untested,
zero pruned). No migration was pending or applied; journal 258 remains current.
At `09:18:33.627`, all four original endpoints remained active and the run
inventory remained 290 terminal/zero active. The Telegram worker's successful
receipt was checked against current company, bot, generation, credential
fingerprint and managed callback URL hash, without printing secret values.
The actual browser controller still reports the Mac locked after deployment.

Earlier, server 76 exited cleanly after a fresh zero-active-run check at
`08:46:53.650 UTC`; graceful drain interrupted zero runs. Its stopped database
was backed up to private
`pre-77-backup.RfChxI/pre-server-77-20260909-034715.sql.gz`
(8,720,075 bytes; directory 0700/file 0600; gzip integrity passed; restore not
tested; no backup pruned). Migration 0259 applied successfully; journal count
258, up to date. Cutover was held while root's late-found Telegram subscription
gap received seven genuine RED/20 focused GREEN checks and independent review.
No credentials or historical recovery records were rewritten.
At `08:56:34.067 UTC`, the run inventory remained 290 terminal, zero active,
and the original Discord/GitHub/Slack/Telegram endpoints remained active.
The qualified runner and lockfile SHA256 values are unchanged.

Private Board: `https://dottas-macbook-pro.tail29c1aa.ts.net`.
Public webhook-only proxy: port `3104` → `3137`; Funnel uses stable port
`8443` (also existing `10000`). Do not expose the Board or files publicly.
Port **3103 belongs to another checkout** and must not be touched.

Passive rejection diagnostics are committed/pushed as `6c5e9c215`. After
verifying zero active proxy connections, root replaced proxy PID 48112 with
PID **27961**, handle **3313**. Log: `webhook-proxy-rejections-0909.log`.
A non-mutating GET through public Funnel at 03:51:14 UTC returned the expected
404 and exactly one closed-label method-rejection record. This proves proxy
deployment/rejection visibility, not provider message delivery. Server 69 was
not restarted during this proxy-only change.

All local runtime material is under ignored
`.paperclip-runtime/chat-adapters-live/`, including:

- `start-server.sh`: configured isolated startup, no embedded credentials.
- `server-experimental-landing-78.log`: current server log.
- `pre-server-78-backup-0909.log`: private backup/schema metadata.
- `server-78-state-0909.log`: scoped health/current-receipt verification.
- `qualified-runnerd-2400740c`: preserved old qualified runner backup.
- `home/instances/chat-adapters-live/runtime/paperclip-runner/durable-sessions`:
  live native roots; do not manipulate historical evidence.

**Build caution:** server `pnpm typecheck` invokes a full runner build and
stages the binary. For source checks use an explicit package TS-only build,
then `pnpm exec tsc --noEmit` from `server/`. Root briefly triggered that
side effect, restored exact signed `2400740c…`, and audited no new live runs;
the later `6279d39a…` cutover was deliberate after qualification. Do not
describe the normal binary as continuously unchanged across that earlier check.

## Immediate next actions

1. **Resume real browser qualification on server 78.** Latest actual browser
   inventory reports **Mac locked**; the user has been asked to unlock it.
   Discord login was restored before the lock. Do not request Discord login
   again unless the actual provider page requires it.
2. Run Discord native-command checklist DC4a, including private status, DM new,
   guild new guidance and bound-thread close. Then repeat same-thread
   Discord/Slack conversations, queueing and two-file output
   on this deployment. Check transitions, failure copy, final placement,
   reaction cleanup, duplicates and usable returned files, not just final text.
3. On GitHub, exercise the deployed unavailable-file fallback, click its task
   link, and upload the file on that task. Check the correct company, immediate
   chooser readiness and actual usable upload. This complete live journey is
   still unverified; deterministic cases already pass.
4. Continue the remaining browser-runbook permutations. Do not merge or edit
   the disposable GitHub repository while using its PR comments for chat QA.
5. Teams requires an eligible Microsoft 365 work/school tenant and authorized
   Entra/Azure Bot/custom-app setup. Personal Teams login is insufficient.
   Its deterministic tests are not tenant-qualified live proof.
6. Preserve the historical recovery boundaries below. A new conversation can
   qualify new work, but cannot be presented as successful recovery of the
   original failed request.
7. Live-retest the deployed Telegram photo/document boundary and Discord
   normalized interaction denial. Code and deterministic regressions are
   complete; they are not newly qualified live provider journeys.

## Current parallel work and audit conclusions

**Current additional work:** James's Slack rendered-paragraph repair is frozen
and independently reviewed. Root staged the exact candidate in this checkout's
installed adapter; default-import regression passes 192/192. It is deployed on
server 78 but still lacks the new live-provider UI walkthrough. The repair
bounds post-mention-resolution payloads including the SDK's pending buffer,
validates coherent native receipts and prevents fallback after ambiguous or
partial delivery. Boole's Telegram Stop implementation is also frozen and
independently reviewed: it stops the exact private draft presentation, never
the current task/run. Durable ownership, final-send arbitration and a
non-reusing instance sequence are covered by the new tests. Root's fresh
combined repeat passes **825/825** integration, **31/31** deterministic browser
and **348/348** helper/runtime tests. DB/shared/server/UI plain types pass.
Migration 0259 and both fixes are deployed on server 77. The follow-up
subscription gate passes 20/20 and keeps old Telegram endpoints on ordinary
replies until automatic upgrade is verified. The automatic maintenance slice
has three genuine RED restart cases, then 34/34 focused integration and 38/38
helper/Stop checks plus plain server types. It preserves the existing managed
URL, secret, subscriptions, connection limit and queued updates. It requires
strict SET acknowledgement and independent actual-setting readback before
recording current authority. Retryable failures are durably backed off; unsafe
configuration is refused. Both keep normal final replies available.
Same-endpoint lease contention is bounded, not a claim
of zero reply delay. Root's first combined repeat passes 31/31 deterministic
browser cases, 367/367 helper/runtime checks and plain server types, but full
integration is **842 passed / 4 failed**. The three restart targets were beyond
the scanner's first 25-row page; their tests incorrectly assumed a single
global page. The Teams API test's automatic-listener harness reproduced
pre-Express connection resets without provider/DB code. Explicit awaited
listen/close ownership passed a 10,000-request probe; the original failure's
exact kernel cause was not observed. Narrow test-only repairs now pass the
fresh **846/846** combined repeat in 157.43 seconds. Production service code
was unchanged during that repair. The final targeted Telegram paging repeat
passes 34/34 and Teams projection 26/26, with plain types green. Server 78 is
now deployed and the original Telegram subscription upgraded successfully on
its first attempt. Actual native Stop/button presentation and the new Discord
UI walkthrough remain unverified because the Mac is locked.
Root repaired the server's release bundle
manifest so all five adapter patches and the Discord transport patch ship to
npm consumers. Packaging contracts pass 22/22. The earlier isolated helper
stage at patch snapshot `1a0a77025` was not a full server install. A new stage
at source `d5b154e1c7` freshly compiled all 17 runtime packages, applied the real
production bundle helper, packed and installed local tarballs with npm 10.9.7,
and verified all 21 patched files. All Paperclip sibling registry probes were
rejected; installed siblings resolve to the exact local tarballs and module
imports remain inside the consumer. Compiled-server imports and synthetic
Slack stream/Telegram Stop transport pass. The retained qualified runner was
copied, not rebuilt. Root's separate **31/31** packaged static-UI checks pass
in **2.0 minutes** on a fresh isolated database, with served HTML, service
worker and main JS byte hashes matching the artifact. These tests mock the
chat-control-plane API routes; they exercise real unmocked bootstrap/company/
agent/catalog paths and current packaged UI, not a chat-backend/provider
round trip. This is a local macOS consumer
check, not published-CLI, native cross-platform or CI-owned frozen-lockfile
release provenance; those release boundaries remain open.

### Earlier qualification checkpoints — historical, not current work

The intermediate checkpoints below are superseded by the current deployment
and immediate actions above. Their old pending/unfixed labels describe their
original tested revisions, not server 78. Current provider evidence resumes
under **Latest provider evidence — scope matters**.

**Earlier qualified checkpoint:** the restored Discord login was not the gate:
the in-app browser tool still reports that the Mac is locked. Read-only health
confirms server 76 is ready and the original four configured endpoints remain
active; that is not a new live conversation. Slack receipt contention/cleanup
and Telegram optional-MIME/Live Photo repairs are now frozen and independently
reviewed. Slack's final joined repeat passes 10/10, and Telegram's repaired
configured-2-MiB cohort passes 22/22. After diagnosing three test-only failures,
root's fresh combined regression passes **770/770** integration tests in
149.26 seconds, **31/31** deterministic browser tests and **127/127** final
helper/runtime checks. Shared/server/UI plain types and targeted formatting
pass. These repairs are deployed on server 75 but are not live-provider proof.

Root corrected stale Teams file guidance: personal chats ask for file consent,
while channels/groups can receive supported images directly. The old universal
consent wording failed the updated regression before the fix. The full composer
component suite passes 27/27; two deterministic file-consent browser cases pass
on fresh `chat_teams_guidance_browser_20260909_root01` in 14.1 seconds. Root
inspected the rendered guidance screenshot; it fits without clipping. Provider
publication is simulated in those tests. Token gates and targeted formatting
pass. This does not qualify live Teams or the deployed Slack/Telegram repairs.

**In-progress provider-version work:** the [current Telegram Bot API contract](https://core.telegram.org/bots/api#recent-changes)
includes changes absent from the pinned adapter. A bounded read-only audit
confirmed rich Markdown output and private drafts already work; do not list
those as missing. Actual pinned-parser probes found three separate gaps:

- API 10.3 `expandable_blockquote` and rich `document` input disappeared,
  including a quotation beside a supported paragraph. Boole's inbound-only
  normalizer now passes the three original parser/service failures plus seven
  mixed-file/restart/topic/edit/revocation/dedup cases. It is independently
  reviewed; the fresh broader compatibility repeat passes 32/32. Unsupported or
  malformed content receives an explicit omission. Draft-only thinking and
  private button capabilities are never projected.
- James completed callback-only native ephemeral denial notices. The
  actual pinned runtime now rejects ephemeral messages/commands from ordinary
  `chat:0` admission and captures authenticated, recipient-bound callback
  provenance. Service-entry deadline, deduplication, current-authority and
  no-public-fallback regressions pass, including preserved exact-actor DM
  notices. The final Telegram cohort passes 154/154, helper/runtime 51/51 and
  plain server types. Private commands remain off.
- On server 76, native generation-stop updates are neither subscribed nor
  dispatched and draft IDs are process-local. The frozen successor now binds
  exact presentation authority durably and uses a noncycling sequence that
  survives rollback and endpoint/company deletion. The new TG4a runbook still
  requires live native-button qualification; deterministic Stop races pass.

Rich input and private callback fixes are committed/pushed as `b9802d9e4` and
deployed on server 76. Final recovery review found that **old queued Telegram
`chat:0` input** could bypass the new ingress guard when rehydrated with `raw: {}`;
an already-processed delivery with a pending wake also bypassed hydration.
Boole completed fixed-reason retained-source filtering and an independent
wakeup-authority guard, with positive-ID/legacy controls and no history
rewrites. Root reproduced a PostgreSQL microsecond timestamp CAS failure in
the initial filter. The repaired path locks and revalidates the current row,
and settles work only after a confirmed filter commit. Held claims and a
concurrently replaced positive source remain protected. The fresh final
cohort passes 47/47, including 15 recovery cases and 32 adjacent rich/media
cases; plain server types and independent review pass. Root's combined
helper/runtime suite passes 298/298. Full integration passes **812/812** on
fresh `chat_private_rich_full_20260909_root01` in 185.47 seconds; deterministic
browser checks pass **31/31** on separate fresh
`chat_private_rich_browser_20260909_root01` in 2.8 minutes. Shared/server/UI
plain types pass. Recovery fencing is committed/pushed as `52a46cbf6` and
deployed on server 76. These are not new live-provider conversations.
Native generation-stop is deployed behind the confirmed-subscription gate. Preserve recipient/source
authority and never expose raw model thinking merely because a provider
offers a thinking block.

**Ready-output latency repair (`a5ac8c7cc`, pushed, deployed on server 76):** completed, approved
publication text no longer needs simulated 75-ms generation pauses. Ordinary
text uses bounded 2,000-code-point batches; `@`/`&` content retains the prior
280-code-point batch because Slack resolves cached mentions after rendering.
Review reproduced a 12,974-character native chunk with a larger mention batch;
the conservative guard keeps that case within the provider limit. The separate
preexisting case of one unbroken paragraph expanding past the native limit
still needs a provider-rendered boundary fix. Do not mistake this small output
latency improvement for explaining the historical pre-ingress minute delays.
The six-file focused repeat passes 161/161 and the real-service safe-projection
case passes; provider pacing/final-receipt paths remain intact. No live UX claim.
James independently reproduced the remaining defect with the real pinned
adapter and a normal cached Slack user ID: a 2,704-character unbroken paragraph
became one 13,504-character native chunk. A strict local transport accepted a
prefix, then rejected the oversized chunk without a final receipt. The next
fix belongs after mention resolution in the adapter flush, including the
Web API's pending buffer; reducing source chunks cannot fix paragraph buffering.
Do not claim this case repaired or live-qualified.

**Local database interruption:** PostgreSQL logged backend PID 23977 killed by
SIGKILL at `07:49:34.230 UTC`, then recovered automatically and accepted
connections at `07:50:13.305`. The source of that signal is unproved. The rich
final-01 run failed during fixture seeding (32/32), not behavior assertions;
retain its log and use a new fixture database. At `07:51:06.576`, root verified
`pg_is_in_recovery = false`, server 75 healthy and the same 290 terminal runs,
zero active. No database reset, server restart or historical replay was used.

**Deployed in `cfbda24be` on server 74:** a bounded parallel acceptance
audit found two gaps beyond the browser lock. Explicit Board publication accepted
100,000 characters but the shared projector silently kept only 40,000. Four
real-service Slack/GitHub new/existing-comment cases reproduced the missing
tail; the frozen lossless transport now passes 19 joined cases and 47 helper
tests, including native-result, Unicode/rich-text, unknown-part and restart
coverage. Its first follow-up also exposed children sorting before a
database-timestamped root because JavaScript loses PostgreSQL microseconds;
children now preserve the root's exact database timestamp. A tiny-paragraph
CPU adversary improved from 6.1 seconds to under one second locally. Independent
boundary review found no remaining blocker; live rendering remains unqualified.

Teams channel/group pictures were incorrectly treated like arbitrary files,
both outbound and on intake. Root's two outbound cases reproduced zero native
images; the current thirteen-case service cohort passes, including actual
pinned SDK HTTP serialization, 100k text plus PNG ordering, malformed/large
fallback, source/reach withdrawal and unknown/missing receipts with no resend.
The bounded PNG/JPEG/static-GIF helper and pinned App HTTP tests pass in a
195-case adjacent cohort. The two pinned-parser-to-service intake RED cases
now pass in a 21-case intake/reference cohort, including deferred restart,
revocation, and pending source edits/deletes during download. Its 84-case
helper/runtime cohort also proves a deadline around the actual SDK's token
acquisition; late token release issues no HTTP. The new image lane shares one
10-second token/download budget, with no later request after expiry. This is
not a deadline or cancellation claim for DB/storage commits. Final root checks
pass 749/749 full integration tests (177.75 seconds), 31/31 deterministic
browser tests (2.9 minutes) on separate fresh databases, 163/163 helper/runtime
tests, shared/server/UI types, 85 UI tests and eight OpenAPI checks. No
eligible Teams tenant or live picture journey is claimed. Personal-file consent
and historical recovery evidence stay unchanged. The runbook now explicitly
requires experimental visibility checks and actual native Runner/Luna evidence.

**Current Teams composition (`693cfa888`, included in deployed `b9461c4a6`):**
Teams personal-file output is now wired to
the real service: source-derived recipient authority, atomic Board intent,
authenticated callback, staged worker, public receipt projection and audited
stage/version resolution. Server 73 includes its schema and runtime activation;
eligible-tenant live qualification remains blocked. A native committed-response
digest-format mismatch and a cold Board-send runtime initialization bug were
reproduced and fixed. Focused Board
and native-source suites pass 12/12 and 8/8. After fixing two scheduling
regressions caught by the first full run, the corrected full integration suite
passes 690/690 on a fresh database (134.68 seconds). The browser suite passes
31/31 with simulated provider/model ports; the final consent-copy rerun passes
2/2. Root inspected the waiting/mixed
receipt screenshots and shortened the repeated pre-send explanation in a
retained receipt. This is not live Teams consent/file qualification.

Completed follow-up in `b9461c4a6`: the review reproduced a conflict-state
liveness gap where Activity offered no action although the protocol could safely cancel. A
read-only, exact-scoped proof now offers only cancellation after ownership is
cleared or coherently expired; the versioned resolver remains authoritative.
Fresh protocol/projection tests pass 90/90, composed tests 39/39 and existing
UI/API tests 84/84. The combined follow-up passes the full 711-case suite.

Discord automatic registration is now composed with configure, resume and
runtime reconciliation in deployed `b9461c4a6`. Five root service tests pass,
including a process-reconstructed unknown POST settled by GET without reposting,
automatic upgrade, an external namespace conflict, and healthy Gateway
preservation on optional registration failure. The native command handler
passes 15 cases, the durable ownership/helper cohort 61, and the final combined
integration run 711/711 (142.31 seconds). Root runtime/helper tests pass 119/119
and the deterministic browser suite 31/31. The first full run's three fixture
isolation failures were fixed; its single Slack socket error did not reproduce
in isolation or the corrected run and is not claimed as a repaired provider bug.
Deployment and real command registration are verified above, separately from
these checks. The Mac lock prevents live command/UI qualification; the most
recent inventory was checked again after the restart.

### Earlier parallel checkpoints (historical, superseded by the deployment above)

The checkpoints below retain intermediate failures and evidence boundaries.
Their references to inactive hooks, pending integration or server 71/72 are
historical states, not current blockers. Current remaining work is listed above.

Pushed `f5698f533` isolates Teams expiry recovery and adds guarded Discord
command registration groundwork. Pushed `aacd4963f` adds the opt-in awaited
Discord command boundary; its private acknowledgement cannot become an ordinary
public publication receipt. Commands remain off pending durable service
registration/admission integration. Root independently passes its 125-case
runtime/Teams foundation cohort. The wireframe images remain removed.

**New maximal-capability audit, September 9:** the original goal is not met by
documenting every adapter omission as a fallback. Three concrete gaps now own
the next implementation pass:

- **Telegram video-note intake:** the pinned parser produces video attachments
  without filename/MIME, as permitted by Telegram's video-note schema. The
  default policy rejected them before download. A real parser-to-service test
  with a valid MP4 reproduced zero stored files. The narrowly scoped fix now
  binds provider-declared video-note identity to MPEG4 metadata; ordinary unknown
  files remain rejected. Final fresh-database regression: 6/6, including exact
  bytes after restart and current access revocation; adjacent parser/adapter/photo
  checks: 114/114; plain server TypeScript passed before the concurrent Discord
  edits. The new Telegram path is deployed on server 72 but not live qualified.
- **Discord native forms:** v6 now implements native text/select open/submit,
  current source/actor authorization, identical/conflicting duplicate handling
  and actor-scoped private correction/reopen. Existing endpoints automatically
  gain the capability after current runtime qualification. Actual lock-wait
  regressions cover retired/replaced runtimes and changed credential refs.
  Root's final full service run passes **641/641**; seven focused files pass
  **165/165**, including actual discord.js wire serialization. Provider I/O and
  scheduler remain simulated; real modal UI and native continuation still need
  live qualification. A modal submission cannot itself open another modal.
- **Teams personal file output:** existing bot credentials can support native
  consent/upload without new Graph permissions; the pinned adapter does not
  implement the consent callbacks. The new inactive helper/actual-SDK hook
  foundation passes root **81/81**, the owner's egress cohort **119/119**, and
  plain server types. It protects upload capability privacy, exact bytes and
  receipts, and uncertain delivery. The subsequent durable protocol now has
  encrypted early-accept buffering, restart restoration, versioned stage
  resolution and same-transaction projection hooks. Its fresh PostgreSQL
  cohort passes **115/115**, including a reproduced publication/transfer lock
  inversion and a conflicting callback during an owned card send. The original
  81-case foundation did not prove these durable properties. Worker/source
  integration and tenant qualification are still required before activation.
  Channel/group files retain their documented fallback; do not infer broader
  authority.

Root owns shared verification, documentation, Git and deployment. Server 72
loads the committed Discord/Telegram implementations at `739750c15`;
the new native modal and video-note journeys are not live qualified.
Teams durable transfer, schema, safe batch UI/API and runtime hooks
are integrated in the working tree but not deployed. Root owns shared
verification and migration review. Browser control still reports Mac
locked. Preserve all parallel edits; no lockfile or PR work is part of this pass.

**In-flight Teams activation checkpoint (after server 72 startup):**

- Durable-transfer owner: new `chat_teams_file_transfers` table and transfer
  service/tests, private encrypted event/capability restoration, early callbacks
  and versioned I/O receipts. Source comment/attachment IDs retain evidence
  without preventing normal deletion; each later effect must recheck the source.
- Runtime owner: optional authenticated consent callback and narrowly typed
  native consent/file-info sends inside the existing regional service-URL scope.
  No service registration or generic Adaptive Card conversion.
- UI/contracts owner: `awaiting_consent`, safe per-part transfer summaries,
  disjoint settled/outcome counts, whole-batch dismissal and version/phase
  preconditions. New fields are additive for rolling compatibility. Missing
  settlement evidence must keep the send identity, not unlock a duplicate send.
- Root next: connect API projections and stage-aware audited resolution, then
  current personal-recipient admission, worker intents/results and restart
  integration. An accepted consent card or PUT is never a published file.

Generated migration `0257_brave_living_mummy.sql` includes the new table,
publication company/ID unique index and `awaiting_consent` CHECK. Root moved
the generated parent unique-index creation before its dependent foreign key.
DB safety/types/build and a complete fresh migration chain passed on
`chat_teams_transfers_schema_20260909_root01`; table and CHECK were inspected.
This has **not** been applied to the live database. It is a passive schema and
protocol slice, not runtime activation. Logs:
`teams-file-transfer-db-build-0909.log` and
`teams-file-transfer-fresh-schema-root-0909.log`. The optional actual-SDK runtime
hook and strictly personal file-card methods pass **25/25**; their seven-file
cohort passes **223/223**. These use synthetic JWT/provider transport, not a
live tenant. The runtime hook stays unregistered until current recipient/source
authority is connected to the worker.

Root's read-only API projections and generic replay/resolution safety guards
pass **19/19** on fresh `chat_teams_projection_20260909_03`. A deliberately
wrong-conversation transfer first reproduced an Activity/batch disagreement;
the exact-scope join fixes it. These are seeded-state API proofs, not native
file delivery. The final UI cohort passes **101/101**, types/token gates pass,
and the two consent-specific browser cases pass **2/2** (13.9 seconds) on fresh
`chat_teams_consent_browser_20260909_03`. Browser publication responses are
mocked; actual task/file-upload controls and reload behavior are exercised.
These targeted runs were followed by the complete current 665-case service
and 31-case browser runs below.

Next integration boundaries are explicit: preserve a minimal authenticated
personal-recipient proof on new Teams deliveries, bind it to the current
processed delivery/principal/conversation generation, supply current source and
permission checks to every file stage, and atomically project real receipts.
The generic publication resolver currently refuses all transfer rows rather
than mislabel a consent card or PUT as delivered; dedicated stage resolution
must replace that guard before the new UI actions are activated. A card/file
send timeout does not prove that the provider request was cancelled.

Passive transfer/schema/runtime foundation is committed and pushed as
`146cf23b9`; server 72 still runs the earlier deployed code. A second standalone
helper cohort now passes root **103/103** on fresh
`chat_teams_projection_20260909_root01`: personal-recipient proof **35**, safe
batch projection **36**, and atomic publication projection **32**. The new
projection records per-attempt intent once, only links the actual final file
card, preserves explicit operator confirmation without inventing a native ID,
and defers affirmative no-I/O failures by 30 seconds. Its combined owner cohort
with encrypted transfer/SDK contracts passes **147/147**. These helpers do not
yet activate file delivery.

The proof validator checks actual pinned-parser personal activity fields but
does not authenticate JWTs or authorize users by itself. Original admission
must supply the verified runtime fence; retained-source checks must bind the
exact causal requester, not select an unrelated newer personal message. The
service's new admission/restart cases pass **3/3** with mocked runtime/transport.
The original normalized proof survives reconstruction exactly, denied reach
redacts it, and a proofless legacy receipt cannot acquire new authority.

Two further genuine worker regressions were reproduced and fixed in the
in-flight service integration: generic publication processing sent a pending
Teams transfer as ordinary text, and its 60-second stale sweep quarantined a
live 90-second Teams intent. Exact company/publication exclusions and a
publication-lock-before-lane-check fix both. The combined API/worker block now
passes **21/21** on fresh `chat_teams_worker_exclusion_20260909_green01`.
The full service run now passes **665/665**, zero skips, on fresh
`chat_teams_integration_20260909_root01` in **125.77 seconds**; the full
deterministic browser run passes **31/31**, zero retries, on fresh
`chat_teams_browser_20260909_root01` in **2.8 minutes**. Logs:
`teams-full-integration-root-0909.log` and `teams-browser-full-root-0909.log`.
The browser loaded the current UI/API work before the later generic-worker
exclusion fix; that worker fix is covered by the final 665-case service run.
Provider transport and model execution remain mocked. New Teams file delivery
is still not activated or live-qualified.

Final service-run source SHA256:
`dbb146cd5cc5494a0cd9026f102ba55f399556caca81d51204e75679e6e845c3`;
integration test SHA256:
`1907518eabc63e73a43489270642404ce7368eb379a9682f5050cdc28a4fa4d0`;
browser spec SHA256:
`d286a6daa1feacde14423044a8a8b0a2324fe217a13ff262313e5eb1648508d4`.
Root additionally passes **44/44** OpenAPI/batch contract tests and **95/95**
selected UI tests; the earlier owner's 101-case UI selection is a different
cohort. Plain server TypeScript and diff checks pass. The dedicated transfer
worker still needs current causal-source/recipient authority, stage resolver,
expiry-recovery scheduling and per-row sweep failure isolation. Do not expose
stage actions with the generic resolver or treat an expired send lease as proof
that no file/card was delivered.

Standalone projection/recipient helpers are committed and pushed as
`e9099b5c4`. The shared service/API/UI activation work remains uncommitted and
preserved. No server restart, live database migration, runner staging or live
provider message occurred during this pass. Lockfile and runner SHA remain
unchanged.

The September 9 browser inventory still reports the Mac lock screen,
not a Discord login failure. Loopback/private health is ready on server 72; the
05:00:24 UTC check has 290 terminal runs and no active run, latest start
02:15:47.812 UTC.
No new live provider conversation has been sent during this audit pass.

Discord's generated question card → parsed concurrent clicks → real service/DB
→ one continuation publication now passes on a fresh database. The Slack
signed `view_submission` bridge passes 10/10; its final callback is a pure
validator/observer. A separate signed adapter/runtime-to-real-service/DB case
now covers invalid submission consuming SDK context, revoked-user denial,
restored operator correction and duplicate no-op. Its three-case database
cohort and 140 adjacent tests pass; root's full 625-case regression passes in
125.87 seconds on fresh `chat_slack_modal_joined_20260909_root01`. The final
test-only teardown adjustment separately passes all three focused database
cases and plain server TypeScript. The case proves one durable
`wake_fallback` receipt and simulated scheduler call, not a native model turn.
Provider I/O and model execution remain explicitly simulated, not newly
qualified live journeys.

The Teams `task/fetch`/`task/submit` bridge found a genuine error-only card that
removed the original inputs and Submit after invalid answers. A frozen repair
rebuilds only current authorized invalid forms with known bounded draft values
and readable question labels. Slack inline errors and all stale/denied guards
stay unchanged. Helper/Teams tests pass 31/31; independent helper/Teams/Slack
review passes 41/41; real-service Slack/Teams invalid-form cases pass 2/2.
The fresh full database regression passes 624/624, zero skips, in 120.61 seconds
on `chat_modal_correction_20260909_root01`; root's helper/Teams/Slack repeat
passes 41/41 and plain server TypeScript passes.
The Teams JWT checker is an explicit test double, not eligible-tenant proof.
The repair is deployed on server 71, with healthy Board and connected Discord
Gateway. No new live provider conversation or Teams tenant proof is implied.

- **Telegram photo eligibility (complete):** bounded PNG/JPEG metadata selects
  photo within supported geometry and a conservative 10,000,000-byte budget.
  Other images retain original document bytes. Header screening never decodes
  pixels. Valid fixtures, malformed headers and exact limits pass through the
  pinned adapter. Ambiguous photo sends are never retried as documents.
  Independent review's JPEG component-header cases are fixed.
- **Webhook diagnostics (complete):** portable tests pass 6/6 and root's actual
  wired-source HTTP tests pass 8/8, including keep-alive, native parser errors,
  privacy, 1 MiB ceiling and the explicit QA fault fixture. Deployed above.
  This closes a diagnostic gap, not the cause of earlier pre-ingress delays.
- **Discord interactions (complete):** real normalization strips raw methods
  used by the old denial check. Runtime-owned context now selects rejection
  after durable denial; foreign-guild actions no longer success-ACK. Forged
  payload markers and concurrent webhook context cannot supply that context.
  Real adapter → runtime → service → DB regressions pass, including one denial
  row and no wakeup for repeated synthetic delivery. Simulated socket/API
  results are not live Discord button qualification.
- **Native reasoning effort (audit complete):** legacy `modelReasoningEffort`
  is not a supported field in the closed native v4 provider contract. The five
  latest succeeded runs freeze `{kind: codex, model: gpt-5.6-luna,
approvalPolicy: never}`. Injecting an effort field is rejected; resolving
  legacy low versus high yields the same native profile. This is a missing
  native capability, not a proved dropped supported setting. A future explicit
  versioned contract addition needs frozen identity, new/resumed turn coverage
  and real qualification. Do not silently map the legacy field or claim low
  effort is effective today.

The latest user reports Discord login restored; root's subsequent browser probe
still reports **Mac locked**. Only the OS unlock is being requested. Root
rechecked server 75 health and its 3137 listener; no new live provider turn
has been sent during this code-only audit.

## Latest provider evidence — scope matters

Maya E2E `31f56712-3944-423e-b7c7-404bb8fbb993`, company
`7ffa9799-0b1b-4a26-9b44-8e897f832f89`, uses native
`paperclip_runner` / `codex_app_server` / `gpt-5.6-luna`. Terra was not
substituted. Effective reasoning effort is not yet proved; the old configured
low field is outside the native v4 contract. Do not claim it is running low effort.

| Provider | Latest useful real evidence                                                                                                           | Still missing                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Discord  | Server 68 same-thread image/TXT return on CHA-32; both previews and full TXT inspected, one attempt per output; bot reconnected on 78 | Live repeat on current deployment, remaining runbook cases, second-process takeover    |
| Slack    | Server 68 same-thread image/TXT return on CHA-33; exact received bytes retained; live edited-source reuse denied                      | Live repeat on current deployment, remaining lifecycle/governance/failure permutations |
| GitHub   | Server 68 honest unavailable-private-file reply, followed by correct pasted-text answer on the same session                           | New safe task-link → task-upload live journey and remaining runbook cases              |
| Telegram | Earlier real text/media/reaction/backlog cases; accepted CHA-26 image answer later delivered without another model run                | Exact failed document-B recovery and remaining file/interaction/performance cases      |
| Teams    | Deterministic personal-file consent, channel/group pictures, progress, actions, access and safe file-link coverage                    | Actual qualified tenant setup and live provider journeys                               |

Real media repeats on server 68 were descriptive, not a controlled speed claim:
Discord run `265d35e0-af1e-421b-b3e2-61ba65fcc288` took 60.073 seconds,
source→last file 64.926 seconds; Slack
`12d6d924-9748-4d13-ad6e-2035937e12dd` took 51.030 seconds,
source→last file 61.173 seconds. Each was sent after the previous run settled
to avoid same-agent queue contention. See permanent log for source/message IDs.

GitHub generic private attachment URLs can be unavailable to the App even when
the signed-in human can read them. Never forward browser cookies or guess file
contents. The new deterministic fallback appends an authorized Paperclip task
link; it does not make those provider files generically downloadable.

Slack once took about 61.5 seconds and Telegram once 234.435 seconds before
local ingestion. Later samples were fast without configuration changes.
Those delays are localized, not explained or fixed. Unauthenticated retry
headers are diagnostic hints, not authority or proof of earlier request paths.

## Protected historical failures

These are not unlocked by the forward warm-transition or startup fixes.
Do not infer full process-tree retirement from a missing PID or leader exit,
clear quarantine, rewrite receipts, reset history or replay accepted output.

### Telegram CHA-26: preserve exact failed B

- Task `ab55427f-615e-4a2d-819a-8af9c1292fa3`, generation 10.
- Accepted A: `fd7011b6-323b-461a-bc43-a81835bece5f`; external messages 153/154
  were presented once without rerunning A.
- Failed document B: **`fcf7adc4-39a5-4c42-8cbb-a9723ad22302`**. Only its
  exact authorized retry can qualify recovery; do not create replacement C.
- Native session `ce94db0c-3aec-40be-8caa-c80d008fcbbb`;
  runner `0c1da1cb-513b-4ab9-8e28-4466ac060016`;
  lease `ae666e16-338c-400a-bc9b-7792f97c1770`;
  provider thread `01a08176-e3a3-7891-b06f-439b9e68b641`.
- Scope `1c080549b2c4f48602d28768e62c56bbc50d48c4479e8abd8fc054a498f4b391`.
- Latest cleanup copy `cleanup-BufsxY`; maintenance
  `native-cleanup:ae644c98-7ecd-483a-bb3e-ecccbf0bb42a`.
  Epoch 0 PID 88642 has retirement; epoch 1 PID 88736 lacks the required
  authenticated retirement receipt. Absence does not supply it.

Earlier CHA-24 had damaged historical event 44. A Board retry accidentally
selected its older UUID-keyed context and is not damaged identifier-keyed
recovery. Its retired conversation generation must not regain external access.

### Discord CHA-29: preserve old accepted owner

- Task `5448a71e-4303-425a-8fbe-f66ae4a9482b`;
  thread `1547036525059907626`.
- Accepted A `29d19d67-9591-469d-ada3-f72261b732d0`,
  result `e9700900-7e55-4716-8812-409600d679b8`;
  failed B `6b6f6db4-7d3b-4b40-beb7-f385cb610cbc`.
- Native session `1c2c4bbc-8416-46ff-960d-f0f72eef3862`;
  runner `75630d5c-ddae-4c3c-b1a4-86c707b4fbc5`;
  provider thread `01a08380-cfca-7ea2-ba46-6a8a8ae678ed`.
- Scope `e88d6c2a0bee3c91af49d155d63ce2ad043975ecf51cae77b5e1129a5688ae37`.
- Archive suffix `identity_indeterminate.cleanup.1ad3d873-71c2-47aa-9d7d-74407d75d311`;
  failed copy `cleanup-mZx1xU`; maintenance
  `native-cleanup:75e0faf7-bc67-4a4b-b206-ce0c0f4340be`.
  Runner PID 69543 retired, but renewed provider retirement is unproved.
  Do not retry the original or failed copy on that fact alone.

## Completed repairs — do not reimplement

- Experimental chat gate preserves production GitHub tools when chat is off.
- Ambiguous outbound delivery has explicit audited resolution; ordinary replay
  refuses unknown delivery. Board send+comment creation is atomic/idempotent.
- Exact failed-run retries derive source/context on the server, preserve the
  admitted batch, dedupe retry intent and recheck current authority. UI surfaces
  use that route; they no longer need a new generic retry implementation.
- Accepted-result presentation is separate from physical session reuse and
  preserves later task state and audit evidence.
- Current-source attachment revocation, native byte-preserving file output,
  media batching guidance, whole-message sizing and truthful status repairs
  have focused and scenario-specific live evidence in the permanent log.
- GitHub unavailable-file task links are durably prepared and reauthorized.
  Task navigation/uploads bind the loaded task's company; outgoing route and
  file-chooser readiness are fenced. Narrow connected-task banners are fixed.
- Warm run handoff has immutable receipt/result/ACK boundaries and final
  activation acknowledgment. Old authority is replay-only. Fresh recovery
  preserves the same lease and requires independently verified server ownership.
- Recovery-only authorization retires only after a fresh exact new-authority
  snapshot. Missing/wrong results and sync/async callback failure keep ordinary
  work fenced, including requests racing bootstrap.
- The event pump is fenced by run identity; local cursors reset after confirmed
  activation. Remote FIN closes the owned WebSocket wire.
- Forward startup ownership receipts prevent unproved relaunches. None of
  these repairs retroactively authorizes historical cleanup.

## Verified automated gates and limitations

Current combined service integration passes **846/846**, no skips, on fresh
`chat_stop_subscription_full_20260909_root02` (157.43 seconds), after causal
test-harness repairs recorded in the permanent log. Helper/runtime checks pass
**367/367** across 15 files, deterministic Board browser checks **31/31** on
fresh `chat_stop_subscription_browser_20260909_root01` (2.8 minutes), and plain
server types pass. The same production candidate is deployed on server 78.
These tests use simulated provider/model ports; they do not qualify the live
Discord command/modal, Telegram Stop or Teams consent experience.

Earlier combined service integration passes **711/711**, no skips, on fresh
`chat_commands_full_20260909_root02` (142.31 seconds). Final runtime/helper
tests pass **119/119**, and deterministic Board browser tests **31/31**, zero
retries (2.8 minutes), on `chat_commands_browser_20260909_root01`. Plain server
TypeScript passes. These cover the deployed implementation with mocked
provider/model ports, not a live command or Teams consent journey. Earlier
cohorts below retain their original narrower scope; the permanent log records
both the first failed combined run and the corrected run's exact source hashes.

On the frozen native candidate: optimized full transport **133/133** (zero
skips, 198.64 seconds), controller **69/69**, optimized Rust lib **248/248**,
and the Codex/native/supervisor/durable integration targets passed.
Root independently passed **26/26** recovery cases, **36/36** generated server
admission, **75/75** adjacent server tests, plus post-format **55/55** selected
protocol cases and **260/260** executor tests. Package TS build/types, direct
server types and Rust formatting pass. Formatting is scoped; some preexisting
files are not globally Prettier-clean.

Generated server admission uses the actual checkpoint rebind and restart
classifier with real PostgreSQL, but mocks the backend after admission.
It is not combined server→real-provider recovery proof. Only local Codex
`resume_dead_runner` with a verified managed/projectless checkpoint is admitted;
surviving-runner, remote/listen and missing-independent-checkpoint cases remain
unsupported and fail closed.

Earlier Discord modal workflow integration **641/641**, zero skips, ran on fresh
`chat_discord_modal_final_20260909_root02` (123.87 seconds). Root's focused
seven-file cohort passes **165/165** and plain server TypeScript passes.
The first full attempt passed 637/638 because a fixture's unscoped initialization
hook changed the target generation before its own initialization. The hook is
now endpoint-scoped with an exact invocation assertion; the negative capability
assertion is unchanged. Three separate real lock-wait bugs were reproduced and
fixed. Source hashes and exact simulated-vs-live boundaries are in the permanent
log. New Teams durable-integration work is separate and not covered by that run.

The preceding frozen-foundation chat integration **631/631**, zero skips, ran on fresh
`chat_modal_telegram_foundation_20260909_root01` (119.53 seconds). It includes
the Telegram video-note repair and Discord's modal transport foundation with
capability still off, not the subsequent Discord service/correction workflow.
The exact loaded source hashes are in the permanent log. A later test-only
global-collector setup/cleanup correction passes GitHub-filtered **149/149**
(482 other cases filtered) on a second fresh database; this does not change
production behavior. GitHub attachment/stress/setup units pass **182/182**;
the shared Slack/Teams/modal-helper cohort passes **41/41**.

The preceding full chat integration **625/625**, zero skips, ran on fresh
`chat_slack_modal_joined_20260909_root01` (125.87 seconds). A later test-only
nested-cleanup/fixture-retirement adjustment passes the final-source focused
Slack/Teams **3/3** and plain server TypeScript; the full run loaded the prior
semantic freeze, not that cleanup delta.
Root's focused helper/Teams/Slack cohort passes **41/41** and direct server
types pass. The earlier parser/runtime/adapter cohort passed **199/199**.
The full suite includes Slack's signed corrected-modal/database flow,
Teams invalid-form preservation, Discord's parsed
question/denial paths, Telegram photo boundaries, and previous Slack/Discord
partial-file batches across restart and explicit ambiguous-file resolution.
Provider I/O is simulated. Prior log: `slack-signed-modal-full-root-0909.log`
in ignored runtime.

Full deterministic chat browser **29/29**, zero retries (2.8 minutes), includes
six task-company/upload routes and readiness behavior. It is not live provider
qualification. The real-Codex staged startup canary
`paperclip-real-startup-phHTMj` used actual Codex 0.153.4, one provider process
and no model turn; reopen made no new provider RPC. Direct-child exit was
observed, not whole-tree retirement.

Broad workspace tests previously had unrelated harness/runtime failures; never
claim the entire workspace passed from these focused gates. Renew final-source
installation/build/release gates when appropriate; do not substitute PR/CI work
for remaining provider qualification.
