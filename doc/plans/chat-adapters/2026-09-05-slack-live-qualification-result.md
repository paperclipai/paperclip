# Slack live qualification result — 2026-09-05

> **Status: current-working-tree partial live evidence plus historical core-smoke evidence, not full release qualification.** The current runs proved successful Slack root interactions, rapid two-message FIFO serialization, reaction delivery, pause/resume behavior, and suppression of a redundant same-run follow-up wake on an uncommitted hardening tree above `4b868d3cb`. The older run below remains useful regression evidence. These runs did not execute every Slack case in the browser E2E runbook and are not a full-provider PASS.

## Current-run evidence

- Paperclip source reported by the live process: `4b868d3cbb7b16f784bded5da3183534881a9c32`
- Additional tested state: uncommitted false internal-drain duplicate fix and subsequent chat hardening on top of that source
- Relevant guest-failure UX fix included in that source: `037e57e0d`
- Live checkpoint: 2026-09-05 from 21:05:49 through 21:56:27 local-provider time
- Paperclip issue: `d7f718da-a8da-468e-99a7-79dc337d5cbc`

A signed Slack root message reached the current public tunnel and completed the provider-visible lifecycle: the bot added its receipt reaction, showed a working response, and replaced or completed it with the successful final response in the originating thread.

Earlier unlinked-guest attempts reached Paperclip but failed closed at agent execution with `low_trust_isolation_unavailable`. After identity linking, the current root interaction completed successfully. The `037e57e0d` UX change now presents that containment failure as an actionable blocked-execution explanation instead of leaving the operator with a vague stopped-run state; this is a UX correction, not a relaxation of the low-trust isolation boundary.

The rapid two-message FIFO retest also passed:

1. Slack sent follow-up one and follow-up two in the same thread at `21:06:31.005` and `21:06:31.353` respectively.
2. Paperclip processed each delivery exactly once, with `attempts=1` and no error, at `21:06:32.054` and `21:06:32.286`.
3. All three runs succeeded with exit code 0 and were strictly non-overlapping. In UTC on 2026-09-06, the root ran from `02:05:50` to `02:06:04`, follow-up one from `02:06:32` to `02:06:44`, and follow-up two from `02:06:44.544` to `02:06:58`.
4. Slack displayed the two final replies in one-then-two order.
5. The root and two follow-ups produced six working/final publications total. Every publication completed with `attempts=1` and no error, and each working message was edited in place to its corresponding final response rather than producing an extra progress message.

This is direct evidence for single-thread FIFO serialization, exactly-once delivery processing in this burst, and working-to-final in-place edits. It does not replace the unexecuted Slack capability, governance, failure-injection, and recovery scenarios listed below.

The current public tunnel also passed a reaction round trip after the FIFO run. A user `+1` on follow-up two produced one `reaction_added` delivery for provider message `1788660391.353319`; removing it produced one `reaction_removed` delivery for the same message. Both were processed once with normalized `thumbs_up`/raw `+1` metadata and no redacted error. This proves the manifest's added reaction subscriptions are active on the current setup, not merely present in configuration.

### Latest false-duplicate and pause/resume retest

A later live retest on the current working tree produced the following evidence in UTC:

1. A root sent at `04:28:42` completed normally. Its durable delivery recorded one legitimate ignored duplicate caused by Slack exposing the same root through overlapping subscribed event shapes. This expected provider overlap remained deduplicated after removal of the separate false internal-drain duplicate counter.
2. Follow-up one and follow-up two were sent at `04:29:27.713` and `04:29:27.857`. Each processed exactly once with `attempts=1`, no error, and `duplicateCount=0`.
3. Their runs were FIFO and strictly non-overlapping: follow-up one ran from `04:29:28.507` to `04:29:50.777`, then follow-up two ran from `04:29:50.828` to `04:30:03.065`.
4. Each working/final publication pair completed with `attempts=1` and no error. The final publication reused the working publication's provider message ID, so each response was edited in place and no duplicate external reply appeared.
5. After the endpoint was paused at approximately `04:32`, `slack-paused-should-not-run` appeared in Slack but produced no bot reaction, no bot reply, and no Paperclip delivery. After resume, `slack-resume-ok` was accepted once and published one final response.

