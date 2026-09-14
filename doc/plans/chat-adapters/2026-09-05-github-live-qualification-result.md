# GitHub live qualification result — 2026-09-05

For the September 7 private-attachment limitation and live outbound task-notice
check, see [media qualification](2026-09-07-media-live-qualification.md).

For September 8–9 native Luna conversations, private-file omission/pasted-text
proof and deployment, use the
[current qualification ledger](2026-09-08-chat-queue-and-webhook-repair.md).
Historical rows below keep their original scopes. Server 70's new task-link →
correct-task upload journey and remaining provider permutations are not yet
qualified live.

> **Status: current App connection, signed Tailscale ingress, exact agent replies, ordered burst handling, and keep-open idle recovery are proven; full production qualification remains open.** The September 7 checkpoints below supersede the older login/credential gates and the intermediate unsolicited-recovery blocker.

## 2026-09-07 current live checkpoint

On `95cbbd08e`, the user-authorized PEM import connected **Paperclip Maya E2E
0906** (App ID `4853886`, installation `159668881`) to endpoint
`e516ceb3-397c-4a28-9640-1b2779515fb9`. The installation is restricted to two
private disposable repositories. The operator's `cryppadotta` identity is
linked to the local Board account through the private confirmation flow.

The App now sends signed webhooks through stable Tailscale Funnel origin
`https://dottas-macbook-pro.tail29c1aa.ts.net:10000`. Only provider webhook
ingress is public; the board remains local/private. The temporary Cloudflare
tunnel was stopped after a real signed issue comment reached Paperclip.

- [Issue 1](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/1)
  created CHA-1 before identity linking and received the expected safe guest
  refusal. That task retains its guest trust classification.
- [Issue 2](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2)
  created CHA-2 after identity linking, with a receipt reaction. Its bundled
  Codex ACP process incorrectly reported an unsupported-model provider error
  as a completed assistant response, which was published to GitHub. This is a
  release-blocking defect at that checkpoint, not a successful answer. Commit
  `1325329e3` repairs the typed ACP terminal-error classification. The later
  response-selection repair described below is separately required.
