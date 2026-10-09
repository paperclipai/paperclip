# Native chat Board files and webhook recovery — 2026-09-07

## Environment and scope

Isolated Board `http://127.0.0.1:3103`, company Chat Adapter E2E, snapshot 10,
loaded server `2026.831.0+396.git.dde176bbc`. The branch HEAD was `66a68fee5`
(documentation-only after the running implementation). Maya E2E remained
`paperclip_runner` → `codex` → `gpt-5.6-luna`.

These are real signed-in in-app browser checks against the configured Slack,
GitHub, Discord, and Telegram sandboxes. They deliberately start no model turns:
the Codex account limit still prevents additional native model qualification.
They do not qualify Teams, which still needs an eligible tenant/admin setup.

## Bounded webhook outage

Paused only the owned webhook proxy process with `SIGSTOP` at
**19:23:33.168 UTC**. A separate watchdog automatically sent `SIGCONT` after
45 seconds, at **19:24:18.173**. The Board server and Discord Gateway remained
running. The proxy was verified running afterward with the same PID and command.

Added then removed our thumbs-up on the existing admitted Slack message and the
completed generation-5 Telegram reply. No provider message, task, bot reaction,
credential, callback URL, or endpoint reach setting was changed.

| Provider | Event  | Browser action UTC | Received → processed UTC    | Delivery ID                            |
| -------- | ------ | ------------------ | --------------------------- | -------------------------------------- |
| Slack    | Add    | 19:23:39.001       | 19:24:18.420 → 19:24:18.426 | `4453aff3-e004-442b-a340-af44b4e0037f` |
| Slack    | Remove | 19:23:42.874       | 19:24:18.419 → 19:24:18.424 | `dd006230-f1c1-4195-86b8-3a5a0f364ed9` |
| Telegram | Add    | 19:23:39.333       | 19:24:18.191 → 19:24:18.197 | `e26e155f-e14f-4fa5-85b1-a291a997df91` |
| Telegram | Remove | 19:23:48.281       | 19:24:18.341 → 19:24:18.343 | `2cdc0a84-d8ef-4f85-99df-7d184192c07a` |

During the pause, at **19:23:57.284**, the proxy was stopped and there were zero
new delivery rows. All four events were subsequently processed with null error.
At the later check after **19:29 UTC**, there were still exactly four rows, not
late duplicate receipts. Counts before any Board sends remained **86 Maya runs,
17 tasks, 216 comments, 200 publications**.

Telegram's already-mounted Activity automatically showed the recovered pair,
and the rows were visually inspected. Slack retried **remove before add**.
Current Activity is a receipt/processing history, not provider occurrence
chronology; it does not persist an occurrence timestamp or reconstruct reaction
state. These events do not wake an agent or change task authority. This proves
loss-free recovery for this bounded reaction outage, not ordered Slack replay,
an exhaustive retry window, or a live Discord Gateway interruption.

This check did not reconfigure Telegram's webhook URL. The separate historical
URL-changing reconnect/backlog proof is recorded in the
[Telegram result](./2026-09-05-telegram-live-qualification-result.md).

## Explicit Board file sends

Prepared fixtures through the real Board attachment API, not direct database
inserts. Each existing linked task received three unbound files: a selected
128-byte text document, a selected 2,111,878-byte PNG of the previously used cat,
and an unchecked `internal-only.txt`. File prefixes were
`board-qa-1930-{provider}-`.

- Document SHA-256: `fd40030afb62b83181a2a46dde8220e8defecfa0b4328e380c30b1899ccdce24`.
- PNG SHA-256: `7693966f6c2b4aaebf9e46359f715fdaede021346bcd926078bb331b1dddc3c1`.

Started from Telegram connector Activity → Conversations → Open task. Used the
actual **Send to channel** composer, selected only the named document and PNG,
and explicitly identified the message as a transport test requiring no reply.
Continued to the existing Slack, Discord, and GitHub tasks and repeated the same
UI action. The unrelated pre-existing Discord attachment stayed unchecked.

| Provider | Board click UTC | All three publications confirmed UTC | Canonical Board comment                |
| -------- | --------------- | ------------------------------------ | -------------------------------------- |
| Telegram | 19:28:53.440    | 19:28:56.199                         | `2ee161b6-3fda-4ff7-b23b-c8f19c2fd087` |
| Slack    | 19:29:18.770    | 19:29:20.468                         | `efc7dd3c-9c7a-46c7-b026-aadb7e3402c2` |
| Discord  | 19:29:38.549    | 19:29:40.179                         | `e32c0140-c16d-43f1-838d-c657f2891bd9` |
| GitHub   | 19:30:44.104    | 19:30:46.196                         | `45cacf74-dc9a-4d0a-abd9-dfef3ce3d73b` |

