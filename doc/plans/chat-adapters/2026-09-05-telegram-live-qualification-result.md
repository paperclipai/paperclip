# Telegram live qualification result — 2026-09-05

> **Status: broad private-chat and group/topic live evidence, not full release qualification.** The latest live runs cover task controls, FIFO and burst handling, reactions, edits, native documents, task-generation races, the repaired interleaved status/final lane, group/topic isolation, removal/rejoin, the silent-publication boundary, and a complete native confirmation-to-continuation round trip. Broader media boundaries, global token revocation, and other runbook cases remain open.

## 2026-09-06 merged-build tunnel-rotation retest

The final pushed merge commit is `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`. After the account-less Cloudflare test tunnel expired, the bot webhook was rotated to the new verified URL with the already-vaulted token and webhook secret; neither credential was exposed. Telegram reported zero queued updates and no provider-side webhook error. A fresh `new` followed by a `task` command created one task and produced exact `TELEGRAM-MERGED-A-0906`. Its working placeholder and final share provider message ID `-1004415501660:69`, proving that the final edited the status in place. Both inbound command deliveries processed once and both publications completed with `attempts=1`, no error, and no pending, retry, failed, or ambiguous row. A plain unaddressed group follow-up was intentionally not delivered to the bot under Telegram privacy mode.

## 2026-09-06 final answer/recovery audit

The final transcript and durable-ledger review for `CHA-81` found one provider-visible exact final publication, `TELEGRAM-LATENCY7-Cobalt`, with `attempts=1`; Telegram also showed the native question card settled to **Answered: Cobalt**. No late duplicate or internal run summary reached the provider.

A third recovery run did execute after the answer continuation. Its comment stayed internal and the task then reached `done`, so the externally visible safety boundary held. The extra recovery incurred about $0.21 of model cost and is retained as efficiency evidence: it is the intentional productive-terminal fallback that prevents an `in_progress` task from being stranded, not a second answer publication. This observation does not upgrade Telegram to a complete runbook pass, and future tuning should preserve that liveness guarantee while avoiding unnecessary work when the continuation has already terminalized the task.

## 2026-09-06 current-build continuation closure

After the public test tunnel changed, Paperclip rotated the bot webhook to the current verified URL using the already-vaulted credential; no token was exposed. The first current-build request then exposed a real shared presentation defect: the exact final comment existed in Paperclip, but Telegram received only `Maya completed this turn.` because heartbeat materialized the final response as an internal comment.

The repaired path now authorizes only the selected final-assistant presentation of an exactly chat-bound run. A fresh request produced exact provider-visible `TG-CURRENT-BUILD-0906-C` instead of a generic completion. A fresh ordinary confirmation then rendered native **Approve** and **Reject** controls; selecting **Approve** edited the card to **Accepted**, scheduled one continuation, and produced exact provider-visible `TG-CONFIRM-CONTINUED-0906`. The final response appeared once, and no generic completion followed it. Raw reasoning, tool events, and internal logs remain in Paperclip.

Transcript review then found that the originating run's own meta-summary still appeared beside the native control and exposed internal interaction terminology. The final implementation keeps that source-run summary internal whenever its exact provider-visible interaction prompt exists, including when the user answers before presentation resolves. The native prompt and the later continuation remain external.

## 2026-09-06 native confirmation follow-up

Earlier provider checks on pre-merge revision `77ad5383e3a8badf7b1b0933a7e9c66469186d55` distinguished the native control from its downstream continuation:

- The older confirmation attempt exposed a link-only fallback gap and is not evidence for native Telegram actions.
- A fresh confirmation on provider message `521…` displayed native **Yes** and **No** controls in Telegram. Selecting **Yes** was accepted exactly once, the sibling choice expired, and the same provider message was edited to **Accepted** with no buttons left active. Paperclip scheduled exactly one continuation.
- The continuation run's final comment remained internal because its run lineage was not recognized as originating from the bound external turn. That older attempt exposed the defect. The current-build **Approve** retest documented above supersedes it and completed the native question-to-continuation round trip with exact final output.

## 2026-09-06 group and boundary extension

The live bot was installed in group `pc-e2e-telegram-0906`; the endpoint remained live through the following cases:

- **Captioned media defect and fix:** a 41-byte `text/plain` document initially normalized with zero attachments because the slash-command callback did not invoke the pinned Telegram adapter's `parseMessage`. The implementation now uses that parser for Telegram command captions. The live retry stored the durable attachment, the agent fetched it with HTTP 200, and Telegram received exact response `paperclip-live-telegram-media-proof-0906`.
- **Topic isolation:** custom topic id `2` mapped to task `CHA-65` and native thread `telegram:-1004415501660:2`; General mapped separately to `CHA-66` and `telegram:-1004415501660`. No cross-topic task reuse was observed.
- **Queue ordering:** A and B were sent six seconds apart. B was admitted only after A succeeded, the placeholder/final lane coalesced, and the exact final marker `tg-queue-A-then-B-0906` was visible. This is live FIFO evidence for one group conversation, not a universal throughput benchmark.
- **Removal, rejoin, and migration:** `my_chat_member` plus the basic-group-to-supergroup migration marked the old resource unavailable and the new resource available once, while restoring the human group label. One stale legacy basic-group inventory artifact created before the fix remains in this disposable database; future migration and membership events use the corrected behavior. The artifact is historical local state, not a current provider failure.
- **Silent publication boundary:** after the `03:44` restart, a prompt explicitly forbidding a public comment produced only generic provider text `Maya completed this turn.` Internal presentation comments are no longer auto-published. Explicit `allow_*` and runner-authored comments remain eligible. The unwanted auto-publication was an implementation defect and the live rerun verifies the fix.

## Scope

- Pre-merge source revision for the historical breadth checks below: `77ad5383e3a8badf7b1b0933a7e9c66469186d55`
- Final pushed and most recently live-rerun source revision: `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`
- Telegram provider-ordering, slash-command receipt, false internal-drain duplicate, stale-action denial, endpoint-generation fencing, command admission, provider-failure classification, coherent progress/status/final lane, native-confirmation lifecycle, and exact final-presentation lineage fixes are present in the final merge revision. The historical breadth checks exercised the pre-merge revision above; the merged-build section records the final live rerun.
- Provider: Telegram, dedicated test bot in a private chat
- Live checkpoint: 2026-09-05 through 2026-09-06

No bot token, webhook secret, cookie, password, or one-time identity-link URL is recorded here.

## Latest live breadth run

### Commands and linear task generations

The live private chat exercised `new`, `status`, and `close` as real Telegram commands. The recorded command deliveries used provider-native `chat_id:message_id` identities, processed with `attempts=1`, and had no redacted error. The task request after `new` returned the exact `telegram-command-prod-a74` response once. A later `status` reported the active task, and `close` closed the linear binding before the next generation.

Telegram commands continue to receive the normal provider receipt reaction because, unlike Slack slash callbacks, Telegram supplies a real message ID. Local regression coverage now asserts that this capability difference survives deferred delivery reconstruction.

### FIFO, bursts, reactions, and edits

The live ledger and provider UI showed:

1. The exact requests `tg-prod-fifo-one` and `tg-prod-fifo-two` were admitted once each and returned their matching final publications in provider order. Each final publication completed in one attempt with no error.
2. A tighter same-second burst, `tg-prod-rapid-three` followed by `tg-prod-rapid-four`, produced two processed inbound deliveries and two one-attempt final publications in three-then-four order. The two wakes were allowed to coalesce operationally without merging, dropping, or reversing the externally visible results.
3. Removing and then adding a reaction on provider message `417200359:143` produced one `reaction_removed` and one `reaction_added` delivery. Both processed once with no error.
4. Editing a source message produced separately auditable `message_updated` deliveries for the provider message, without treating the edit as a duplicate of the original inbound event or starting an unintended replacement task.

### Native file proof

A Telegram document plus “Read the attached file and reply with exactly its Token value” produced one processed direct-message delivery, one stored Paperclip issue attachment, and the exact `chat-upload-a74` final response. Its working and final publications each completed in one attempt, and the final edited the working provider message in place. This proves the tested document path only; photos, audio, video, oversize files, malformed files, and download-failure recovery remain separate cases.

### Queued `new` generation race

The run deliberately put a slow task in one Telegram DM generation, sent another `new`, and then started a new task before the older task finished. The durable state shows distinct consecutive bindings (`CHA-54` and `CHA-55`) on the same Telegram chat. Both inbound requests processed once and both final publications succeeded once. The newer generation returned `telegram-new-generation-a74` before the older generation later returned `telegram-old-generation-a74`; neither final overwrote or attached to the other generation.

This is useful proof of generation isolation, not strict global FIFO across generations. Paperclip intentionally gives each task generation its own provider publication lane, so an older still-running task may finish after a newer one. The current run did not test cancellation of the old run, because `new` defines a new active binding rather than cancellation semantics.

### Delayed-status chronology defect found live