- [Disabled-repository issue 1](https://github.com/cryppadotta/paperclip-chat-e2e-disabled/issues/1#issuecomment-5571234021)
  produced a GitHub webhook response **200 / ignored**, with no Paperclip
  conversation or task. Provider installation access did not override the
  Paperclip allowlist.

At `2026-09-07T13:45Z`, on `1325329e3` plus the final-response selection,
receipt, and scheduler working-tree changes, an unmentioned follow-up in
issue 2 requested exactly `GH-LIVE-0907-ROUNDTRIP-OK`. Run
`b7190e01-0176-4af7-a471-c1e013c2a015` succeeded and
[bot comment 5571558895](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2#issuecomment-5571558895)
contained exactly that response. The existing conversation and CHA-2 task
were retained. The setup UI subsequently completed and the endpoint is now
`active`.

The preceding live run had produced the correct model final but published an
earlier internal bookkeeping comment instead. External-chat runs now publish
only the runner-selected final; intermediate lifecycle comments remain
internal. A yielded or missing final cannot fall back to an internal note.
After the corrected reply, generic productive-task recovery incorrectly
started an unsolicited extra run. That separate queue defect is under repair;
the exact reply is not evidence that the entire interaction lifecycle passes.
The narrow recovery fix subsequently passed the full 133-case process-recovery
suite. A rapid three-message live test also retained all messages on CHA-2,
coalesced the last two into one deferred wake, and returned exactly
`DELTA EPSILON` without mixing Discord's distinct test words. Its two causal
runs took roughly 78 and 15 seconds. A keep-open task retest is still needed
to verify the recovery guard live, because this burst ended with the task done.

### Clean keep-open recovery qualification — 2026-09-07, 13:59 UTC

This checkpoint supersedes the pending keep-open retest above. On clean source
revision `5bd9c0d55`, an unmentioned follow-up on the existing CHA-2 issue left
the task deliberately `in_progress` and requested exactly
`GITHUB-IDLE-WAIT-OK`. Run `c3335bdf-6a2e-49a5-82eb-8d31df92e4d0` ran from
`13:59:33.398Z` through `13:59:39.464Z` and succeeded. GitHub
[bot comment 5571729974](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2#issuecomment-5571729974)
contained exactly that marker.

CHA-2 remained `in_progress` with its external conversation active for more
than eight minutes after the terminal reply. No additional run appeared. This
is live evidence that an idle, keep-open chat task is no longer mistaken for
stranded productive work, while explicit inbound and queued work remain
runnable. It supersedes the earlier checkpoint where generic recovery started
an unsolicited run after a successful reply.

### PR and review-comment boundary qualification — 2026-09-07, 14:29 UTC

A live pull-request boundary check used disposable private
[PR 3](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/pull/3),
branch `qa/chat-review-0907`, commit
`e5219350f17973895671f420c596de16852d1f10`, and the two-line file
`chat-review-0907.txt`. No repository operation was delegated to the agent.

The PR's main conversation received human comment `5572099126` and one
[bot reply `5572100025`](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/pull/3#issuecomment-5572100025)
containing exactly `GH-PR-LEVEL-0907-OK`. Paperclip bound provider thread
`github:cryppadotta/paperclip-chat-e2e-enabled:3` to conversation
`6f313c48-e684-421f-a730-dd68112c1e2c` and task
`5329b4bf-6b16-40d5-ad69-65bcbeac2ab3`. Run
`0d57af6e-2351-4bf2-8736-1d61cc877e67` ran from `14:29:10.041Z` through
`14:29:16.354Z`.

GitHub's current Files changed UI did not expose an actionable line-level
comment control during this walkthrough. The test therefore used **Comment on
this file** followed by **Add single comment**. Human review comment
`3950666444` received one
[bot reply `3950666803`](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/pull/3/changes#r3950666803)
containing exactly `GH-PR-REVIEW-0907-OK`. Paperclip bound the distinct provider
thread `github:cryppadotta/paperclip-chat-e2e-enabled:3:rc:3950666444` to
conversation `241f99a5-54ff-4bef-a0e7-313d69bf72b2` and task
`860c7878-f1a6-498d-995c-6feaa735eb27`. Run
`78deae9a-eb13-4374-a272-645ef1aec2d1` ran from `14:32:16.599Z` through
`14:33:29.285Z`. Its working publication at `14:32:17.750Z` and final
publication at `14:33:30.445Z` both settled through provider message
`3950666803` in one attempt, so progress-to-final used one edited comment rather
than producing duplicates.

This proves that a real PR main conversation and a real GitHub review-comment
thread on the same PR bind to different Paperclip conversations and tasks, and
that both can return an exact agent response. It does **not** qualify a
line-specific review comment: the exercised GitHub control was file-level. The
review reply also appeared only after a page reload. Its roughly 73-second
latency was dominated by a 72-second model turn (`ensure_session` was about
433 ms), not Paperclip queueing or provider transport; the result was correct,
but that wait remains a user-experience risk and prevents calling this path
fully production-ready.

### Image and file boundary — 2026-09-07

GitHub's native comment composer does not deliver uploaded bytes to the App.
It first hosts the upload and writes a reference into the comment body. In the
current GitHub UI, an image may appear as an HTML `<img src="https://github.com/user-attachments/assets/…">`
element rather than Markdown image syntax; a general file appears as a
Markdown link to `https://github.com/user-attachments/files/…`. Paperclip
retains a bounded set of safe HTTPS destinations in the normalized task text,
but deliberately does not fetch or store those provider-hosted bytes. GitHub's
[anonymized-URL rules](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)
also mean the URL itself can be a capability, so it remains ordinary external
text rather than being republished as a Paperclip-owned attachment.

The inverse direction is also link-only. The GitHub App issue-comment and
pull-review-comment APIs accept a Markdown body, but expose no attachment-byte
upload field. Using GitHub CLI's `--attach` workaround would require repository
push access, which is intentionally outside this chat connection's Issues and
Pull requests permissions. Paperclip therefore must not claim that a checked
Board file was uploaded to GitHub. It now publishes an explicit limitation and,
only when the Board has a safe externally configured URL, an authenticated
Paperclip task link. A private/local Board produces a private-task notice with
no unusable localhost or webhook-ingress URL.

The task banner presents this provider-specific boundary before send: checked
files remain on the Paperclip task, while GitHub receives the authenticated
task link or the private-task notice. Focused adapter coverage exercises both
GitHub's native HTML image form and Markdown file-link form while asserting
that neither becomes a native attachment. Integration coverage asserts both
outbound fallback variants and that no provider file bytes or storage reads
occur. This is truthful link interoperability, not native GitHub file transfer.

A live issue-comment exercise then used GitHub's native upload UI with a known
image and a 128-byte text fixture. Human comment `5572301393` contained the
default HTML image reference plus the Markdown file link. Run
`0c252a02-51cc-4aeb-b829-73865415070e` ran from approximately `14:44:27Z`
through `14:46:37Z`. The
[bot reply `5572302077`](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2#issuecomment-5572302077)
did not fabricate either file's contents, which is the correct safety outcome,
but said that no authorized GitHub connection was available and suggested a
new connection request. That explanation is misleading: the GitHub **chat**
connection was active and transported the hosted links, but it intentionally
grants neither GitHub repository-tool authority nor credentials for fetching
provider-hosted attachment bytes. Chat-origin guidance must state that precise
boundary instead of implying the existing App is disconnected or requesting a
duplicate chat connection. Until that wording is corrected and the optional
separate-tool path is qualified, inbound GitHub media remains link-preservation
evidence, not readable-file qualification.

Focused adapter regression coverage now includes unmentioned follow-ups in PR
and review-comment threads plus the native review reply/edit HTTP boundary.
That file passed **3/3**, and the server typecheck passed. The broader
current-tree integration result remains pending after the latest causal issue
fence, so the earlier full-suite count is not advanced by this checkpoint.

The current split ingress topology keeps the board private. Public HTTPS
`:10000` remains available for the existing Slack and GitHub callback URLs;
public HTTPS `:8443` is the canonical webhook-only origin used for Telegram.
Both terminate at the narrow loopback proxy on port 3104. HTTPS `:443` remains
tailnet-only for the board, and the public webhook listeners do not forward
board health or company API routes.

After the latest setup-edge changes, the full chat integration suite passed
**258/258** and the combined process-recovery/status-payload suite passed
**135/135**, both with zero skips. The deterministic browser suite had passed
**5/5** on clean revision `5bd9c0d55`, but has not yet been rerun after the
latest setup-edge/UI changes; the current working tree is therefore not being
claimed browser-green here.

The [live addendum](2026-09-06-live-qualification-addendum.md) records exact
delivery and runtime evidence. Broader burst/fault coverage, recovery, reviews/PRs,
actions/files, and the rest of the release matrix remain open. All checkpoints
below are historical, not descriptions of the current login or credential state.

## Historical 2026-09-06 evidence checkpoint

The evidence boundary is unchanged but is now quantified more precisely:

- The archived endpoint `4e87c64e-7d0b-497d-85d2-6eb8820340fc` is genuine historical transport proof. One GitHub issue mapped to one Paperclip task; two inbound issue comments were recorded; an exact webhook redelivery folded into the existing delivery; and six outbound publications reached GitHub in one attempt each.
- The repository used for that historical proof was deleted during its authorized cleanup. Its former provider URL now returns HTTP 404, so it cannot be opened as current visual evidence and must not be cited as proof of the present source revision.
- Four agent runs in that historical task failed closed because the principal was unlinked and the instance had no low-trust isolation environment. That is a Paperclip governance boundary, not a GitHub transport failure, and it must not be presented as successful agent execution.
- The current draft endpoint whose id begins `a31` contains only a Paperclip-generated webhook secret. It has no verified GitHub App identity, private key, installation, repository, signed ping, conversation, or task.
- Current setup is stopped at GitHub's **Confirm access** MFA challenge. That is an external account gate, not an implementation defect. Current-source live qualification cannot resume until the account owner completes that challenge and creates/installs the disposable App.

### Release decision at this checkpoint

GitHub remains a release blocker for the five-provider claim. The current browser session is still stopped at the six-digit sudo-mode MFA prompt, before App creation, key generation, installation, signed ping, or any issue/PR/review webhook. Deterministic browser, integration, signature, lifecycle, concurrency, and permission tests establish implementation coverage only; they do not convert the historical deleted-repository run into current-source provider evidence. A temporary tunnel response would prove only that Paperclip's route is reachable, not that a durable production callback, GitHub App identity, or real event round trip is qualified.

## Historical setup-run evidence and blocker

- Last pre-merge setup-attempt source revision: `77ad5383e3a8badf7b1b0933a7e9c66469186d55`
- Latest implementation revision covered by focused checks: `83018c688`
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

The signed setup-ping path also accepts a correctly signed GitHub `ping` before App API credentials exist, records `chat_endpoint.webhook_verified` with only the safe provider delivery ID, and returns 401 for a missing or invalid signature. These were code and local-test results at the September 6 checkpoint; that App had not yet been created to send the ping.

## September 6 hardening checkpoint

The branch includes the following GitHub safety and concurrency behavior. These are code and local-test observations, not live GitHub qualification:

1. **Immutable App identity:** Paperclip binds the endpoint to the numeric App registration identity returned by GitHub, separately from the operator-entered App ID used to sign the App JWT. Reconnect and first-setup recovery from `attention` both revalidate an already claimed identity; credentials for a different App are rejected with `chat_bot_identity_changed`, including after a crash between identity claim and secret persistence.
2. **Signed setup-ping state and UI gating:** only a `ping` whose `X-Hub-Signature-256` validates against the current Paperclip-generated webhook secret sets `webhookVerifiedAt`. Missing or invalid signatures return HTTP 401. The setup UI polls this safe timestamp, displays waiting/verified state, and keeps **Connect and verify** disabled until the signed ping has arrived.
3. **Fail-closed secret rotation:** generating a replacement webhook secret clears the prior verification timestamp, removes the active runtime, degrades/disables the connection, and returns setup to the provider-update step. Reconnect remains blocked until GitHub sends a correctly signed ping using the new secret. Concurrent rotation/reconnect paths are serialized so stale credentials cannot overwrite the rotated secret.
4. **Atomic first-resource admission:** the first addressed setup repository is admitted inside the endpoint's serialized transaction. Concurrent root mentions from two initially disabled repositories can enable only one repository and create only its one conversation/task; the other repository remains disabled rather than racing through the first-resource exception.
5. **Runtime singleflight:** concurrent webhooks that arrive while a configured GitHub runtime is cold share one initialization promise. Paperclip installs one runtime and both requests proceed through it instead of racing duplicate adapter instances.
6. **Complete repository inventory:** GitHub installation-repository discovery follows successive 100-item pages, so an installation with more than 100 repositories is not silently truncated. Installation discovery likewise scans every page before enforcing the one-active-installation invariant.
7. **Retryable subscription without duplicate task state:** if the provider thread subscription fails after the task, external comment, wakeup request, and message link commit, the delivery remains retryable. A retry reuses those durable idempotent records, attempts the subscription again, and does not create another task, comment, or wakeup.
8. **Lifecycle revalidation:** installation creation or unsuspension re-authenticates the exact stored App identity and rechecks required permissions and events before recovery. App-ID, permission, or event drift fails closed: the endpoint moves to attention, the connection/runtime is disabled, resources and conversations remain unavailable, and the lifecycle delivery stays diagnosable/retryable rather than restoring access optimistically.
9. **Stable repository identity:** repository rename or transfer is reconciled through GitHub's immutable numeric repository ID. Paperclip preserves the resource, conversation, task, allowlist choice, and follow-up route while updating mutable owner/name coordinates and provider URLs; a conflicting dual-coordinate binding fails closed.
10. **Cold-start response budget:** the provider ingress deadline begins before runtime initialization. A signed webhook that cannot finish cold adapter startup inside the provider budget returns promptly and proceeds only through bounded durable retry instead of consuming GitHub's delivery timeout before Paperclip begins accounting for it.
11. **Provider-global App ownership:** the immutable numeric App registration
    id has one live Paperclip endpoint even if GitHub transfers the App to a
    different owner. Setup claims that id through a database uniqueness fence
    before persisting App credentials; concurrent cross-company attempts leave
    credentials only on the winner and do not reveal the owning company,
    endpoint, or agent.

None of these local checks substitutes for exercising the same paths against GitHub's real App registration, installation, webhook redelivery, and suspension UI.

On merge revision `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`, the full chat-channel PostgreSQL integration suite passed 188/188 on fresh migrated database `chat_adapters_test_20260906_1140`; merge-conflict-focused server tests passed 355/355; and the deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts` passed 5/5 across Slack, GitHub, Teams, Discord, and Telegram. Implementation revision `83018c688` then passed the 42-test Discord adapter/runtime subset, the 34-test Discord/OpenAPI/UI contract subset, server/UI typechecks, token gates, a clean Discord patch application against the pristine package, and both working-tree checks. CI owns `pnpm-lock.yaml` and regenerates the PR lockfile artifact before its frozen install. Earlier provider-focused results remain valid regression evidence. These local results strengthen the setup path but do not change the live-provider blocker or qualification status.

The final combined working tree passed 193/193 chat-channel integration tests on fresh migrated database `chat_adapters_test_final_20260906_1257`, 111/111 focused runtime/error/privacy tests, all package typechecks, token gates, and the deterministic five-provider browser suite. This remains local evidence only for GitHub.

At the September 6 checkpoint, App registration and current-build provider delivery remained unexecuted because the signed-in session was stopped at GitHub's six-digit sudo-mode prompt. The later connected-App evidence above supersedes that setup gate without retroactively qualifying the unexecuted scenarios on the older revision.

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
- Archived the Paperclip chat endpoint, which retired its endpoint-owned secrets but did not change any GitHub App registration, installation, repository grant, or webhook setting.
- Separately deleted all four disposable GitHub Apps in GitHub after qualifying the provider form and manifest paths.
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
