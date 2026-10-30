# Chat adapters live qualification addendum — 2026-09-06

This addendum records the qualification state observed on 2026-09-06. It is
deliberately narrower than the provider runbooks: automated proof and live
provider proof are reported separately, and an account page being reachable is
not counted as a successful end-to-end conversation.

## Reliability work completed in this pass

- Provider-visible mutations are fenced against credential rotation, pause,
  reconnect, and removal with durable credential leases and generation/ref
  checks.
- Outbound sends use short durable claims around provider I/O. A response lost
  after provider acceptance is quarantined as `delivery_unknown`; it is not
  replayed automatically.
- Explicit duplicate-risk retries are audited and single-owner. Slack
  slash-command roots persist a provider-confirmed phase before the separate
  Paperclip task admission phase, so crash recovery cannot post a second root.
- Slack slash-command authorization and destination reach are snapshotted in a
  transaction that releases its row locks before provider I/O. That snapshot
  authorizes only the Slack root send. The later Paperclip task admission is a
  separate mutation that rechecks current endpoint reach, resource state,
  identity link, membership, and guest sponsorship after any crash or restart.
  Reclaimed admission workers carry a durable ownership token so an obsolete
  worker cannot settle the successor's attempt. A recovered command cannot
  reactivate a disabled setup destination, including when its durable envelope
  was written by an older version. Rejected, unapplied deliveries retain only
  identifiers needed for deduplication and filtering diagnostics, not message
  text or principal profiles.
- Receipt reactions use their own idempotent outbox. A Slack retry that reports
  `already_reacted` settles successfully, while rate limits retain their full
  provider retry interval.
- Inbound turns are processed in durable provider order under a renewable
  conversation lease. Lifecycle changes and credential changes fence stale
  runtimes instead of allowing them to commit later work.
- Run completion waits for the runner's presentation decision and suppresses a
  generic completion when an explicitly authorized final response exists. A
  provisional same-run final comment can be upgraded to the externally visible
  response without creating a duplicate comment.
- GitHub verifies webhook signatures and current installation/repository reach
  before retaining a bounded recovery payload. Durable claims survive process
  restarts, fence credential changes, and redact terminal payloads. A manual
  provider redelivery can rearm a terminal failure only for the identical event
  and body digest; lifetime attempt ownership is not reset. Both GitHub mention
  forms work, while setup instructions show the App's bare slug.
- Discord responses exceeding the provider's rendered message limit are sent
  losslessly as a Markdown attachment. Only the safe external response is used;
  internal reasoning and logs are not included.
- Telegram can finish an already-queued second turn after natural task
  completion, but cannot cross an explicit `/new` or `/close` boundary. Teams
  thread decoding validates canonical encoding before interpreting legacy IDs.
- Invalid publication payloads fail individually instead of poisoning the
  global queue. Transient preparation failures use bounded backoff, and the
  same drain can continue to a healthy publication behind the failed row.
- Provider-confirmed Slack admissions on paused or attention endpoints remain
  parked without occupying the active worker page. They become eligible again
  after the endpoint is repaired or resumed; active endpoints can keep moving.
- Dual-purpose connectors keep their chat setup separate from tool credentials.
  The tool connection flow excludes chat-only methods from selection,
  recommendations, and submission, and agent-facing connection intents expose
  only tool methods. GitHub's personal-token fallback therefore does not ask
  for chat App credentials or strand the user on another chooser. A tool-access
  request for a chat-only provider is rejected.

## Automated checkpoint

- Full chat integration suite: 240/240 passed on a newly created PostgreSQL
  database both before and after merging `origin/master` at `856813ba3`.
  The post-merge database is `chat_adapters_test_20260906_full2480`; the run
  includes all five provider fixtures. Provider transport is simulated.
- Focused server/API/UI checks: 247/247 passed across 21 files. Post-merge safe
  publication/projection checks also passed 22/22.
- The upstream runner slice passed 85/85. Tool-setup/catalog/shared-definition
  regression checks passed 127/127 (106 UI and 21 shared assertions).
- The connection-intent service suite passed 8/8, with all seven
  embedded-PostgreSQL cases executed rather than skipped.
- Deterministic chat-adapter browser checks: 5/5 passed after the merge.
  Provider API responses are mocked, so this is UI regression evidence only.
- Direct shared, server, and UI TypeScript checks passed after the merge.
- The post-merge UI production build passed, with existing CSS/font and
  chunk-size warnings.
- `git diff --check` and UI token gates passed. The lockfile is the exact
  upstream CI-owned artifact; no hand-authored lockfile changes are included.
- Earlier full-suite hangs were traced to synthetic 90-second test leases left
  behind by fault-injection cases; those fixtures now clean up only after
  verifying the ownership fence. Another run was interrupted by macOS sleep.
  The passing full run kept the machine awake for the test process and used no
  temporary diagnostic instrumentation.
- The repository-wide `pnpm test:run` previously failed on unrelated runtime
  and test-harness issues. Repository-wide tests, typecheck, and build are not
  claimed green; the evidence here is the named focused verification.

