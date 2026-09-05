# Slack live qualification result — 2026-09-05

> **Status: historical core-smoke evidence, not current release qualification.** This run exercised a narrow transport round trip on the older source revision named below. It did not execute every Slack case in the browser E2E runbook, and it must not be read as a full-provider PASS for the current branch.

## Scope

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

This evidence is useful for regression comparison, but it is incomplete release evidence. In particular, the full live runbook's identity-linking and permission-revocation cases, unlinked-participant governance checks, disabled-resource matrix, DM lifecycle, file and rich-interaction paths, edit/delete behavior, failure and retry recovery, reinstall/reconnect, and cleanup assertions were not all executed in this run. Slack remains unqualified for stable release until the current source revision passes the complete live runbook.