Slack and Discord visibly rendered the document's `cobalt otter 47` verification
phrase and the cat image. Slack's full image viewer was opened and inspected.
Telegram visibly rendered a 128-byte document card and the cat photo. This
batch does not claim a downloaded-byte checksum of the provider copies.

GitHub visibly posted the Board text and two honest private-task file notices;
it did not claim to upload bytes or expose a private Board URL. The selected
files were available on the Paperclip task after reopening it. GitHub's App
transport limitation remains explicit, not a passed native image-upload claim.

Each send produced exactly one canonical comment and three ordered published
rows with provider message IDs and null errors. All eight selected attachments
were bound to their respective comment. All four unchecked fixture files stayed
unbound and had no publication. Counts became **86 Maya runs, 17 tasks,
220 comments, 212 publications**. No additional model run or task was created.

## Experience findings still requiring a fix/retest

The provider-side outcomes above passed, but the Board experience needs work:

1. Slack's send returned **Publishing to channel** with a retained disabled
   draft even though all three rows subsequently published. The component keeps
   that returned state without an authoritative refresh. This visit navigated
   away before measuring an indefinite stale state; a deterministic regression
   must establish and fix that terminal-refresh gap without replaying the send.
2. On GitHub's canonical `CHA-2` task route, the newly sent comment/files did not
   appear in the mounted timeline after completion. Reopening the task showed
   them. The banner invalidates UUID-keyed queries while the page can use an
   issue-identifier key. The same useful outcome must become visible without a
   reload.

An independent code audit also found outbound file hydration lacks a bounded
storage read and persisted SHA-256 verification. That is failure-injection work,
not a corruption observed in these successful live sends. Fixes and supporting
tests are being handled separately; none is qualified by the preceding baseline.

## Follow-up implementation and deterministic verification

The outbound reader now checks the persisted SHA-256 and exact byte length,
bounds storage acquisition and streaming to ten seconds each, and destroys a
stream returned after timeout. Task/comment scope and metadata validation run
before storage access. Invalid metadata fails definitively; storage/query/read
failures remain safe pre-provider retries under the existing five-attempt limit.
An accepted provider send with an uncertain durable result still becomes
`delivery_unknown`, never an automatic retry.

The Board composer now uses a scoped read-only batch-status endpoint. It waits
for every text/file part, observes explicit Activity resolution, and refreshes
both UUID and canonical-identifier task caches. Its exact submitted payload,
selected files, and idempotency key are stored before POST in session-scoped
browser storage. Reload resumes a known anchor through GET only; a lost response
restores a locked draft with an explicit same-key **Retry safely** action.
Storage failure before submission prevents an untracked send. State and late
responses are isolated by company, task, endpoint, and conversation. This is
reload/navigation continuity within that browser session, not a cross-device
draft synchronization claim.

Verification before restarting the live server:

- Fresh PostgreSQL integration: **269/269**, database
  `chat_adapters_test_20260907_latency_17` (78.12 seconds).
- Focused UI/API/OpenAPI/draft tests: **43/43**; separate hydration/API/OpenAPI
  subset: **17/17**, including four bounded-read/integrity unit cases.
- Five-provider browser file plus Board regressions: **9/9**; clean final Board
  subset after scope hardening: **4/4** (39.9 seconds).
- Shared/server/UI typechecks, UI token gates, and diff checks passed.
- The lockfile was unchanged; no broad workspace-test pass is claimed.

The previous DB14 run passed 268 cases before the final pretransport guard
expansion. DB15 exposed metadata validation being masked by missing storage;
the guard ordering was corrected, not the expected security result weakened.
That run also exposed leaked retry work in a projection-only test fixture. The
fixture now retires its exact staged publication and shuts down its service;
new hydration tests shut down in `finally`. DB16 passed the new cases but found
a timing assumption in a GitHub lease test: a nonblocking HTTP response can
precede the worker claim. The test now waits for the same required `processing`
state while the lease is held. DB17 is the clean combined result above.

An early full browser run overlapped development hot reload and missed one
success toast; the final clean runs supersede it. The initial red browser test
also established that the old component made zero status GETs for eight seconds
and kept the completed send disabled.