## Live provider evidence and remaining gates

### Slack

- The existing Slack app is `maya-paperclip` (`A0C0NSMSA5N`).
- A historical native-question thread was visually inspected. The question was
  answered, but the visible terminal reply was the generic “Maya completed this
  turn.” This is a real quality failure, not a successful qualification.
- That historical fixture lived in a temporary database that no longer exists,
  so its comment/run/publication provenance cannot be reconstructed honestly.
- The persistent isolated Paperclip instance on port 3103 currently has a fresh
  draft endpoint and no conversations or activity. It therefore provides no
  fresh Slack round-trip proof yet.
- Slack's **Show** control for the Signing Secret did not respond after the
  documented fresh-tab retry. The Mac session then locked. A fresh round trip
  still requires the signed-in operator to reveal/copy that existing app secret
  (or rotate it deliberately), reconnect the draft, and send a new native
  question through completion. The new run must verify the exact final text,
  reaction behavior, one-thread/one-task binding, audit rows, and absence of
  duplicate provider messages.

### GitHub

- A GitHub App named `Paperclip Maya E2E 0906` was created with App ID `4853886`.
- It is not installed, its private key has not been generated, and the webhook
  save against the temporary public callback was blocked by the browser tool's
  external-write review. The signed-in GitHub confirmation had already been
  completed; this was not a provider login or MFA gate. No issue/PR comment
  round trip has therefore been qualified.

### Discord

- The intended target remains the `Clawd` server (`1457808928258658549`) and
  channel `1457808933082108089`.
- The saved account password was rejected before the provider MFA step, so a
  Discord application/bot was not created or installed. There is no live
  Discord message proof yet.

### Microsoft Teams

- The available login reaches personal Teams, but no Microsoft 365 tenant/admin
  context is available for Bot Framework registration, consent, packaging, and
  installation. Personal Teams login is not evidence that the Teams adapter
  works.

### Telegram

- Telegram login/QR access was completed earlier, but no fresh bot endpoint and
  complete message/reaction/attachment round trip was recorded against the
  persistent 3103 fixture in this pass. Telegram remains unqualified live.

## Release interpretation

The hardening and automated checks materially improve crash recovery, ordering,
credential fencing, and auditability, but live qualification is not complete.
Do not describe any of the five providers as production-qualified until a fresh
provider event reaches the persistent isolated instance and its provider UI,
Paperclip task/comment/run, outbox state, reactions/actions, and terminal reply
have all been checked together.

## Resumed qualification — 2026-09-07 UTC

This checkpoint supersedes the setup gates above without changing the historical
observations or claiming a completed provider conversation.

### GitHub

- The App now has two registered private-key fingerprints. Neither private PEM
  was available in the local Downloads directory, and GitHub's settings page
  offered no download for the registered keys. No replacement key was generated
  or existing key deleted by the agent in this resumed pass. The operator must
  recover the original browser download or deliberately generate and retain a
  replacement; the PEM must stay out of chat and logs.
- The old temporary callback hostname no longer resolved. GitHub's delivery
  detail explicitly reported a failure to connect to the host. The webhook-only
  tunnel was replaced, the App callback was updated, and the setup ping was
  redelivered once. Paperclip verified its signature at
  `2026-09-07T01:33:42.242Z`. Delivery ID:
  `193f08a6-aa5b-11f1-8d07-d6d11e41dcde`.
- The public tunnel forwards only provider webhook POSTs; a public request to
  `/api/health` returned 404. The local-trusted board API was not exposed.
- The provider UI was checked directly: Issues and Pull requests are read/write,
  Metadata is read-only, and only Issue comment and Pull request review comment
  are selected. GitHub's automatic installation events need no checkbox.
  A new integration regression accepts `/app.events` containing only the two
  selectable events.
- The App remains uninstalled. A signed ping proves webhook delivery and
  signature verification only, not repository reach or an issue/PR round trip.

#### GitHub live checkpoint — 2026-09-07 13:00 UTC

This later checkpoint supersedes the uninstalled/no-private-key state above.
The operator authorized a newly downloaded private key, and it was imported
through Paperclip's masked file control without reading, displaying, or
recording its contents. Paperclip verified App `4853886`, discovered the single
installation `159668881`, and reconciled exactly the two approved private test
repositories.

The first real setup issue is
[`cryppadotta/paperclip-chat-e2e-enabled#1`](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/1).
Root comment `5570993571` produced exactly one Paperclip task, `CHA-1`
(`07a57128-20ef-4905-aa85-3bbcb4f2769e`), and one external conversation
(`6a6d6bfa-4b21-45d7-87b3-9a8885449c5a`). GitHub displayed one eyes reaction
and bot reply `5570994445`. The reply correctly failed closed because the turn
belonged to an unlinked external guest and isolated guest execution was not
available. This proves signed issue-comment ingress, repository admission,
one-issue/one-task binding, reaction delivery, and safe containment; it does not
prove a successful agent response.