The later run also exposed a redundant automation follow-up wake inside Paperclip: the active run's own final comment carried `resume: true`, so it queued another wake even though the same run still owned the issue. The wake was deferred rather than run concurrently, and Slack received no duplicate external message, but the queue work was unnecessary. The fix now suppresses this narrow same-owning-run case while retaining explicit resume from a completed prior run.

A post-fix live retest at `04:58:32` sent `slack-no-empty-wake`. Paperclip admitted one message delivery, processed it once (`attempts=1`, no error), published working and final states once each by editing the same Slack provider message, and produced exactly one assignment wake for the incoming message. No automation follow-up wake was inserted by the agent's own final comment. Slack displayed one final `slack-no-empty-wake` reply.

## Current local regression evidence

- Full chat-channel PostgreSQL integration suite on fresh database `chat_adapters_test_153`: 111/111 passed.
- This local suite does not replace the remaining live-provider cases.

## Historical-run scope

- Paperclip release base: `342c01fee`
- Provider: Slack, disposable App and private channel in the Paperclip workspace
- Paperclip endpoint: `c3c20e8d-5dbd-49b7-9d7e-14068c9ded8b`
- External conversation: `slack:C0C0NFGUYKS`
- Paperclip task: `4a6dd0ca-d022-44c6-868d-7246169f3ef4`

No bot token, signing secret, webhook URL, cookie, password, or one-time identity-link URL is recorded here.

## Historical core-smoke result

The Slack bring-your-own-App path passed the following core live round trip on `342c01fee`:

1. The Paperclip manifest created a Slack App with the exact 16 required bot scopes, including reaction read/write support.
2. Slack accepted the Paperclip request URL for Events API delivery and interactivity.
3. Paperclip rejected neither the App identity nor its scopes and advanced the endpoint to live verification.
4. A root channel mention created one provider thread, one Paperclip conversation, and one Paperclip task assigned to the endpoint's immutable agent.
5. An unmentioned reply in the Slack thread stayed in the same Paperclip conversation and task.
6. Paperclip added the processing reaction, published lifecycle messages in the originating thread, and ignored Slack retry duplicates durably.
7. An explicit **Send to channel** board publication produced a Slack bot reply in the same thread and reached `published` state.
8. The setup test completed with endpoint status `active`, the discovered private channel enabled, and all Settings, Access, Conversations, and Activity views present.

The Activity view recorded both inbound deliveries as processed, showed provider retry duplicates ignored, and recorded all outbound messages as published.

## Deviation

The isolated test instance had no sandbox workspace provider. Its automatic low-trust agent heartbeat therefore failed closed with `low_trust_isolation_unavailable`. The transport round trip was completed using the audited, explicit **Send to channel** publication path. This confirmed inbound mapping, subscribed thread replies, outbound provider delivery, deduplication, and setup activation without weakening the low-trust containment invariant.

## Cleanup

- Archived the disposable private Slack channel.
- Removed the Paperclip Slack endpoint, retiring its endpoint-owned secrets.
- Deleted the disposable Slack App, revoking its bot token and signing secret.
- Stopped the temporary public relay and isolated Paperclip process.

## Historical local regression evidence

- Shared, server, and UI typechecks: passed.
- Focused UI/OpenAPI/server tests: passed.
- Chat-channel PostgreSQL integration suite on fresh `chat_adapters_test_016`: 47/47 passed.
- Deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts`: 4/4 passed.
- Token gates and `git diff --check`: passed.

This evidence is useful for regression comparison, but it is incomplete release evidence. In particular, the full live runbook's identity-linking and permission-revocation cases, unlinked-participant governance checks, disabled-resource matrix, DM lifecycle, file and rich-interaction paths, provider delete behavior, failure and retry recovery, reinstall/reconnect, and cleanup assertions were not all executed in this run. Slack remains unqualified for stable release until the current source revision passes the complete live runbook.