The updated-backend live retest below is separate from these deterministic
results. A further code audit found synthetic Slack file-share message IDs;
reaction matching on uploaded Slack files is not yet qualified.

## Updated-backend live retest

Restarted only the isolated Board server as snapshot 11. Health reported loaded
`2026.831.0+399.git.43b63da40`, process start **19:52:33.594 UTC**, startup recovery
ready, and the Discord Gateway connected. Maya's safe configuration fields were
rechecked: `paperclip_runner`, provider `codex`, model `gpt-5.6-luna`. The stored
reasoning-effort setting is `low`, but the current native input contract does
not propagate that legacy field, as documented in the native-runner report.
The following checks do not invoke the model.

### Slack: paused queue, reload, and automatic completion

Used the connector Activity **Pause** control, then the canonical `CHA-6` task's
**Send to channel** UI. Selected only `board-queue-retest-note.txt` and
`board-queue-retest-cat.png`; the previous internal-only fixture stayed unchecked.
Clicked Send at **19:53:07.191 UTC** with marker `BOARD-QUEUE-RELOAD-1954`.

The mounted timeline immediately showed exactly one Board comment and both
attachments. The composer truthfully showed **Queued for channel**, **0 of 3
parts published**, and a locked draft. Reloading preserved that exact draft and
status. A database check while still paused confirmed one comment and three
pending rows, not a duplicate submission:

- Comment: `9e461b1e-ccc9-478b-9799-5fce4c6d96b1`.
- Publications: `85a6121d-4554-4c52-89ad-7725b0603329`,
  `acb97e67-a44a-439b-8828-ad2ab4c95114`, and
  `ecc5e90f-d5cb-4fcd-b8be-3dda7ffe84f9`.

Clicked **Resume** at **19:53:35.884**. Text published at **19:53:38.067**, document
at **19:53:38.560**, and image at **19:53:39.154**, all with null errors. By the
next UI observation at **19:53:42.451**, the same mounted task had automatically
closed the draft and re-enabled Send. Slack's actual thread visibly contained
the marker text, the document preview with `cobalt otter 47`, and the cat image.
There was still one canonical comment. Slack was left active.

One remaining experience defect was observed and assigned for correction: once
the selected attachments bind to the new comment, they disappear from the
pending selection list, leaving only the unchecked internal-only file visible.
Although the timeline and three-part status are correct, the composer should
continue showing the exact locked selected filenames through reload.

### Discord, Telegram, and GitHub on the same backend

Uploaded two new unbound fixtures per provider using the Board attachment API,
then selected them through each canonical task's actual Send composer. Markers
were `BOARD-NEW-BACKEND-{PROVIDER}`. Unrelated and internal-only files stayed
unchecked. No agent reply was requested.

| Provider | Board click UTC | All three parts published UTC | Canonical comment                      |
| -------- | --------------- | ----------------------------- | -------------------------------------- |
| Discord  | 19:54:40.669    | 19:54:46.478                  | `0cbe837f-b48c-42dc-b36f-f2bc7c901ec2` |
| Telegram | 19:55:11.630    | 19:55:14.991                  | `57639d0a-4c3e-4b2b-80c8-e36c5311fdc6` |
| GitHub   | 19:55:36.324    | 19:55:38.967                  | `0b206e5a-4171-4fb8-b8af-773ad612f419` |

All nine rows were published with real provider message IDs and null errors.
Discord visibly rendered the text preview and cat; Telegram rendered its 128-byte
document card and cat photo. The composer closed automatically on each task.
GitHub posted the accurate private-file notices. Its already-mounted canonical
`CHA-2` timeline now showed the new comment and files without reopening; the cat
opened successfully in the private task's full image viewer.

Final counts were **86 Maya runs, 17 tasks, 224 comments, 224 publications**.
All four configured endpoints were active; all four previous internal-only
fixtures remained unbound. These checks establish successful transport and Board
recovery on the updated backend, not additional model qualification, a throughput
SLA, downloaded provider-byte checksums, or native GitHub file upload support.

### Retained filename receipt and resume latency finding

UI commit `9763e11fc` fixes the pending-file selection issue. Its filename
snapshots remain local to the session's existing scoped send record; they do
not change the publication payload or authorize resending bound files. Focused
tests passed **46/46**, mocked Board browser cases **4/4**, and UI typecheck,
token gates, and diff-check passed.