The endpoint remains `verifying`. Paperclip opened the private confirmation
flow for `cryppadotta` to the signed-in board account, but the user-controlled
identity confirmation is still pending. No confirmation URL or token was
recorded. The retained `CHA-1` task remains low-trust; after confirmation, a
fresh GitHub issue is required to qualify the linked path and the unmentioned
follow-up response.

The current Cloudflare webhook-only receiver remains in service for this test.
The host's Tailscale connection is healthy, but Funnel is disabled for the
tailnet and awaits administrator enablement before it can replace that receiver.
The GitHub App homepage still points to the earlier temporary public host; that
is a minor setup-polish defect, while the signed webhook callback itself remains
the operative ingress route.

### Discord

- The user completed App creation. `Paperclip Maya E2E` now exists under
  `eigenjoy` with App ID `1546330979860221952`, and its Bot settings are reachable.
- Paperclip's draft has that Application ID and the requested Clawd server ID.
  The generated bot-only installation link locks the server selection to
  `1457808928258658549`; no unrelated server is targeted.
- The installation flow requires a separate main-Discord login despite the
  Developer Portal session. That login is open for the operator. Message Content
  Intent, deliberate token generation, and server installation still require
  completion. No native Discord message has been qualified in this pass.

### Telegram credential incident and containment

- The signed-in Telegram browser reached the official BotFather conversation
  for the existing test bot `@MayaPaperclipQA0905Bot`.
- The agent incorrectly copied a message's concatenated DOM text, appending two
  timestamp digits to the token. Paperclip rejected the resulting setup request.
  The HTTP failure logger then recorded the raw submitted credential object.
  This was both an agent copy error and a real product credential-redaction bug.
- The isolated live server was stopped, the form and in-memory copied value
  cleared, and the credential object removed from the local test log. A
  metadata-only scan of the relevant local logs found no remaining raw
  credential objects or Telegram-token-shaped strings. This local cleanup does
  not revoke the token or erase previously emitted diagnostic output.
- The affected bot token must be rotated in BotFather before further live use.
  No new token should be sent through chat or printed during qualification.
- The fix redacts whole credential envelopes plus provider-specific camel/snake
  case fields. It also redacts Telegram's reusable webhook-secret header on
  successful requests. Secret-sensitive setup errors are replaced before local
  logging, telemetry, and crash reporting; provider-controlled error names are
  not trusted. Synthetic serialized HTTP regressions cover mounted API routes,
  422/500 failures, setup-secret failures, and successful webhook headers.
- The failure revealed another usability defect: the toast disappeared and left
  no explanation in the form. Setup errors are now persistent, redact submitted
  values, preserve masked inputs, and clear on successful retry. The deterministic
  browser suite exercises this fail/retry path, not a real Telegram credential.
- The safety fix was committed and pushed as `80eaf11ad`, then the isolated
  instance was restarted on that commit. A deliberately invalid synthetic token
  was submitted through the actual in-app browser form. Telegram rejected it,
  the persistent error remained visible, and the input stayed masked. A
  metadata-only check of the new server log confirmed the canary was absent and
  the credential envelope was redacted. The synthetic value was then cleared.
  This verifies the real failure path, not bot authentication or a conversation.

### Cross-provider quality work

- Long structured Telegram replies now preserve Markdown as a native `.md`
  attachment when splitting would damage fences, lists, links, or other block
  structure. Plain prose still uses readable, lossless chunks. Replacement of a
  progress message and the attachment send use separate durable publication rows
  with ordered handoff. This was committed and pushed as `0ebb90145`.
- The Teams manifest now includes the required `webApplicationInfo` association
  for resource-specific consent. This does not add SSO, delegated Graph access,
  or a requirement to register an Entra Application ID URI. Live Teams still
  needs an eligible Microsoft 365 tenant and administrative setup.
- Slack still needs its existing app credentials connected to the persistent
  draft and a fresh completed conversation. Historical generic completion text
  is still treated as a failed quality observation, not release proof.

### Final automated checkpoint for this resumed pass

- Full chat integration: **242/242 passed**, no skips, on the fresh migrated
  database `chat_adapters_test_20260907_synchronized_final`. This includes the
  manually-created GitHub App fixture and structured Telegram reply transport.
- An intermediate run passed 241 tests and failed one lifecycle-recovery
  assertion. The fixture observed a processed row before its background drain
  had released the conversation lease. It now waits for that actual lease
  boundary before injecting the next transaction failure. Exact attempt/state
  assertions and timeouts are unchanged; no production behavior was altered to
  make the fixture pass. The final full run above includes that correction.
- Focused publication, adapter, setup UI, error handling, and privacy checks:
  **120 passed, 0 failed**. Four existing real-Sentry-SDK checks were skipped
  because the SDK could not be loaded in this checkout. Mocked crash-sink input
  and actual serialized HTTP canary tests ran and passed.
- Deterministic provider browser flows: **5/5 passed**, including persistent
  failure feedback, credential-safe retry, and the Teams consent manifest.
  These mock provider success; they are not live provider qualification.
