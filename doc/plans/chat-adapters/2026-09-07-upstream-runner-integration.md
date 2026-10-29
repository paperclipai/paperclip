# Chat adapters: upstream runner integration checkpoint

## Scope and provenance

The live qualification agent remains Paperclip Runner → Codex →
`gpt-5.6-luna`. The earlier real Slack, GitHub, Discord, and Telegram text
samples completed in 13.472–16.467 seconds from send to provider acknowledgement.
Those are historical samples, not measurements of the changes in this document.
Teams still has no qualified live tenant. Terra has not been substituted.

This checkpoint incorporates these code-only changes from the fetched
`origin/master` revision `297d8741f5f192c66abbec325b1e956cf0e5e667`:

- `5bddff092041c1430d049ee2bb5f421df1957823`: guarded runner API fallback.
- `1cc45086d3b2f2710d4e161b0dc9ad1d3662a9a8`: operation-time execution identity.
- `d8b95805314c70b13d9efce338cbc287c2afb4e1`: recent-task ordering debounce.
- `ff2457876`: initialize the runner's Rustls crypto provider before TLS.
- `297d8741f`: resolve duplicate connections to the same GitHub account.

The independent lockfile refresh
`392ab26b1ede1634b947d1d539926052c79a2636` is deliberately not included:
the repository owner explicitly prohibited editing `pnpm-lock.yaml`. Its SHA256
remains `313c6a80f077364abe06d237d518ba555ccaf03745f3504a1f7df36e7baf8040`.
These are code cherry-picks, not a claim that master ancestry or the frozen
dependency installation gate is reconciled. The previously observed
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` remains an open release gate.

## Reconciled behavior

- Keep the API escape hatch disabled unless an operator explicitly enables it.
  Local file registration, current-wake reading, attachment listing and reuse,
  and the chat-specific direct-response policy remain available independently.
- Preserve mutation receipts, dispatch reauthorization, pre-replay checks,
  definite-precommit cleanup, and issue-before-run lock ordering.
- Preserve native file/workspace fingerprints and conversation checkpoints
  while rotating run-scoped GitHub authority between provider processes.
  Rotate when a credential is removed as well as when one is added or replaced;
  a warm provider process must not retain an earlier run's token.
- Keep generated webhook secrets and private identity-link capabilities out of
  generic API results and mutation receipts. Their existing Board checks also
  remain authoritative.
- Withhold raw GitHub credentials from low-trust execution, including personal
  sponsor and dedicated-agent accounts. A token does not enforce the guest's
  read-only tool boundary. Check current agent/project/task/run policies and
  reject quarantined, invalid, or missing task context before secret resolution.
  Taskless runs also recheck their current project policy. Malformed task identity
  is rejected before attempting a UUID database lookup.
- Persist a run's low-trust boundary at dispatch, before workspace setup or
  credential resolution, and intersect it with later policy checks. Relaxing a
  task, project, or agent afterward does not erase the running turn's restriction.
  Project trust remains effective even when isolated workspace selection is off.

Useful lifecycle, question, final-answer, image and file signals may reach the
provider. Native thinking/tool activity remains on the private Paperclip Board;
raw reasoning, internal logs and credentials are not broadcast to chat.

## Database compatibility

Master's canonical identity migrations retain slots 0240–0245. The ten existing
chat migrations move from 0240–0249 to 0246–0255, preserving every SQL byte and
SHA256, including historical migration names inside repair audit strings.
Drizzle generated all ten cumulative snapshots from staged historical schema
inputs; snapshots were not hand-merged.

Two independent PostgreSQL upgrade checks passed:

- A clone of the already-migrated chat test database had exactly six pending
  identity migrations. Its original 248 migration-history rows remained unchanged;
  six rows were added. Counts and full-row digests for nine chat, attachment and
  outbox tables remained unchanged. Reapplying migrations was a no-op.
- The committed regression test creates a fresh database, reconstructs the
  deployed pre-identity schema/history shape, and proves that existing chat SQL
  is not replayed. An ambiguous file publication remains unchanged and historical
  issues are not assigned invented execution identities.

Generation inputs, the original SQL, hashes, baseline, proof script and results
are retained locally under
`.paperclip-runtime/chat-adapters-live/migration-reconcile-20260907/`.
Those fixture checks did not mutate the live database. The later backed-up live
upgrade is recorded below.

## Verification recorded so far

All commands ran in the existing `codex/chat-adapters` worktree. Provider failures
and transport races in deterministic tests are simulated, not live-provider proof.

- Full chat integration: **282/282**, fresh PostgreSQL database
  `chat_adapters_test_20260907_upstream_identity_full_02`, rerun after the final
  dispatch trust-retention changes.
- Mocked browser qualification: **9/9**, including all five setup/detail flows
  and Board file-batch refresh after success, failure, unknown delivery and a lost
  HTTP response. It uses a throwaway local server, never a live provider login.
- Runner tool authority/API cohort: **890/890** before the additional five
  secret-link restriction cases; API/OpenAPI cohort with those cases: **852/852**.
  Final root rerun of eight authority/API/file-handoff/real-server suites:
  **891/891**, with no skips. A child rerun could not bind loopback sockets;
  the root rerun exercised the real HTTP suites successfully. These counts
  overlap and must not be summed as unique coverage.
- Final current-wake comment reader: **5/5** against fresh embedded PostgreSQL.
- Final combined heartbeat, issue routes, execution identity, GitHub broker and
  trust cohort: **208/208**. A narrower broker/identity/trust run passed **24/24**,
  including fourteen policy-source/personal-or-dedicated denial combinations,
  malformed references and taskless current-project tightening.
- Dispatch trust-retention and trust resolver: **13/13**, including seven new
  regressions that persist restrictions, remove current policies and confirm the
  real broker still denies personal and dedicated credential export.
- Native executor and runtime context: **153/153**, including all four warm
  credential transitions (absent/absent, absent/present, present/present,
  present/absent). These cohorts overlap; counts are not unique totals.
- UI chat contracts and recent-task behavior: **50/50**.
- Migration reconciliation, identity migration and final snapshot: **5/5**.
- Shared/server/UI and DB typechecks passed. DB numbering/safety and UI token
  gates passed. Runner TypeScript checks passed; locked Rust release build passed.
  Two focused Rust regressions passed, covering GitHub environment handling and
  launch rebinding.

Detailed command logs are under
`.paperclip-runtime/chat-adapters-live/upstream-*.log`.

## Deployed checkpoint

Code checkpoint `26b6df7c1` was committed and pushed to `codex/chat-adapters`.
The isolated live server was gracefully paused with no queued or running runs.
Before migration:

- Created a portable JavaScript-engine SQL backup in the ignored runtime
  directory. Restoring it into a new fixture preserved row counts, but did not
  reproduce every row digest. The inspected agent row differed in its
  sub-millisecond `created_at` precision; this backup is not recorded as exact.
- Created native PostgreSQL snapshot database
  `chat_adapters_live_pre_identity_20260907_01` while the application was stopped.
  All **198** table counts/full-row digests and all **248** original migration
  history rows matched the live database exactly. No existing database was
  overwritten. Both backup forms and the restore fixture are retained.
- Applied exactly the six identity migrations to the live database. All nine
  captured chat/attachment/outbox table digests stayed unchanged, the original
  history remained unchanged, the journal grew to **254**, and repeating the
  migration was a no-op.

Backup, baseline and verification artifacts are in
`.paperclip-runtime/chat-adapters-live/upstream-live-backup-20260907/`.
The guarded local `upstream-live-upgrade.ts` helper and its logs remain alongside
that directory. The portable-backup precision discrepancy was not patched as
part of this chat integration.

`pnpm --filter @paperclipai/server build` passed, including the full native runner
build, protocol/contract checks and binary staging. The package and vendored
runner binaries share SHA256
`f7c1273cce29e521e820ad947d657e500da28477f563053148e764cdfb3730cd`.
The restarted server reports `2026.831.0+413.git.26b6df7c1` at
`http://127.0.0.1:3103`; its log is `server-native-checkpoint-16.log`.
Maya remains `paperclip_runner`, provider `codex`, model `gpt-5.6-luna`.

The staged Rust-backed Codex transport suite passed **71/71** in
`upstream-runner-staged-driver-03.log`, including cold restoration with a changed
run binding. Two earlier full attempts each timed out in different tests while
macOS slept: the host power log records thermal/maintenance sleep overlapping
both runs, including a two-minute sleep during the second. A targeted rerun of
cold restoration and prompt process-exit handling also passed **2/2**. No timeout
was increased and no power/thermal protection was changed.

During that host sleep Discord's lease expired, its local listener stopped, and
a fresh listener connected after wake. A later read-only check found a valid
gateway lease, all four configured endpoints active and no queued/running runs.
The old detached Board tab could not attach; a fresh in-app catalog tab loaded
and showed Maya's Slack, GitHub, Discord and Telegram connections active. This
was a catalog-state check, not an interactive journey or visual-polish sign-off.

## Remaining qualification

The earlier 86/87 cohort against the old staged binary was not new-runtime
qualification; the rebuilt transport suite above closes its cold-restore gap.
The whole-workspace build and test suite have not been claimed green.

Live model qualification remains limited by the observed Codex capacity gate.
The in-app browser input outage also needs recovery, and Teams still requires a
work/school tenant and the necessary bot/admin setup. Real cross-person GitHub
push qualification needs two authorized users/accounts and a disposable repo.
New Slack delayed-upload receipt recovery, native overflow/history resend and
GitHub line-specific review replies still need the live passes described in the
existing qualification notes. This checkpoint is not a production-ready claim.

## Live Luna recheck after capacity returned (September 7, 22:42 CDT onward)

The capacity and browser-input gates above are historical: the account now
reports available Codex capacity and signed-in in-app browser input works again.
No usage reset was consumed, no credits were purchased, and no alternate model
was substituted. The server still reports `2026.831.0+413.git.26b6df7c1` during
these tests. All runs below use native `codex_app_server` with `gpt-5.6-luna`.

| Live journey                  | Observed outcome                                        | Native run                             | Submit to final provider acknowledgement |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| New Slack root mention        | One task/thread; visible `SLACK-LUNA-READY`             | `5483fa21-0127-4625-8fcc-58e985943b2c` | about 14 s                               |
| Telegram DM                   | Visible `TELEGRAM-LUNA-READY`                           | `8568dad8-2653-47de-95ed-7c8290e7fe06` | about 13 s                               |
| Existing GitHub issue #2      | Visible `GITHUB-LUNA-READY` in bot comment `5578817993` | `594094cd-cddb-4cc7-a85e-edc08bde086b` | about 20 s                               |
| Existing Discord CHA-4 thread | Failure message, not a successful reply                 | `3dd32648-3d07-4616-a845-98625fce020f` | failed before provider startup           |

The latency endpoint is the final publication's `published_at`, not the earlier
working-placeholder message timestamp. Native execution alone took 11.3 s,
10.6 s and 14.3 s respectively. This small, awake-host sample is not a latency
SLO or a production load benchmark.