Retested live with the unchanged snapshot-11 backend and the refreshed Vite UI.
Paused Slack, then sent `BOARD-RECEIPT-CHECK` with `board-receipt-check-note.txt`
and `board-receipt-check-cat.png` at **19:58:15.799 UTC**. Before and after reload,
the composer showed **Files in this send** with exactly those two names checked
and disabled. The canonical timeline also showed the one new comment and both
attachments. After eventual completion, a new empty draft offered only the
unbound internal-only file, not the files already sent.

The resume at **19:58:22.029** exposed a separate scheduling defect: the paused
head had acquired a synthetic deadline of **19:58:45.898**. Text, document, and
image eventually published at **19:58:46.193**, **19:58:46.887**, and
**19:58:47.515**, under comment `0eae4850-b752-4f62-bd63-05ff6c27e427`. Slack
visibly received all three, but the approximately 25-second post-resume wait is
not acceptable transport latency. The scheduling correction and its live retest
are separate from the successful filename-persistence result.

## Subsequent scheduling and Slack identity hardening

The publication selector now excludes paused/attention endpoints before applying
its global page limit. A pause racing an already-selected row restores its
original deadline, not a synthetic 30-second delay. Resume therefore makes due
work eligible immediately without clearing genuine provider rate-limit or
storage-retry deadlines. DB18 reproduced both the old delay and starvation with
a one-row page. The revised fixture also resumes through the real configuration
service and verifies an unrelated provider backoff remains unchanged. DB19
exposed incomplete fixture inventory during provider revalidation; the test now
returns its actually available channel rather than bypassing the reach check.

The pinned Slack adapter now uses the uploaded file's real share timestamp for
its exact channel/thread. Sparse upload responses use a bounded, read-only
`files.info` lookup under the existing required `files:read` scope. Every returned
file must match its expected uploaded ID and have one unambiguous common share
timestamp. Missing, mismatched, timed-out, or ambiguous identities after upload
remain `delivery_unknown`, not synthetic success or a retry that uploads again.
An unpreparable local file fails definitively before transport. Adapter and
bounded-hydration units passed **49/49** after the final patch; server typecheck
passed. Applying the tracked patch to pristine 4.39.0 reproduced the installed
adapter bytes exactly. The lockfile remains unchanged as instructed; a fresh
frozen-lockfile install was not part of this check.

DB20 passed **268/269**, including the new resume and exact Slack file-ID tests.
Its failure was an existing slash-command test that raced provider-root
completion against channel-access revocation and assumed a task must result.
The recorded delivery was correctly filtered because the destination was
disabled. The test now explicitly controls transport and admission scheduling,
retains the duplicate-acknowledgement and lease assertions, commits revocation,
then drains the exact receipt and requires denial with no task or wake. No
production authorization check was relaxed to make that expectation pass.

The clean combined DB21 rerun passed **269/269**. The isolated deterministic
revocation test also passed on its own newly migrated database; server typecheck
passed after the final test changes. Live verification of the new Slack identity
and scheduling behavior follows separately.

The separate early-reaction race remains open: a reaction arriving before the
outbound message link commits currently has no exact lineage and is dropped.
Resolving real Slack file IDs fixes normal post-commit matching, not that race.

## Snapshot 12: fast resume passes; Slack share visibility exposes a failure

Loaded snapshot 12, `2026.831.0+402.git.dc1d17351`, at **20:09:56.742 UTC**;
health/recovery and Discord Gateway were ready. Paused Slack and sent
`SLACK-UPLOAD-ID-CHECK` at **20:10:56.530** with `slack-upload-id-note.txt` and
`slack-upload-id-cat.png`. Reload retained both checked, disabled filenames.
While paused, all three publications had zero attempts and null retry deadlines.

Resumed at **20:11:15.347**. The text published at **20:11:16.915**, a 1.568-second
resume-to-acknowledgement sample, without the prior synthetic delay. However,
the document then entered `delivery_unknown` at **20:11:17.645** because the
one-shot file metadata lookup could not resolve its share. The image remained
pending behind that uncertain result. The Board truthfully showed **Delivery
not confirmed**, **1 of 3 parts published**, and kept its exact draft.

Slack visibly contained the document and correct `cobalt otter 47` content.
Its native permalink timestamp was `1788811877.783349`, corresponding to
**20:11:17.783**: the actual share appeared about 138 ms after the adapter had
given up. This is failed file-identity qualification and evidence of eventual
share visibility, not a successful automatic file receipt. No upload retry was
performed. The follow-up uses bounded read-only polling for the same uploaded
file IDs, keeping the original upload and ambiguity safeguards unchanged.