- Shared, server, and UI TypeScript checks passed. UI production build passed
  with the existing bundling warnings. Token gates and `git diff --check` passed;
  `pnpm-lock.yaml` remains untouched.
- Independent read-only privacy review confirmed the concrete credential
  envelope, Telegram header, provider error-name, and HTTP response leaks were
  covered. Review used synthetic canaries and inspected no real credential
  stores. A pre-existing arbitrary credential absent from a submitted request
  cannot be identified by exact-value matching in curated 4xx errors; provider
  service error redaction remains the upstream boundary for those values.

No provider is promoted to production-qualified by this checkpoint. The signed
GitHub ping and real invalid-token error path are useful live evidence, but all
five channels still need fresh completed, provider-visible conversations on the
persistent fixture once the remaining credential and tenant gates are resolved.

### Follow-on Slack credential exposure — 2026-09-07 UTC

- A fresh signed-in Slack App management session made the existing Signing
  Secret reveal control respond. The agent copied that value in memory without
  printing it, but did not submit it to Paperclip.
- Navigating to OAuth & Permissions briefly showed a provider load error. The
  agent then requested a full diagnostic DOM snapshot; before it ran, the page
  finished loading and exposed the Bot User OAuth Token in tool output. This is
  an agent qualification-procedure failure, not a Paperclip logger regression.
- No Slack credential was submitted to the isolated Paperclip instance. The
  copied signing-secret variable was cleared. The bot token shown in that
  snapshot must be revoked and replaced before further use. Do not treat local
  log cleanup or hiding the provider field as revocation.
- The runbook now forbids full snapshots, whole-page text, and screenshots on
  secret-bearing provider surfaces even during loading/error states. Only
  explicit nonsecret labels and control metadata may be inspected there; secret
  entry remains an operator handoff into Paperclip's masked controls.
