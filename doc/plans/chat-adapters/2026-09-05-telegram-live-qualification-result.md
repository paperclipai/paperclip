# Telegram live qualification result — 2026-09-05

> **Status: broad private-chat and group/topic live evidence, not full release qualification.** The latest live runs cover task controls, FIFO and burst handling, reactions, edits, native documents, task-generation races, the repaired interleaved status/final lane, group/topic isolation, removal/rejoin, and the silent-publication boundary. Interactive actions, broader media boundaries, global token revocation, and other runbook cases remain open.

## 2026-09-06 group and boundary extension

The live bot was installed in group `pc-e2e-telegram-0906`; the endpoint remained live through the following cases:

- **Captioned media defect and fix:** a 41-byte `text/plain` document initially normalized with zero attachments because the slash-command callback did not invoke the pinned Telegram adapter's `parseMessage`. The implementation now uses that parser for Telegram command captions. The live retry stored the durable attachment, the agent fetched it with HTTP 200, and Telegram received exact response `paperclip-live-telegram-media-proof-0906`.
- **Topic isolation:** custom topic id `2` mapped to task `CHA-65` and native thread `telegram:-1004415501660:2`; General mapped separately to `CHA-66` and `telegram:-1004415501660`. No cross-topic task reuse was observed.
- **Queue ordering:** A and B were sent six seconds apart. B was admitted only after A succeeded, the placeholder/final lane coalesced, and the exact final marker `tg-queue-A-then-B-0906` was visible. This is live FIFO evidence for one group conversation, not a universal throughput benchmark.
- **Removal, rejoin, and migration:** `my_chat_member` plus the basic-group-to-supergroup migration marked the old resource unavailable and the new resource available once, while restoring the human group label. One stale legacy basic-group inventory artifact created before the fix remains in this disposable database; future migration and membership events use the corrected behavior. The artifact is historical local state, not a current provider failure.
- **Silent publication boundary:** after the `03:44` restart, a prompt explicitly forbidding a public comment produced only generic provider text `Maya completed this turn.` Internal presentation comments are no longer auto-published. Explicit `allow_*` and runner-authored comments remain eligible. The unwanted auto-publication was an implementation defect and the live rerun verifies the fix.

## Scope

- Final locally verified and live-rerun source revision: `6f13ec09e95717c4b3b248d1d8cb9ca4e55754ab`
- Telegram provider-ordering, slash-command receipt, false internal-drain duplicate, stale-action denial, endpoint-generation fencing, command admission, provider-failure classification, and coherent progress/status/final lane fixes are committed at this revision.
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

## Current local regression evidence

- On revision `6f13ec09e`, the full chat-channel PostgreSQL integration suite passed 138/138 on fresh migrated database `chat_adapters_test_173`.
- Focused chat server tests passed 115/115, the exact Slack/Telegram interleaved-lane regressions passed 2/2, focused UI tests passed 38/38, OpenAPI passed 6/6, server typecheck passed, and the deterministic browser suite passed 4/4.
- Shared/database/UI typechecks, token gates, and the full workspace build had already passed on the immediate parent before this server-only race fix. Local results do not substitute for the remaining unexecuted live cases.

## Earlier core-smoke evidence

On the older `e5f3917b7` checkpoint, rapid updates `88` and `89` each produced one inbound delivery and one final publication in FIFO order. One Telegram Web client displayed an apparent duplicate, but an independent client, the provider event IDs, and Paperclip's durable records showed only one inbound event and one final publication. That older evidence remains a rendering-artifact diagnosis, not a substitute for the current run.

## Qualification gap

This was not a full Telegram runbook PASS. Private-chat commands, text documents, group privacy-mode operation, forum-topic boundaries, queue ordering, removal/rejoin, reaction add/remove, edits, and the silent-publication boundary now have live evidence, but the following still do not:

- disabled-resource enforcement and linked/unlinked identity governance;
- native interactive questions/actions, including forged, expired, and repeated taps against the real provider;
- photos, audio, video, oversize or malformed media, and download-failure handling;
- flood-control retry, global token revocation, recovery, and credential rotation; and
- the complete cleanup and evidence checklist.

Telegram remains unqualified for stable release until those live scenarios pass on the final release-candidate source.