Slack's root is `1788838921.759279` in channel `C0BUT55N9RV`:
[live Slack thread](https://papercliplabs.slack.com/archives/C0BUT55N9RV/p1788838921759279).
[GitHub reply](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2#issuecomment-5578817993).

Ten Slack follow-ups (`BURST-LUNA-0907-01` through `-10`) were sent through that
thread's actual composer in 4.3 s. All ten became distinct durable inbound
comments on one task. Luna acknowledged `01` once in run
`6cf15c58-55db-4b95-b7c2-bdbefdb8b394`, then `02` through `10` once each and in
order in run `2cb0ac3c-3ad9-4cec-8a40-555a84d7db6d`. The second run started 41 ms
after the first finished; the native current-wake reader appears in its durable
events. Final Slack text was inspected in the real browser. Both runs resumed
the provider session. No queue marker was omitted or duplicated. The second
batch's final publication was acknowledged at 03:51:07.023 UTC, roughly 36 s
after the last submitted marker, including the first run's remaining work.

The Discord failure is a real checkpoint-selection defect, not a transport or
quota success: a pre-bootstrap retry reused normalized session
`5e8168d9-e0ce-4c4b-8b4c-2da16e862880` without the saved checkpoint, then attempted
fresh startup against an older suspended run's durable directory. The strict PRP
identity guard rejected it. The directory and prior checkpoint were retained;
no live DB state or provider history was deleted to force a green result.
This finding requires a code fix and live retest before Discord sign-off.

A fresh Telegram photo was uploaded through the signed-in browser at 22:55 CDT.
Luna run `d4c0c338-ac12-4ce3-956e-577d8e6c1008` inspected the image, correctly
described the orange tabby, and returned an actual visible photo attachment.
The native turn took 52.4 s. A subsequent history-only resend request failed the
user journey: the completed DM task rolled over to a new generation, and run
`a9261539-3a93-4e1f-b45f-d9741216de65` truthfully reported no attachments in its
new task. The request had explicitly asked to keep the previous task in progress.
The separate attachment-history capability is not signed off by the successful
current-message round-trip; task continuity needs investigation without widening
attachment access across unrelated tasks or identities.

Functional text/queue outcomes are good in the exercised Slack, GitHub and
Telegram paths; experience quality is not yet signed off across all providers.
Teams tenant setup, Discord recovery and
remaining attachment failure/recovery journeys are still explicit gaps.

The existing disposable GitHub PR #3 line-review thread was also exercised on
the new native runner. A plain reply without another bot mention, review comment
`3954194584`, mapped to the existing `:rc:3950666444` conversation and one native
Luna run `a57802aa-4df8-4415-9b19-41444eb3caa0`. The run finished in 14.0 s and
published `GH-INLINE-LUNA-READY` as review comment `3954194907`, under the same
line thread rather than the PR main discussion. The response was inspected after
refreshing GitHub's classic PR page, which did not insert the new reply live.
[Inline reply proof](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/pull/3#discussion_r3954194907).
This closes fresh native inline-reply delivery, not every inline edit/delete or
file-fallback journey. No test PR was merged and no implementation PR was tended.

### Discord host-pause admission hardening

The gateway can renew an expired local deadline only by an atomic compare-and-
swap on its exact durable token after current endpoint/credential checks. A
resumed callback establishes that authority before consuming a buffered message
or reaction. An actual standby takeover still fences and stops the old listener.
Callback-triggered teardown fences synchronously but does not await the gateway
task that may itself be awaiting that callback; shutdown joins the tracked stop.

Both targeted host-pause/takeover regressions pass after the final change
(`discord-host-pause-regressions-03.log`). Full chat integration passes **283/283**
on a fresh embedded PostgreSQL fixture (`discord-host-pause-full-03.log`). The
first two full attempts each exposed the same adjacent Slack test-cleanup issue:
an intentionally deferred valid receipt outlived its fixture. That test now
drains its own receipt after clearing the test-only due time, without weakening
the subsequent linked-authority/reach assertions. The cleanup pair separately
passed **2/2**. Direct server TypeScript checking also passed for the gateway fix.
These are deterministic admission proofs, not a live forced-host-sleep claim.

### Native checkpoint-selection correction

Native bootstrap now searches exact company/agent/issue/session history rather
than trusting a stale task-session `lastRunId`. Only terminal attempts with no
checkpoint, process or established-provider events can be skipped. Newer
provider authority is a barrier, never a checkpoint to adopt or roll back past.
Compatibility checks for provider, workspace, runtime context and native tools
remain strict. A new, uninitialized run with no compatible checkpoint receives
a fresh normalized session/durable root and full task context. Previously
admitted immutable inputs are not rewritten, and old history is retained.

The locked persistence step rereads provider evidence and checks the immutable
input before accepting a recovered checkpoint or fresh session ID. This also
fixes prefilled native session IDs overriding an explicitly selected fresh ID.
Real PostgreSQL regressions cover scoped lookup, newer progress barriers,
incompatible checkpoints, fresh-ID persistence and a provider event committed
while recovery waits on the run-row lock.

Root's frozen-snapshot resume/runner-selection/cancellation/status-context cohort
passed **61/61** (`native-resume-recovery-root-01.log`); this includes **28/28**
resume tests. Direct server TypeScript checking passed. The separate heartbeat
process-recovery file passed **133/133** on a clean rerun. An earlier combined
run reported two failures while files were changing; one recovery-case failure
was truncated and its cause was not established. It is not counted as a pass.
Live deployment and the original Discord retry are the next required checks.

The frozen native fix also passed the full server build and formatting checks.
An independent read-only review found no concrete findings in the scoped diff.

The subsequent native GitHub inline-file run
`c90e0948-1512-41b3-81af-bb14d4e93ada` succeeded in 30.3 s, but exposed a
wording defect: the model claimed the file was attached in the review thread,
while the transport correctly explained that GitHub App comments cannot upload
file bytes and saved the file on the private Paperclip task. This is not signed
off as native GitHub attachment delivery; capability/result guidance needs to
prevent the conflicting claim.

### Deployed native recovery proof

Commit `062cfcacc` is pushed and deployed on the isolated live instance. Health
reports that exact revision, startup recovery ready, and the agent remains
`paperclip_runner` / `codex` / `gpt-5.6-luna`. No credentials were regenerated.
The new follow-up in the original Discord conversation succeeded as run
`b9fc4be1-3a22-44c8-9198-4527fc8b90c4`: native execution took **12.85 s** and
the final publication followed **0.75 s** later. Its new normalized session is
`74083a50-8e04-4732-baed-5b5180267a56`; the old incompatible durable directory
and task/conversation history remain intact. `session.started` is recorded,
and the browser shows `DISCORD-LUNA-RECOVERED` on the same provider thread.
[Discord recovery proof](https://discord.com/channels/1457808928258658549/1546513811672932372/1546734998126854244).
This closes the exercised stale-checkpoint bootstrap failure, not every
possible interrupted native-session recovery scenario.

Ten subsequent real Discord messages were admitted once each to that same task.
Runs `68814d68-1913-4f03-9199-8cd707121372` and
`427bd446-88e1-461d-9fb6-bfdba64f9cda` resumed the same new native session and
acknowledged markers 01 and 02–10 respectively, once each and in order. The
queued second run started **63 ms** after the first finished; its 46.5 s duration
was native/provider work (six tool calls), not a multi-minute delivery poll.
Both final responses were inspected in Discord. The Board run page also showed
the native Luna identity, 13 s recovery turn, session change, transcript controls,
tool/terminal events and detailed timing spans.

The GitHub inline-file artifact was independently checked in private storage:
19 bytes, exact `INLINE-LUNA-FILE-OK` content with no trailing newline,
SHA-256 `73bf300550546d6a389e7c0791266a3a1e5e3466ff7e9f74f2f2aff11dffdaf1`.
This proves file creation/storage, while the conflicting provider-facing wording
remains a separate fix and live-retest requirement.

### Fresh Slack native media round-trip

The signed-in Slack thread received a real PNG and text file via its upload UI.
Native Luna run `5041afe7-27b1-4d99-8e29-7f560f889680` correctly described the
orange tabby and read `cobalt otter 47` from the file, then returned both original
files. The browser screenshot confirmed the image and readable text attachment.
Inbound/outbound asset hashes match for each file: PNG
`005f8dabdb19ef786c0e2e76695596d22c1d0bb53de374e0be209cc6d89851c9` and text
`fd40030afb62b83181a2a46dde8220e8defecfa0b4328e380c30b1899ccdce24`.
Native execution took 57.6 s; the final text published 0.93 s after completion,
with both native files delivered within another 5.8 s. This verifies actual
current-message file/image handling on Luna, not just an attachment label.
[Slack media proof](https://papercliplabs.slack.com/archives/C0BUT55N9RV/p1788841046075929).

### Historical file follow-up and private-review arbitration

Discord historical-file run `db32efde-61d5-45fa-9763-e2676e666600` exposed two
distinct gaps. Existing reuse could prepare old same-conversation files but
listing intentionally exposed metadata only, so Luna could not inspect the
historical image or quote the text. Native completion correctly required review.
However, its system-authored private review interaction incorrectly suppressed
the provider final despite being ineligible for chat projection, leaving the
visible working placeholder stranded.

Interaction arbitration now reserves the pending response slot only for an
interaction authored by the source run's agent. A durable actual provider prompt
still suppresses duplicate source prose after resolution. System/Board-created
reviews cannot silently consume that slot. Real PostgreSQL coverage plus the
existing safe-milestone suite pass **17/17**, and server TypeScript checking
passes (`native-chat-arbitration-root-02.log`). The first test attempt exposed
duplicate company prefixes in the new isolated fixtures; that seed defect was
corrected before the successful rerun. This correction is not yet deployed;
historical content inspection and live retry remain separate work.

### Additional native hardening under verification

The explicit external-chat wait correction passes **9/9** real-PostgreSQL tests
(`native-chat-wait-root-03.log`): same-task liveness with no scheduled extra turn,
current-authority revocation, and a contended endpoint proof that retries without
the issue/endpoint deadlock. Governance and ordinary non-chat behavior retain
their existing priority. Independent review found and prompted corrections to
lock ordering and authority-loss classification before this pass. Earlier runs
found fixture FK/prefix errors and an incorrect retry-count assertion (assessment
rows intentionally deduplicate); those attempts are not counted as passes.

File-preparation results now explicitly distinguish native attachment capability
from GitHub/Teams private-task-only delivery and never claim confirmed sending.
Focused coverage passed **32/32**, broader prompt/tool-authority coverage
**119/119**, and adapter-utils/server typechecks passed before later reader work.
The queued-publication change uses at most four independently owned endpoint
lanes, preserving same-bot credential fencing and conversation order. Its
focused queue/lease/app checks passed **8/8**, and broader receipt/FIFO/retry
coverage passed **20/20**. The first full integration run passed 284/287: two
old stale-worker fixtures needed exact lease expiry, and one failure exposed
an empty-page race when an excluded busy endpoint became idle during selection.
Those cases were corrected. A real row-lock regression also reproduced expiry
resurrection before the new lease guard sampled its clock after acquiring the
lock; the corrected guard rejects late settlement without replaying the send.
The frozen full integration rerun passes **288/288** in 100.13 s
(`chat-channels-full-root-hardening-02.log`), with app lifecycle checks **8/8**.
These changes are not yet deployed.

### Frozen native tool and continuity verification

The native historical reader now admits one exact same-conversation attachment
under current run, agent, source-lineage, membership and destination policy.
After bounded storage retrieval and size/hash verification it revalidates
authority, commits that transaction, then stages bytes in the confined temporary
workspace. Reading never selects a file for outbound delivery. Empty files are
inspectable, cancellation cannot return a path, and run completion clears the
staged inode. Review caught both filesystem work holding policy locks and a
pre-validation cleanup path that could truncate an unauthorized inode; focused
regressions cover both corrections. Remote staging is explicitly unsupported,
not silently replaced by a public URL.

Direct Codex chat also advertises the existing run-bound `request_human_input`
tool. No general task/governance tool was added. Fingerprint v5 rotates older
provider catalogs, including the intermediate reader-only catalog. Independent
review found no remaining authority/privacy defect in this narrow exposure.

Combined native-runtime, prompt/file guidance and provider arbitration coverage
passes **1,350/1,350 across 34 files** in 164.80 s
(`native-combined-root-hardening-01.log`). The Codex driver suite passes **65/65**,
including fresh and resumed direct-tool dispatch. The full server/runner build,
shared/adapter-utils/UI typechecks and whitespace checks pass. New files are
Prettier-formatted; whole-file Prettier reports existing mixed-style formatting
in several touched modules (also reproduced against the pre-change
`server-utils.ts`), so that broader check is not claimed as a pass. The lockfile
remains unchanged. Live verification of these combined changes is still pending.

### Live native Luna qualification on `205c0ca99` (September 8 UTC)

The combined changes were built, committed and deployed at 04:43:39 UTC; health
reports `2026.831.0+419.git.205c0ca99`. Deterministic browser coverage also passed
**9/9** in 2.7 minutes (`chat-ui-root-hardening-01.log`). This is supporting
fixture coverage, separate from the signed-in provider journeys below.

Maya's runtime settings visibly select **Paperclip Runner → Codex →
`gpt-5.6-luna`**, with automatic isolated permissions and turn-by-turn lifecycle.
The actual native run/model records agree. No Terra substitution was made.

- **Slack structured question: passed.** A real thread message requested an
  Amber/Cobalt choice. Run `d305f396-3257-4665-afc4-36fab64a0c60` produced the
  native question in 15.14 seconds. Clicking Cobalt once settled the card to
  “Answered: Cobalt.” One durable response delivery woke one continuation,
  `3d9cf547-d0fd-4a6b-9e23-eab8d3533c74`; its single final “cobalt” was published
  14.92 seconds after the answer. A later DB check found no duplicate response,
  continuation or final. [Visible reply](https://papercliplabs.slack.com/archives/C0BUT55N9RV/p1788842861244389?thread_ts=1788838921.759279&cid=C0BUT55N9RV).
- **GitHub file-location wording/storage: passed.** Inline review run
  `e903e64c-a91d-404e-ab27-cc3483f8b95d` completed in 50.43 seconds. The result
  correctly says the file is on the private Paperclip task, not attached in
  GitHub. Independent inspection verified the stored 21 bytes are exactly
  `LUNA-FILE-LOCATION-OK`; SHA-256
  `907f14d2edb054321688372f2e96d43ee50f7f4093bf7a912ea675238de2d633`.
  [Visible reply](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/pull/3#discussion_r3954401548).
  This does **not** qualify native GitHub binary uploads, which the App does not
  support.
- **Telegram photo inspection: passed; wait/history follow-up: failed.** Run
  `53501280-d5b3-491b-9372-17e70fdbe839` correctly described the real uploaded
  orange cat photo in 23.23 seconds, but created a native completion review
  despite the explicit request to keep the task open and wait. Follow-up
  `7cfd468c-c29d-4099-9380-b05e834141f1` could not read/resend that stored photo:
  `list_chat_attachments` correctly rejected a missing authenticated chat
  execution binding. The upstream dispatch omitted that binding for
  `in_review` issues. The visible response honestly reported failure; the
  journey is not qualified.
- **Discord historical file inspection: not qualified.** Run
  `91cba10c-0fe2-4154-a831-a88cb5b4ee44` encountered the same reviewed-task binding
  problem. macOS then slept from 04:49:57 to 05:05:00 (903 seconds). Timeout
  cleanup durably interrupted the provider turn, but recovery at 05:06 retained
  its stale active-turn checkpoint and waited without progress. Rust provider
  state and authenticated PRP event 89 both record the exact interruption;
  there was no second active task execution. This wall time is not a valid Luna
  latency sample. The driver recovery and attempt-local timing defects are
  being corrected, not counted as a successful recovery.

The live failures expose gaps in otherwise-green fixtures. Follow-up work must
preserve real review/approval gates, add current-execution attestation without
pretending a reviewed task was checked out, accept an explicitly yielded chat
wait at the native completion boundary, and reconcile an already-terminal
provider turn without replaying its work. Retest these exact provider journeys
after deploying those fixes. Teams still needs the previously documented
work/school tenant and bot-registration/admin setup; personal Teams login is
not qualification.

### Corrections from those live failures

Recovery commit `d2c3e87d0` reconciles the exact previously active provider turn
before returning a recovered session. Native execution consumes a newly adopted
terminal without resending the original work and without checkpointing that
terminal before its event is durable. Tests cover completed/interrupted turns,
failed append followed by recovery, unchanged identities and exactly-once
finalization. Driver/backend/runtime coverage passed **299/299** during combined
integration (`native-recovery-root-05.log`); the expanded runtime suite alone
passed **74/74** and its typecheck passed.

Reviewed follow-ups now receive a distinct, server-minted chat execution binding
only after proving current run ownership and current endpoint, resource and
principal authorization. It is explicitly not checkout or approval; a real
pending governance interaction remains unchanged. Current/historical readers
retain their full permission checks. Pure same-issue status coalescence keeps
the exact admitted chat payload; changed source/comment scope cannot reuse its
authority. The reviewed binding has a five-second bounded retry for normal row
contention or the exact inbound delivery still finishing, releasing locks and
rechecking authority between attempts. Its focused real-PostgreSQL/prompt/reader
coverage passed **202/202**, with server and adapter-utils typechecks.

The explicit wait failure was also a tool-contract gap: the generic run-result
schema allowed a yield, but Codex's completion tool and runnerd rejected it.
`paperclip_finish` now accepts `yielded` only with a `response_wake` continuation;
an immediate `same_agent` continuation remains rejected. Tool fingerprint v6
rotates v5 catalogs. Focused runner checks passed **36/36**, resume checks
**31/31**, exact Rust admission checks **2/2**, and Rust format/TypeScript checks
passed. A broader Rust substring command overmatched unrelated ACPX port tests
and failed three host-port reservations; that command is not reported as green.

Preparation timings now begin at the current dispatch attempt, not the original
run start before sleep. Original queue/comment history and total elapsed run
time remain intact. The actual executor wiring and timing cases pass
**154/154** (`native-timing-root-01.log`). The combined full server/runner build,
including semantic contracts, generated catalogs, binary and replay golden
checks, passed (`native-followup-root-build-01.log`). Live requalification of
these corrections is still required.

An independent **73/73** safety/transcript check confirms native commentary,
reasoning, tool activity and timing are Board-visible but not copied into chat.
External surfaces receive safe lifecycle, authorized final replies, projected
questions and selected attachment handoffs. External progress remains coarse.
Same-bot uploads intentionally serialize, while independent endpoint lanes
avoid cross-bot head-of-line blocking. Eligible new Slack/Telegram long posts
still incur bounded synthetic streaming delay (about one second per 4,000
characters); edited working messages bypass it.

The inbound dispatch-order audit found a remaining durability concern: both
initial ingress and committed-link recovery can dispatch the wake before
subscription and the `processed` delivery transition finish. The bounded
reviewed-attestation retry mitigates that startup window, but is not an atomic
outbox. Reordering those writes naively would lose wakeups after a crash. A
separate delivery-bound durable wake-intent design is being reviewed; no claim
of full production readiness should omit this remaining race.

### Live follow-up qualification on `9c2c65ed3` (September 8, 05:33 UTC)

The server reported this exact clean revision after startup at 05:29:53 UTC.
Maya's runtime settings still showed `paperclip_runner`, Codex, and
`gpt-5.6-luna`; no fallback to Terra was made. The frozen native matrix passed
**1,371/1,371**, 36 files, 161.29 seconds
(`native-followup-root-tests-02.log`). Full chat integration passed
**288/288** on isolated PostgreSQL (`frozen-chat-integration-0908-01.log`).
The first native matrix had one restart-test timeout while a concurrent build
replaced its runner binary; the unchanged isolated case and full restart file
passed, followed by the successful frozen matrix. Do not rebuild runner
artifacts while real-process tests or retained live processes depend on them.

The live browser retest did **not** pass all journeys:

- Telegram `TG-LUNA-HISTORY-FIX-0908`, run
  `1b782683-55b1-4569-85ac-4f35fad63875`, proved the new reviewed-chat binding
  worked without checkout or changing the existing governance gate. However,
  `list_chat_attachments` returned an empty index. The existing photo had valid
  lineage and bytes but a null original filename, which the historical reader
  incorrectly excluded. The honest visible failure arrived after 57.25 seconds;
  no file was returned. A safe filename fallback now uses the attachment UUID
  and validated MIME extension, without changing bytes, hashes, or permissions.
  List/read/reuse and reviewed-binding regression coverage passed **29/29**,
  plus server typecheck (`unnamed-chat-attachment-02.log`).
- Slack `SLACK-LUNA-WAIT-FIX-0908`, run
  `3939c72d-0849-40ff-83b8-35ddd4f70728`, failed semantic completion and retried
  before showing the failure message. The actual Codex discovery output exposed
  `paperclip_finish(args: unknown)`: the new provider schema's conditional-only
  root `allOf` hid the concrete argument fields. The model consequently guessed
  incomplete arguments, including a continuation without its summary/key.
  GitHub `GH-LUNA-WAIT-FIX-0908`, run
  `ec29d6cd-fd66-40b3-a861-9a3a06028e44`, also exhausted semantic-result recovery.
  The provider schema now keeps its concrete object root with an equivalent
  direct `if`/`then`, preserving validation, and fingerprint v7 rotates stale
  declarations. Schema/driver tests passed **23/23** and resume tests **31/31**.
  Actual model-visible signature and live completion still require retesting.
- The old Discord run `91cba10c-0fe2-4154-a831-a88cb5b4ee44` remained visibly
  working after restart. Its retained process used the prior runner executable;
  the newly built controller expected a different executable digest, rejected
  authentication, then waited indefinitely while that PID remained alive.
  This is not Luna generation latency. The existing durable lease does not
  retain an authenticated historical executable digest, so relaxing the check
  would be unsafe. Recovery must time out explicitly, preserve evidence, and
  require ownership-safe recovery rather than silently launching duplicate work.

These live failures remain separate from passing automated tests. They are
included in the production-quality assessment, not hidden by successful run
status or a generic working indicator.

### Ownership-safe recovery and native runtime audit (September 8)

The actual Codex rollout `turn_context.model` confirms `gpt-5.6-luna` on both
the original Slack turn and its recovery, not merely the agent configuration.
The Board's native run inspector exposes canonical events and diagnostics;
private reasoning/raw tools remain Board-only. No Terra fallback was used.

The old Discord run finally failed at 05:44:58 UTC on the old server after its
15-minute controller timeout. Its retained PID was then absent. No historical
rows were rewritten and no manual process termination was used to manufacture
a recovery result. That behavior remains a failed qualification, not a pass.

New recovery handling bounds adopted-runner authentication without signaling an
unauthenticated process. Authentication timeout holds the run, task locks, and
environment ownership rather than treating timeout as proof that execution
stopped. It blocks automatic replacement, reaping, restart recovery and implicit
cancellation. Terminal writes use an atomic not-held predicate; cleanup occurs
only after a successful compare-and-swap. Resume queries exclude held rows
before their limit, preventing held rows from starving eligible work. This does
not exempt held runs from configured concurrency limits.

External chat receives one safe attention message with a Board recovery path,
not an indefinite working message or a false claim that the provider stopped.
Publication preflight cancels late queued/working updates and stale attention
updates before provider I/O, including overlapping sweeps.

Verification before deployment: full chat integration **292/292** on isolated
PostgreSQL (`ownership-chat-integration-root-02.log`); native executor, ownership,
teardown and restart cohorts **194/194**; heartbeat recovery/concurrency subset
**17/17**; the pre-limit starvation regression **1/1**; server typecheck passed.
Adopted transport tests passed **9/9**, real-process restart **8/8**. The safe
completion-hint Rust integration/module cohorts passed **31/31** and **26/26**.
These automated checks do not replace the pending rebuilt-server live retest.

An independent filesystem audit found a further boundary to harden: linked
native external tasks currently share the agent-home cwd, despite having
different native workspace IDs. File registration validates current task/run
and confined bytes but cannot prove another task did not produce a readable
file. No actual leak was observed or private file contents inspected. Task-scoped
native chat workspaces are being implemented; this issue and the previously
documented inbound durable-wakeup race remain open production-readiness items.

### Rebuilt live qualification on `981233481` (September 8, 05:58 UTC)

The full server/runner build, Rust release binary, semantic catalogs and replay
golden checks passed (`native-ownership-root-build-01.log`). Recovery stale-lock
tests also passed **14/14** on root's fresh PostgreSQL fixture; the subagent's
sandbox had skipped this cohort. The server restarted with no active Maya turns
and reported clean `981233481` at 05:58:05 UTC, ready at 05:58:10 UTC.

New real messages were sent through the signed-in provider interfaces:

- Slack run `e606f147-610b-4d19-ba79-bc5a37f9d816` completed in **17.90s** and
  GitHub run `a2f8192c-0d3d-4b16-801e-f9bddc73777b` in **19.11s**. Both accepted
  canonical `yielded` / `response_wake` with the exact requested marker and
  server decision `external_chat_response_waiting`, without semantic retries.
  However, both displayed only “Maya E2E completed this turn.” The response
  materializer still suppressed every yielded summary. The new narrow fix
  permits the canonical summary only after committed native response-wait proof
  and current durable chat authorization; generic control-plane waits and raw
  final prose remain suppressed. Resolver tests passed **41/41**, server
  typecheck passed. A live response retest remains required.
- Telegram run `0b0f20da-f92d-499a-abd5-a27ebcaa047d` now listed the exact earlier
  unnamed JPEG (221,327 bytes, unchanged SHA-256), proving the filename fix.
  Byte reads repeatedly returned `read_busy`; no photo was returned. Discord
  run `340b9802-9183-442f-b765-0a32827f1585` also found the original fixtures but
  could not read or prepare them. These runs' successful native termination
  does not mean their requested file outcome succeeded.
- A single-conversation Telegram retry reproduced the read refusal with no
  other active Maya turn. A bounded read-only PostgreSQL monitor observed the
  reader's NOWAIT check overlapping native event persistence on the run row.
  The reader previously treated any immediate lock miss as “policy is changing.”
  It now retries the entire authorization transaction for at most one second,
  rechecking current policy on each attempt and again after reading storage,
  without holding locks during backoff or filesystem work. Permanent revocation
  is not retried; cancellation stops the retry. Reader/reuse tests passed
  **26/26**, including brief run-row contention, revocation while blocked and
  cancellation during retry; server typecheck passed.

The simple completion latency improved substantially, but these visible output
failures still make the interaction quality unacceptable. No file delivery or
response-wake journey is marked qualified until the corrected server is tested
through the actual provider UI again.

### Cohesive native chat hardening before the next live retest

The native local workspace fix selects external tasks from durable task and
conversation state. Projectless chats receive separate company/agent/task
directories outside the legacy shared agent home; an existing provider process
with the old shared-root input is held, never silently migrated or replaced.
Project-backed local chats require a task-owned isolated worktree. Extra project
roots are not inherited into an external conversation. This complements the
native Codex root-denied permission policy; a different workspace ID alone would
not isolate readable files.

Inbound task/comment creation now also stages a durable wake intent. Attachment
ingestion and provider subscription finish before acceptance; acceptance and
intent readiness commit together, before scheduler admission. The action ID is
also the unique wake receipt ID. Retries repair the ledger without scheduling
twice, preserve the original actor, and recheck current access under the task
lock. A pending intent cannot be bypassed by generic stranded-task recovery.
Failed original authorization does not become valid merely because the external
account is linked later. Explicit Board reauthorization is not implemented in
this slice; no caller-supplied actor/source flag bypasses the guard.

The accepted native response-wait summary is now eligible for publication only
with committed finalization and current exact chat binding. Attachment tool
descriptions name all required arguments and bounds; the native tool-contract
fingerprint advances to v8 so resumed provider sessions get the new declarations.

Supporting verification on the combined source snapshot:

- Native-runtime directory: **1,253/1,253**, 33 files, 164.74s, including real
  processes (`native-cohesive-root-01.log`).
- Codex driver, completion schema and transport: **293/293**
  (`native-codex-luna-contract-root-01.log`).
- Response summary and native attachment catalog: **73/73**
  (`native-wait-summary-catalog-root-01.log`).
- Real PostgreSQL default-local workspace dispatch, retained legacy ownership
  and four unadmitted-intent recovery states: **6/6**, with 135 unrelated tests
  excluded (`native-workspace-outbox-recovery-root-01.log`).
- Deterministic browser contracts: **9/9** on their isolated fixture server,
  not live provider accounts (`chat-ui-native-followup-root-02.log`).
- Shared and UI typechecks passed. The full chat integration snapshot initially
  passed **286/294**; it exposed Slack slash-command fence propagation, replay
  expectations and receipt-aware fixture gaps. Those fixes and retry readiness
  regressions passed the focused cohorts. The final fresh PostgreSQL rerun
  passed **295/295** in 103.76s (`inbound-wakeup-full-11.log`), with durable
  scheduler **8/8** and targeted compatibility regressions **12/12**.
- Explicit Board wake attempts for four unadmitted-intent states now return an
  actionable 409 instead of silently doing nothing. Those **4/4** real PostgreSQL
  tests also prove no run, receipt, action rewrite or adapter execution occurred.
  This is not a reauthorization bypass.
- Full server/runner build and subsequent emitted server typecheck passed
  (`native-chat-cohesive-build-root-01.log`,
  `native-chat-cohesive-tsc-root-02.log`). The lockfile is unchanged.

These checks do not qualify the still-failing visible photo/file and final-reply
journeys. The next deployment and live provider outcomes are recorded separately.

### Live results on `78caec9f6` (September 8, 06:27 UTC)

The clean committed/pushed revision restarted at 06:27:37.664 UTC and reported
ready at 06:27:45.434 UTC. No Maya runs were active at restart. The historical
seven native recovery holds were left intact rather than rewriting old evidence.

- Slack `b3d8f284-36fe-4817-b556-3971246f0e75` completed in **14.71s** and
  displayed the exact `SLACK-LUNA-READY` reply, replacing its working message.
  [Visible reply](https://papercliplabs.slack.com/archives/C0BUT55N9RV/p1788848899973669?thread_ts=1788838921.759279&cid=C0BUT55N9RV).
- GitHub `2c41782e-cef3-4f6d-af68-a1d1c647a1d3` completed in **13.65s** and
  displayed `GITHUB-LUNA-READY` in the same inline thread, still present after
  reload. [Visible reply](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/pull/3#discussion_r3954971454).
  Both used `external_chat_response_waiting`, materialized one authorized final
  comment, and published into the existing working message. Their actual native
  execution inputs have separate task-owned cwd paths outside the agent home.
- Telegram `7aaded5c-2e90-40f7-bf2f-1a656afdcb69` finished in **32.53s** and
  reported successful original-photo inspection and exact-file preparation.
  However, its decision was `governed_response_waiting`; its visible message was
  still only “Maya E2E completed this turn,” with no delivered image. Discord's
  `485d2467-67f0-4f2c-9f01-0c5e131a2cf4` likewise displayed only completion and
  no files. Neither media journey passes. The current wait gate is being
  investigated without bypassing genuine approval or review authority.

The three-message Slack burst preserved order and delivered each marker exactly
once across two turns. Its wall time is not a valid awake latency benchmark:
macOS power logs record 174 seconds of sleep from 06:31:08 UTC, then 931 seconds
from 06:34:47 UTC. Those pauses account for most of the observed long waits.
At 06:51:46 UTC a 30-minute, process-scoped `caffeinate -is` assertion was started
for testing; it does not keep the display unlocked or change persistent settings.
The next two immediate Slack messages produced ordered, nonduplicate responses
with run durations **11.86s** and **13.08s** (`519f8c91-97d5-47fe-9b56-f004d4d2761c`
and `baff6436-526b-45a7-abdf-f75307ca2842`). The durable wake ledger contains one
receipt per input, including deferred and coalesced aliases; no input was lost
across the host sleep.

Independent tool evidence confirms actual `turn_context.model=gpt-5.6-luna` in
both new Telegram and Discord provider rollouts, not just saved configuration.
Telegram's historical reader returned the exact verified staged JPEG, and its
`view_image` call opened that same path. Reuse prepared attachment
`07e93350-24da-417b-a5f0-680e98815129` with unchanged source hash and size.
Discord read and inspected both original fixtures and prepared a 128-byte note
and 2,111,878-byte PNG with the original hashes. Its v8 calls used valid list
bounds, both read identifiers, all four reuse fields and stable idempotency
keys; native completion succeeded on the first try. Neither channel queued an
attachment publication. Both remained in review with no scheduled extra turn.

The blocking gate is a genuine pre-existing system-native completion review
whose `supersedeOnUserComment` is explicitly false. New chat input must not erase
or approve it. The follow-up fix separates permission to present the current
chat answer/files from permission to resolve that review.

The successful Slack run was also opened through the Board's native Runner
Inspector. Canonical events and final-presentation decisions are available with
raw capture off. The overview incorrectly labeled this state “Expired” beneath
a successful run. It now says “Raw capture off”; the live hot-reload retest,
UI typecheck and token gates pass. All **8/8** inspector tests pass after
explicitly selecting Overview before asserting its label
(`native-inspector-status-root-03.log`). No raw capture or credential exposure
was enabled.

### Review-preserving chat presentation and receipt recovery (September 8)

The follow-up separates a current authorized chat answer from resolution of a
pre-existing native completion review. A server-minted proof binds the committed
decision, accepted canonical result and assessment, exact review policy, causal
requester and destination. It permits only the canonical final summary and
selected files; generic governed waits, new questions/approvals, raw provider
output and forged markers remain private. Current permission, task status,
review policy and destination are rechecked at comment creation and transport.
A later valid chat wait under the same unchanged review does not invalidate
files already queued by an earlier turn.

Independent reviews also closed crash and contention edges: proof/result
projection is recoverable from the committed tuple, reconciliation materializes
the reply/files exactly once without resolving the review, and an atomic
ownership guard preserves a concurrently installed recovery hold. Completed
presentations take a cheap existence fast path, including operator-deleted
comments, so recovery neither recreates them nor repeatedly performs expensive
authorization transactions. Comment retries release all transaction locks;
pre-provider authorization contention is retryable, not ambiguous delivery.

The duplicate-ingress stress test initially exposed an omitted receipt on the
existing-message retry path. That path now recovers its idempotent reaction
only after a durable wake receipt. A deterministic endpoint-lock test proves
one comment, one wake and one visible receipt after the retry. The broader
duplicate storm test now permits only the specific transient lock error from
direct synchronous SDK callbacks and verifies the durable queue drains.

- Focused native review/recovery tests: **76/76**
  (`native-review-presentation-08.log`), including concurrent ownership holds,
  repeated crash replay, later same-review decisions and operator deletion.
- Full chat integration plus reviewed binding/interaction compatibility:
  **313/313**, including **296/296** chat integration tests
  (`native-review-chat-compat-root-02.log`). The earlier 311/312 result exposed
  the receipt-recovery defect and is not recorded as a pass.
- Both independent code reviews passed. The full native-runtime cohort passed
  **1,277/1,277** across 33 files in 81.62s
  (`native-review-full-root-01.log`), and emitted server compilation passed
  (`native-review-emitted-tsc-root-01.log`). These precede two narrow follow-ups:
  skipping redundant metadata restoration for the latest already-materialized
  decision and excluding only adapter-managed `paperclipRuntimeServices` and
  `paperclipRuntimePrimaryUrl` display fields from the otherwise unchanged
  context hash. Those final differences passed **78/78** focused tests
  (`native-review-presentation-09.log`) and server typechecking; changed causal
  wake data still denies publication.
  Live media qualification remains pending until the new server is restarted.

### Live media passes on `3ab1384f9` (September 8, 07:25 UTC)

The clean committed/pushed revision started at 07:25:36.405 UTC and was ready at
07:25:40.416 UTC. There were no active Maya runs at restart; all seven historical
recovery holds remained intact. The final emitted server compile also passed
(`native-review-emitted-tsc-root-02.log`).

- Telegram run `7a26a46f-931e-4394-b6a5-3596393c39d0` completed in **31.005s**
  on actual Codex `gpt-5.6-luna`. The original JPEG was read, viewed and reused
  with its unchanged 221,327 bytes and SHA-256. The canonical reply and image
  each published once to messages `417200359:76` and `417200359:77`, with durable
  outbound message links. Request-to-image delivery took about **36s**. The
  in-app browser visibly rendered the original orange tabby photo. The genuine
  completion review remains pending and the task remains `in_review`.
- Discord run `a4d3e502-9f49-4ae8-a639-9888f37e81e8` completed in **62.412s**
  on actual Luna. All six dynamic tool calls succeeded without malformed
  inputs. The 128-byte note and 2,111,878-byte PNG matched their original hashes
  and published to Discord messages `1546783913744146503` and
  `1546783919049809982`. The browser showed the native text-file preview,
  correct verification phrase and rendered cat PNG. The original human-only
  review remains unresolved; no additional run or monitor was scheduled.
  Power logs show no sleep in this interval: this is an awake latency result.
  Recorded tool execution accounts for 2.818s; the runner turn is 59.163s, with
  the remainder between tool calls attributable only to combined model/provider
  orchestration from the available evidence, not pure model inference.
- GitHub's post-deployment inline smoke run
  `ac222e50-07b3-4e30-a92c-97dfbe2324d0` completed in **12.75s** and the browser
  showed `GITHUB-LUNA-VERIFIED` after reload in the existing fixture thread.

Both media answers still include the model-time phrase “provider delivery is
not confirmed,” although transport confirms and displays the files seconds
later. This is not a delivery failure, but it is a remaining wording issue:
prefer neutral file labels and actual content over transport implementation
details, without asserting delivery before it happens. The native Runner
Inspector for the successful Telegram run shows 88 canonical events with raw
capture off; no private reasoning or raw provider trace was sent to chat.

The final Slack post-deployment smoke encountered a separate ingress delay:
provider message `1788852525.310329` is timestamped 07:28:45, but its Paperclip
delivery was not created until 07:30:23.026 and was processed at 07:30:23.794.
The final reply was displayed once as `SLACK-LUNA-VERIFIED` at bot message
`1788852624.382399`. Native run `7c2e2e0c-7522-428f-b5da-ca2e760cfb80` took
**11.305s**, with **12ms** queue time. The event was `subscribed_message`, proving
the subscription survived restart. The approximately 98-second gap precedes
durable admission, but that does not establish HTTP-arrival time: development
logs omit request duration/start and Slack retry headers. The gap remains
unattributed, not proven to be Slack or Paperclip initialization. The 07:34:06
repeat did not reproduce it: ingress took **0.526s**, queue time **10ms**, native
Luna run `abda130f-c886-4e39-b2fc-ceb921ebf136` **12.439s**, and total
message-to-final **15.004s**. `SLACK-LUNA-QUICK` published once on existing working
message `1788852848.668699`, with one delivery/wake/eyes action. The in-app browser
confirmed the exact final reply. Request-start/duration and retry metadata are
still needed to attribute a future pre-receipt outlier reliably.

### Timed ingress and transport revocation checkpoint (September 8, 07:48 UTC)

Committed/pushed `eb0cb2841` (file-answer guidance), `2924ec872` (local webhook
timing), and `fa3a0b63f` (real-database transport and admission regressions).
The clean `fa3a0b63f` process started at 07:48:25.276 UTC and recovery was ready
at 07:48:27.230. All seven historical recovery holds remained intact and no
Maya run was active at restart. The webhook-only public proxy remained running.

- Root's full chat integration passed **299/299** in 58.37s against fresh
  embedded PostgreSQL (`native-webhook-transport-full-root-01.log`). The three
  new transport cases build a genuine committed native review response and
  selected files, then revoke the original requester or change the exact gate
  before draining publications. All three parts cancel without a provider post,
  edit, upload or receipt lookup. A held policy row instead produces a definite
  pre-provider retry, then exactly one text and two file sends after release.
- Mounted timing/body-parser/route tests passed **10/10**; with the real Slack
  adapter/PG admission-failure case, **11/11**. Forged signatures and failed
  inserts never report a durable receipt. The accepted retry records its real
  committed row before acknowledgment. Events contain only closed numeric,
  timing, provider/row identity and bounded retry-hint fields; no body, URL,
  arbitrary header, credential or raw error is logged. This is local logging,
  not telemetry or externally exported tracing.
- File/prompt tests passed **123/123**, adapter compilation passed, and emitted
  server compilation passed (`native-webhook-presentation-emitted-tsc-root-01.log`).
  These tests do not prove the model will follow the wording guidance.

The first live Slack message after this restart, `SLACK-TIMING-0908`, gives an
actual HTTP boundary. Its provider timestamp was 07:49:22.930; HTTP arrived at
07:49:23.520. Cold runtime initialization took about **6ms**, the durable receipt
was recorded at **21.856ms**, and the 200 acknowledgment finished at **24.047ms**.
Run `2250a8ec-52d0-40c4-a65c-200e94010a79` took **11.861s**. The single final
`SLACK-LUNA-TIMED` was visible and published at 07:49:37.302, **14.372s** after
the provider message. The earlier 98-second outlier did not recur; its historical
cause remains unknown rather than retroactively attributed by this new sample.

GitHub's inline `GH-TIMING-0908` returned `GITHUB-LUNA-TIMED` visibly in the
same fixture thread. Run `db757de7-0f20-456a-9aa4-6c0adf0babf1` took **14.932s**.
The webhook durably staged ingress and returned 202 in **82.379ms**, then
initialized the runtime and admitted the message asynchronously under the same
diagnostic request identity. No repository operation was requested or performed.

Both native file retests delivered once: Telegram run
`bf0eb51f-bc9e-49c2-9827-212fa4a3bcbb` took **38.171s**, with text/image messages
`417200359:82` and `417200359:83`; Discord run
`afc3ad5d-6c63-468a-bd83-e90cb57c5490` took **63.188s**, with the original note
and PNG at `1546789814529957918` and `1546789820725071932`. The in-app browser
showed the images and Discord's note preview. The wording retest **did not fully
pass**: Telegram retained prepared/waiting boilerplate and Discord still said
provider delivery was unconfirmed. Scoped boolean checks confirm the updated
guidance reached both actual Codex user-input messages, not just stored server
context. This is an instruction-following/wording defect, not a failed file
transport or missing-prompt claim.

### Native answered-question continuation defect (September 8, 07:43 UTC)

On the earlier deployed `3ab1384f9`, Discord and Telegram each received a natural
request to choose Amber or Cobalt through a clickable prompt, then return only
the chosen color. Actual `turn_context.model` records for all four source and
continuation runs are `gpt-5.6-luna`.

- Discord source run `f93e89a8-6e36-447f-b523-11d7853be886` produced interaction
  `00de7efd-2876-45d1-91a4-0cf6e5a15722`. One Cobalt click settled the visible
  card to **Answered: Cobalt** and queued exactly one response continuation,
  `a54a834d-55b1-4f0c-8a9a-941de93a4471`.
- Telegram source run `c8b117fc-caf8-41d6-810c-b1d70e32e501` produced interaction
  `40e22877-3354-46b0-a033-48458ab28373`. One Amber click removed the keyboard,
  showed **Answered: Amber**, and queued exactly one continuation,
  `5628e9a3-e3c4-4fb2-8b46-1463a15f92e9`.

The continuations succeeded in 14.952s and 15.619s, but both provider finals
said **Maya E2E completed this turn** instead of the selected color. Their
accepted semantic summaries contained workflow bookkeeping, and no authorized
review-preserving presentation proof was minted. The exact source-comment
lineage survives, but the `issue.interaction.respond` wake is not recognized as
an authenticated external answer for prompting and presentation. Separate human
completion reviews remained pending and must not be bypassed by the repair.
This is a failed end-to-end answer scenario, despite successful cards and
exactly-once response delivery. A narrow attested-continuation fix is in progress.

### GitHub inline edit audit (September 8, 07:55 UTC)

Edited only our existing comment `3955555016` through GitHub's **Edit comment**
UI, appending harmless marker `GH-INLINE-EDIT-0908`. The update was saved at
07:55:19.257 UTC. Paperclip received one `message_updated` event
`f373ca14-06b8-4c86-971d-3d15e0538272` and processed it at 07:55:21.673.
It appended correction comment `964922f1-c620-433f-ae40-d130d31a4f0b` to the
existing `CHA-10` task and preserved the original comment. No new run was
created. GitHub visibly retained the corrected text. In Paperclip's `CHA-10`
activity, expanding **System update · An external message was edited** showed
the same correction and marker. No PR code, review resolution, installation
or repository settings were changed.

### Native answer repair checkpoint (September 8, 08:05 UTC)

`5d329ba4d` fixes Discord terminal-card edits to send explicit empty components,
so Discord removes answered controls instead of retaining the previous buttons.
The adapter patch passes **39/39** tests and applies cleanly to pristine 4.39.0;
the patched scratch module matches the installed module. The combined root
Discord/prompt/file cohort passed **167/167**.

`fb905c844` adds a distinct server-attested native answered-question path. It
binds the exact source run/comment, processed provider choice, canonical answer,
durable response receipt, target wake/run, current linked actor and destination.
The marker alone grants no authority. Finalization and transport revalidate it;
lost authorization is revoked rather than an excuse to schedule generic work.
The existing human completion review is preserved. A real PostgreSQL overlap
test verifies advisory-before-identity locking during concurrent unlink.

The focused native files passed **58/58**, server typecheck passed, and the
independent guard review found no remaining blocker in this bounded repair.
Root separately passed **299/299** chat integration tests, shared/UI typechecks,
adapter compilation and emitted server compilation. These are installed-tree
checks, not clean frozen-install qualification.

This repair currently covers a single-choice provider answer sourced from one
direct-chat comment. Questions created by an already resumed answer turn and
multi-comment source batches are deliberately not covered; arbitrary sequential
question chains remain a release gap. Live requalification of the repaired
answer, Discord controls and wording is still required at this checkpoint.

### Live native answer repair passes (September 8, 08:06–08:10 UTC)

The clean `bb7531a4a` process reports that version from `/api/health`. Root's full
native runtime suite passed **1,305/1,305** across 33 files in 86.90s before
restarting the idle live server; the verified webhook proxy was left running.

- Telegram source `06225db3-09bb-4dfe-bb77-150146497b8a` created the clickable
  question in 10.072s. One Amber click settled interaction
  `600c46ba-26dc-4c7a-a495-1d6247d00e0c`. Continuation
  `b0aa2657-2541-405d-b2bc-be1c553dc2f4` took 14.412s and visibly returned exactly
  **Amber** at `417200359:86` (08:07:24.682). The answer keyboard disappeared.
- Discord source `431d7909-fc69-49b6-9077-08cd033681a5` created its question in
  25.738s. One Cobalt click settled interaction
  `02a31169-ebfe-4fcb-b21f-1e2141b07f7a`. Continuation
  `03b4aee5-a6b5-4f59-b580-6a232ba26934` took 16.460s and visibly returned exactly
  **Cobalt** at `1546794131576197221` (08:07:57.437). The settled card had no
  choice buttons. Publication `40787c5c-d413-46b2-ad90-d21f209c7476` encountered
  one definite pre-provider policy-lock retry, then updated the same work
  message once; it was not an ambiguous delivery or duplicate response.

Both answer deliveries had one attempt and zero errors; both continuations have
persisted answer attestation and authorized presentation. The separate original
human reviews remain pending with no resolution timestamp. An independent check
of actual Codex `turn_context.model` events confirms `gpt-5.6-luna` in all four
source/continuation runs, not merely in the agent's configured model.

The Telegram answer run page shows **PAPERCLIP RUNNER openai / gpt-5.6-luna**,
the canonical **Amber** result and 51 events. Its Runner Inspector works with
raw provider capture **off**, exposing canonical events and persisted
presentation decisions privately in Paperclip. External chats received the
selected answer, not private reasoning or tool events.

The stronger wording instruction still did **not** fully pass the live media
retest: Telegram `71c44d92-9026-436e-ad03-384a44494e7e` (30.960s) retained
prepared/waiting boilerplate; Discord `1a7341d9-4f54-43ec-a868-050c3dfcb91d`
(70.375s) still added an unconfirmed-delivery caveat. Their original files were
visibly delivered once, all on publication attempt one: Telegram image
`417200359:89`, Discord note `1546794573777604631` and PNG
`1546794580345749514`. Transport passes; model wording remains a quality gap.

The independent earlier-file latency audit attributes the Discord/Telegram
25.017s difference mostly to provider/model time between additional inspection
and reuse steps, not scheduling. Explicit provider-start queue was 117–162ms.
Discord's 63.188s run comprised 1.934s startup, 51.378s provider/model residual,
4.231s preceding tools, 0.194s finish tool and 5.451s settlement. That settlement
includes the deliberate five-second semantic-result grace before controlled
provider cancellation; reducing it requires a separate correctness proof for
durable suffixes and session suspension. These overlapping runs are one workload
sample, not a controlled model benchmark or proof about the earlier 98s outlier.

### Atomic chains and completion-field contract (September 8, 08:24 UTC)

Committed/pushed `67bdc52f4` for bounded sequential questions and `161212685`
for completion-field descriptions. Root passed **1,322/1,322** native runtime
tests, **299/299** chat integration tests, **89/89** runner completion/actual
Codex transport tests, **33/33** checkpoint tests, emitted server compilation,
and runner TypeScript build. The deterministic chat browser suite also passed
**9/9** (all five setup flows and four Board file-batch recovery states).
No Rust binary, generated protocol artifact or lockfile edit was needed.

Chains now support at most eight linked single-choice answers from one original
direct-chat comment. Every ancestor is reconstructed from durable answer/action/
delivery/wake records and current identity/reach; cycles, duplicates, altered
ancestors and a ninth hop fail closed. Authorization and response materialization
share a short nonblocking-lock transaction. A real PostgreSQL barrier test
blocks a coherent answer/action/receipt rewrite until the authorized input is
captured, then rejects the changed chain on the next read. No provider I/O holds
those locks. Answers enter the existing immutable native execution input used
for replay; this is not a zero-persistence claim and creates no extra durable
wake/chat/task answer copies.

The clean `161212685` live process reports the correct loaded health version.
All four real provider-session declarations contain the updated completion
schema and description. The existing fingerprint mechanism correctly starts a
new Codex session with full task context while retaining each Paperclip
conversation, task, attachments and audit history. Actual `turn_context.model`
events confirm `gpt-5.6-luna` in all four initial runs and the Discord correction.

- Slack `3b9b46c4-e636-4a2f-8240-3cc126fc329c`: 14.864s run; exact visible
  `SLACK-LUNA-CONTRACT-READY`, one publication at 08:24:38.554.
- GitHub `2ac53402-2024-4203-b4d9-fea5fa21cdf0`: 13.299s run; exact visible
  `GITHUB-LUNA-CONTRACT-READY` in the same inline fixture thread, comment
  `3955842490` at 08:25:03.120. No repository operation.
- Telegram `3e644cd2-b25a-4c5d-affc-22ff161b9ea1`: 41.235s run; original photo
  visibly delivered once at `417200359:92`. Waiting/unconfirmed-delivery wording
  disappeared, but an unnecessary prepared-attachment sentence remains.
- Discord's initial sequential request `b747a717-e0ff-4a84-88c6-91f9ec6a7bfc`
  did **not** create a native question: its canonical summary fabricated relative
  choice links, which the safe renderer reduced to a text list. A natural
  correction `37800c84-281e-486f-9e63-15241221f6c4` then used `paperclip_block`
  and falsely claimed the choice interaction was unavailable. Neither run
  invoked `request_human_input`; no question interaction was created.

The actual Discord session's 23-tool declaration does contain
`request_human_input`, including its required fields and question interaction
kind. This is not a missing-tool or provider-outage finding. Its current live
description says **active mock task**, and the native chat prompt gives no
structured-question exception to the zero-API text shortcut. Production
descriptor/guidance correction and another live test are required; these failed
requests do not qualify sequential interaction behavior.

The next correction keeps the generic mock catalog unchanged and overrides only
the real authority's advertised description. Native external-chat guidance now
explicitly selects the real structured-question tool, forbids fabricated answer
links, and explains one-at-a-time continuation. Its documented argument shape is
`payload.questions`, matching the production authority and declared schema;
there is no `questionSpec` argument. The retained-tool fingerprint advances to
v10 so already-open Codex sessions receive the corrected declaration without
resetting Paperclip task history. Root's combined prompt/authority/checkpoint
suite passes **56/56**, with server typecheck passing. The real authority test
creates the documented question on an in-review, human-review-required task,
replays it idempotently, and verifies the original task/review state and one
audit event. Live requalification is still required.

### Live sequential questions pass (September 8, 08:38–08:40 UTC)

The clean `7df7d4ca1` live process reached startup-ready at 08:38:32.585;
the verified webhook proxy stayed running. Root repeated the same natural
two-question request in the existing Discord and Telegram conversations.

- Discord: source `1e79740e-670f-4926-8752-a65bd06ae9a4` took **10.192s** and
  displayed real Amber/Cobalt buttons. The Cobalt click at 08:39:12.587 settled
  `dd3a3984-0844-498c-bd52-0ec519cba4eb`. Continuation
  `a7a34328-1dfb-44a4-8134-a78faaa2501f` took **15.268s** and displayed a new,
  separate Apple/Pear question (`303e8bba-7d8f-4c4e-8a38-61d4e7d72531`).
  The Pear click at 08:39:42.027 led to
  `5c5394c1-0ec1-4bf3-817c-357076b28513` (**19.009s**) and exactly
  **Cobalt Pear**, visibly delivered once at `1546802203795390525`,
  08:40:04.504 (publication attempt one).
- Telegram: source `926f9adb-1d73-407d-9da7-e8e9a65b1329` took **9.071s** and
  displayed real Amber/Cobalt buttons. The Amber click at 08:39:21.032 settled
  `f374a67e-f48f-4097-b3bc-cc318937ce96`. Continuation
  `cb7468ef-5ccc-4203-ad7d-13aed9b1f388` took **13.344s** and displayed the
  separate Apple/Pear question (`1be9f0f0-0335-4e71-bd82-509c7bc4bc16`).
  The Apple click at 08:39:55.677 led to
  `5742e514-7e3f-464c-80cc-0d7ed41c7c04` (**17.804s**) and exactly
  **Amber Apple**, visibly delivered once at `417200359:96`, 08:40:16.984
  (publication attempt one).

Both provider UIs removed the controls from each answered card. There were
exactly two questions and three runs per conversation, with no duplicate answer
or follow-up work. Screenshots show the resulting cards and final Discord
answer; Telegram's settled answer was verified in its live accessibility state.
The original independent human-review interactions remain pending with no
resolution timestamp. These journeys pass functionally and the interaction
experience is substantially improved: actual controls, one question at a time,
visible working feedback, and a concise answer preserving both selections.
All four answer deliveries have one claim attempt, zero errors, and exactly one
fallback-wake target. Both tasks remain in review.
An independent audit of actual Codex rollouts confirms **gpt-5.6-luna in all
six turns**, four real `request_human_input` calls using `payload.questions`,
and two real `paperclip_finish` calls yielding to `response_wake`. All four
provider-session declarations contain the corrected real-task question and
completion descriptions. Each channel retains its task-scoped workspace;
the first question uses a fresh provider session and the two answer turns
share a resumed provider session. No Terra substitution occurred.
The final-answer click-to-publication times were **22.477s** (Discord) and
**21.307s** (Telegram), distinct from run duration and not a general latency SLO.

An independent source audit also confirms the native tracing boundary: rich
run events and the Runner Inspector remain private in Paperclip. External
providers currently receive only coalesced queued/working/waiting/completed/
failed milestones, authorized final responses, files, and supported question
controls. Raw tool activity is not relayed. Long turns still have coarse
"working" feedback; richer public progress would need its own closed,
cadence-limited phase mapping, not forwarding Board snippets or tool names.

One run-log timing presentation gap remains: the final Discord run's
`task.run.measured` span reports 69.091s because its start comes from the
original provider comment at 08:38:49.891, including the preceding question
and human-answer wait. The current run actually starts at 08:39:42.527 and
finishes at 08:40:01.536 (19.009s). This is an ambiguous aggregate-span label,
not evidence of a 69-second current model call. The latest run and its private
Runner Inspector are open in the Board for inspection; raw capture stays off.

### Current-answer timing and live media recheck — 2026-09-08

Commit `8becccc10` corrects the question-continuation timing boundary. The
server exposes the latest answer's timestamp only after its existing durable
authorization transaction commits. That attempt-local value creates
`question_response.to_run_created`; it is not persisted into wake authority,
markers, or telemetry. Original comment provenance and ordinary/retry timing
remain unchanged. Root independently passed **108/108** trace, question-wait
authorization, and redaction tests (`question-timing-root-01.log`). The author
also passed the two actual-executor timing cases and direct server TypeScript
checking. Live verification of the new timing boundary is still pending.

On deployed `7df7d4ca1`, the real Discord media run
`ffb87912-bede-4465-b894-414fd47b38e6` returned the original 128-byte note and
2,111,878-byte PNG with matching hashes, once each. Browser inspection shows
the note's “cobalt otter 47” phrase and the actual orange-tabby image. The
brief response describes pale green eyes and a pink-and-blue cushion without
an unconfirmed-delivery disclaimer. Run time was **43.575s**, with the final
image published **50.234s** after the request.

Slack run `4347cb30-40d2-4ee3-b42e-ec50550d061e` likewise returned the original
128-byte note and 2,088,249-byte PNG with matching hashes and single-attempt
publications. Both the file preview and full-size image were inspected in the
signed-in browser. The retained original filename contains “telegram”; the
hash matches this Slack conversation's own upload, not another conversation's
file. Run time was **68.388s**, request-to-image **78.952s**. The text still
says “prepared below,” a minor wording weakness despite successful delivery.
For these two runs, `heartbeat.queue` was 10ms each, runner startup was
1.30–1.45s, and `agent.turn` was 41.553s / 66.697s. These file-work timings
must not be represented as queue delay or compared directly to simple echoes.

GitHub run `9fa4bd36-21f1-4cee-b63a-c1f6fa946314` produced
`github-file-proof-0908.txt` on the same review-thread task. The visible Board
file controls work, and a read-only local content-route check returned HTTP
200 with exactly 18 bytes, no newline, and SHA256
`ec122da672aaa0e82dff8877c0240be2c3d5eab7f4f9545dae73d4d513347703`.
The provider's fallback comment `3956106559` settled once at 08:55:14.201Z,
but had no useful Open task link because this instance advertised loopback.
The private Board also shows repeated model workspace/filename typos during
the 54.155s run; this is a model-quality cost, not transport queueing. A
closed-metadata audit of all three actual Codex rollout windows confirms
`gpt-5.6-luna`, not merely the configured model. GitHub made seven tool round
trips: five commands, file registration, and completion. Two commands supplied
the wrong workspace and one returned a missing-file error. The failures
themselves returned in 29–64ms, while failure-to-next-call intervals summed
to 19.148s. The applied file receipt correctly says `paperclip_task_only`.

The local launcher's canonical Board URLs now use the existing private
Tailscale HTTPS origin, while the public webhook-only Funnel remains on
`:8443`. Before restart, read-only checks verified private Board task/health
HTTP 200 and public Funnel task HTTP 404. No routing, audience, credential,
or public Board access was added. A fresh provider fallback-link check remains
required after restart.

GitHub's official CLI upload implementation explicitly excludes App tokens;
using a personal-token uploader is not an acceptable chat-identity workaround.
Public inbound attachment ingestion is being implemented separately from the
still-unsupported private inbound and native App upload cases. New work also
adds closed, cadence-limited native progress without relaying event payloads.
Neither in-flight change is counted as live-qualified here.

`origin/master` was fetched to `297d8741f5f192c66abbec325b1e956cf0e5e667`.
The two new code changes after the previously integrated `d8b958053` are
awaiting reconciliation; the explicit no-lockfile-edit constraint remains.

The isolated deterministic browser suite passed **9/9** in 2.2 minutes
(`chat-ui-native-progress-root-01.log`): all five provider setup/management
flows and four file-batch delivery/reload recovery scenarios. It used a fresh
throwaway instance on port 3199, not the signed-in live accounts or port 3103.

The frozen safe-progress/public-GitHub implementation then passed the full
chat integration suite **309/309** on a fresh embedded PostgreSQL fixture
(`chat-progress-github-full-root-01.log`), plus root direct server/shared/UI
typechecks. Safe progress passed **34/34** unit cases and **6/6** focused
database cases, including exact 19.999s/20s boundaries and same-phase
suppression. Independent review found no additional privacy or ordering
blocker. Provider prose comes only from exact event-type constants; selectors
do not read native event messages or payloads. Existing final/question/current
reach fences and the single working-message lane remain in place.

GitHub's focused cohort passed **156/156**, including 50 new helper tests;
four restarted-ingress database cases cover public bytes, private 404,
21-reference omission accounting, and abort without subsequent fetches.
Independent review caught the original silent overflow, which is now fixed.
Downloads are credential-free with pinned public-network egress, bounded
redirects/bytes, per-file timeout, and a shared 60-second download-batch
budget. This is not a hard total admission deadline: storage and bounded DNS
resolution have their own costs. Only canonical source-bound URLs and a
bounded omission count survive restart; signed redirects remain ephemeral.
This checkpoint still requires live deployment and provider qualification.

### Deployed native progress, GitHub intake and private task links — 2026-09-08

The pending deployment above was completed on `78a7e668e` at 09:18:46Z.
The freshly rebuilt and staged release runner includes the Rustls startup
fix. Health reports `2026.831.0+443.git.78a7e668e`, private exposure and
ready authentication/recovery. The seven pre-existing recovery holds were
not altered. The live server remains on port 3103; the public Funnel still
terminates at the webhook-only proxy, not the Board.

Code-only upstream reconciliation is now complete through fetched
`297d8741f`: commits `b0b7dcd2f` and `78a7e668e` incorporate the Rustls and
duplicate-GitHub-account changes. Conflict resolution preserves the chat
branch's low-trust, taskless, malformed-task and current-capability denials
as well as upstream's duplicate-grant cases. Root passed **44/44** credential
cases, **2/2** launcher cases, **2/2** Rust startup cases and direct server
TypeScript checking. An initial credential rerun exposed missing imports
in the conflict resolution; those imports were restored before the successful
rerun and commit. `pnpm-lock.yaml` retains the SHA256 recorded above; this
does not close the frozen-install gate.

The signed-in browser then exercised real Slack, Telegram and GitHub turns
concurrently. Their run durations were **55.651s**, **33.111s** and
**36.815s**, respectively; queue times were **9–12ms**. Each working message
was edited in place through safe native phases and the final answer:

| Provider | Single reused working/final message | Observed phases                                 |
| -------- | ----------------------------------- | ----------------------------------------------- |
| Slack    | `1788859193.862669`                 | working → making progress → using tools → final |
| Telegram | `417200359:98`                      | working → making progress → final               |
| GitHub   | `3956321476`                        | working → making progress → final               |

Every publication attempt was one. Files use their separate existing
delivery messages: two in Slack, one in Telegram and one GitHub fallback.
Slack's “making progress” state was also witnessed directly before its
final response. No raw reasoning, tool names, arguments or event payloads
were projected into these provider messages.

Slack run `f891e0fd-cfb1-4dc5-9b83-79845ec45508` delivered the newly created
`cat-summary-0908.txt`. The real Slack preview contains “cobalt otter 47,”
orange tabby fur with darker stripes, and pale green eyes with a white
muzzle. The original image is visible both inline and at full size. Its
retained filename still contains “telegram,” as explained above; it is this
conversation's original uploaded file. The final prose still says “prepared
for this response,” a wording weakness despite the visible successful files.
The summary is 172 bytes (attachment
`c08366b4-d921-495e-9f94-3c2422d282dc`, SHA256
`150ad534f83b7562113eeafbcf9aab0ae4d6a9dff6a5e4539c52a41121224ec2`).
The returned PNG is 2,088,249 bytes with the original SHA256
`005f8dabdb19ef786c0e2e76695596d22c1d0bb53de374e0be209cc6d89851c9`.
The final answer published at 09:20:49.361Z, summary at 09:20:51.102Z and
image at 09:20:56.469Z, about 65.2 seconds after the request's Slack timestamp.

Telegram run `ff689ddb-9011-42c6-9b09-b7931a6e6490` describes the original
orange tabby's pale green eyes and white whiskers, then returns an actual
photo visible in the conversation. It likewise uses cautious “prepared”
wording. These samples establish working file delivery, not a guarantee
that every model description or delivery phrase is polished.
The returned JPEG is 221,327 bytes and retains its original SHA256
`1d22f8c026abf16ff0dde087d6c46a3b4a41978cfb4cee62c62e159e5550ce8a`.
The final answer published at 09:20:40.036Z and image at 09:20:41.274Z,
36.889 seconds after the browser send action. Its reuse receipt is anchored
to the original attachment and comment in this same conversation.

GitHub's current message deliberately supplied two different attachments:
the public Paperclip README's WebM and a newly uploaded non-sensitive text
fixture in the private test repository. Run
`809d3630-f9dc-4346-98f2-59f05e56fe2e` received only the public WebM:
**video/webm, 2,658,275 bytes**, SHA256
`8214cfb8604ffa39f2150044e56b652985e1f41481c67023ee92a7953296ebbf`.
The exact current-comment omission is `download_unavailable: 1` for the
private text fixture. No private file was stored, no older attachment was
substituted, and the final provider response explicitly said that file was
unavailable and not inspected. The inbound delivery processed once.
The final answer published at 09:20:48.841Z and the file fallback at
09:20:49.931Z, 45.471 seconds after the browser submit action.

The returned WebM is saved as attachment
`469d4c9a-25a3-48cd-8918-f18c84224f14`. Clicking GitHub's actual fallback
link reached the private Tailscale Board and its correct CHA-10 task. The
visible file control leads to the attachment content route, whose read-only
HTTP check returned 200, `video/webm`, the same 2,658,275 bytes and the same
SHA256. Public intake and the private task-link fallback are therefore
live-qualified for this sample. No public image intake sample passed yet.
Private GitHub intake remains unqualified/unavailable on this path; this
is not a claim that all possible GitHub authentication approaches are
inherently incapable of downloading it. Native App outbound attachment
upload remains a separate platform limitation. No personal-token workaround
or repository-visibility change was introduced.

### Live current-answer timing verification — 2026-09-08

Discord source run `0536fbbe-038b-4dd5-8c13-16b7508a4f05` asked the real
Sunrise/Moonlight question. Interaction
`9b65e988-95c0-4cd1-85c7-10696adb2d8e` was created at 09:20:01.035Z and
resolved by the real Moonlight button at 09:21:19.289Z, deliberately leaving
**78.254 seconds** of human-answer time. The provider card visibly changed
to “Answered: Moonlight,” with no remaining choice buttons, followed by one
final answer containing exactly `Moonlight`.
The question's provider publication at 09:20:01.906Z makes the visible-card
to-answer interval 77.383 seconds. The settled final published at
09:21:36.768Z, **17.842 seconds after the browser click**. Both the question
resolution and continuation final edited their respective existing messages;
every publication attempt was one.

Its one answer delivery had one attempt, zero errors and one fallback-wake
target: continuation `3cfc11a2-33c1-4a76-9bec-27370fb49b11`. That run was
created at 09:21:19.305Z, started at 09:21:19.314Z and finished at
09:21:34.927Z: **15.613 seconds** of run wall time. The measured spans are
`question_response.to_run_created` **16ms**, `heartbeat.queue` **9ms**,
`task.prepare` **2.059s**, `agent.turn` **11.025s**, and
`task.run.measured` **14.446s**. No `comment.to_run_created` span appears.
The aggregate trace correctly excludes the earlier human wait; it is not
represented as a 92-second current response. The aggregate span and the
complete persisted run wall time have different terminal boundaries and are
reported separately here.

A closed-metadata audit of the actual Codex turn contexts confirms
**`gpt-5.6-luna` for this continuation and all three new media runs**, not
only an agent configuration value. Native Runner remains the driver; no
Terra substitution occurred. This test-it-for-real pass materially shaped
the changes: genuine provider controls, visible delivery and timing from
the current answer were checked beyond the deterministic test results.

### Live Slack cancellation and Discord DM isolation — 2026-09-08

These tests used the deployed `78a7e668e` server and the same Maya E2E
`paperclip_runner` agent configured with `gpt-5.6-luna`; both new Discord
runs and both Slack runs use `codex_app_server`. No model substitution,
provider API shortcut, or direct database mutation was used.

Slack's real **Stop maya-e2e** button was clicked at 09:30:43.635Z during
run `59e58412-630f-47ea-a420-3531f473f7d6` on CHA-21. It immediately became
disabled and showed “Stopping maya-e2e…”. The run finished cancelled at
09:30:44.307Z with `native_session_interrupted`; audit
`7471b687-6be4-4f81-9673-c6361c0f0448` records
`chat.slack_session_stopped`. The existing working message
`1788859829.322089` changed to “Maya E2E stopped at your request.” at
09:30:45.262Z. No requested long checklist leaked out after cancellation.
One fresh follow-up in the same provider thread started run
`21fb27ed-3082-4f1f-ac17-a610cb52da52` and returned exactly
`SLACK-STOP-RECOVERED` once at 09:31:20.505Z, **15.298 seconds** after the
browser send action. Its working/final message ID is `1788859867.497279`.
Every publication attempted delivery once; the task remained open.

The first Discord DM failed at Discord itself: Clyde rejected it and
Paperclip received no DM delivery. Although Paperclip's endpoint already
allowed DMs, Clawd's per-server **Direct Messages** switch was off.
This is a documented independent provider constraint in
[Discord's DM troubleshooting guide](https://support.discord.com/hc/en-us/articles/360060145013-Why-isn-t-my-DM-going-through).
Temporarily enabling that switch and reopening the bot's Message action
allowed the actual test. The switch was subsequently restored to **off**;
Message requests returned to its original disabled/off state. Share my
activity and Activity joining remained unchanged. Paperclip's existing
Allow direct messages setting was not changed. A short Discord-only hint
now explains this prerequisite beside that setting.

The accepted DM at 09:42:36.338Z created conversation
`77234abc-885e-4420-a097-fb39959ea2b4` and a **new CHA-25 task**
(`b76d64f5-2edb-442a-8cb8-0fb9e8a4733b`), not the guild thread's CHA-4.
Source run `a983a99b-1139-481a-bdff-64bb9ad52c2a` displayed genuine
Maple/Cedar choice buttons at 09:42:48.723Z. Clicking Cedar once at
09:43:06.039Z changed that card to “Answered: Cedar.” and removed its
choices. Continuation `8535a5c5-9ae4-41d6-818b-ee0534192bf6` succeeded;
the final message contained exactly `Cedar` at 09:43:23.991Z,
**17.952 seconds after the click**, editing working message
`1546818157036048445`. Every publication attempted delivery once and
CHA-25 remained open. The direct conversation is inspectable at
[the Discord DM](https://discord.com/channels/@me/1546815225334865972).

Teams Developer Portal was rechecked at `https://dev.teams.microsoft.com/apps`;
it currently redirects to a fresh Microsoft sign-in page. An eligible
work/school tenant and its app-upload policy are still required, as described
in [Microsoft's prerequisites](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/tools-prerequisites).
No Teams bot event or successful live Teams qualification is claimed.

### Verified hardening and live restart — 2026-09-08

Commits `230ebb1ce` and `f5066ecac` add current-authority-fenced private
GitHub image resolution, suppress terminal runs' stale queued/working/native
progress, and preserve provider-specific file preparation guidance after a
durable external question answer. File effects and receipt replays revalidate
the actual answer chain and current endpoint/principal; a wake marker alone
does not grant file authority. Independent reviews covered both authority
changes. The GitHub resolver's supported boundary is documented separately in
`2026-09-08-github-private-attachment-authority.md`.

Verification after the combined changes: **316/316** chat integration tests,
**85/85** native external-wait tests, **180/180** focused GitHub SDK/egress/input
tests, **9/9** deterministic browser tests, shared/server/UI typechecks, and
token gates. The first combined runs were not clean: four legacy progress
fixtures assumed working messages could still be sent after terminalization,
one global wake spy observed another company's valid retry, and a fixed-delay
contention assertion sampled a legitimate short retry transaction. Fixtures
now publish initial progress while their runs are active, the wake assertion
checks its own company, and the contention test observes the actual rollback
boundary and verifies issue/coordinator/interaction locks are available there.
No production authorization was weakened to satisfy these tests. Broad
workspace tests/build and frozen-install validation are not claimed here.

The live server was gracefully restarted with no running/queued company runs.
Health reports clean commit `f5066ecac`, private exposure, and ready recovery.
The seven historic recovery holds were not changed. Telegram question run
`7191fb31-7802-42f5-8fae-bb0d56b452e6` had already displayed an actual
Original photo / Small note choice before restart. Its existing provider card
`417200359:101` survived. Clicking Original photo at 09:50:52.325Z started
one continuation, `533fb22b-0a68-451d-803e-cf0252e53bf6`, on the same CHA-24.
The old card changed to “Answered: Original photo.” The new working message
`417200359:102` displayed safe progress and became the concise final
**Original cat photo**. A real photo then arrived as `417200359:103` at
09:51:32.734Z: **40.409 seconds after the click**, including file delivery.
Every publication attempted delivery once. Attachment
`f638d678-2d7f-46b8-ab27-4ee0faa85282` is the exact original JPEG:
221,327 bytes, SHA256
`1d22f8c026abf16ff0dde087d6c46a3b4a41978cfb4cee62c62e159e5550ce8a`.
The response no longer adds a routine “prepared” caveat to an ordinary
successful native image reply.

The first live private-image attempt on `f5066ecac` still failed intake.
GitHub review comment `3956584966` supplied only a newly uploaded image;
run `f43884bd-fbd7-47d8-88f6-355cbf5d6b44` correctly reported it unavailable,
did not inspect an older image, and created no image attachment. The actual
provider reply is `3956585653`. This is an explicit failing live sample, not
a passing private-image qualification. The signed-in browser renders a
signed image anchor, but that does not establish the installation App's
canonical response format; follow-up diagnosis must use the genuine product
path without copying browser credentials or signed links into the connector.

### Current Luna timing breakdown

Closed `run.performance.span` data for the eleven successful native runs
created after 09:15Z shows queue times of **9–15ms**. Fresh-task preparation
is **101–217ms**; answered-question preparation is **1.771–2.059s**.
Representative spans below are internal boundaries, not provider delivery
or end-to-end latency:

| Live sample | Queue | Preparation | Agent turn | Measured run span |
| --- | ---: | ---: | ---: | ---: |
| Slack follow-up after Stop | 9ms | 139ms | 12.434s | 13.656s |
| Discord DM answer | 11ms | 1.771s | 12.511s | 15.709s |
| Telegram photo | 10ms | 137ms | 31.394s | 33.100s |
| Telegram answered photo | 15ms | 1.850s | 30.676s | 33.871s |
| Slack two-file response | 10ms | 102ms | 54.069s | 55.646s |

The earlier click/send-to-provider timestamps remain the actual user-visible
measurements. Do not label the difference between these internal spans as
provider publication overhead: it also includes run finalization boundaries.
The short GitHub unavailable-image reply is not a successful image-performance
sample. These observations do not show queue starvation; most measured time
is inside the native model/tool turn. They support keeping Luna for the
current test pass, not a claim that every request meets a latency target or
that Terra would necessarily be faster. No model/effort change was made.

### Live canonical-format evidence and remaining delivery gate

The real diagnostic comment `3956635669` produced delivery
`7ce03dae-cf9d-42f4-988a-e2a276f6f58b` on `8b9a29ccc`. At 09:57:09Z,
the genuine installation-App path emitted only the closed code
`github_attachment_canonical_signed_anchor_only`. This establishes that the
exact unchanged App-readable comment—not merely the signed-in browser—uses
the same-UUID signed-anchor/image representation. No response HTML or signed
URL was copied into diagnostics or the connector's durable input.

Commit `27c6dc4f8` accepts that precise representation alongside the original
anchor form. The link must equal its sole image source, both must satisfy
the same fixed-host/path/UUID/JWT checks, and original/signed candidates share
one ambiguity count. Source-body, comment/repository/review-root, current
principal/admission, storage, and credential-free download fences remain.
Independent security review found no blocker. Verification: **318/318** full
chat integration tests, **202/202** focused SDK/attachment/egress tests
(including **96** helper/runtime tests), **11/11** targeted real PostgreSQL
intake/restart/revocation cases, and server typecheck passed. These counts
overlap and must not be added into a fictitious unique-test total.

The live server is running clean `27c6dc4f8`, private and recovery-ready.
The final repeat was submitted at 10:02:47.933Z as
[review comment 3956680939](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/pull/3#discussion_r3956680939).
It remains visible after a browser reload, but no corresponding Paperclip
delivery or run has arrived during this check. Tailscale's public 8443/10000
webhook proxy is reachable; Board 443 remains tailnet-only. The provider's
[status page](https://www.githubstatus.com/) reports webhooks operational;
that does not rule out a delivery-specific failure. GitHub App settings
currently require a fresh six-digit authenticator code before its recent
delivery history can be inspected. The Confirm access page is open. No
duplicate provider message, forged webhook, receipt rewrite, or inferred
successful image import was substituted. **Live private-image byte
qualification is still pending**, despite the tested format fix.

All work is pushed on `codex/chat-adapters`; the lockfile is unchanged.
An additional fetch confirms `origin/master` remains `297d8741f5f192c66abbec325b1e956cf0e5e667`.
The temporary keep-awake process expired; the live server and restricted
webhook proxy remain running.

### Busy-thread follow-up qualification — 2026-09-08

The live Maya configuration was re-read: `paperclip_runner`, model
`gpt-5.6-luna`; actual new runs use `codex_app_server`. No legacy adapter or
Terra substitution was used. On the running `27c6dc4f8` code, a Slack picnic
request was sent at 10:11:51.174Z and a replacement request at 10:11:58.362Z
while the first turn was visibly working. The documented FIFO behavior held:
run `666e9a6e-0d65-4298-88d8-3492fc4abe1c` finished first, and continuation
`f3d86bb2-cea7-4cd8-8c32-8d740e333160` then returned exactly
`SLACK-QUEUE-COBALT` once. Both stayed on CHA-21. The first final edited
`1788862313.653509` at 10:12:25.598Z; the correction edited
`1788862346.729459` at 10:12:37.627Z. All publication attempts were one.

This qualifies the earlier latency interpretation: **9ms heartbeat queue
time does not mean a busy-thread follow-up waited only 9ms**. The correction's
`comment.to_run_created` span was **24.639s** before its run existed, then
its heartbeat queue span was 9ms. Browser send to the final was **39.265s**.
Its aggregate `task.run.measured` span was 37.070s, not a provider-delivery
measurement. The pending input received an eyes receipt, but no explicit
“queued next” feedback before the next run's working message. FIFO ordering
is functional; instant steering or cancellation is not claimed.

The same Discord journey failed and is **not qualified**. Initial run
`6831cef6-58e5-4653-bf8f-032d297d417d` succeeded at 10:13:05.978Z.
The queued correction's run `8908ed2f-0803-4d10-9bf9-8446853fa563` then
failed at 10:13:06.171Z with `runner_state_identity_mismatch`. The browser
showed “stopped before completing this turn,” while the first run's working
message `1546825549438128158` still showed “making progress.” Its final
publication `0dd150ef-66fc-4a45-88bb-70fee4a0ce5a` was cancelled with
“Task control requester or destination is no longer authorized,” despite
its committed final comment. No successful queued Discord answer is claimed.
Native session lifecycle and final-publication authorization are being
investigated independently; no identity fence was disabled or receipt
rewritten to manufacture recovery.

Telegram's corresponding FIFO check passed on the same running code.
Initial send at 10:16:02.756Z created run
`920f9b5a-43c8-4969-9afe-60e5f6961db6`; the correction sent at
10:16:28.671Z created continuation `7395655e-18dc-4665-aa31-f70a5523d2a7`
only after that first run finished. Both succeeded on the original CHA-24.
The first final edited `417200359:105` at 10:16:40.791Z (two publication
attempts, not duplicate provider messages). The final `TG-QUEUE-MINT`
edited `417200359:107` at 10:16:51.710Z once, **23.039s** after the
correction send. Its pre-run comment wait was 9.497s, heartbeat queue 15ms,
preparation 144ms, and agent turn 10.100s. The browser showed both ordered
answers, with no residual working placeholder. This passing sample does not
negate the separate Discord runner shutdown failure.

Commit `eec06a9e3` removes the GitHub bot-edit orphan retry churn. Signed
comment-author/editor bot metadata or an exact company/endpoint/thread-bound
outbound message link now filters the update on attempt one. The retained
receipt excludes message text. Unverified signatures, human orphan edits,
wrong-thread links, and message-body claims of bot identity do not acquire
that shortcut. Ten focused PostgreSQL cases passed. Full chat integration
then exposed two fixture races: the Slack burst test observed the last
comment before its wake, and a global sweep validly woke an earlier fixture
company. Commit `9d893daa3` waits for the exact scoped wake sequence and scopes
the bot-edit assertion to its assigned agent. The fresh full suite passed
**325/325**; these were test corrections, not relaxed production ordering.

Commit `649869dab` fixes the completed-answer cancellation race. A later
failed run can set shared `agents.status` to `error`; that is runtime health,
not revocation of an earlier succeeded run's exact committed response proof.
Only that transient status is removed from this presentation-specific denial.
Explicit pause (including budget pause), termination, pending approval,
current membership, endpoint/destination, review gate, and exact result/context
checks still apply. The change does not authorize execution or new tool/file
effects. Same-task and concurrent-other-task failures reproduced the defect;
the concurrent lock test still requires a retry while the agent row is held.
**91/91** external-wait tests and server typecheck passed, with a final
**16/16** targeted run after adding revocation while the agent remains in
error. The historical cancelled live publication was not rewritten or replayed.

Commit `de43b250b` hardens local runner shutdown. The live failed handoff had
a pending stop/suspend command and an ACK backlog: the previous close spent
its entire grace period stopping/draining, then could kill a still-ready
runner and report success. Local close now reserves a suspension window and
requires both the completed suspend command and exact current durable
identity in suspended state, as remote close already required. Completed
historical suspension receipts cannot certify a resumed ready runner. No
session-rotation or quarantine guard was relaxed. Failure to establish proof
rejects close while retaining durable evidence; it does not invite a blind
rerun of committed tool effects.

Verification includes **85/85** real-process transport tests, **154/154**
native executor tests, runner TypeScript validation, and an independent
**8/8** transport regression review. A 144-delta process fixture verifies
backlog to durable suspension to the same provider conversation under fresh
run authority. Readiness/wrong-identity and stale-completed-command cases
fail closed. The configured grace bounds acceptance of proof, not an overall
wall-time SLA for an independently bounded remote state read. The already
quarantined live Discord root was not restored. A fresh explicit message
may follow the existing safe replacement policy; that must not be described
as recovery of the quarantined provider's original history.

Publication reconciliation now also wakes on exact committed native progress
and final-presentation event types, rather than depending only on the
one-second sweep. The initial notification schedules an immediate scan;
sustained notifications coalesce with a dirty bit and at least 100ms between
scan starts. Recovery polling remains, never adds dirty work to an active
scan, and shutdown cancels deferred scans while joining active work. This
uses a separate internal company-event observer, not the public global event
stream, and never forwards event prose/payloads. Independent review and
**19/19** helper/application tests passed. Shared, server, and UI typechecks
also passed. This removes avoidable polling latency; it is not evidence that
Luna's own model turn or FIFO waiting time has become shorter. The combined
build still requires the following live post-deployment qualification.

### Post-deployment consecutive-turn proof — 2026-09-08

The combined `6e47a2942` build started at 10:26:03.584Z on the existing
private live instance. A fresh explicit Discord request sent at
10:26:22.388Z produced succeeded native run
`100fec90-b923-4d57-abdd-e2e73e3cc9de` and its visible book-swap answer at
10:27:18.647Z. This is evidence of the normal new-request path, not a claim
that the historically quarantined provider conversation was restored.
Independent durable-state inspection confirms explicit continuity fallback
from unavailable old provider session `01a0802b…` to new provider session
`01a0808d-fe51-7e00-b6c5-e032a49f4e3d`, preserving the Paperclip task and
normalized conversation binding. The following busy request and correction
both resume that exact new provider session. Their archived/current runner
roots all retain exact identities, completed stop/drain and suspend commands,
and a suspended lifecycle. Actual rollout turn context independently records
Luna for all three; the evidence is not limited to the agent configuration.

A second request at 10:28:52.934Z produced
`bc72fd3b-ec5b-40b6-9ea2-e0ea0c9420ca`. At 10:29:01.039Z, while its working
message was visible, a correction was sent in the same CHA-4 Discord thread.
The first run succeeded at 10:29:43.336Z and its final publication
`744685dd-7a54-4a55-9724-9c0b8437a6ff` edited `1546829681213575258`
at 10:29:43.860Z. The queued continuation
`3ee1cfba-0cb2-4a13-be4d-81078a79b684` started at 10:29:43.409Z,
succeeded at 10:29:57.651Z, and edited `1546829891733815326` to exactly
`DC-HANDOFF-CEDAR` at 10:29:58.078Z. Both new working messages became their
respective finals; every associated publication attempt was one. Browser
accessibility and a screenshot confirm both ordered replies on the same task.
The old failed test's stale working message was not silently rewritten.

This busy correction took **57.039s** from browser send to provider final:
the preceding request still had to finish under the documented FIFO contract.
The short correction's own started-to-finished time was **14.242s**; the
preceding 220-word turn took **49.349s**. The two final publication
created-to-published intervals were **473ms** and **380ms**. Those intervals
include reconciliation, current-authority checks, transport, and settlement;
they do not isolate provider network latency or establish an overall SLA.

A separate idle Slack request sent at 10:31:04.782Z produced
`64e9a2f9-a8c2-4eda-b616-b3b4805bb740` and exactly `SLACK-LUNA-READY`
at 10:31:20.672Z, **15.890s** end to end. Its working message
`1788863466.965279` was updated in place, once; final publication
`35675ea4-14cc-454f-9ba6-9490eb255462` took **346ms** from creation to
published settlement. All these real runs use `codex_app_server`; Maya's
persisted adapter/model remain `paperclip_runner` / `gpt-5.6-luna`.

The fresh deterministic browser suite passed **9/9** on isolated port 3199.
No external provider account was accessed by that Playwright suite.

Two further quality findings remain explicit pending their follow-up fixes.
The Discord plant-swap answer visibly rendered ordinary prose as “token
[REDACTED]”; this is being checked against the credential redactor rather
than accepting corrupted user-facing text. Also, review of the new wakeup
bridge confirmed the normal committed-final path emits its signal, but
native PRP progress events enter through a different durable port and still
depend on polling. A short observed publication interval is not proof that
those progress updates were event-triggered. Neither finding is hidden by
the passing consecutive-turn test.

The additional timing audit distinguishes a future optimization from a
failed safety check. The two longer Discord answers used the native runtime's
intentional five-second semantic-result terminal grace, then consumed the
7.5-second stop-preparation budget while their final-output suffix drained.
Codex's recorded task completion preceded the runner terminal event by
approximately 3.4–3.9 seconds. In contrast, the short correction completed
naturally and closed in 241ms. A bounded burst benchmark for per-event durable
persistence and cumulative ACK processing is the next performance target;
removing the exact suspension proof or blindly shortening the semantic grace
is not justified by these measurements. The busy correction's 42.358-second
pre-run FIFO wait is separate from its 12ms created-to-started queue span.

Commit `d0b7638fa` fixes the confirmed prose redaction at its source in the
Rust runner, before canonical result storage. It recognizes only a bounded,
determiner-led “token system” noun phrase. Explicit assignments, quoted or
compound/CLI keys and values, attached credential suffixes, nested sensitive
fields, and independent credential-prefix/Bearer/JWT scanning remain protected.
The actual structured durable-command test and protected negative cases passed
with the full **214/214** Rust library cohort. The release build and staged
binary passed; SHA-256 is
`e33d464cba6766becf9fb536182976c0359a78e4250301a5c86874f8212c9963`.
The frozen staged binary then passed **85/85** real-process transport tests.

The running instance subsequently launched that rebuilt binary for a new
Discord request at 10:37:20.329Z. Run
`3b2fa76f-42c2-4ad8-9f0c-91b9261e485c` succeeded, and publication
`e5625593-db8f-4d3f-997f-f17978f5904f` edited `1546831811294920754`
once at 10:37:33.976Z: **13.647s** end to end. The browser displayed exactly
“Use a simple token system so guests can exchange plants.” The old corrupted
historical answer was not rewritten. This proves the narrow repaired prose
case through the real native runner, not merely through a chat-only formatter.
Independent inspection confirms this binary-upgrade retest resumed the same
`01a0808d-fe51-7e00-b6c5-e032a49f4e3d` provider session, used Luna in actual
rollout context, and closed with the exact new run identity suspended and its
drain/suspend commands completed. No fresh continuity hold was introduced.

Commit `04315aea1` closes the native progress signal gap. The PRP port emits
only fixed event types and company/issue/run/agent/sequence identifiers after
its event row commits. Duplicate replays and unsupported event types do not
signal. Recovered final presentation emits only after its authorized comment
transaction commits. Optional synchronous listener failures are contained;
they cannot reject committed native work or skip its callback, and the
existing recovery poll remains. Database, schema, and permission failures
are outside that exception boundary.

The frozen bridge passed **135/135** tests across the full native port,
external-chat wait, reconciliation, and safe-progress files, plus server
typecheck. Independent review passed **44/44** overlapping tests, including
real PostgreSQL row visibility from a separate connection, payload exclusion,
replay behavior, and throwing-listener callback continuity. No full-file
formatting churn, lockfile edit, raw trace broadcast, or authority relaxation
was retained.

### Final clean-build live pass — 2026-09-08

The private live server now runs clean `cad8ccd07` on loopback port 3103
with the rebuilt runner above. Health is ready; historical recovery holds
remain unchanged. The fresh full chat integration suite passed **325/325**
after the final bridge changes. The earlier isolated browser suite passed
**9/9**; no claim of a passing broad workspace build/test gate is added.

Discord's request at 10:43:19.563Z created native run
`82828c7c-75dd-4c8b-9d3c-0b359d3ac265` on the existing CHA-4. Its
cadence-selected safe `item.completed` event, sequence 54, committed at
10:43:43.035Z; the progress publication was created at 43.119Z (**84ms**)
and published at 43.584Z (**549ms** after the event). The browser showed
“making progress” on existing message `1546833317133942784`, then the final
verification phrase “cobalt otter 47” on that same message at 46.456Z.
There was one final comment, publication, and outbound link, with attempt one.
This sample's end-to-end time was **26.893s**. The timestamps measure the
committed event through publication, not an isolated provider-network span.

In parallel, Telegram's request at 10:43:28.534Z created
`7bb24611-d4c2-43e4-a186-30711e7f476b` on the existing CHA-24. One native
Maple/Cedar question was delivered on `417200359:109` at 38.428Z,
**9.894s** after the request. The actual Cedar button was clicked once at
54.737Z; one durable answer delivery woke continuation
`8667469d-2eef-472e-a73f-8aa4b0b4aaf0`. The question became “Answered:
Cedar,” and working message `417200359:110` became exactly “Cedar” at
10:44:12.521Z, **17.784s** after the click. The final publication's own
created-to-published interval was 1.289s, so sub-second delivery is not
claimed universally. All associated publications were attempt one, without
duplicate questions or final comments. The short question turn did not need
a separate cadence-limited progress phase.

Actual rollout contexts for all three clean-build runs confirm
`gpt-5.6-luna` and `codex_app_server`. All four active provider endpoints
(Slack, Discord, Telegram, GitHub) remain assigned to Maya's
`paperclip_runner` / Luna configuration. Terra was not substituted.
GitHub's App delivery settings still show the six-digit Confirm access gate;
the pending private-image delivery is not declared qualified. Teams Developer
Portal still shows its Microsoft sign-in gate. These provider gates and the
separately documented latency benchmark remain explicit; this is not a
blanket production-ready sign-off for all five providers.

The final Discord file answer was independently distinguished from memory-only
recall: its run-scoped provider record contains exactly one successful
`read_chat_attachment` operation (527.616ms), with matching durable
`tool.execution.started` / `tool.execution.completed` events at sequences
29/33. Its returned metadata identifies attachment
`2fa67267-dab6-477d-a1e0-00e75d2d39cd`, 128-byte `text/plain`, SHA-256
`fd40030afb62b83181a2a46dde8220e8defecfa0b4328e380c30b1899ccdce24`.
No raw tool arguments, contents, reasoning, or credentials were copied into
this evidence record or external progress messages.

### Acceptance audit and live modal failure — 2026-09-08

The post-bridge deterministic browser suite passed **9/9** again on the
isolated test instance. A coverage audit still found live-open requirements:
GitHub's new private-image intake, Discord buffered Gateway takeover,
Slack's form/modal journey, Telegram token/flood-control recovery, and all
Teams tenant-backed journeys. The frozen-install/lockfile release gate remains
separate. Earlier live successes do not constitute a complete same-build
production sign-off.

A new text-only GitHub PR-level sentinel was submitted once at
10:53:53.004Z and is visible as comment `5584024357` on the disposable PR #3.
It did not reach Paperclip; the endpoint's last event remained
09:57:08.687Z. The earlier inline private-image comment `3956680939` likewise
remains without ingress. This distinguishes the current callback gap from an
image-decoding failure. Both fixtures were preserved without blind retries.
GitHub's App settings still require Confirm access; no available code was
entered or inferred. Tailscale's public 8443/10000 routes and the local
webhook-only proxy were verified running; port 443 remains tailnet-only.

The Slack form request at 10:54:25.293Z exercised actual Runner/Codex Luna,
not a synthetic interaction. Source run `8f019518-0a88-475c-a907-79ab28954ec0`
resumed provider session `01a08037-0bb4-7b72-a4ae-2a724f876dbd`; its actual
rollout turn context records `gpt-5.6-luna`. The working message
`1788864868.004959` became a native Respond card at 10:54:38.533Z, **13.240s**
after the request. Respond opened a Slack modal with a Maple/Cedar selector
and a free-text field. Empty submission showed required-field errors without
answering. Cedar plus the unique label `cobalt lantern 82` was submitted once
at 10:55:17.242Z.

The answer committed, but continuation failed before the provider started:
interaction `d2028e5b-033c-4227-bfba-d85410ac9942`, wake request
`5c3559c0-7456-4df2-854d-ea7766d48025`, and failed run
`3672ff28-51c0-495b-be42-cbf1307d5c27` identify the exact failure.
The error was `reviewed_chat_execution_binding_not_authorized`; the provider
then showed a misleading stopped-turn message at 10:55:19.066Z. This is a
Paperclip modal-answer authorization defect, not Luna generation latency or
a provider permission requirement. Button answers used a recognized durable
action kind, while modal answers used an unrecognized form-submit kind.
The original failed evidence is retained while that proof path is repaired.

Separately, commit `ffbef0b53` makes multi-field/free-text answer settlement
surface-neutral ("Answered.") without echoing private free text. Its actual
PostgreSQL publication suite passed **12/12**. Commit `019f37a27` preserves
bounded Teams channel/group file-reference metadata and exact-current-comment
unavailable-file warnings through immediate, deferred, restart, and
post-comment retry paths. It passed **9/9** focused PostgreSQL cases and
**5/5** current-wake-comment tests. It adds no download capability, URL/token
persistence, Graph permission, or claim of live Teams qualification.
The subsequent fresh full chat integration suite passed **333/333** (69.18s).
The failed Slack question is also visible on the real Paperclip task: both
answers are retained, followed by `setup_failed`. Its durable answer-delivery
row remains `fallback_queued` against that failed run; no database edit,
automatic historical answer replay, or false recovery claim was used.

Commit `a6ae8703d` repairs the exact modal-answer authority path, with
**109/109** native-wait/publication tests, **32/32** control-plane/progress
tests, root server typecheck, and an independent **25/25** security cohort.
The live server restarted on that committed TypeScript source at 11:03:09Z;
the health stamp was explicitly dirty because isolated runner benchmark/code
and this evidence document were still in progress. Its actual staged Rust
binary remained the previously verified `e33d464c…` build.

The fresh Slack request at 11:03:27.333Z created source run
`2e622c5d-7eca-49ac-9f3e-bcb066e9f1a3` and modal interaction
`d3ade486-58f3-4fa4-b01d-b1df3ae6b8cd`. The first Respond attempt produced
no observed server callback or durable modal-open attempt; after confirming
the form was still unanswered and no modal was open, one new click at
11:04:40.274Z successfully opened it. No cause is inferred for the first
provider/browser-side missed action.

Maple plus `amber compass 93` was submitted once at 11:05:06.304Z. The
answer committed at 06.732Z and correctly started native continuation
`6d2b552d-38f9-4a5b-821f-22ab210618d3` at 06.759Z. The provider displayed
the corrected neutral "Answered." status and a working message. This closes
the prior authorization failure, but the **whole journey still failed**:
Luna asked the same two questions again as interaction
`535d8574-9916-4d96-8e84-d5c30ae48142` instead of returning the requested
answer. The continuation completed at 11:05:27.131Z on a fresh provider
session `01a080b1-7be1-7711-9a15-e36e0c017bc9`.

Closed inspection confirms actual `gpt-5.6-luna`, both canonical answers,
and the bridge-generated answered-question summary in the actual model input.
The database interaction's nullable summary was not the cause: materialization
correctly supplied its fallback. The follow-up investigation therefore targets
the competing presentation of the old form request and the current answers,
not missing data, permission broadening, or a model substitution.

Commit `a5477215e` adds bounded provider acknowledgments after per-event
durable saves. The isolated, fake-provider burst benchmark records a
512-delta median visible tail of 18.658s before and 13.745s after, with
exact ordering, replay, and close-identity checks. This is not a live model
latency claim; the methodology and remaining close tail are recorded in
`2026-09-08-runner-output-burst-benchmark.md`. The production release binary
was then rebuilt and staged with SHA-256
`af19f64dfdf7e2e4efb5b41275e26cd873338315207c36fd4d108bdb69bae3c1`.
Its real Rust/TypeScript Codex transport regression suite passed **85/85**
(36.20s) before any subsequent live provider request. The staged digest is
distinct from the isolated benchmark candidate; neither identity is inferred
from the Git revision alone.

The answered-question framing repair places canonical answers before only
their exact source request; genuinely new/coalesced comments keep a separate
unresolved heading. The outer Codex task envelope also names the resolved
question IDs, with JSON-escaped identifiers and a fail-closed canonical result
guard. Cancelled, malformed, pending, empty, and non-question envelopes do not
gain that instruction. Completion criteria and their digest are unchanged.
Root checks passed **119/119** wake/native-input tests, **160/160** native
input/executor tests, **20/20** runner context/contract tests, and both server
and runner source typechecks; overlapping cases are not summed as unique
coverage. Independent review and equivalent focused checks found no remaining
blocker. Live retesting is recorded separately below, not inferred from these
tests.

The parallel native-progress audit found that interrupted runs were missing
from terminal milestone selection. Commit `239cced90` now settles the exact
run's working message once, while retaining an already selected final and
leaving successor-run messages independent. It passed **14/14** focused
PostgreSQL cases, **58/58** unit cases, server typecheck, and the subsequent
root full chat integration suite, **336/336** (64.53s). Raw errors, summaries,
tool arguments, and reasoning remain excluded from external progress. The
six fixed progress phases use a 20-second cadence; a short Luna turn may
correctly show working followed directly by its final answer. Pre-run FIFO
waiting still has a receipt reaction rather than a separate queued-next
message. Teams progress remains without tenant-backed live qualification.

### Live answered-form repair on the committed build — 2026-09-08

The server restarted at 11:22:32.606Z on clean `4391c9dff`, with the staged
`af19f64d…` runner binary. The existing pending Slack interaction
`535d8574-9916-4d96-8e84-d5c30ae48142` survived the restart and opened normally.
Its first submit at 11:22:57.197Z showed Slack's "We had some trouble
connecting" error; the interaction was still pending with no committed answer.
One explicit provider "Try again?" click at 11:23:31.822Z resolved it at
32.272Z, without duplicate continuation. This transient failure is retained,
not counted as a clean first-attempt pass or attributed to an unproven cause.
Run `83b46ee3-6571-4993-91ef-88e5dcfec824` reused the actual Luna provider
session `01a080b1-7be1-7711-9a15-e36e0c017bc9` and returned exactly
`Cedar / silver beacon 64`. Final publication `068cf7c5-5fec-420d-986b-a0cc051e2b55`
edited its working message `1788866614.101909` at 11:23:54.006Z (22.184s after
the successful retry), attempt one. The actual provider input contains the
new outer resolved-question constraint and current answers; no repeat form
was generated.

A fresh first-attempt journey then started at 11:24:09.464Z. Source run
`6dd8eb9a-88b2-4d44-804f-857dbd3c273e` created a new Birch/Pine-plus-label
form, interaction `fd637f6f-e664-4109-8c8d-c2c5f5aacfa9`, published at
11:24:22.430Z (**12.966s**). Respond opened on the first click. Pine plus
`violet harbor 27` was submitted once at 11:24:56.732Z, committed at 57.115Z,
and started continuation `f088a043-ed2c-4620-a768-905f7f52a6a8` at 57.157Z.
It returned exactly `Pine / violet harbor 27`, with no re-ask. Final publication
`3c9f8d9c-3dd7-4a07-b7d8-6f62fa976ad7` edited the same working message
`1788866698.368079` at 11:25:14.202Z: **17.470s** after Submit and 386ms
after publication creation. Every associated outbound publication was attempt
one. Actual rollout turn contexts verify `gpt-5.6-luna` for source and
continuation, both using `codex_app_server`; Terra was not substituted.

The same-build Discord 220-word text request was sent at 11:25:38.522Z.
Run `bc31b671-0574-4490-b441-a8dbb5506801` started at 39.526Z and completed
at 11:26:17.028Z, reusing provider session
`01a0808d-fe51-7e00-b6c5-e032a49f4e3d`; its actual rollout records Luna.
Working message `1546843965431484556` appeared at 11:25:40.444Z, became the
fixed "making progress" phase at 11:26:05.402Z, then the complete answer at
11:26:17.599Z: **39.077s** request-to-final. The final publication took 522ms;
the native progress publication took 249ms. All three publications were
attempt one and reused one message. The response was complete and coherent,
and ordinary prose such as "emerald token" was not spuriously redacted.
This is live qualification of the optimized build, not a controlled before/
after model benchmark: its different-content predecessor took 49.349s, so
the difference must not be represented as an isolated causal speedup.

Telegram's same-build native button check started at 11:27:23.682Z. Source
run `21fdb7fb-197c-41f3-a95f-7abb14f2f28f` generated the new Orbit/Harbor
interaction `359ebf93-7557-4d71-affc-9f621e338b8a`, published as
`417200359:112` at 11:27:34.692Z (**11.010s**). Harbor was clicked once at
11:27:48.674Z; the answer committed at 48.879Z. Continuation
`4f49883e-469e-45c2-87aa-1fbdf40ecf7e` reused its native provider session and
returned exactly `Harbor`, without another question. Its working message
`417200359:113` became the final answer at 11:28:07.940Z (**19.266s** after
the click). The final publication's own interval was 1.521s, so universal
sub-second transport delivery is not claimed. All related publications were
attempt one; actual source/continuation rollout contexts verify Luna.

A final fetch still resolves `origin/master` to `297d8741f`; its code-only
reconciliation and deliberately excluded lockfile refresh remain as described
above. No claim of reconciled master ancestry or frozen-install success is
made. The live test server stays available on loopback 3103, with no active
or queued Maya run after these checks. GitHub's pending callback investigation
still needs App Confirm access; Teams still needs its work/school tenant.