- Canonical comment: `1181fcde-c098-4136-a2c9-e3dd13c6dd0c`.
- Text: `12b3bef4-390f-4e89-9dcf-cb930aa52f13`, real ID `1788811876.864209`.
- Held document: `ad9e2afb-85ab-4ed6-90bb-5168f760688a`.
- Pending image: `24d08c07-63de-45af-9f4b-8d1a8b00342b`.

The current operator **Mark delivered** action records an audited confirmation
but does not accept a recovered provider message ID or reconstruct its message
link. An operator-resolved document therefore must not be counted as a passed
automatic lineage/reaction test; a fresh normally acknowledged file is needed.

The follow-up adapter change polls sparse, matching `files.info` results under
one absolute five-second deadline, with paced 100/250/500/1000 ms waits. It never
uploads again and cannot start a lookup after a delayed token resolution has
exhausted that deadline. Missing/mismatched identities and lookup errors still
produce a safe uncertain-delivery result. Focused adapter and hydration tests
passed **51/51**; the first typecheck caught a generic mock typing error in the
new late-token test. The corrected test and server typecheck pass. Live qualification of
this polling change is recorded below rather than inferred from those tests.

## Snapshot 13: real file identities and file reactions pass

Loaded `2026.831.0+403.git.dddcf0d93` at **20:21:08.692 UTC**, with startup
recovery ready and Discord Gateway connected. Rechecked the existing document
in Slack, including its correct fixture text, then used Activity's **Mark
delivered** at **20:21:31.363**. It retained one upload attempt; no retry or
provider-ID backfill was performed. Its missing automatic lineage remains an
explicit limitation of manual resolution, not a successful identity test.

The previously pending image then published once, automatically, at
**20:21:36.719**, with real Slack ID `1788812496.261909` and a matching outbound
message link. Slack showed the cat image in the intended thread. The mounted
Board composer closed automatically after the batch completed. A new draft
offered the new unbound note and the internal-only fixture, not already sent
files.

Sent `SLACK-FILE-ID-RECHECK` from the Board at **20:21:55.713**, selecting only
`slack-upload-id-recheck-note.txt`. Text and document published in one attempt
each under canonical comment `f1118339-a6e2-40f5-b4e6-b67fe3883e1f`. The document
publication `e7517c83-15b2-4928-964b-422d1b64e8d1` completed at
**20:21:56.890**, with native ID `1788812516.721189` and a matching outbound link.
Slack visibly rendered the correct `cobalt otter 47` content. No manual
resolution or duplicate send was needed, and the Board draft cleared again.

Added and removed the operator's thumbs-up on that exact document, then on the
new image, through Slack's message controls. All four receipts processed once,
without error, and the Activity tab refreshed to show them:

| File  | Event   | Received UTC | Processed UTC | Exact native message ID |
| ----- | ------- | ------------ | ------------- | ----------------------- |
| Note  | added   | 20:22:38.257 | 20:22:38.262  | `1788812516.721189`     |
| Note  | removed | 20:22:56.917 | 20:22:56.921  | `1788812516.721189`     |
| Image | added   | 20:23:24.762 | 20:23:24.768  | `1788812496.261909`     |
| Image | removed | 20:23:27.958 | 20:23:27.962  | `1788812496.261909`     |

Both test reactions were removed; existing reactions were untouched. Maya's
run counts remained 78 succeeded / 8 failed, with no running or queued run.
An unrelated automatic productivity-review task, CHA-18, appeared during this
window; it has no chat conversation and must not be attributed to these
reactions. All four configured endpoints remained active.

Functional result: fresh Slack document/image delivery, exact outbound lineage,
post-commit file reactions, and automatic Board draft completion passed live.
The one-shot failure did require operator recovery; the corrected fresh-send
journey did not. This does not qualify the still-open reaction-before-link race,
native model generation under exhausted quota, or Microsoft Teams.

### Manual confirmation is not a recovered provider receipt

Read-only review confirmed that `mark_delivered` intentionally records the
operator's confirmation without inventing an external ID. Exact reactions or
later message replacement cannot use a link that does not exist. The current
adapter discards its known uploaded file IDs when bounded share lookup expires,
so old uncertain/manual-confirmed rows cannot safely be matched later by
filename, text, or time-window searches.

