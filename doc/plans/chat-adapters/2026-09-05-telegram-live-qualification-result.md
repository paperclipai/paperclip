# Telegram live qualification result — 2026-09-05

> **Status: current-build core-smoke evidence only, not full release qualification.** This run proved a private-chat round trip and ordered burst handling on the source revision below. It did not execute every Telegram case in the browser E2E runbook.

## Scope

- Paperclip source used for the live run: `e5f3917b7`
- Provider: Telegram, dedicated test bot in a private chat
- Paperclip task used for the rapid-turn check: `ede30d33-2924-477f-8cfd-3acf86183006`

No bot token, webhook secret, cookie, password, or one-time identity-link URL is recorded here.

## Core-smoke result

The following private-chat behavior was observed on the recorded source revision:

1. `/new` established a fresh task boundary and a subsequent exact-response request completed successfully.
2. Two rapid follow-up requests were accepted in their original order and produced two successful Paperclip runs in FIFO order.
3. Telegram update IDs `88` and `89` each produced exactly one inbound Paperclip delivery and one final response publication.
4. Paperclip recorded the inbound deliveries as processed, the outbound publications as published, and the endpoint as active with health `Connected`.
5. One Telegram Web client rendered what looked like a duplicate second response. An independent Telegram Web client, provider event IDs, and Paperclip's durable delivery/publication records each showed only one inbound event and one final publication for that request, so the artifact was not an adapter-side duplicate.

## Qualification gap

This was not a full Telegram runbook PASS. Group and forum-topic reach, disabled-resource enforcement, linked and unlinked identity governance, commands and inline interactions, file/media handling, reactions, edits, flood-control recovery, membership loss/recovery, credential rotation, and the complete cleanup/evidence checklist remain unexecuted on this source revision. Telegram remains unqualified for stable release until those live scenarios pass on the release candidate.
