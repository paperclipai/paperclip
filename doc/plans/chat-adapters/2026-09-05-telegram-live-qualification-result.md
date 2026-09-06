# Telegram live qualification result — 2026-09-05

> **Status: current working-tree core-smoke evidence only, not full release qualification.** The latest live runs proved a clean no-false-duplicate private-chat round trip, deterministic ordering for a same-second `/new` race, and a valid provider receipt reaction for the slash command. The fixes were still uncommitted on top of the source checkpoint below, and the runs did not execute every Telegram case in the browser E2E runbook.

## Scope

- Paperclip committed base reported by the live process: `4b868d3cbb7b16f784bded5da3183534881a9c32`
- Additional tested state: uncommitted Telegram provider-ordering, slash-command receipt, and false internal-drain duplicate fixes on top of that base
- Provider: Telegram, dedicated test bot in a private chat
- Current active Paperclip task: `b2867d3e…` (redacted suffix in this record)
- Live checkpoint: 2026-09-05 at approximately 21:53 local time

No bot token, webhook secret, cookie, password, or one-time identity-link URL is recorded here.

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

- Full chat-channel PostgreSQL integration suite on fresh database `chat_adapters_test_153`: 111/111 passed.
- This local suite does not replace the remaining live-provider cases.

## Earlier core-smoke evidence

On the older `e5f3917b7` checkpoint, rapid updates `88` and `89` each produced one inbound delivery and one final publication in FIFO order. One Telegram Web client displayed an apparent duplicate, but an independent client, the provider event IDs, and Paperclip's durable records showed only one inbound event and one final publication. That older evidence remains a rendering-artifact diagnosis, not a substitute for the current run.

## Qualification gap

This was not a full Telegram runbook PASS. Group and forum-topic reach, disabled-resource enforcement, linked and unlinked identity governance, the rest of the command vocabulary and inline interactions, file/media handling, user reaction add/remove lifecycle, edits, flood-control recovery, membership loss/recovery, credential rotation, and the complete cleanup/evidence checklist remain unexecuted on this source revision. Telegram remains unqualified for stable release until those live scenarios pass on the release candidate.