A future recovery path would need a durable internal partial receipt from the
original attempt: the exact server-observed file IDs, publication/attempt, bot
identity, and intended channel/thread. It could then repeat only scoped,
read-only metadata lookups under current authorization, require the same unique
share match, and transactionally bind the identity without another upload or
repeating manual-completion side effects. That path is not implemented or
claimed in this qualification.

## Early-reaction recovery hardening

The previously open reaction-before-link race now has a durable, bounded path.
If the exact message link is not yet visible, only a currently authorized
destination with an unambiguous in-flight publication can stage a minimal
reaction receipt. It has no conversation/task association until the exact
outbound message link exists. Recovery rechecks the endpoint/runtime fence,
destination reach, and current principal authorization; it never creates a task,
comment, run, or wake. Unknown unrelated messages are not admitted just because
they share a channel.

Pending reactions stay outside both ordinary inbound FIFO selectors. Their
metadata-only recovery runs alongside ordinary deliveries, with paced retries
bounded by 20 attempts and two minutes. Exact provider-event deduplication is
preserved across the original callback, retry, and server restart. A completed
DM generation can own its late reaction; a newer generation is never guessed.

Independent review found and corrected three subtle interleavings: publication
commit between the unlocked preflight reads; conversation FK key-share locks
deadlocking with endpoint-first reaction admission; and a pre-lock timestamp
allowing replay after expiry. Conversation locks now use `NO KEY UPDATE`, and
expiry is evaluated after acquiring the delivery lock. Recovery promises are
observed immediately and joined even if ordinary delivery processing throws,
before the original error is rethrown.

Seven focused real-PostgreSQL cases passed on fresh `reaction_focus_01` (5/5)
and `reaction_focus_02` (2/2): preflight recheck, durable duplicate/restart replay
without task work, publication-link lock overlap, late-duplicate expiry,
post-lock clock expiry, revoked destination, and completed older-DM ownership.
Server, shared, and UI typechecks passed. Cross-endpoint liveness under a held
reaction lock was code-reviewed, not a separately executed eighth fixture.

The full combined suite then passed **276/276** on the fresh migrated
`chat_adapters_test_20260907_reaction_full_01` database, in 72.10 seconds
(64.52 seconds of tests). This run included the final frozen service/test files
and all seven additions. Simulated provider failures in its log are intentional
negative fixtures, not live-provider failures.

### Recovery failure-path regression follow-up

Two additional real-PostgreSQL fixtures now exercise ordinary inbound-drain
failure while both action and reaction recovery are in flight. Each injects an
error only at the fixture endpoint's inbound lease acquisition. One releases
action recovery first; the other releases reaction recovery first. Both require
the sweep to remain pending until the second recovery finishes, then reject
with the exact original error. Durable reaction/action state completes once,
without extra comments, tasks, runs, wakes, or publication sends; the ordinary
delivery remains unprocessed and recovery leases are released.

The focused run passed **2/2** on fresh
`chat_adapters_test_20260907_reaction_join_01`; server TypeScript passed.
The isolated mocked browser suite also passed **9/9** in 2.7 minutes, covering
all five setup/management journeys and four Board batch-delivery/reload cases.
Those browser cases use a throwaway instance on port 3199 and mocked providers,
not the signed-in live provider sessions or the live instance on port 3103.

The combined suite then passed **278/278** on fresh migrated database
`chat_adapters_test_20260907_reaction_full_02`, in 79.68 seconds (71.62 seconds
of tests). This includes both recovery-release orders and the prior seven
reaction-link regressions. The current change is test-only; it does not add a
new live-provider qualification or change the running server's production code.

## Snapshot 14: deployed; post-restart browser smoke remains unverified

Loaded `2026.831.0+407.git.e6f52b4cc` at **20:44:52.362 UTC**. Health and
startup recovery are ready; Discord Gateway connected. All four configured
endpoints remain active. A read-only recheck confirms Maya still uses
`paperclip_runner` / `codex` / `gpt-5.6-luna`; the four earlier successful text
run rows retain `native` / `codex_app_server`. No model defaults were changed.

The attempted live post-restart reaction smoke did not complete. Browser click
and scroll calls returned without a visible effect in Slack and Paperclip,
including a newly opened Board catalog tab. One browser-automation session reset
and the documented alternate interaction API did not restore input. Navigation,
rendered snapshots, and screenshots remained available. No new Slack reaction
receipt arrived after this restart, and Maya's run counts remained 78 succeeded
and 8 failed, with no queued or running run. No duplicate message or credential
rotation was attempted as a workaround.

