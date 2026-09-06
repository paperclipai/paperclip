# GitHub live qualification result — 2026-09-05

> **Status: current setup-path hardening plus historical core-smoke evidence, not current live release qualification.** No current-branch GitHub webhook/task round trip has run. The setup flow is still blocked at GitHub's six-digit sudo verification prompt, and the older provider round trip below must not be treated as a rerun of the current source.

## 2026-09-06 evidence checkpoint

The evidence boundary is unchanged but is now quantified more precisely:

- The archived endpoint `4e87c64e-7d0b-497d-85d2-6eb8820340fc` is genuine historical transport proof. One GitHub issue mapped to one Paperclip task; two inbound issue comments were recorded; an exact webhook redelivery folded into the existing delivery; and six outbound publications reached GitHub in one attempt each.
- The repository used for that historical proof was deleted during its authorized cleanup. Its former provider URL now returns HTTP 404, so it cannot be opened as current visual evidence and must not be cited as proof of the present source revision.
- Four agent runs in that historical task failed closed because the principal was unlinked and the instance had no low-trust isolation environment. That is a Paperclip governance boundary, not a GitHub transport failure, and it must not be presented as successful agent execution.
- The current draft endpoint whose id begins `a31` contains only a Paperclip-generated webhook secret. It has no verified GitHub App identity, private key, installation, repository, signed ping, conversation, or task.
- Current setup is stopped at GitHub's **Confirm access** MFA challenge. That is an external account gate, not an implementation defect. Current-source live qualification cannot resume until the account owner completes that challenge and creates/installs the disposable App.

## Current-run evidence and blocker

- Last pre-merge setup-attempt source revision: `77ad5383e3a8badf7b1b0933a7e9c66469186d55`
- Current locally verified merge revision: `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`
- Signed setup-ping, one-time secret generation, App-identity, lifecycle, admission, and runtime hardening are committed in the current branch.

The current endpoint is back in the honest pre-connect state: `draft`, at the provider-setup step, with no App identity, App ID, private key, installation, resource, conversation, delivery, publication, or signed setup ping recorded. This is expected because the GitHub App has not been created yet.

### Pre-connect secret trap found and healed

The live setup attempt exposed a control-plane defect before GitHub credentials existed. Regenerating Paperclip's webhook secret was treated as rotation of a configured App, which moved the endpoint to `attention` and asked the operator to reconnect credentials that had never been supplied. That was a false degraded state, not a provider failure.

The committed fix distinguishes first-time setup from live credential rotation:

1. Paperclip generates a random 32-byte webhook secret server-side, vaults it through endpoint-owned secret references, returns the plaintext once from the board-authenticated setup-secret route, and marks the response `Cache-Control: no-store`.
2. Normal endpoint reads expose only `webhookSecretConfigured`; they never return the secret. The setup UI presents a read-only one-time copy value, then shows only configured state after refresh.
3. Generating or replacing a secret before any App identity/App credentials exist keeps—or heals—the endpoint to `draft` / provider setup with unchecked connection health. It clears any verification for the superseded secret but does not pretend a live App was degraded.
4. Rotating the secret after an App is configured remains fail-closed: it disables the runtime and requires the operator to update GitHub and reconnect.
5. Every generation is audited as `chat_endpoint.setup_secret_generated` with safe metadata indicating whether the operation was a live rotation; no plaintext secret enters the activity record.
6. The UI opens GitHub's new-App form for first setup, requires App ID and private key rather than pretending a secret-only endpoint is reusable, and explains the consequence before a real rotation.

The signed setup-ping path also accepts a correctly signed GitHub `ping` before App API credentials exist, records `chat_endpoint.webhook_verified` with only the safe provider delivery ID, and returns 401 for a missing or invalid signature. These are code and local-test results; the current GitHub App has not been created to send that ping.

## Current hardening

The branch includes the following GitHub safety and concurrency behavior. These are code and local-test observations, not live GitHub qualification:

1. **Immutable App identity:** Paperclip binds the endpoint to the numeric App registration identity returned by GitHub, separately from the operator-entered App ID used to sign the App JWT. A reconnect that authenticates as a different App registration is rejected with `chat_bot_identity_changed`; endpoint identity cannot drift during credential replacement.
2. **Signed setup-ping state and UI gating:** only a `ping` whose `X-Hub-Signature-256` validates against the current Paperclip-generated webhook secret sets `webhookVerifiedAt`. Missing or invalid signatures return HTTP 401. The setup UI polls this safe timestamp, displays waiting/verified state, and keeps **Connect and verify** disabled until the signed ping has arrived.
3. **Fail-closed secret rotation:** generating a replacement webhook secret clears the prior verification timestamp, removes the active runtime, degrades/disables the connection, and returns setup to the provider-update step. Reconnect remains blocked until GitHub sends a correctly signed ping using the new secret. Concurrent rotation/reconnect paths are serialized so stale credentials cannot overwrite the rotated secret.
4. **Atomic first-resource admission:** the first addressed setup repository is admitted inside the endpoint's serialized transaction. Concurrent root mentions from two initially disabled repositories can enable only one repository and create only its one conversation/task; the other repository remains disabled rather than racing through the first-resource exception.
5. **Runtime singleflight:** concurrent webhooks that arrive while a configured GitHub runtime is cold share one initialization promise. Paperclip installs one runtime and both requests proceed through it instead of racing duplicate adapter instances.
6. **Complete repository inventory:** GitHub installation-repository discovery follows successive 100-item pages, so an installation with more than 100 repositories is not silently truncated. Installation discovery likewise scans every page before enforcing the one-active-installation invariant.
7. **Retryable subscription without duplicate task state:** if the provider thread subscription fails after the task, external comment, wakeup request, and message link commit, the delivery remains retryable. A retry reuses those durable idempotent records, attempts the subscription again, and does not create another task, comment, or wakeup.
8. **Lifecycle revalidation:** installation creation or unsuspension re-authenticates the exact stored App identity and rechecks required permissions and events before recovery. App-ID, permission, or event drift fails closed: the endpoint moves to attention, the connection/runtime is disabled, resources and conversations remain unavailable, and the lifecycle delivery stays diagnosable/retryable rather than restoring access optimistically.
9. **Stable repository identity:** repository rename or transfer is reconciled through GitHub's immutable numeric repository ID. Paperclip preserves the resource, conversation, task, allowlist choice, and follow-up route while updating mutable owner/name coordinates and provider URLs; a conflicting dual-coordinate binding fails closed.
10. **Cold-start response budget:** the provider ingress deadline begins before runtime initialization. A signed webhook that cannot finish cold adapter startup inside the provider budget returns promptly and proceeds only through bounded durable retry instead of consuming GitHub's delivery timeout before Paperclip begins accounting for it.

None of these local checks substitutes for exercising the same paths against GitHub's real App registration, installation, webhook redelivery, and suspension UI.

On final pushed merge revision `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`, the full chat-channel PostgreSQL integration suite passed 188/188 on fresh migrated database `chat_adapters_test_20260906_1140`; merge-conflict-focused server tests passed 355/355; and the deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts` passed 5/5 across Slack, GitHub, Teams, Discord, and Telegram. Shared, database, server, and UI typechecks, migration safety, token gates, a clean Discord patch application against the pristine package, and both working-tree checks passed. CI owns `pnpm-lock.yaml` and regenerates the PR lockfile artifact before its frozen install. Earlier provider-focused results remain valid regression evidence. These local results strengthen the setup path but do not change the live-provider blocker or qualification status.

Actual GitHub App registration and current-build provider delivery remain unexecuted. The signed-in GitHub session is stopped at GitHub's six-digit sudo-mode verification prompt. Until that account challenge is completed, no current App credentials, installation, signed ping, issue/PR/review event, reaction, edit, file fallback, or outbound publication can be qualified live.

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
