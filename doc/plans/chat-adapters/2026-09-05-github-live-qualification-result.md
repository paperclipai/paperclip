# GitHub live qualification result — 2026-09-05

> **Status: current setup-path regression evidence plus historical core-smoke evidence, not current live release qualification.** The current branch fixes signed setup-ping handling and proves unsigned requests fail closed, but creation/configuration of the real GitHub App is still blocked at GitHub's sudo verification prompt. The older provider round trip below is not a live rerun of the current branch.

## Current-run evidence and blocker

- Current source checkpoint after rebase and final verification: `1d952088ce20b18e236a256095a0a6513f6363be`
- Setup-ping fix: `4b868d3cb` (`fix: accept signed GitHub setup pings`)
- GitHub control-plane and runtime hardening is committed in the current branch.

The current regression path accepts a correctly signed GitHub setup ping while an unsigned setup ping receives HTTP 401. This closes the setup-probe signature bug without weakening webhook authentication.

## Current hardening

The current working tree adds the following GitHub safety and concurrency behavior. These are code and local-test observations, not live GitHub qualification:

1. **Immutable App identity:** Paperclip binds the endpoint to the numeric App registration identity returned by GitHub, separately from the operator-entered App ID used to sign the App JWT. A reconnect that authenticates as a different App registration is rejected with `chat_bot_identity_changed`; endpoint identity cannot drift during credential replacement.
2. **Signed setup-ping state and UI gating:** only a `ping` whose `X-Hub-Signature-256` validates against the current Paperclip-generated webhook secret sets `webhookVerifiedAt`. Missing or invalid signatures return HTTP 401. The setup UI polls this safe timestamp, displays waiting/verified state, and keeps **Connect and verify** disabled until the signed ping has arrived.
3. **Fail-closed secret rotation:** generating a replacement webhook secret clears the prior verification timestamp, removes the active runtime, degrades/disables the connection, and returns setup to the provider-update step. Reconnect remains blocked until GitHub sends a correctly signed ping using the new secret. Concurrent rotation/reconnect paths are serialized so stale credentials cannot overwrite the rotated secret.
4. **Atomic first-resource admission:** the first addressed setup repository is admitted inside the endpoint's serialized transaction. Concurrent root mentions from two initially disabled repositories can enable only one repository and create only its one conversation/task; the other repository remains disabled rather than racing through the first-resource exception.
5. **Runtime singleflight:** concurrent webhooks that arrive while a configured GitHub runtime is cold share one initialization promise. Paperclip installs one runtime and both requests proceed through it instead of racing duplicate adapter instances.
6. **Complete repository inventory:** GitHub installation-repository discovery follows successive 100-item pages, so an installation with more than 100 repositories is not silently truncated. Installation discovery likewise scans every page before enforcing the one-active-installation invariant.
7. **Retryable subscription without duplicate task state:** if the provider thread subscription fails after the task, external comment, wakeup request, and message link commit, the delivery remains retryable. A retry reuses those durable idempotent records, attempts the subscription again, and does not create another task, comment, or wakeup.
8. **Lifecycle revalidation:** installation creation or unsuspension re-authenticates the exact stored App identity and rechecks required permissions and events before recovery. App-ID, permission, or event drift fails closed: the endpoint moves to attention, the connection/runtime is disabled, resources and conversations remain unavailable, and the lifecycle delivery stays diagnosable/retryable rather than restoring access optimistically.

None of these local checks substitutes for exercising the same paths against GitHub's real App registration, installation, webhook redelivery, and suspension UI.

The full chat-channel PostgreSQL integration suite passed 111/111 on fresh database `chat_adapters_test_153`. This strengthens the current working-tree regression evidence but does not change the live-provider blocker or qualification status.

Actual GitHub App registration and current-build provider delivery remain unexecuted. The signed-in GitHub session is stopped at GitHub's sudo-mode six-digit verification prompt, so no current App credentials, installation, issue/PR/review event, reaction, edit, or publication has been qualified live. That provider verification must be completed before the current live run can continue.

## Historical-run scope

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
