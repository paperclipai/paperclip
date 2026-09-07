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