The new early-reaction path therefore has the database/integration coverage
above, but no passed post-deployment live reaction smoke. Snapshot 13's actual
document/image and reaction results remain valid evidence for that version;
they are not relabeled as snapshot 14 results. Browser-input recovery is a
testing-tool limitation, not an established Slack or Paperclip product defect.
Model-driven follow-ups still require restored Codex capacity; Teams still
requires the eligible tenant/admin setup. The isolated server is left running,
with the public webhook-only proxy and private Board boundary unchanged.

## Frozen-install release gate

The preserved lockfile is now a confirmed release blocker, not merely an
unexecuted check. On September 7, the non-regenerating diagnostic
`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts --offline`
exited with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`: the current overrides do not
match the lockfile. It stopped before validating dependency and patch entries;
source inspection also shows that the five pinned chat-adapter dependencies
and their patches are absent from that lockfile. The diagnostic left the
lockfile and working tree unchanged and did not replace the live server's
installed modules.

The installed, patched dependency tree used for the recorded tests is therefore
not proof of a reproducible frozen installation from this branch. The existing
instruction not to edit or commit `pnpm-lock.yaml` remains in force. No patch,
override, or dependency was removed to make the check appear green. Release
qualification needs a reconciled lockfile and a clean frozen-install retest
after that constraint is resolved; the active local server is unaffected.

## Upstream reconciliation remains open

A fresh fetch on September 7 found `origin/master` at `d8b958053`, four commits
ahead of this branch's merge base `f6a211479`. In addition to the lock refresh,
upstream adds guarded Runner API fallback, responsible-person GitHub execution
identity, and recent-task ordering. The tested checkpoint `9007e4111` does not
contain those changes.

A non-worktree `git merge-tree` diagnostic confirmed conflicts in migration
metadata 0240–0245 and the journal, the OpenAPI route test, issue routes, and
native runner tool authority. Automatically merged heartbeat/executor paths
still require semantic verification; a textual auto-merge is not proof that
native chat authority and continuation behavior remain correct. No merge,
rebase, migration rewrite, or lockfile update was applied to the live worktree.
The existing live database must retain its applied migration history during
that future reconciliation. Current-source release qualification cannot be
claimed against the newer upstream revision until this work and its tests are
complete.

Independent review identified the concrete merged checks: retain both the
chat-specific native tool/attachment authority and upstream's guarded API
fallback; carry identity-context fields through the rewritten issue handlers;
test fresh and already-migrated databases; and verify broker-bound resumed
turns with different linked actors. Guest messages are currently quarantined,
and higher-trust runs omit their bodies and attachments. Upstream identity
initialization skips authorless comments and may inherit a continuation actor,
so guest-root and linked-A/guest/linked-B scenarios need explicit combined
identity/credential tests. This is an unverified integration boundary, not
evidence that credentials leaked in the tested branch.

## Slack accepted-upload receipt recovery

The bounded share lookup still had a process-interruption gap: after Slack
accepted a file, Paperclip could lose the returned file IDs before confirming
the share's real message timestamp. The follow-up records those exact IDs in
a private, attempt-bound `slack_file_upload_receipt` action immediately after
the successful upload response, before the eventual-consistency lookup. It
uses a per-call asynchronous context around ordinary `Thread.post`, preserving
the SDK's sent-message, typing, and history behavior.

An independent recovery lane performs only metadata reads for the saved file
IDs. It does not re-upload files, guess timestamps from filenames, or create
another model turn. Settlement requires the exact publication attempt,
endpoint bot/runtime/credential identity, conversation, channel/thread, and
current destination reach. It is endpoint-authorized bookkeeping for bytes
already accepted, not a newly authorized external-user send; file publications
have no original-principal anchor, and this change does not claim to add one.
Task controls and interactive cards are excluded. Historical attachment reuse
continues to authorize its own requesting principal separately.

An exact receipt can settle an unconfirmed publication automatically. After
an operator explicitly marks that same attempt delivered, recovery may only
enrich the missing provider identity/link; it must not repeat completion
effects or alter the confirmed timestamp. Retry/cancel/new-attempt changes
invalidate the old receipt. A conflicting existing message binding remains
unconfirmed. Receipts are omitted from normal endpoint Activity and publication
payloads. Older uploads without a durable receipt cannot be reconstructed by
this change.

Independent review caught two worker races before qualification: stale
selection could bypass a newly scheduled backoff, and held endpoints could
monopolize the bounded selection page. Claims now recheck eligibility and
attempts under the row lock; held endpoints and same-attempt streaming work
are excluded before the page limit.

The first real PostgreSQL run caught an additional timestamp-precision defect:
a server-default `updated_at` had microseconds, but the decoded JavaScript
timestamp used for equality had only milliseconds. The receipt remained
`received` and recovery returned zero. This is a production claim-path defect,
not a flaky timing assertion. Claims now use the already-locked row; malformed
or removed-endpoint receipts use a precision-safe state and semantic JSONB
comparison, with SQL null distinguished from JSONB null. The manual-confirmation
case also exposed untyped `jsonb_build_object` parameters; explicit casts fix
the PostgreSQL error before any deployment.

Supporting verification so far:

- All pinned-provider adapter and reconciliation-coordinator tests passed
  **59/59**. Coverage includes reverse-order concurrent upload callbacks,
  callback failure without a second upload, strict accepted-ID validation,
  preserved SDK sent-message methods, independent reconciliation, and joined
  shutdown for both successful and failed receipt lookups.
- The frozen tracked patch applied cleanly to pristine Slack adapter 4.39.0.
  Its output exactly matches the installed module, SHA-256
  `094eafb219f99546c5189a28e6c25b228034cc6a589edca63ed09a09d7ca42ea`.
  The lockfile was not modified; this is patch reproducibility, not a passed
  frozen workspace installation.
- Fresh databases `chat_adapters_test_20260907_slack_receipt_01` and `_02`
  exposed the timestamp and manual-confirmation SQL defects. After fixes,
  `_03` passed both expanded database cases, including duplicate receipt
  capture, a 25-row paused backlog, exact-message conflict, cancellation, and
  identity-only manual-confirmation enrichment.
- Fresh `_04` passed **4/4** focused cases, adding two workers demonstrably
  preselected behind a held credential lease, and channel reach revoked during
  a held metadata lookup. Only one competing lookup ran, its new retry deadline
  remained intact, and revoked reach produced neither a provider link nor a
  second upload. The final malformed-row SQL-null variant landed afterward
  and was included in the final full-suite gate below.
- The first full receipt suite passed 278/282. Its fake Slack transport wrongly
  invoked upload acceptance before a definite-rejection hook, leaving a receipt
  that also disrupted two later tests. The fixture now separates pre-acceptance
  rejection from post-acceptance ambiguity; production acceptance handling was
  not weakened. An unrelated Discord Gateway renewal also consumed a global
  one-shot database fault intended for the Slack lifecycle test. That fault is
  now bound to the exact lifecycle transaction's uncommitted terminal row,
  proving rollback of both its comment and terminal state. Fresh `_05` passed
  all **6/6** affected cases, including the final null-result receipt variant.
- Final fresh database
  `chat_adapters_test_20260907_slack_receipt_full_02` passed **282/282** in
  63.91 seconds (58.15 seconds of tests). Server TypeScript passed after the
  final code and fixture changes. These are simulated-provider tests with
  real PostgreSQL, not new live-provider or process-kill qualification. The
  earlier frozen-install, upstream, browser-input, model-capacity, and Teams
  gates remain open; this is not a whole-product readiness sign-off.

## Snapshot 15: receipt repair deployed; live ambiguity proof still open

Committed and pushed `9277e0dc5`. The isolated instance restarted with loaded
version `2026.831.0+411.git.9277e0dc5`; startup recovery was ready at
**21:36:00.332 UTC**. The health endpoint and `/CHA/apps` both returned 200,
and Discord Gateway connected. Slack, GitHub, Discord, and Telegram endpoints
remain active. Maya still uses `paperclip_runner` / `codex` /
`gpt-5.6-luna`; no global defaults or agent model settings changed. There were
no active Maya runs at restart. The webhook-only proxy stayed running on 3104,
and the Board remains private on 3103.

The live rare-path test—Slack accepts bytes, share identity is temporarily
unavailable, and durable metadata recovery later binds the real message—is
still unqualified. Snapshot 13's fast-path file evidence is not relabeled as
this new recovery-path evidence. Browser-input recovery remains unresolved,
and a fresh account-limit check still reports exhausted weekly Codex capacity
with no reset credit. No model-driven retry, historical-file resend, or Teams
live pass is claimed by this deployment. The final automated evidence for the
deployed source remains 282/282 database cases, 59/59 adapter/coordinator cases,
server TypeScript, and exact pinned-patch reproduction.