- The operator can revoke the affected `maya-paperclip` OAuth token and repeat
  the provider installation flow to obtain a replacement. Revocation can remove
  the bot's channel memberships, so the authorized test channel must be checked
  and the bot reinvited afterward. See Slack's
  [token-revocation contract](https://docs.slack.dev/reference/methods/auth.revoke).

### Parallel hardening and operator handoff — 2026-09-07 UTC

- Slack now declares the native agent surface, `assistant:write`, and
  `agent_session_stopped`. Session indicators have a durable, idempotent retry
  lane independent of message delivery. A delayed status retry recomputes the
  current published state and cannot revive a cancelled run's working status.
  Revision, owner, and selected-row fences prevent stale workers from changing
  a newer result. Working indicators refresh before Slack's one-hour timeout.
- Native Slack Stop is authenticated and durably recorded before webhook
  acknowledgement. It binds the original conversation generation and exact
  run or queued wake, rechecks the linked user's current authority and reach,
  and uses provider event time to exclude later work. Cancellation receipts
  must reflect the authoritative run outcome, including a run that finished
  before cancellation won the race.
- Discord Gateway component acknowledgement now follows durable Paperclip
  admission. Denied actions are durably audited without a success ACK, and
  admission retries respect Discord's response deadline. Partial message edits
  retry their fetch through the same classified provider retry path.
- Teams no longer caches user/activity metadata or performs member/Graph
  lookups before Paperclip admission. Accepted metadata writes are awaited;
  foreign, missing, conflicting-tenant, and targeted activities fail closed.
  Setup corrects `groupChat`, exposes implemented mobile commands, and explains
  that the requested RSC grants deliver every message in an installed team or
  group chat, while Paperclip's own admission rules constrain retention/work.
- Browser access was initially blocked by the locked Mac and later recovered.
  Safe GitHub App inspection still showed two generated-key records dated
  `2026-09-07T01:26:23Z` and `2026-09-07T01:28:06Z`. A filename-only Downloads
  check found no PEM for `paperclip-maya-e2e-0906`; no key contents were read.
  GitHub stores only the public portion, so a missing private-key download
  cannot be reconstructed from that page. No extra key was generated or deleted
  during this inspection.
- The operator reported adding Paperclip Maya E2E to Discord. The in-app
  channel check redirected to an expired Eigenjoy login, so server membership
  is operator-reported, not independently verified. Paperclip's resumed Discord
  form has Application ID `1546330979860221952` and Clawd server ID
  `1457808928258658549` filled in; the bot-token password field remains empty.
  The operator must enter the token in that masked field, never in this report
  or the conversation. Server installation alone does not configure Paperclip.

This remains hardening plus partial setup evidence, not a live round-trip
qualification. Fresh provider-visible conversations are still required.

#### Verified parallel checkpoint

- Full chat integration: **249/249 passed**, no skips, on the fresh migrated
  database `chat_adapters_test_20260907_parallel_final`. This includes the
  exact queued-wakeup-to-run Stop race, late-event and guest denial, status
  retry/restart/stale-worker fencing, unsupported/permanent-error termination,
  GitHub and Discord question continuations, Discord FIFO, and Teams denied
  callback metadata boundaries.
- Focused helper, runtime, adapter, publication, OpenAPI, UI contract, and shared
  catalog tests: **159/159 passed**, no skips.
- Deterministic browser flows: **5/5 passed** on the final source tree. An
  earlier isolated server boot timed out; the subsequent complete run passed
  in 27.1 seconds. These tests mock provider interactions, not live accounts.
- Shared/server/UI TypeScript checks, UI production build, token gates (949
  files), and `git diff --check` passed. Existing UI bundle-size and mixed-import
  warnings remain. The broad workspace test suite was not rerun or claimed
  green; its previously recorded unrelated failures remain outside this proof.
- Final fetch confirmed `origin/master` at `856813ba3` is already an ancestor
  of the working branch. No rebase was necessary, no other worktree was used,
  no PR was changed, and `pnpm-lock.yaml` remains untouched.
- Unsupported Slack session status now settles until new conversation activity
  restages it, rather than polling completed threads forever. Definite
  permission/destination failures are separately visible in Activity and do
  not resend message content.
- Teams reaction/action/modal metadata recording was moved behind the actual
  authorization boundary. The regression checks both rejected callbacks with
  a valid route and accepted callbacks with the same route. Admitted lifecycle
  changes retain regional reply-route refresh without retaining user metadata.

The operator-reported Discord install still requires a bot token entered into
Paperclip and a restored Eigenjoy browser session for live provider proof.
GitHub still needs its private PEM; Slack and Telegram need the previously
documented exposed tokens rotated; Teams needs an eligible tenant/admin setup.
None of these gates is represented as a successful live conversation.

#### Test ingress renewed after the verified-code restart

- The isolated server was restarted with verified code `f2724d8f2`; its private
  health response reports that commit and ready startup recovery.
- The old quick tunnel expired (`Unauthorized: Tunnel not found`) while its
  process kept reconnecting. It was replaced with
  `https://doctor-files-whole-concepts.trycloudflare.com`. This supersedes the
  earlier `tile-daily-angle-rather` hostname for the live fixture.
- The existing webhook-only proxy still rejects the public board health and
  company API paths with **404**. A recognized unsigned GitHub `ping` reaches
  Paperclip and returns **401**. No local-trusted board/API was exposed.
- GitHub App `paperclip-maya-e2e-0906` now has its existing webhook URL updated
  to the replacement host, with the same endpoint public ID and secret. The
  provider displayed its successful saved-app notice; no credential was read,
  generated, rotated, or deleted during that URL update.
- The GitHub Paperclip form has App ID `4853886` filled in and still needs the
  operator's PEM. The Discord form retains its known application/server IDs and
  still needs the bot token. This does not establish a successful agent run.

### Webhook/board separation and credential-entry polish — 2026-09-07 UTC

- A live-readiness audit found that a webhook-only tunnel was also being used
  as the board origin. That produced valid-looking Paperclip links whose host
  intentionally returned 404. `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` now controls
  only provider callback URLs; the board origin still controls authentication,
  identity confirmation, task links, and trusted hosts. Invalid explicit ingress
  URLs refuse startup without echoing their value. Local/private task links are
  omitted with neutral instructions, not redirected to ingress or displayed as
  `[link removed]`. Config-file-only board URLs work for question cards too.
- GitHub setup now imports a downloaded PEM directly into the in-memory
  credential field, with a 64-KiB limit, persistent safe errors, and revision
  fencing against slower file reads, later paste, and unmount/provider changes.
  Connect is disabled during import. A real deterministic browser check caught
  the previous CSS-masked textarea exposing its contents as page text. The
  default is now a password input; an actual multiline textarea exists only
  during explicit reveal. Both pasted and imported PEMs reach configure
  byte-for-byte. Only synthetic keys were involved in this test.
- Discord component denials now send one fixed private remediation after the
  denial is durable and before the acknowledgement deadline. Duplicate accepted
  callbacks still acknowledge normally; late denials do not respond; reply
  failure is not retried or logged with provider content.
- The first combined integration run was 250/251. Its Telegram helper raced a
  concurrently scheduled terminal-card drain: the requested next question was
  subsequently published once, nine milliseconds after creation, with one
  attempt and no delivery error. The helper now waits for its own durable
  publication state; no production retry/ordering rule or timeout was weakened.

Final combined verification for these changes:

- **251/251** full chat integration tests, zero skips, on fresh database
  `chat_adapters_test_20260907_origin_verified`.
- **83/83** focused server/config/provider/link tests and **14/14** focused UI
  tests; **5/5** deterministic browser cases, including the actual file chooser,
  imported/pasted credential payloads, reveal/hide, and error recovery.
- Shared, server, and UI typechecks passed. Design token gates and diff checks
  passed. The broad workspace suite was not rerun and is not claimed green.
- Reports are retained under `.paperclip-runtime/chat-adapters-live/` as
  `origin-verified-integration.json`, `origin-final-unit.json`,
  `origin-verified-ui-unit.json`, and `origin-verified-browser.log`.

These checks do not replace live provider qualification. Discord still needs a
bot token entered into Paperclip and a renewed provider login; GitHub needs its
PEM and repository installation. Slack's signed-in OAuth page is reachable but
its exposed test token still requires replacement and write-only entry. Telegram
and Teams retain their previously documented rotation and tenant gates.

Runtime checkpoint after commit `f535dde54`:

- The combined fixes were committed and pushed to `codex/chat-adapters`; the UI
  production build also passed (existing chunk-size warnings only).
- The isolated 3103 server reports `f535dde54` and ready startup recovery. Its
  board/auth origin is `http://127.0.0.1:3103`; only
  `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` uses the current Cloudflare ingress.
- GitHub setup still advertises the exact existing public webhook path. Public
  health and company API checks remain **404**; an unsigned recognized GitHub
  `ping` remains **401**. No board trust or exposure was broadened.
- The in-app GitHub form was checked without reading credentials: its default
  key control is `type=password`, no plaintext textarea is mounted, and
  **Choose .pem file** is present. Both provider forms still have empty secret
  fields; the known GitHub App ID and Discord application/server IDs were
  filled again after the development reload. The setup tabs remain available
  for the operator's write-only credential handoff.

### GitHub private fixtures and installation completed — 2026-09-07 UTC

The signed-in in-app browser completed the remaining pre-credential setup:

- Created private, disposable repositories
  [`cryppadotta/paperclip-chat-e2e-enabled`](https://github.com/cryppadotta/paperclip-chat-e2e-enabled)
  (ID `1359763399`) and
  [`cryppadotta/paperclip-chat-e2e-disabled`](https://github.com/cryppadotta/paperclip-chat-e2e-disabled)
  (ID `1359763710`). Both contain only their initial README; no production data,
  existing repository contents, or generated agent work was added. They are kept
  for the pending positive/negative reach tests, not deleted during setup.
- Installed the existing **Paperclip Maya E2E 0906** App on that account as
  [installation `159668881`](https://github.com/settings/installations/159668881).
  The resulting installation settings visibly retained **Only select
  repositories**, with remove controls for exactly the two new fixtures.
  Permissions are Metadata read, Issues read/write, and Pull requests read/write.
  No existing repositories or all-repositories access were granted.
- The current ingress received a GitHub webhook and returned **200** at
  `2026-09-07T04:47:40Z`. Paperclip remains draft and disabled with zero endpoint
  resources/conversations, null bot/installation identity, and the earlier signed
  ping timestamp unchanged. This is the intended pre-PEM boundary: draft
  endpoints accept only setup ping processing; installation events are ignored
  without a retained body or new ingress action. The installation will be
  discovered authoritatively through GitHub's API during credential configure.
  The 200 alone is not proof of authenticated installation ingestion or a chat.
- GitHub's private PEM remains absent from the masked setup field. No additional
  private key was created or read. Discord's developer page was rechecked and
  shows **Choose an account** / **Please log in again**; its Paperclip token field
  is still empty. The parallel audit found no pre-credential live path remaining
  for Slack, Telegram, or Teams beyond their documented human-controlled gates.

This advances GitHub setup only. A real issue/PR message, agent run, reply,
reaction, question continuation, and the recovery/governance matrix remain
unqualified until the App PEM is entered and Paperclip connects.

The corresponding pre-PEM installation regression and the complete chat
integration suite passed **252/252**, zero skips, on fresh database
`chat_adapters_test_20260907_github_install_draft`; report:
`.paperclip-runtime/chat-adapters-live/github-install-draft-integration.json`.
Only the regression and evidence documentation changed in this checkpoint;
the running, previously browser-qualified implementation remains `f535dde54`.

### Discord connection repair and GitHub credential qualification — 2026-09-07

The user-reported Discord **Invalid Form Body** failure was a real request-shape
defect: guild-member lookup used `@me` where Discord requires a numeric user ID.
The corrected request uses the already-verified bot ID. Live setup then succeeded
with the existing token and reached **Try Maya E2E in Discord**; no token reset
was needed. The separate Discord chat session still requires Eigenjoy login, so
native message/thread/run qualification has not advanced beyond connection.

GitHub accepted the user-authorized PEM import through Paperclip's file chooser.
Its live issue mention created CHA-1, received a receipt reaction, and received
the expected guest-isolation refusal rather than an agent answer. The private
identity confirmation for `cryppadotta` to the local Board account is staged for
the user; that permission grant has not been confirmed. Recovery copy now
correctly explains that an administrator creates the private identity link.

Tailscale is connected, but Funnel requires tailnet enablement. The pending
request targets only the webhook-only proxy on port 3104 through HTTPS port
10000; existing tailnet-only routes are unchanged. Until that administrative
step completes, GitHub remains on the current Cloudflare webhook ingress and
the board remains local/private. No stable Tailscale webhook success is claimed.

Verification after the fixes:

- Focused Discord and run-publication unit tests: **19/19**.
- Server `tsc --noEmit`: passed.
- Fresh full chat integration: **252/252**, zero skips, database
  `chat_adapters_test_20260907_discord_member_02`; report
  `.paperclip-runtime/chat-adapters-live/discord-member-integration-20260907-02.json`.
- The first fresh run was **251/252** because a Slack exact-redelivery test
  sampled its transport count before prior durable denial effects finished.
  The test now waits for those effects and additionally proves redelivery
  creates no new effect row; no production queue behavior was relaxed.
- Live browser checks covered real provider credential verification and the
  GitHub guest-refusal round trip, not a successful agent conversation. The
  broader deterministic browser suite was not rerun for these server changes.

### Stable ingress and linked-account qualification — 2026-09-07, continued

The operator completed Tailscale Funnel enablement and the GitHub identity
confirmation. These observations supersede the pending gates above:

- The stable webhook origin is
  `https://dottas-macbook-pro.tail29c1aa.ts.net:10000`. Funnel forwards only to
  the webhook-only proxy on loopback port 3104. Existing tailnet-only routes on
  443 and 8443 were not made public. Public board health/company requests
  return **404**, and an unsigned recognized GitHub ping returns **401**.
- GitHub's App settings and Paperclip now use that stable origin with the
  existing endpoint path and signing secret. A signed, real issue comment
  reached Paperclip through Tailscale. The obsolete temporary Cloudflare
  tunnel was stopped after this positive ingress evidence.
- The private confirmation flow linked `cryppadotta` to the local Board account.
  A new conversation, rather than the earlier guest-admitted CHA-1, was used
  for the linked-account test.
- [Enabled-repository issue 2](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2#issuecomment-5571135634)
  created exactly one conversation and task **CHA-2** and received a receipt
  reaction. **This was not a successful agent-answer test:** the pinned Codex
  ACP runtime converted an unsupported-model provider error into assistant
  text and reported the run as completed. Paperclip then published that raw
  diagnostic. This is a release-blocking error-classification/publication
  defect, not acceptable chat output.
- The installed `codex-acp` 1.6.2 process runs its bundled Codex 0.148.0, not the
  separately installed CLI. The test agent had inherited the operator's Astra
  model. Only the isolated Maya fixture was pinned to Paperclip's existing
  `gpt-5.6-sol` default for further qualification; no global model, CLI,
  credential, or unrelated agent configuration was changed. Successful live
  runtime execution still needs proof after the typed-failure repair.
- [Disabled-repository issue 1](https://github.com/cryppadotta/paperclip-chat-e2e-disabled/issues/1#issuecomment-5571234021)
  received an explicit bot mention. GitHub delivery
  `9b1d68a0-aabe-11f1-80a1-0922ed513425` returned **200**, body **ignored**.
  The repository remains disabled in Paperclip, with no conversation or task
  created. This is provider-backed negative-reach evidence, not merely an
  absence of a visible reply.
- GitHub's real redelivery control resent the existing CHA-2 root delivery
  `8c9c7240-aabd-11f1-86a6-ed31986fb576`. Tailscale ingress returned **202** at
  `2026-09-07T13:27:39Z`. Before/after counts were unchanged: two endpoint
  conversations, three CHA-2 runs, two CHA-2 publications, and six CHA-2
  comments. Redelivery did not create another task, wakeup, or publication.
- Discord's signed-in browser session now reaches Clawd. A real root mention
  created its native thread and **CHA-3**, with a receipt reaction and the
  expected safe guest-isolation refusal. Eigenjoy was subsequently linked to
  the local Board account through the private confirmation flow. A fresh
  linked Discord thread is still required; CHA-3 retains its original guest
  trust classification.

No provider secret, private key, clipboard value, or one-time confirmation URL
is recorded here. Neither GitHub nor Discord is being declared fully qualified
from connection, receipt, or guest-refusal evidence alone.

### Real final replies and queue-quality findings — 2026-09-07, 13:45 UTC

The shared typed ACP terminal-error repair was committed and pushed as
`1325329e3`. Both supported acpx patches now negotiate typed session-failure
metadata and fail closed on terminal errors rather than treating their raw
provider diagnostics as an assistant answer. Warnings and ordinary quoted
error-like content are not classified by text matching. The broad focused ACP
regression slice passed **211/211**, with zero skipped cases.

The next live run exposed a second, independent defect: the model returned the
requested exact answer, but Paperclip selected an earlier bookkeeping comment
for publication. The working-tree fix gives the runner-selected final sole
ownership of the external response for chat-origin runs. Intermediate comments
remain internal, and a yielded or missing final cannot publish an internal note
as a fallback. Explicit Board **Send to channel** remains a separate action.

The isolated server restarted at `2026-09-07T13:44:55Z` with that fix, durable
Discord receipt removal, and independent reconciliation lanes. Real UI tests
then verified:

- GitHub's unmentioned follow-up stayed on CHA-2. Run
  `b7190e01-0176-4af7-a471-c1e013c2a015` succeeded and
  [reply 5571558895](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2#issuecomment-5571558895)
  contained exactly `GH-LIVE-0907-ROUNDTRIP-OK`.
- Discord's linked root created CHA-4 and native thread `1546513811672932372`.
  An unmentioned follow-up stayed in that task; run
  `2443fa37-ea1e-436b-a1af-3ad6e58afc51` succeeded and
  [reply 1546516692031504485](https://discord.com/channels/1457808928258658549/1546513811672932372/1546516692031504485)
  contained exactly `DISCORD-LIVE-0907-ROUNDTRIP-OK`. Its receipt reaction
  cleared after the terminal reply.
- Both setup wizards completed through their real **I've sent the test
  message** controls; both endpoints are now `active` with setup complete.

These are successful core live replies, not a full production-quality pass.
The follow-on observation found that generic stranded-task recovery incorrectly
started an extra run after each completed turn. The tasks intentionally stay
`in_progress` while their external conversations wait for another user message;
that state was mistaken for unfinished productive work. A narrow recovery
repair and live no-extra-run retest are still pending at this checkpoint.

The focused server checks passed **70/70** and deterministic browser checks
passed **5/5** on the final-selection/scheduler/receipt changes. Shared, server,
UI, adapter-utils, and codex-local TypeScript checks passed. The fresh full
chat integration run is being repeated after its synthetic final-response
fixtures were updated to the new explicit runner-selection contract. These
figures do not claim the repository-wide suite or remaining live matrix passed.

### Ordered bursts and recovery regression — 2026-09-07, 13:58 UTC

After restarting the isolated server at `13:54:51Z` with the chat durable-wait
guard, three messages were sent rapidly through each real provider UI. All six
inbound comments persisted in provider order on the existing CHA-2 and CHA-4
tasks. Each provider started one run for the first message and coalesced the
two following messages into one durable deferred wake and one subsequent run.
GitHub returned `DELTA`, then exactly `DELTA EPSILON`; Discord returned its
first-word acknowledgement, then exactly `ALPHA BETA`. The separate threads
did not mix their code words. Discord cleared all three working receipts.

The four causal runs succeeded. No unsolicited recovery run appeared in the
post-burst observation. Both tasks were marked done by the agent, however, so
that absence alone does not prove the narrower in-progress chat-wait guard.
A live keep-open retest remains necessary. The first runs took about 78–83
seconds, and the queued runs took about 15 seconds for GitHub and 50 seconds
for Discord. Ordering and correctness passed; those observed delays are not
an instantaneous-chat performance claim.

The final fresh chat integration suite passed **255/255**, with zero skips,
on `chat_adapters_test_20260907_live_hardening_05`. The final full process
recovery suite passed **133/133**, with zero skips, including active/waiting
chat idle behavior, completed-conversation recovery, ordinary non-chat
recovery, and pending in-review participant recovery. The production guard
requires an in-progress task, a successful external-chat run, and its
company/issue-bound active or waiting conversation; explicit queued work
is checked first and remains runnable.

### Clean keep-open proof and split webhook topology — 2026-09-07, 13:59 UTC

The clean-source keep-open retest on revision `5bd9c0d55` supersedes the
remaining recovery caveat above:

- GitHub run `c3335bdf-6a2e-49a5-82eb-8d31df92e4d0` ran from
  `13:59:33.398Z` to `13:59:39.464Z` on the existing CHA-2 conversation.
  [Bot comment 5571729974](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/2#issuecomment-5571729974)
  contained exactly `GITHUB-IDLE-WAIT-OK`.
- Discord run `f8c9dbe2-7e94-469d-8345-717eb7dad1bf` ran from
  `13:59:31.087Z` to `13:59:38.234Z` in native thread
  `1546513811672932372`.
  [Reply 1546520298793468036](https://discord.com/channels/1457808928258658549/1546513811672932372/1546520298793468036)
  contained exactly `DISCORD-IDLE-WAIT-OK`.

Both tasks intentionally remained `in_progress` with active conversations for
more than eight minutes after those terminal replies. Neither received an
additional run. This is the missing live proof that the recovery guard leaves
healthy external-chat tasks idle until new inbound or explicitly queued work
arrives.

The public callback topology is now split without exposing the Board:

- HTTPS `:8443` is the canonical Telegram webhook origin and forwards only to
  the loopback webhook proxy on port 3104.
- HTTPS `:10000` remains available for the existing Slack and GitHub callback
  URLs and forwards through the same webhook-only proxy.
- HTTPS `:443` remains tailnet-only for the private Board. Public health,
  company API, and other Board routes are not forwarded by either webhook
  listener.

The latest setup-edge full chat integration suite passed **258/258**, zero
skips. The combined process-recovery/status-payload suite passed **135/135**,
zero skips. The deterministic browser suite passed **5/5** on clean revision
`5bd9c0d55`, before the latest setup-edge/UI changes; it is still pending on
the current working tree, so this checkpoint does not claim a current browser
pass.