The sequence `new`, a delayed task request, then `status` exposed a provider-visible chronology problem. Status was sampled as `in_progress` and posted after the working placeholder, but the older final response later edited that earlier placeholder in place. Telegram therefore rendered the final answer above a now-stale-looking status message. Every transport operation succeeded, but the resulting conversation was not production-quality.

The final fix makes a task-bound status a durable `task_control` publication in the same conversation FIFO, re-samples authoritative task state at the outbox head, and treats the active run's provider message as one coherent lane. Status edits the open run's queued/working message; the final edits that same provider message again. Once terminal output exists, a later status has no open placeholder and posts separately instead of erasing the final.

The live final-revision rerun used `new`, then `Run sleep 12 then reply exactly tg-status-lane-6f13`, then `status` while `CHA-62` was active. Telegram showed the current `in_progress` state while the run was active and later showed only the final `tg-status-lane-6f13` in that bot-message position. There was no stale `Maya is working…` or `in_progress` sibling. The working, status, and final publication rows all share provider message ID `417200359:199`; each is `published`, `attempts=1`, with no error.

## Latest false-duplicate regression retest

On 2026-09-06 UTC, Telegram update `128` (`/new`) arrived at `04:26:26` and update `130` (the root request) arrived at `04:26:32`. Both deliveries processed with `attempts=1`, null errors, and no `duplicateCount` field, which represents zero duplicates. The exact final response `tg-no-false-duplicate` appeared promptly in Telegram.

Earlier delivery rows intentionally retain the false duplicate telemetry produced before the fix. They are preserved as bug evidence rather than rewritten to resemble the clean retest.

## Core-smoke result

The following private-chat behavior was observed on the recorded working tree:

1. Telegram delivered sequence `118` (`/new`) and sequence `119` (the next request) with the same second-resolution `sentAt` value.
2. The corrected ordering uses Telegram's raw provider date together with monotonically increasing `message_id`, so Paperclip processed `/new` before the request even when their normalized timestamps tied.
3. The corrected slash-command normalization preserved provider message ID `417200359:118`; the provider receipt reaction succeeded and the durable delivery's redacted error remained null. This supersedes the earlier sequence `114` run, where a synthetic hash was incorrectly passed to Telegram as a message ID and the receipt reaction failed.
4. `/new` established the fresh boundary, the following request entered active issue `b2867d3e…`, and the provider showed the acknowledgement followed by the successful final response `tg-receipt-order-live`.
5. The working and final publications each completed in one attempt with no error and reused provider message `417200359:121`, proving that the final response edited the working message in place instead of posting a duplicate.
6. The focused same-second ordering regression passed before the live retest and now asserts the provider-native `chatId:messageId` shape.

This proof supersedes the previously observed same-second race. It does not by itself prove general burst handling across different tasks, multiple chats, or multiple workers.

## Pre-merge local regression evidence

- Telegram edit lifecycle rows now retain the normalized external actor and revalidate the current identity link and Paperclip membership under lock immediately before creating the lifecycle system comment. A deterministic race revokes the actor's link after the original message is admitted; the later edit is filtered, its text is removed from the durable row, and no task comment is created.
- On that pre-merge working tree based on revision `77ad5383e`, the full chat-channel PostgreSQL integration suite passed 183/183 on fresh migrated database `chat_adapters_test_final_20260906_0833`.
- Focused shared tests passed 11/11, focused server tests passed 194/194, and focused UI tests passed 41/41.
- The deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts` passed 4/4, and shared, database, server, and UI typechecks all passed.
- These deterministic checks support the live continuation fix but do not replace the remaining provider cases.

## Earlier core-smoke evidence

On the older `e5f3917b7` checkpoint, rapid updates `88` and `89` each produced one inbound delivery and one final publication in FIFO order. One Telegram Web client displayed an apparent duplicate, but an independent client, the provider event IDs, and Paperclip's durable records showed only one inbound event and one final publication. That older evidence remains a rendering-artifact diagnosis, not a substitute for the current run.

## Qualification gap

This was not a full Telegram runbook PASS. Private-chat commands, text documents, group privacy-mode operation, forum-topic boundaries, queue ordering, removal/rejoin, reaction add/remove, edits, and the silent-publication boundary now have live evidence, but the following still do not:

- disabled-resource enforcement and linked/unlinked identity governance;
- forged and expired real-provider actions beyond the tested one-shot native confirmation; native rendering, continuation, sibling expiry, accepted-state edit, and exact final delivery now have live evidence;
- photos, audio, video, oversize or malformed media, and download-failure handling;
- flood-control retry, global token revocation, recovery, and credential rotation; and
- the complete cleanup and evidence checklist.

Telegram remains unqualified for stable release until the remaining live scenarios pass on the final release-candidate source.
