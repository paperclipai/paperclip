# GitHub live qualification result — 2026-09-05

> **Status: historical core-smoke evidence, not current release qualification.** This run exercised a narrow transport round trip on the older source revision named below. Reconciliation onto another source revision was not a live rerun. The result does not represent a full-provider PASS for the current branch.

## Scope

- Paperclip base used for the live run: `5da649986016e4010da8156f83f5bfc9c0128be4`
- Reconciled release base after the run: `342c01fee`
- Chat SDK / GitHub adapter: `4.39.0`
- Provider: GitHub.com, disposable personal-account App and private repository
- Paperclip endpoint: `4e87c64e-7d0b-497d-85d2-6eb8820340fc` (archived during cleanup)
- External conversation: `github:cryppadotta/paperclip-chat-e2e-enabled:issue:1`
- Paperclip task: `9ad34556-30b5-47a1-b207-ba666d8d897e`

No token, webhook secret, private key, cookie, password, or one-time identity-link URL is recorded here.

## Historical core-smoke result

The GitHub bring-your-own-App path passed the following core live round trip on `5da649986016e4010da8156f83f5bfc9c0128be4`:

1. Paperclip generated and stored the webhook secret without exposing it through normal endpoint reads.
2. A private GitHub App was created with Issues and Pull requests set to read/write and only the selectable `issue_comment` and `pull_request_review_comment` events requested. GitHub supplied installation lifecycle events automatically.
3. The App was installed on one selected private repository. Paperclip discovered that repository disabled by default.
4. A mention sent before Paperclip access was enabled was durably filtered with `Destination is not enabled in Paperclip`.
5. After enabling the repository, a root GitHub issue comment mentioning the immutable App bot created exactly one Paperclip conversation and one task.
6. A non-mention follow-up in the same GitHub issue remained in the subscribed conversation.
7. An explicit Paperclip board publication produced a GitHub bot reply and reached `published` state.
8. The setup test completed with endpoint status `active` and health message `Connected`.

GitHub accepted all qualified webhook deliveries with HTTP 200 once a public relay was available. The initial Tailscale hostname was tailnet-only, so the run used a temporary TLS relay and then shut it down.

## Deviation

The isolated test instance had no sandbox workspace provider. Its automatic low-trust agent heartbeat therefore failed closed with `low_trust_isolation_unavailable`. The transport round trip was completed using the audited, explicit **Send to channel** publication path. This confirmed inbound mapping, subscribed replies, outbound provider delivery, and setup activation without weakening the low-trust containment invariant.

## Cleanup

- Closed the disposable GitHub issue.
- Archived the Paperclip chat endpoint, which retired its endpoint-owned secrets.
- Deleted all four disposable GitHub Apps created while qualifying the provider form and manifest paths.
- Deleted the explicitly disposable private repository `paperclip-chat-e2e-enabled`.
- Stopped the temporary registration server, public relay, and isolated Paperclip process.

## Historical local regression evidence

- Workspace build: passed.
- Shared, server, and UI typechecks: passed.
- Focused shared/UI/OpenAPI tests: 45/45 passed.
- Chat-channel PostgreSQL integration suite on fresh `chat_adapters_test_014`: 47/47 passed.
- Deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts`: 4/4 passed.
- Token gates and `git diff --check`: passed.

This evidence is useful for regression comparison, but it is incomplete release evidence. In particular, the full live runbook's issue/PR/inline-review boundary matrix, linked and unlinked identity authorization, reaction/edit lifecycle, text-only attachment fallback, burst/redelivery behavior, installation suspension/recovery, and all cleanup assertions were not all executed in this run. GitHub remains unqualified for stable release until the current source revision passes the complete live runbook.
