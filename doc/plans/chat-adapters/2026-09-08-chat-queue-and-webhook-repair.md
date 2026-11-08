# Chat queue, Gateway admission, and GitHub reconnect checkpoint

## Execution target

The isolated live agent remains Maya E2E, `31f56712-3944-423e-b7c7-404bb8fbb993`,
using `paperclip_runner` and `gpt-5.6-luna`. The initial live runner binary was
`af19f64dfdf7e2e4efb5b41275e26cd873338315207c36fd4d108bdb69bae3c1`.
Actual Codex app-server source/continuation evidence and measured Slack,
Discord, and Telegram timings are recorded in the
[runner integration checkpoint](2026-09-07-upstream-runner-integration.md).
Terra was not substituted. Raw reasoning, tool arguments, and private logs
remain on the private control plane, not in external chat.

## Changes

- Pre-run FIFO admissions now have one durable, closed-text queue notice per
  canonical wake and destination. Current actor, reach, generation, admission,
  and exact source-comment checks run again at transport claim. Promotion before
  send suppresses the notice; the exact eventual run may reuse its message for
  working, question, or final output. A predecessor or second final cannot
  overwrite it. These notices do not become Slack session/Stop state or attach
  outbound activity to the user's inbound comment.
- Review caught and fixed two stale-notice cases: an admitted run failing before
  its first working update, and deletion of the original coalesced input. The
  latter uses only “This queued message was removed.” against the original
  still-visible notice; it never says the surviving batch failed to run and
  cannot overwrite an answer that won the race.
- Discord fresh message admission renews only the exact Gateway owner token
  inside its database transaction. Local expiry updates happen after commit.
  A paused obsolete callback cannot write after a standby has taken ownership.
- GitHub reconnect reconciles only the verified App's callback URL, stored
  secret, JSON encoding, and TLS verification through its normal App JWT path.
  The fixed provider host, redirect rejection, bounded response, closed errors,
  lease checks, and intent/completion audits prevent credential exposure and
  false success after ownership loss. No repository permission, subscription,
  installation, or provider Active toggle changes. Historical signed-ping
  evidence is not fabricated; a fresh chat round trip is still required.
- The actual GitHub reconnect screen incorrectly repeated App-creation and
  installation instructions. Reconnect now hides those steps, names the repair
  correctly, and explains saved-credential reuse. First-time setup is unchanged.
- Teams personal/channel tests now cover closed progress, same-message edits,
  question/final precedence, replay suppression, and reach revocation. These are
  deterministic tests, not live tenant qualification.

## Verification

- Fresh PostgreSQL full chat integration: **364/364**, final frozen backend,
  75.62 seconds. The preceding full run had 359/360 with a socket hang-up in the
  existing publication-batch read test; that case passed independently and the
  final complete rerun passed. The earlier run is not counted as a pass.
- Focused queue/publication/GitHub webhook helpers: **72/72**.
- Server and UI source typechecks passed; token gates and diff checks clean.
- Deterministic browser suite: **9/9** before the final reconnect heading and
  no-create-instructions assertions. The final focused GitHub rerun passed
  **1/1** (29.2 seconds), including those assertions and reconnect after secret
  rotation. Mocked browser tests are not live webhook evidence.
- Independent review found the two queue defects above and confirmed the final
  corrections without an authorization/privacy bypass.

Logs are retained under `.paperclip-runtime/chat-adapters-live/` with the
`chat-queue-gateway-webhook-full-final-0908`, `chat-queue-webhook-unit-final-0908`,
and `github-reconnect-copy-browser-final-0908` prefixes.

`origin/master` still resolves to `297d8741f5f192c66abbec325b1e956cf0e5e667`.
The lockfile SHA256 remains
`313c6a80f077364abe06d237d518ba555ccaf03745f3504a1f7df36e7baf8040`.
Master ancestry/frozen-install reconciliation and the previously documented
whole-workspace build/test gate remain open. This checkpoint does not declare
all providers production-qualified.

## Live qualification on `1f28e0da9`

The clean committed server started at 11:51:10 UTC on September 8, with the
same staged runner and Luna configuration. No server pause or restart occurred
during these probes.

### GitHub callback repaired; answer withheld (failed chat test)

The normal reconnect UI reused saved credentials. The App webhook sync was
audited at 11:51:29.306 (started) and 11:51:29.453 (completed); reconnect finished
at 11:51:29.961. Historical signed-ping evidence remained unchanged. No new
login, private key, repository permission, or installation was required.

The browser-created PR comment `5584695046` arrived at 11:51:59.660. Run
`f5260e73-6b0b-4a31-9098-192db2d455be` used `codex_app_server`, ran from
11:52:00.458 to 11:52:16.909, and produced the exact final summary
`GH-RECONNECTED-LUNA`. However, finalization recorded
`external_chat_response_wait_authorization_lost`, created no answer comment,
and GitHub showed only “Maya E2E completed this turn.” Both transport
publications succeeded on their first attempt against comment `5584695856`.
This proves restored ingress, not a successful setup round trip. The endpoint
remains in its legitimate reconnect test state; it was not manually activated.
The bound-conversation authorization helper required endpoint status `active`,
although normal setup admits test traffic while `verifying`. This creates a
setup/finalization cycle. A narrowly scoped current-generation test-window
exception now retains the existing actor/reach/ownership checks. Every exact
bound delivery must have been received and processed within the current test
window, carry the current runtime generation and canonical credential-fence
shape, and pass current policy again at commit. Arbitrary verifying states and
old-generation events remain denied. Positive tests for all five providers
reach an actual pending answer publication; reconnect and activation overlap
tests prove the final authorization recheck. The full external-chat wait suite
passed 106/106 and server typechecking passed. This fix is included in the
deployment candidate but has not yet passed its fresh live qualification.

### Slack upstream retry and queue failure are separate findings

The first source message `1788868365.043179` was sent at 11:52:45.043, but the
first matching local HTTP request arrived at 11:53:45.946: **60.903 seconds
before Paperclip received it**. The request carried retry 2 / `http_error`
hints; those hints are diagnostic, not authenticated authority. No earlier
matching request appears in this server log. Paperclip acknowledged the
received request in 22.738 ms. Run `e007b44a-a6d9-4f17-92ba-19ee10c44552`
took 22.542 seconds and its actual answer was published at 11:54:09.815:
84.772 seconds from source to answer. All publications used one attempt and
reused message `1788868427.157569`. Its displayed Slack timestamp is the
original placeholder time, not when the final edit appeared. The source of
the upstream transient has not been established.

The next source `1788868603.774119` received working feedback on
`1788868606.501909` within about three seconds. Follow-ups
`1788868619.821029` and `1788868619.986369`, sent during that run, coalesced
into wake `2982635e-5de7-4305-81a5-83854593cb5e`. One “Your follow-up is
queued.” notice appeared at 11:57:01.497 on `1788868621.466899`; both source
messages received acknowledgement reactions. Safe progress updated only the
predecessor's working message.

This is **not a passing FIFO round trip**. Predecessor
`61b59b46-d382-4701-910c-ece9e4323dc1` failed at 11:57:30.118, and promoted
successor `94bebeda-5c90-4810-8567-4ccc365df826` failed at 11:57:30.293.
Their closed failure messages edited the correct separate provider messages,
leaving no stale queue notice. The local diagnostics report a missing durable
suspend proof followed by a runner-state identity mismatch; investigation is
ongoing. These are not evidence that Luna itself is unsuitable, nor evidence
that recovery or final-answer delivery succeeded.

The predecessor had already emitted an accepted result and terminal event at
11:57:14.660 and 11:57:14.669. The later failure happened while establishing
durable suspension. Its retained runner had acknowledged only sequence 51,
while the controller had committed sequence 625; 609 `item.delta` events
remained in the durable outbox. Stop/suspend commands remained pending. The
automatic recovery `b217e9ac-c82e-4468-8e9d-bdf85909eb38` exhausted its retry
budget at 11:58:36.424. No state was deleted, forged, or manually marked
successful. A control-loop backpressure regression and fix are in progress.

## Runner corrections and pre-deployment verification

The new 1024-delta, post-semantic-result stress case reproduced the exact
missing-suspension failure against the prior staged `af19f64d…` binary. The
correction gates new provider ingestion while a sent durable prefix is still
awaiting controller acknowledgements. Authenticated control frames continue
in order; every individual event save and cumulative ACK save remains intact.
There is no timeout increase or discarded durable output.

Independent review required two additional safeguards. Backpressure still
advances bounded, already-pending receipt-limit cleanup without starting a
provider, and observes terminal events before deadline fallback. A safely
stopped `prepared` checkpoint can rebind the next run without requiring its
old process to exist, but a resumed provider reporting unexpected active work
is stopped and rejected before any buffered tool is exposed.

Candidate debug verification passed:

- Rust library: **223/223** on the final rerun. The first run had one unchanged
  ACPX process-liveness fixture failure; its isolated rerun and the full rerun
  passed. The initial run is not counted as a pass.
- Targeted real transport: **3/3**, including the original 48-delta case,
  1024-delta saturation with **two actual turns**, and rejection of an unexpected
  active resumed checkpoint. The successor retains the exact provider thread,
  has a distinct turn identity, invokes the semantic handler once, and proves
  exact durable suspension. This is not merely a session-read test.
- Real Codex unacknowledged-terminal maintenance: **1/1**.
- Runner and server TypeScript checks passed; independent review found no
  remaining production blocker in these changes.

The release build completed successfully. Its staged, ad-hoc-signed SHA256 is
`a0fd27895142f333696df720d66c426793c9051f7361288e54f6c2c16cf7ccd8`.
The full staged transport suite passed **87/87** in 56.31 seconds; its digest
was unchanged afterward. Actual Codex integration passed **66/66**, plus its
intentionally ignored subprocess helper invoked by the parent test. Logs use
the `runner-ack-fairness-` prefix under the ignored live runtime directory.

Fresh live round trips remain pending. Restart of the clean `857bd57c2` server
failed closed during native finalization recovery: an assessment belonging to
the failed Slack run already had a valid same-run supersession link, but
effect materialization tried to replace it with the current issue decision's
assessment from another run. PostgreSQL correctly rejected that cross-run
reference. No constraint or data was changed to bypass it; the failed-start
process was stopped. The scoped fix preserves the already-recorded run-local
assessment parent and separately links the issue-wide status decision.
Cross-run, intermediate same-run ancestry, and replay regressions passed;
independent focused PostgreSQL verification passed **4/4**. Root's full status
corpus plus finalization recovery passed **12/12** in 9.15 seconds, and the
server package typecheck (including its runner contract/build prerequisites)
passed. The staged runner digest remains unchanged. Live restart and fresh
round trips remain to be verified after this correction.

The failed Slack session is retained in quarantine; an audited task-scoped
session reset after deployment will create a new provider session, not recover
or replay the failed accepted answer. Paperclip issue, message, file, and run
history will remain. No reset has been performed yet.

The ignored, local webhook-only qualification proxy now has closed timing
diagnostics, tested **6/6** without a real listener. They record only provider,
timestamp, duration, status, outcome, and byte count; no bodies, headers,
credentials, callback IDs, or URLs. The proxy was restarted with this diagnostic
code, retaining the same webhook-only routing and public/private exposure.

## Live restart and GitHub answer on `545c87c67`

The clean committed server reached startup `ready` at 12:27:46.904 UTC. The
assessment-lineage failure no longer prevents startup. A separate, nonfatal
workspace-recovery warning still attempted to use a directory-only run token
as an execution-workspace foreign key; its correction is described below.

A fresh, unmentioned follow-up in the existing PR conversation was submitted
at 12:28:39.398. User comment `5585134211` reached the webhook-only proxy at
12:28:41.889 (202 in 67.749 ms) and was durably received at 12:28:42.602.
Run `e12b49b9-5798-4700-8f01-e77b759f19e5` ran from 12:28:43.404 to
12:28:57.439 using actual `codex_app_server`; its persisted native provider
configuration is `gpt-5.6-luna`. It retained provider session
`01a080dc-602e-7033-8c92-e417668c57fb`, returned an accepted yielded result,
and published the actual answer `GH-LUNA-ANSWER-DELIVERED` at 12:28:58.566.
Working feedback and the final each used one attempt and the same GitHub
comment, `5585135215`. This is **19.168 seconds source-to-answer**, with
working feedback after 5.507 seconds; it is one measured short-answer sample,
not a latency percentile. The visible final was verified before clicking the
normal setup test button. GitHub became `active` / `complete` at
12:29:21.220 without editing provider permissions or exposing secrets.

The Slack task-scoped reset has **not** happened. Its native browser
confirmation stopped responding to the browser controls; the dialog API
reported no active dialog while click, keyboard, and close operations timed
out. The exact task-session row still references the failed recovery run.
Fresh Discord and Telegram requests are only prepared drafts: attempts to
submit them did not remove them from the composers or create inbound
deliveries. They are not counted as live probes. No provider login or model
substitution was used to work around the browser state.

## Subsequent scoped corrections

- Optional safe-progress projection skips contended issue/run rows and
  rechecks them on a later sweep. Milestone production and publication
  dispatch have independent coalesced, single-flight lanes, so a slow
  projection cannot hold unrelated already-committed answers/questions.
  Authorization, per-run phase limits, final precedence, and closed payloads
  are unchanged. Red-before/green-after PostgreSQL contention tests and
  independent review cover retry, intervening questions/finals/revocation,
  and draining both lanes on shutdown. This does not claim every provider
  lane is universally lock-free.
- Workspace-finalization recovery uses an execution-workspace FK only when
  the candidate resolves to a company-owned row. Directory-only tokens stay
  nullable; prior-operation cwd recovery requires exact company/run/issue
  binding. Tests cover a real owned workspace, a directory-only run token,
  and rejection of a foreign workspace / mismatched prior issue.

Root's combined coordinator and
workspace-recovery check passed **16/16**; source TypeScript checks passed.
The final full chat integration run passed **369/369** on fresh PostgreSQL
in 68.90 seconds. Its preceding run had **368/369**: an existing assertion
assumed unordered database rows matched insertion order, although both exact
stale placeholders were correctly cancelled. The assertion now requires exact
cardinality and both exact row contents without imposing an unspecified order;
the isolated case and complete rerun passed. No production behavior was changed
for that test correction.
Long text-only generation still uses coarse working feedback rather than
streaming raw deltas or private reasoning into external chat.

The clean `84a601459` deployment reached startup `ready` at 12:40:30.035 UTC,
with the same staged `a0fd2789…` runner. Neither prior recovery error recurred.
The retained failed Slack run's directory-only workspace check was recorded
as a separate successful recovery operation with a null execution-workspace
FK; its historical failed operation and run remain intact. No new external
publication was created by this restart. Fresh post-deployment provider
qualification and the Slack task-scoped reset remain pending the browser
confirmation/input problem above. The server is available locally on 3103;
the private/public Tailscale routing boundary is unchanged.

## Fresh native Luna qualification after browser recovery

Browser input became responsive again. The earlier prepared drafts were not
counted; the following are newly submitted, provider-visible requests on the
`84a601459` server and staged `a0fd2789…` runner. All four active endpoints
(Slack, Discord, GitHub, Telegram) still bind to Maya E2E with adapter
`paperclip_runner` and configured model `gpt-5.6-luna`. Each run below also
independently records `driver_kind=codex_app_server` and the same model in its
native execution profile. No Terra substitution or legacy adapter was used.

- **Discord long answer and queue:** source message `1546864944140787752`
  submitted at 12:49:01.858 UTC, received at 12:49:02.057. Run
  `e9b877f2-4087-413e-bc3d-4f1edd313420` succeeded in 59.769 seconds.
  Working feedback appeared at 12:49:03.800; a safe native progress update
  reused the same message `1546864951203864586`. The complete long answer
  was delivered as `paperclip-response.md` in message `1546865203755614239`
  at 12:50:04.135, **62.277 seconds** after submission. The attachment was
  opened in Discord's whole-file preview, not inferred from an outbox flag.
  Two follow-ups submitted at 12:49:19.640/.670 shared one queued notice,
  message `1546865026105606204`. Successor run
  `04bd1506-2f5d-41a4-b65e-e4377b420a70` succeeded in 15.608 seconds and
  reused that exact notice for working then `GARNET-QUEUE-A` / `GARNET-QUEUE-B`
  at 12:50:18.813. All publications used one attempt. The prior native
  suspension/acknowledgement failure did not recur.
- **Slack scoped recovery and queue:** the audited Board API reset only
  task `4268eb34-b15a-4ab6-91e7-6c184021690d` at 12:54:12.360. This was an
  authorized recovery-fixture API action, not a claim that the previously
  blocked browser confirmation passed. Failed history remains intact.
  Fresh message `1788872101.219689` was submitted at 12:55:01.100; proxy
  ingress followed at 12:55:01.986 and returned 200 in 44.052 ms. Run
  `593ad9cc-f81d-4008-8308-7e1c71082f1b` succeeded in 37.060 seconds; its
  600-word answer replaced the working/progress message `1788872104.327139`
  at 12:55:40.299, **39.199 seconds** after submission. The two new queued
  follow-ups used one notice `1788872120.702299`, then successor run
  `5e81a966-fc00-4bff-8455-4a8b4ae4d2c1` reused it for working and the exact
  ordered `AMETHYST-QUEUE-A` / `AMETHYST-QUEUE-B` answer at 12:55:58.289.
  Both outcomes were read in Slack. All publications used one attempt.
- **Telegram ingress localization:** the first fresh request was submitted
  at 12:49:02.157 but first reached the local webhook proxy at 12:52:56.592:
  **234.435 seconds before local ingress**, not time spent queued in Luna.
  The proxy returned 200 in 703.024 ms; run
  `584dc938-5d8c-4752-8042-aff378da4a9d` then succeeded in 13.433 seconds.
  `TELEGRAM-NATIVE-LUNA-READY` was visibly delivered on the same working
  message `417200359:115`. A second independent request at 12:55:01.547
  reached the proxy in 0.583 seconds without a reconnect/configuration change.
  Run `a2207faa-ff35-4bac-9e1a-fbc0270f5d96` succeeded in 13.603 seconds,
  and `TG-FAST-READY` replaced `417200359:117` at 12:55:17.775:
  **16.228 seconds end to end**. Both final outbox rows used two attempts;
  neither duplicated the provider message. The earlier pre-ingress delay is
  localized, not yet explained or declared permanently fixed.
- **GitHub native question:** new PR comment `5585485583`, submitted at
  12:56:45.673, started run `1ac82077-478b-444a-a459-efa52aaf9d4d` at
  12:56:49.409. It succeeded in 12.884 seconds and visibly published
  “Choose Quartz or Jade” with its normal Paperclip link. Opening that link
  reached the actual pending Board question. Its answer is intentionally
  pending deployment of the separately reproduced native Board-answer
  continuation correction; question creation is not a completed round trip.

These are individual live samples, not latency percentiles. Private reasoning
and raw tool/diagnostic events stay in Paperclip; external progress uses the
closed, safe phase projection. Teams still lacks a qualified Microsoft 365
tenant and is not counted among these four active live endpoints.

The whole-file inspection found two remaining quality defects: the old
Discord placeholder still said “preparing” after its attachment arrived, and
the runner over-redacted ordinary game-token prose. The attachment handoff
now uses a timeless message-limit explanation, which does not claim delivery
before the attachment's own outbox row succeeds. Both existing Discord and
Telegram long-document tests pass (**2/2**, fresh PostgreSQL), including
retry, rejected attachment, ambiguous delivery, and lossless safe-text bytes.
The runner prose-redaction correction is being tested separately with secret
canaries; no broad redaction bypass is authorized.

## Authored-answer preservation and native GitHub answer authority

The parallel audit reproduced an actual progress-lane collision: a run can
legitimately yield an authorized selected answer and later fail, but the
failure milestone reused the old working-message ID after that ID held the
answer. The reverse order could erase the truthful failure notice. The fix
checks the current exact outbound message link, scoped to company, endpoint,
conversation and issue, before either the run lane or older queued-wake lane
can be reused. Authored answers and failure notices consume their lane;
ordinary working→failure and interleaved task-status updates retain their
existing single-message behavior. Twenty Slack/Telegram order/status and
deferred-admission cases failed before the fix and pass afterward; the final
compatibility subset passed **29/29**. No run status or review decision is
rewritten to make the presentation pass.

GitHub's link-only question fallback exposed a separate native-authority gap:
answering in the authenticated Board creates no provider callback action,
while the native continuation attestor required one. A real PostgreSQL native
fixture reproduced the denial. The correction recognizes a distinct Board
answer receipt for GitHub only, bound to the server-created response delivery,
exact original linked user, published question, source/run/wake chain and
current runtime generation. Existing membership, reach and review checks
remain; it does not invent a chat action or make an answer grant governance
authority. The native question suite passed **130/130**, including wrong
responder, revoked identity/membership/reach, stale generation/receipt and
forged-marker denials, plus native file registration/reuse and idempotence.

Root's full chat-channel integration run passed **390/390** on fresh
PostgreSQL in 74.10 seconds (68.98 seconds in tests); source server TypeScript
checking passed. A new Discord pre-link reaction test also covers durable
replay across service reconstruction without additional task work. These
focused results do not remove the separately documented frozen-install/
lockfile release limitation or qualify the missing Teams tenant.

The first and second Telegram final attempts above were authorization-lock
deferrals: the log explicitly records that no provider send was attempted
on the first claim. The retry count is not evidence of a duplicate Bot API
request.

## Live Discord lease expiry

With no active Maya run, root paused the actual server PID for 30 seconds
using an independent automatic-resume timer: 13:00:05.357–13:00:35.358 UTC,
past the 15-second Discord Gateway lease. New message
`1546867734644662432` and an added reaction on the long-answer attachment
`1546865203755614239` were sent while paused. On resume they became exactly
one processed message and one processed reaction delivery, both in the
original CHA-4 conversation. Only one run started:
`1ca2ec88-9c7e-489b-8b1b-bf6f1a85faf5`, actual native Luna, succeeded in
15.982 seconds. Its working notice was edited into `DC-LEASE-RESUMED` on
message `1546867860427644999`, one attempt each, visibly verified.

The reaction removal was performed **after** resume, at 13:00:52.774, and
was durably processed once at 13:00:52.992 without starting another run.
It is not counted as an in-pause removal. A second independent follow-up was
submitted at 13:01:16.676 to verify continued Gateway operation. Run
`9a05c338-4e43-4bb2-ac99-bed85d2c7c6d` succeeded on native Luna in 14.476
seconds; `DC-CONTINUITY-OK` visibly replaced its own working message
`1546868033899986944` at 13:01:32.493, **15.817 seconds end to end**,
one attempt per publication. This proves expired-owner recovery,
not live takeover by a second server process; stale-owner takeover remains
covered by the deterministic integration tests.

Independent review of the GitHub Board fallback found no additional blocker
and reran **24/24** authorization cases successfully. The Discord reconstruction
test was strengthened to assert one exact Activity row plus its original
thread/message/reaction target across a repeated drain; that final focused
case also passed. The server corrections were subsequently deployed from
`1c4a45f0e`; the Rust change remained a separate build and qualification batch.

## Deployed GitHub Board answer and runner build

After server readiness, root selected Jade on the actual linked Board
question `fb33198f-975c-4e1a-b674-4e8e6f0c9ef6`. The native Luna continuation
`73a59f86-9a7c-40f8-9a67-00100ee8cac9` ran from 13:05:30.342 to
13:05:48.198 UTC, **17.856 seconds**, and succeeded. The original question
message `5585486661` changed to “Answered: Jade.” The new working message
`5585598569` became a single Jade final reply at 13:05:49.207. Each publication
used one attempt. The actual GitHub thread was opened and visibly verified.
This confirms the real link-only Board-answer transport; separate negative
tests, not this visible reply alone, establish governance and authority denials.

The narrow game-token prose redaction correction was committed in
`47ddc4f8e`. Root's unrestricted local runner-core suite passed **223/223**;
the earlier sandbox-only socket failures are not failures of this rerun.
The standard release build staged and signed binary SHA-256
`a61275f338b78b7272633490ef4f48684a3c1dca4bf285ec2846fd477c12da41`.
The staged Codex transport suite then passed **87/87** in 67.01 seconds.
These are build/transport results, not a fresh live prose qualification.

## Master reconciliation and review preparation

Merge `e91b236ff` incorporates upstream `297d8741f`. All sixteen conflicts
were inspected and resolved to the already tested branch implementation.
An automatically duplicated tool-authority test was removed. An exact-content
check confirmed that these resolutions preserve the pre-merge source.
Upstream's 244 migration journal entries are the exact prefix of the branch's
254; no migration renumbering was necessary. The merge inherits upstream's
lockfile, with no lockfile change relative to master.

Release preparation adds a default-off chat-connector visibility experiment
without removing production GitHub tools. Superseded generated wireframes are
archived in Git history so one review can remain below the 500-file limit.
Broad post-merge checks and experimental-gate browser coverage are in progress;
neither PR creation nor these focused results is a production-readiness claim.

## Fresh prose and attachment follow-up

Slack's fresh `TOKEN-PROSE-LIVE-0908` submission at 13:16:27.903 UTC produced
all three requested ordinary game-token sentences without redaction. Run
`001e58df-687b-459e-ac02-8bb6e076af59` used actual Codex app-server Luna,
13:16:29.648–13:16:45.771 (**16.123 seconds**). Its working message
`1788873390.611459` was edited to the final at 13:16:46.116, one attempt,
**18.213 seconds end to end**, visibly verified in the original thread.

Discord's fresh sapphire plan was submitted at 13:16:40.547. Run
`fb1665bd-059b-4b88-be6d-d735e45e5816` used actual native Luna for
**58.630 seconds**. Working/progress message `1546871910300917770` became
the timeless message-limit explanation; attachment `1546872156825198685`
arrived at 13:17:41.919, **61.372 seconds end to end**. Every publication
used one attempt. Root opened the actual whole-file preview and verified the
required “One token can equal one standard game.” sentence. Other ordinary
token phrases in that same document were still redacted. The narrow regression
passes; overall prose-redaction quality is not yet fully fixed.

Post-merge full workspace `pnpm -r typecheck` and `pnpm build` both passed.
A fresh final chat integration rerun passed **390/390** in 119.23 seconds.
The broad `pnpm test:run` is still running and has reported a CLI guidance
allowlist failure; no broad-suite pass is claimed. Experimental-gate focused
coverage passed 252 UI, 96 server settings, and 32 shared tests, with token
gates clean. Independent merge regression coverage initially passed 1,228 of
1,229 tests; one heartbeat fixture read agent state before asynchronous
settlement completed. Its exact bounded state-wait correction passed both
the isolated case and all **141/141** recovery tests. No runtime permission
or dispatch behavior changed. The remaining ten merge-regression files passed.

Independent review also found a pasted-URL shortcut around the hidden gallery.
One visibility-filtered list now feeds both cards and URL matching, with
**106/106** AppsConnect tests passing, including hidden Telegram/Discord URLs,
GitHub tool links, and custom MCP compatibility.

The live server restarted from `56c096e5e` at 13:18:39 UTC and reached ready
at 13:18:48. Root verified the actual default-off Apps catalog: GitHub tools
remain visible and the Connect GitHub button opens the normal account/access
flow without a chat choice. Chat-only providers and existing chat connection
rows are hidden. Root then enabled the actual Experimental Settings switch
on this qualification instance and verified that all four existing active
chat connections and Microsoft Teams setup reappeared. Other instance flags
and provider lifecycles were unchanged.

## Landing CI and fresh native shutdown regression

PR [#13038](https://github.com/paperclipai/paperclip/pull/13038) is open as one
review, currently 473 changed files. Merge `1a442f5a0` also incorporates
upstream `b97101893`; a later fetch found no further master commits.
Workspace typecheck and build passed after that merge. The corrected browser
cohort passed **10/10** on isolated port 3199 and a fresh database, including
the default-off GitHub tool flow and all four file-send refresh outcomes.
Follow-up native recovery **9/9**, legacy rollback **1/1**, issue routes
**92/92**, and clipboard/identity-preview **37/37** passed. These focused
results do not make the still-running broad suite or CI green. Greptile has
not yet produced a review after the requested file-limit override.

Telegram's fresh long-answer submission at 13:28:03.761 UTC created run
`f262ca93-3c29-4338-a625-0d2239757e38`, native Codex app-server Luna. It ran
13:28:05.910–13:29:17.661 and failed with
`provider_transport_failed: runner did not durably suspend before checkpoint`.
A 4,092-character native result and successful terminal metadata had been
accepted, but that was not enough to complete cleanup or authorize final
delivery. Working, progress and failure publications each used one attempt
against Telegram message `417200359:119`. The actual chat showed failure;
no successful long-document handoff was observed.

Durable inspection found a 128-delta suffix (source sequences 174–301) already
committed by the controller while the runner's persisted ACK remained 173.
The stop command waited about 9.8 seconds before entering the command journal;
suspend had not entered it when the bounded close failed. No host sleep/wake
occurred in this interval. This is acknowledgment/control-command starvation,
not slow model inference. The proposed fix batches cumulative ACK persistence
without weakening replay, command durability, or suspension proof.

Slack's subsequent `TOKEN-SYSTEM-LIVE-0908` submission at 13:40:12.298 UTC
also failed. Run `2c17e336-f6b2-4763-9d8f-ba9a3c8b296a`, native Luna,
13:40:14.272–13:41:17.434, ended with `native_session_retry_exhausted` and
`native_session_cleanup_quarantined: prior session cleanup remains incomplete`.
The visible working message became a truthful failure. Further live sends
are paused until safe recovery and the shutdown regression are addressed;
the newly staged prose fix is not claimed to have passed live on this attempt.

## CI follow-through and the next live failure boundary

The broad local command completed its general-server phase with **8,117
passed, 34 skipped, and four failed**, then stopped. Each failure has a
focused passing correction: ignored-recording CLI guidance, exact native
recovery ownership, durable parked-answer attestation, and formatted
read-only route extraction. This is not a full broad-suite pass. CI at
`28dd9ee9f` subsequently passed build, typecheck, canary packaging, all three
browser shards, and non-server workspace tests. Three server shards still
failed. All three now have focused passing fixture corrections: comment-call
arguments, formatted route extraction, and waiting for the exact completed
slash-admission receipt rather than an earlier mock wake callback. The last
fix (`cba5aa51c`) also passed an independent full **390/390** chat integration
rerun on a fresh database after 254 normal migrations. CI still needs to
confirm these follow-ups. Greptile has not completed review.

The ACK persistence correction in `440ae9bbd` passed **226/226** core and
**87/87** staged transport tests, including the real socket backlog,
suspension, and authority-rebind case. Binary SHA-256 is
`3c69ea06153944eff3573b28e439de5eed31b5972ff3b18da4c54f1147b47492`.
Before the controlled server restart at 13:55 UTC, root verified that the
old runner process/group and provider process were absent. Startup found
no new unresolved ownership claim. No durable rows or checkpoint files
were manually cleared.

The next Telegram request, run `d0ae1646-c13d-497c-bf6b-a0fef0ff6693`,
failed immediately at 13:57:15 with `runner_state_identity_mismatch`.
The prior heartbeat was terminal while its checkpoint was not suspended;
existing product recovery safely retained the old state in quarantine and
deliberately rejected that first replacement request. This sacrificed turn
is an operator-recovery UX gap, not a reason to bypass identity checks.

After verifying that retention and the absence of the old processes, root
submitted `TG-AFTER-RETIRED-CHECKPOINT-0908` at 14:00:46.314. Run
`a4938fcc-dc2c-4146-a776-12512cf4b613` started at 14:00:47.771 using
Paperclip Runner, Codex app-server, and Luna. The configured low-effort field
was later found not to reach this native path; effective effort is unverified.
The provider produced `paperclip_finish` at 14:01:26.348, but the run stayed
active without delivering its answer. Working/progress publications each
used one attempt against Telegram message `417200359:123`.

Read-only inspection isolated a different defect: the only pending runner
outbox event, semantic tool input source sequence 44, passes schema and
identity/correlation checks but fails its content digest. The finish summary
was sanitized/truncated before hashing and then truncated again while
enqueuing the envelope. Controller commit remains at 43; repeated connection
resets replay the same uncommittable event. This is not model inference or
outbox backpressure. A narrow final-sanitization-boundary fix and long-input
regression are in progress. Do not count this run as a successful delivery
or repair its persisted digest by hand.

The run eventually failed at 14:17:07.520 with
`native_session_retry_exhausted` / incomplete cleanup. Root attempted the
normal Board Cancel only afterward; the control had disappeared and no
cancellation was applied. At 14:19 UTC there were no active Maya runs. The
retained runner checkpoint was suspended with source 44 still unacknowledged;
the provider checkpoint was prepared. No chat-adapters runner/provider process
appeared in the process inventory. Other worktrees' native test processes
were left alone. This state remains evidence, not a success to reinterpret.

Commit `65bd25a22` separately makes the exact irrecoverable, memoized cleanup
failure a typed operator-recovery hold. Independent review confirmed that
temporary failures still retry and new admission cannot bypass retained
ownership. Runtime **74/74**, executor **159/159**, and transport **88/88**
pass, with runner/server TypeScript checks. The composed real transport test
was placed in the binary-built transport suite rather than adding native
prerequisites to the scheduled lightweight runtime suite. The live server
has not yet deployed this change.

## Final-sanitization repair and four fresh long-answer proofs

`f91282130` fixes the digest/sanitization ordering and preserves authored
finish/block summaries up to the existing 12,000-Unicode-codepoint result
contract. Generic diagnostics remain 4 KiB. Invalid incoming semantic digests
are rejected before receipt lookup or queueing, and the persisted envelope is
sealed over its final sanitized input. Existing invalid history is untouched.
Independent review found no weakening of identity, replay, receipt or size
guards. `d8bfdad98` fixes a test-only port-reuse collision in the provider
lifetime-fence fixture without changing production ownership behavior.

Root's final unrestricted core run passed **231/231**. A release build was
staged and code-signature verified, then **88/88** tests passed against staged
binary SHA-256
`ea2986e2d9f24225d80093354a4361a71afee1859319e13814232046187e360c`.
After confirming no active Maya runs, root gracefully replaced only this
worktree's server at 14:32:32 UTC (PID 22469, log
`server-experimental-landing-43.log`). Startup found no pending ownership
claim or evidence reconciliation work. Historical blocked entries and
quarantined state remained intact.

The following fresh requests were sent through the signed-in in-app browser.
Every persisted execution profile is native Codex app-server / `gpt-5.6-luna`.
Times below distinguish runtime from submission-to-final-provider-publication.

| Provider | Run                                    |  Runtime | End-to-end | Authored summary | Visible result                                                                                 |
| -------- | -------------------------------------- | -------: | ---------: | ---------------: | ---------------------------------------------------------------------------------------------- |
| Slack    | `3ccea4de-8f55-4219-895a-1702853b6e50` | 46.999 s |   49.281 s | 6,775 characters | Full thread reply, ending `SLACK-LONG-COMPLETE-0908`                                           |
| Discord  | `fa3862fe-1c10-4d4e-ba8e-4452cf75e0d9` | 44.616 s |   47.426 s | 6,331 characters | 7 KB Markdown attachment expanded through its final `DC-WHOLE-ANSWER-COMPLETE-0908` marker     |
| GitHub   | `741f9f7c-d334-4df9-94f6-ff14b76bbc24` | 45.183 s |   48.105 s | 5,803 characters | Full disposable PR conversation reply ending `GH-LONG-COMPLETE-0908`                           |
| Telegram | `ae666e16-338c-400a-bc9b-7792f97c1770` | 42.526 s |   44.989 s | 5,876 characters | 6 KB Markdown attachment opened in Telegram Instant View through `TG-FRESH-LONG-COMPLETE-0908` |

Both required ordinary sentences were retained in every result: “One token
can equal one standard game.” and “Use a transparent token system for the game
swap.” Each working/progress/final publication operation used one attempt.
Slack reused message `1788877996.440839`; GitHub reused comment `5586825404`.
Discord delivered one full file as message `1546891437210079363`; Telegram
delivered one full file as `417200359:128`. Discord and Telegram's existing
working message became the timeless message-limit explanation, not a stale
claim that the attachment was still being prepared.

Telegram fresh-task setup is important: `/new` was submitted at 14:40:29.672
and its acknowledgment was published at 14:40:32.267. Only after that visible
acknowledgment did `/task TG-FRESH-LONG-SUMMARY-FIX-0908` start new issue
`CHA-26` at 14:40:45.615. Failed `CHA-24` and the unacknowledged historical
semantic event were preserved. This is a fresh-task success, not proof that
the corrupt session resumed. A read-only recovery audit also found that the
targeted run-detail reset uses an issue UUID while the latest chat session can
use its identifier; alias-aware operator reset is being qualified separately.

Functional outcome: all four fresh long answers reached their provider and
were usable beyond the former truncation boundary. Experience quality still
needs improvement: ordinary phrases such as “token system” with other
punctuation/context, “token design”, and other game-token wording still show
`[REDACTED]`. No historical reply was edited to hide these defects. Permanent
authenticated protocol faults also need prompt, typed user-facing failure
instead of reconnecting until the execution deadline. Teams live qualification
and multi-process Discord takeover remain open.

Master is now incorporated through `0cc796b7b` in `baada1375`. Full workspace
typecheck/build passed after the merge. Release-registry **109/109**, combined
preview/ACPX **23/23**, and source-root patch-routing **6/6** passed; the last
six use synthetic preimages derived from actual patch hunks, not fresh npm
installs. CI on prior head `683067cea` passed build, typecheck/release,
packaging, all browser shards, all workspace suites and four of five general
server shards. The remaining general shard found one real stale-read race in
concurrent identical Slack modal submissions (**2,261 passed, six skipped,
one failed**). The race is being fixed with a deterministic regression. Review
and CI remain merge gates; no Greptile review has completed yet.

## Modal race, scoped resets and final prose regression

`3182b0373` corrects concurrent Slack/Teams modal callbacks that both load an
issued token before one commits its answer. The stale callback now rechecks
current authorization under the existing locks and requires the exact processed
token receipt, canonical answered interaction and original resolving user.
Another token, revoked membership/link, or a relinked active operator cannot
clear that form. The deterministic two-provider case failed before the fix;
the final focused cohort passed **11/11**. Independent review found no new
answer or wake authority and no weakened destination/runtime/identity checks.

`6dab18bba` fixes targeted operator session resets when the UI supplies an
issue UUID but saved chat sessions use the issue identifier. The DELETE resolves
only the current same-company issue's aliases within its own snapshot and
retains agent/adapter scoping. Arbitrary custom keys remain exact-match; model
or run context grants no alias. Seven real-PostgreSQL cases passed twice,
including a root rerun; the combined compatibility cohort passed **217/217**
and server TypeScript checks passed. This does not clear quarantined native
state or establish live corrupt-session recovery.

Root's next full chat run was **389/390**. All modal cases passed. The sole
GitHub lifecycle count failure was traced through the retained database:
exactly four GitHub inbound actions had four wake receipts, each attempt one,
and its seven lifecycle receipts had no wakes. An earlier synthetic Telegram
retry-exhaustion fixture had left one issued action eligible after 30 seconds;
the global worker correctly picked it up during the GitHub fixture. Test-only
`finally` cleanup now removes that exact synthetic action after preserving its
strict six-failure and retryability assertions. The GitHub four-wake assertion
and production worker are unchanged. The fresh full rerun subsequently passed
**390/390** in 91.68 seconds on
`chat_adapters_test_20260908_confirmation_cleanup_laplace_full01`, after all
254 normal migrations. Test/service hashes stayed unchanged during the run.
The prior retry fixture plus GitHub lifecycle focused pair passed **2/2** and
server TypeScript checks passed. Log:
`landing-confirmation-cleanup-laplace-0908-full390.log`.

`d99773a5c` extends only the closed grammatical exception for ordinary game-token
phrases observed in the four long answers. Low-entropy bare token values,
assignments, quotes, compound/CLI keys, credential suffixes and nested secrets
remain redacted. Unknown token-noun phrases can still conservatively redact;
there is no arbitrary-English-word or entropy-based exemption. Independent
review passed. Root passed **231/231** core and **88/88** real transport tests
against newly signed/staged binary SHA-256
`e758b7cdb6ba7c9f176d89cbd17b98dc4c42975326012582d6a7cdf230fb0373`.

After verifying no active Maya run, root gracefully replaced only this server
at 14:52:05.363 UTC, log `server-experimental-landing-44.log`. Startup was ready
at 14:52:11.882 with no ownership claims or awaiting-evidence runs. The
previous five historical blocked run IDs remained unchanged.

The exact observed prose paragraph was then sent in all four existing
conversations. Every visible bot reply preserved economy, station,
reconciliation, limits, rules, design, values, exchanges, count and one-token
limit/rule wording, without a redaction substitution. No old reply was edited.
Every run used native Codex app-server / Luna and succeeded; each working/final
publication operation used one attempt.

| Provider | Run                                    |  Runtime | Submission to final publication | Provider message      |
| -------- | -------------------------------------- | -------: | ------------------------------: | --------------------- |
| Slack    | `f91f3343-1df6-491e-a21f-430c9f65ff0e` | 23.945 s |                        26.578 s | `1788879170.708099`   |
| Discord  | `3c39ed83-0409-4095-abc4-eb27c8d77653` | 24.645 s |                        26.546 s | `1546896106515071038` |
| GitHub   | `2c839667-9c83-4963-b60e-f6941ab0f383` | 25.678 s |                        27.459 s | `5587104571`          |
| Telegram | `7f1c72fd-c22d-48f8-a2f2-0cadb2df2c26` | 24.366 s |                        27.770 s | `417200359:130`       |

These results qualify the observed prose repair and the four existing-task
follow-ups. They do not settle intermittent upstream Telegram ingress delay,
old corrupted-session recovery, prompt permanent-integrity failure feedback,
unfamiliar prose redaction or the remaining Teams/multi-process/file cases.

## Current-master skill preparation merge

`6f90d368a` incorporates master `c723bb4df` (validated runtime skill revision
caching). The two additive import conflicts retain both the chat ingress and
heartbeat preparation timing helpers and upstream failed-skill-preparation
tracing. Independent review found no change to safe external-chat progress or
permission/continuation behavior. Full workspace typecheck and build passed.
Focused merged-source verification passed **80/80** skill service/cache,
**203/203** workspace/session, **38/38** native trace/runtime/progress and
**2/2** native preparation executor tests. The staged runner binary is unchanged.

Greptile completed review of `cd5970276` with **4/5**, finding one P2: the
renumbered interaction-wake migration retains its original 0245 label in
deduplication metadata and operator error text. Migration-history hash
compatibility must be preserved while correcting that provenance. CI and a
clean review of the final pushed head remain merge gates.

After verifying no active Maya run, root gracefully restarted the isolated
server with merged source at 15:04 UTC, log `server-experimental-landing-45.log`.
Startup preserved the same five historical blocked IDs, with no claimed or
awaiting-evidence runs. In the existing Slack thread, a normal follow-up at
15:05:14.176 produced exactly `SKILL-CACHE-MERGE-READY`. Native Luna run
`8b9e0a0e-3d0d-4e86-9009-679783d80799` ran from 15:05:17.542 to 15:05:33.125
(15.583 seconds). Final publication at 15:05:33.462 makes end-to-end time
19.286 seconds. Working/final operations each used one attempt and updated the
same message, `1788879918.356759`. The provider UI visibly cleared its working
indicator and showed one clean final reply. This checks post-merge continuation
on one provider; it does not replace the broader earlier qualification.

## Forward-only migration provenance repair

Greptile's migration label finding is addressed by `e3cfc400e`. The original
0251 SQL remains byte-for-byte identical to its deployed 0245 form, SHA-256
`5e181169a724173d17865d537bd84c385e97e6f78e71aa795cad91734cd37ea0`.
Changing those bytes would break hash-based history recognition and could
replay the duplicate-wake repair. New custom Drizzle migration 0256 instead
corrects only exact legacy `migrationDedupe.migration` values and the matching
generated final audit line. It preserves all wake state, run links, keys,
timestamps, unrelated payload and free-form errors. Primary-key batches are
bounded to 500 rows; locks still last through the migration transaction.

The new cases failed **2/2** with an empty migration, then the complete
reconciliation cohort passed **5/5**, including fresh and deployed-history
upgrades, unchanged original hashes, malformed/unrelated metadata, later
terminalized history, unrelated-only batches and idempotent reapplication.
Root independently passed **48/48** migration/client/snapshot/safety tests.
A fixture JSON typing error found by root's build was corrected; DB build and
typecheck then passed. Independent final SQL/test review found no issue.
The generated snapshot adds no schema delta; the journal now has 255 entries,
11 beyond master. No migration client behavior or historical SQL was changed.

## Database-pool master merge

Master advanced again to `023e640a7` with database pool defaults and orderly
pool closure. Merge `21061f4de` preserves the chat teardown in the sole app
shutdown conflict: unsubscribe publication signals, stop reconciliation and
its timer, await producer/consumer drain, then await chat runtime cleanup.
Upstream's final shutdown awaits that app cleanup before ending the database
pools. The scheduler is stopped once within the awaited app teardown.

Full workspace typecheck/build passed again. A merged-source six-file cohort
passed **71/71**: database client options, client, provenance reconciliation,
server shutdown, chat publication reconciliation and app lifecycle coverage.
Independent ordering review found no regression. Log:
`landing-db-pool-shutdown-merge-laplace-0908.log`. The PR remains one branch,
**483 changed files**, with no lockfile delta relative to current master.
The live server still runs the earlier skill-cache merge (`6f90d368a`);
this last pool/shutdown merge has automated checks, not a new live restart
qualification. CI and final-head Greptile confirmation remain outstanding.

## Permanent protocol-failure propagation

The historical Telegram checksum incident exposed an additional feedback
problem: the controller rejected an authenticated bad semantic digest by
closing its socket, while higher layers kept reconnecting until the turn's
900-second deadline. The current fix distinguishes a proven permanent fault
from an ordinary dropped connection or failed persistence attempt.

`NativeSessionProtocolIntegrityError` carries an allowlisted reason and the
existing `native_event_replay_conflict` disposition. The controller validates
authentication, complete run/turn/item/source identity and source sequence
before latching it. Bad semantic bytes and conflicting committed replay bytes
cannot be committed, ACKed or dispatched. A successful commit already in
flight also cannot reopen dispatch after the latch. Lifecycle command results
remain available for exact-owner suspension; the fix does not discard durable
history or manufacture cleanup success.

The same class instance passes through transport requests and notifications,
the Codex event queue, the harness backend and runtime cleanup. It takes
precedence over buffered success or synthetic governed-wait output. Ordinary
errors and objects that merely resemble its code stay on their existing
paths. A database-confirmed replay conflict now uses the typed class after
the existing authorization and exact-run lock. The server's recovery decision
is permanent/operator-owned, and external chat receives only a safe request
to have a Paperclip admin review the run.

Initial verification passed **130/130** controller/staged-transport tests,
**238/238** Codex-driver/backend tests, **78/78** runtime tests, and **183/183**
executor/coordinator/external-copy tests. The controller cases use genuine
encrypted authentication and cover wrong identity, out-of-sequence input,
repeat faults, transient persistence, in-flight commit and suspension. One
initial transport cohort hit an existing intermittent backlog/turn-ID failure;
the isolated repeat and two later complete transport cohorts passed. Its
original failed log is retained, not rewritten as a pass.

Independent review then found that ancillary executor logging or a failed
recovery-state write could replace the primary fault. Four red regressions
established that gap. The final executor **166/166** pass covers preservation
of the exact original error, continued recovery projection after logging
failure, and no fabricated task/run updates after a failed transaction.
The finalization admission boundary and composed negative-path test are being
qualified separately before deployment; these initial counts are not a
claim that all subsequent edits have completed verification.

## Composed damaged-session replacement proof

A new **35/35** resume cohort includes a real PostgreSQL, runnerd, driver,
native runtime and Paperclip control-plane path. Only the Codex provider
process and a generated historical corruption seed are synthetic. A normally
suspended disposable root receives an invalid pending semantic event. A
nonterminal prior database owner prevents rotation without changing its bytes.
After normal terminal-owner eligibility, the real selector/rebind path tries
warm attachment, which rejects the actual pending-event guard. The governed
continuity-break path then creates one replacement provider turn and persists
exactly one accepted result on the same task and agent.

The archived prior runner-state bytes are SHA-256 identical; the invalid
pending provider event is retained, never repaired or leaked into the new
run. The old provider starts zero turns and the replacement starts one.
This fixture uses persisted execution v2; existing context-guard cases cover
other versions. It is stronger than a mocked selection/rebind or a test that
stops at the replacement callback, but it is not live Telegram `CHA-24`
recovery or proof of external publication. That original live root remains
untouched. Independent server typecheck and formatting/diff checks passed.

## Landing and latest sandbox-recovery master merge

At pushed head `2ded499ed`, Greptile returned **5/5**, with the provenance P2
resolved, and CI run `34248557216` passed every lane. This applies to that
published head, not the later uncommitted integrity work.

Master then advanced to `5752d6bd9`, adding stuck sandbox-plugin setup
classification and bundled-plugin boot recovery. Clean merge `48767c1c0`
retains the native held-owner guard, nonretryable preflight classification,
chat idle handling and unadmitted-wake exclusions. Its internal plugin failure
details are not included in external milestone messages. A six-file
compatibility cohort passed **246/246**, including bundled/loader behavior,
heartbeat recovery, operator notices, chat publication and the composed
damaged-session proof. No migration or runnerd contract changed upstream.

The fresh full chat integration passed **390/390** in 75.93 seconds using
`chat_adapters_test_20260908_integrity_root01`, after all **255 journal
entries through migration 0256**. This run preceded the final sandbox master
merge; the 246-test cohort covers that merge's relevant paths. Full workspace
typecheck and build subsequently passed, along with the final **10/10**
deterministic browser retest. Broader tests are still running.

### Completion admission and primary-error follow-through

The finalization regression is now fixed. Between preparing a semantic result
and invoking `completeRun`, control-plane replay/appends can yield. A final
local snapshot observation rejects a typed fault latched in that interval;
ordinary snapshot/enrichment failures retain their previous behavior. Once
`completeRun` has been invoked, a timeout may mean that its transaction
committed and the acknowledgement was lost. Its deterministic retry therefore
cannot veto that potentially committed result based on a later observation.
This is a local completion-admission boundary, **not an atomic fence with the
remote database commit**. The tests explicitly cover a pending completion
call and both final-event and completion acknowledgement loss.

The two initial pre-admission cases went red-to-green; seven new boundary
cases bring the runtime cohort to **85/85**. The final combined runtime plus
Codex-driver/backend cohort passed **323/323**, with direct TypeScript and
diff checks clean. Required cleanup, quarantine and original startup-race
error preservation remain intact. A composed authenticated negative-path
test subsequently passed as described below.

### Authenticated negative-path composition and live restart

The final negative-path fixture uses a genuine encrypted socket through the
actual durable controller, runner transport, Codex driver, harness backend
and `executeNativeSession`. It injects the invalid frame only after run
admission and a real mapped `turn.started` event. The pending transport read
and runtime reject the same typed object after required cleanup. The fault
fails within five seconds despite a 900-second reconnect setting; source
ACK stays at two, no bad payload is dispatched, no result is accepted and no
replacement process is started. The repeated controller/runtime/driver cohort
passed **132/132**. The synthetic process launcher and in-memory persistence
port mean this is not a Rust-emission, live-provider or server-database test.
Those boundaries have the separate staged transport, scoped coordinator,
executor and composed recovery evidence above. Final runner primary/surface
TypeScript checks passed after adding this test.

Root restarted only the isolated live instance at **16:26:24 UTC**, from
merge `48767c1c0` plus the verified uncommitted integrity patch, using
`server-experimental-landing-46.log`. There were zero active/queued runs;
the prior server gracefully drained zero interrupted runs and shut down its
chat gateways. Pending provenance migration 0256 applied normally. The signed
runner digest remains
`e758b7cdb6ba7c9f176d89cbd17b98dc4c42975326012582d6a7cdf230fb0373`.
All four configured endpoints are active; the Discord gateway connected.

Fresh ordinary continuation `INTEGRITY-LANDING-0908` requested exactly
`NATIVE-LUNA-READY` on existing tasks. Root submitted through the signed-in
provider browsers and saw each final reply with its working state cleared:

| Provider | Run                                    | Native Luna duration | Submit to publication |
| -------- | -------------------------------------- | -------------------- | --------------------- |
| Slack    | `a0f1d707-c6e3-4fd5-90b0-f5d4ba05c48c` | 11.237 s             | 13.146 s              |
| GitHub   | `73ce21b7-9cd8-4380-9bd7-69c9f6992dfb` | 12.686 s             | 17.148 s              |
| Telegram | `823d811f-daad-4bd3-91c0-c1dbdf587e3f` | 14.046 s             | 16.602 s              |

Persisted execution profiles confirm `gpt-5.6-luna` for all three. Each
working/final operation used one attempt and the same provider message:
Slack `1788884841.421029`, GitHub `5588442165`, Telegram `417200359:132`.
No duplicate final reply was observed. Slack's browser initially retained an
older scrolled thread and needed a reload to restore its composer; the new
message then sent normally. This is provider-browser navigation friction,
not evidence of a failed Paperclip delivery.

Discord's Eigenjoy browser login had expired, so no new Discord live send is
claimed. Its login tab was left open and the user notified; the bot connection
itself is active. Teams still lacks a qualified tenant. No corruption was
introduced into live state and the old damaged Telegram task was not reset.

### Final-head review and normal old-task retry

The integrity work was committed and pushed as `d886f52c0`, with **493** PR
files and master `5752d6bd9` incorporated. Greptile reviewed that exact head
at **5/5**, with no outstanding finding. CI `34251447214` hit fourteen
pre-install failures in the lockfile-artifact restore step; sampled job logs
all report `ListArtifacts` HTTP 403 from an intermediary. The policy artifact
exists and five sibling jobs restored it successfully. Running jobs and the
broad local test command are not yet complete. This is not a green CI claim.

Root navigated through Board Tasks to the old Telegram **CHA-24** and clicked
its ordinary **Try again** at **16:35:06.919 UTC**. The UI immediately showed
working state; native Luna run `91a2e169-9674-4853-87ef-22b0d924321e` started
at 16:35:06.982 and succeeded at 16:35:31.003, with one accepted result.
However, this is **not** successful damaged-session recovery:

- The new run used the task UUID as its session key and resumed older provider
  session `01a0802c-06af-7671-b96d-d63d2f5e9b8f`. The damaged run used key
  `CHA-24` and provider session `01a08152-4af9-75a0-bbcb-f40b2f67115d`.
- The original immutable wake was `on_demand` / `manual` /
  `retry_failed_run`, with an issue-only payload and no failed-comment or
  retry lineage. The earlier record incorrectly inferred its trigger from
  mutable run context: a separate `native_status_decision` /
  `issue_status_changed` intent was coalesced at 16:35:30.999, after the run
  started at 16:35:06.982. The model acted on the original photo-resend
  description, not the latest
  failed 900-word request. It reported attachment-binding denial and did not
  resend the photo. A successful run status does not mean the user goal was
  achieved.
- The old Telegram generation 9 remains completed; generation 10 still maps
  to CHA-26. Zero publications were created for the retry. The newer chat did
  not receive an old-task response, and obsolete attachment access was not
  restored. This is the correct safety boundary, not a delivery failure.
- Both damaged root files remained byte-identical: runner state SHA-256
  `b8eedccd5fddbda3f8d099f96ea2e4658360815a133830cfc94a39ecfa011399` and
  provider state `b98888368bfe175e826f6709f34f42b5a1a10c16a6664850b2e24fa6d5a2b09b`.

Experience quality still needs improvement. The task list called the
Board-owned terminal recovery **Observing active run**, the retry's intent
did not match the failed request, and a **Native completion review** remained
visible during execution. No completion was approved. The label is being
corrected below; retry-context and retired-conversation feedback remain a
follow-up. No direct database or saved-runner-state repair was used.

The shared recovery badge now displays **Recovery needed** for a Board-owned
watchdog, including terminal native faults. The expanded card says that a
human decision is needed instead of claiming a silent active run. Existing
agent observation, resolved/cancelled/escalated precedence and authorized
controls remain intact. Four cases demonstrated the old error before the
fix; the final four-suite UI cohort passed **125/125**. UI TypeScript and all
four mandatory `check:token-gates` checks passed. A separate forbidden-name
`check:tokens` command still reports unrelated existing fixture/Storybook
content; no broad cleanup was performed.

Root reloaded the live UI, navigated through Tasks and Inbox, and visually
verified the corrected badge on existing failed **CHA-6**. No run or recovery
action was changed during that check. The expanded card has component-test
coverage but was not visible in this live chat-interface journey. The final
PR diff remains below the review cap at **497 files**.

Read-only comparison with master `5752d6bd9` confirmed the generic retry
context loss predates this PR. The follow-up must bind an explicit failed run
on the server, preserve exact request/comment and task-key lineage, and
revalidate current chat generation, identity and reach before any mutation.
A retired conversation must yield actionable guidance and no queued run.
Concurrent restart/newer input, duplicate retries, cross-company references
and operator-required native faults need negative tests. This is not fixed
by restoring stale chat credentials or bypassing corrupt-session guards.

### Early semantic input versus turn admission

The subsequent broad local run stopped in general-server after **8,208
passed, 30 skipped and one failed** test. The composed real-runner recovery
fixture saw its event stream close before a terminal fact. Five focused
stable-environment repetitions and six whole-file repetitions (**35/35** each,
zero skips) did not reproduce it. Bounded failure-only runner and canonical
event diagnostics were added; none of the ownership, archive or result
assertions was relaxed. The exact historical failure cause remains unproven.

Independent investigation did produce a deterministic related failure: an
authenticated `paperclip_finish` can arrive on the semantic callback path
before the turn-start response establishes the driver’s active provider turn.
The driver rejected that valid call as `tool_binding_mismatch`. Waiting only
in the driver is insufficient because the transport had already copied its
temporary turn identifier into the callback parameters.

The fix adds two admission barriers. The transport waits for the exact
captured start to settle, then checks its epoch, controller, thread and durable
correlation again before constructing provider parameters. Failed startup,
close, detach, a newer start or a typed integrity failure cannot release an
old call into a different turn. The driver separately waits for admission
and then applies its unchanged exact thread/turn guard. Durable semantic
dispatch does not block command-result ingestion or cumulative ACK, so the
barriers do not deadlock that connection. No arbitrary delay, retry loop or
alternate identity was added.

Evidence for the final source:

- Deterministic driver repro went red to green; foreign-turn rejection remains.
- Authenticated controller → transport → driver → backend → runtime tests
  passed **16/16**, including withheld start response, a mismatched provider
  start, failed startup, typed faults, superseded epoch, close and detach.
  Valid early input waits and produces one accepted result. These tests use
  a synthetic launcher and persistence port, not a real provider or database.
- Full controller/staged-transport/Codex-driver/backend cohort passed
  **326/326** with the then-current 12 composed cases; the expanded 16-case
  cohort passed separately. Runtime passed **85/85**. Do not claim a combined
  330-test invocation that was not run.
- The real runnerd/PostgreSQL recovery file passed **35/35**, zero skips,
  after the production fix. Source hashes remained unchanged across that run.
- Full workspace typecheck/build and another fresh chat integration
  **390/390** passed. The integration database was created separately on the
  existing isolated PostgreSQL server and migrated through all 255 entries.

The remaining broad groups exposed separate local test-environment failures:
Workspace B passed **2,996** with 60 skipped; Workspace A passed **6,083**
with one skipped and three embedded-PostgreSQL bootstrap failures. The entire
affected CLI worktree suite then passed **63/63** unchanged with exclusive
database-test access. One serialized server suite hit the same startup error;
a later serialized run passed that suite but stopped on a `socket hang up` in
the unchanged company-import transfer suite. Its full isolated repeat passed
**24/24**. The local machine had 29–30 shared-memory segments against a limit
of 32. Contention is a supported inference, not captured historical stderr.
No global IPC state, unrelated PostgreSQL process or system limit was changed.

A new complete `pnpm test:run` was started after the final build with no other
agent starting an embedded database. Previous failed invocations remain
recorded; focused repeats do not turn them into broad-suite passes.

The admission fix was deployed to isolated server **47** at **16:57:20.764
UTC**, after the full build. No queued or running heartbeat existed. Server
46 drained zero interrupted runs and closed remaining idle HTTP connections
after its normal five-second deadline. The signed native binary hash is
unchanged. Root then sent the same `ADMISSION-LANDING-0908` request through
all three signed-in provider browsers at **16:57:53.655 UTC**, requesting
exactly `ADMITTED-NATIVE-LUNA` on the existing tasks.

| Provider | Run                                    | Native Luna duration | Submit to publication |
| -------- | -------------------------------------- | -------------------- | --------------------- |
| Slack    | `1edcefd6-00aa-41bf-8c82-d89ab2ba3fa6` | 11.743 s             | 14.741 s              |
| GitHub   | `ea8a948f-841e-4932-a29a-eff45118a048` | 13.354 s             | 18.018 s              |
| Telegram | `7a4e76f1-1a97-4ee3-b004-8bba06ff5426` | 13.267 s             | 15.940 s              |

All three runs succeeded and their persisted profiles specify native
`gpt-5.6-luna`. Root saw each exact final reply and the working indicator
clear. Each working/final operation used one attempt and updated one provider
message: Slack `1788886677.466519`, GitHub `5588819297`, Telegram
`417200359:134`. No duplicate final was observed. This is a continuation smoke,
not fresh coverage of every file/interaction permutation or old-task recovery.
Discord still requires renewed browser login; Teams still requires a tenant.

Before this admission fix, PR head `5aa2ac46c` passed all CI lanes in
`34252696878` and Greptile at **5/5**. Those gates must run again for the new
patch and latest master `be6bb768b`, which arrived during final qualification.

### Accessible-company master merge and final landing pass

Merge `49de75691` incorporates master `be6bb768b` after admission fix
`46a946aae`. The only manual conflict retained both the chat OpenAPI assertions
and upstream accessible-company query assertions. The review diff remains
**497 files** and has no lockfile delta. The merged compatibility cohort passed
**256 UI + 32 server tests**, covering company selection, catalog routes,
production GitHub tools, experimental chat visibility, authorization and
OpenAPI. Full workspace typecheck and build passed again after this merge.

Isolated server **48** started at **17:03:55.700 UTC** from `49de75691`,
with zero active/queued heartbeats before shutdown. Server 47's three live
native continuations above cover the unchanged native admission code; this
restart additionally loads the merged company route. The broad local test
invocation began before this small master merge and is still running; its
earlier failed invocations remain recorded. New final-head CI and Greptile
review are required before merge, even though the preceding published head
passed both.

Root reloaded the existing Board catalog. It showed the expected company,
all four configured connections as active, and the enabled experimental chat
surfaces without an error banner. The initial loading screen resolved and
the server health became ready. This is a catalog smoke on the merged server,
not a repeat of the separately qualified default-off or provider journeys.

Final independent driver review found one additional direct-transport edge.
An optimistic `turn/started` notification could set the active identity, then
a start response without `turn.id` threw without clearing it. An already
queued semantic call could consequently succeed despite failed admission.
The deterministic case failed before the fix. Clearing the provisional active
turn and started state before the existing throw now rejects that call and
preserves the original omitted-id error. The focused Codex cohort passed
**178/178** across nine files, including 17 integrity/composition cases;
runner no-emit TypeScript checks passed. No accepted/result/terminal completion
event escaped the failed start. The native transport has its own malformed
response guard; this closes the driver layer too. No further admission-fence
blocker was found. Build/deployment of this final small defense is pending;
server 48 still contains the preceding verified driver source. The broad run
started before this follow-up and is not exact-final-head proof for this hunk.

### Final driver deployment and live file qualification

At head `aaa74597f`, CI **34255076310** passed all lanes and Greptile scored
**5/5** with no outstanding finding. Master remained `be6bb768b`; the review
diff remained **497 files**, with no lockfile delta. A subsequent test-only
fixture cleanup and this evidence record require renewed final-head gates.

The final runner TypeScript build passed and isolated server **49** restarted
at **17:23:07.133 UTC**; health and startup recovery were ready at
**17:23:10.159 UTC**. The previous process had zero active or queued heartbeats
and drained without interrupting runs. The signed native binary stayed at the
same SHA-256; no Rust restaging was needed. The server loaded the final
malformed-response guard, with only test-fixture edits dirty at startup.

Root repeated the disabled-experiment journey on server 48 after the
accessible-company merge: **Settings → Experimental → Chat connectors off →
Connectors → GitHub → Connect**. Chat-only providers and existing chat
connections disappeared, but GitHub opened its production tool account setup
directly, without the chat/tool choice. Root canceled that setup without
creating a connection, restored the experiment through the UI, and verified
all four active connections. The expected company remained selected and no
error banner appeared. This covers the final company-navigation merge, not
every viewport or transition timing.

New signed-in browser file checks on server 48 used native Codex app-server
with persisted **`gpt-5.6-luna`** (effective reasoning effort unverified):

| Journey                                            | Native execution | Submission to useful result |
| -------------------------------------------------- | ---------------- | --------------------------- |
| New GitHub private main-conversation image         | 20.846 s         | 26.303 s                    |
| New GitHub generic private file, truthful omission | 15.912 s         | 21.116 s                    |
| Slack exact original-file return                   | 42.115 s         | 46.266 s                    |
| Telegram exact original-file return                | 49.995 s         | 54.863 s                    |

The GitHub repository remained private, with unchanged App permissions. The
new image imported with exact fixture bytes and the response accurately
described it. The generic text-file request received one current-input
`download_unavailable` omission, zero imported/generated attachments, and a
truthful unavailable answer rather than values invented from an earlier file.
The separate [private attachment authority record](2026-09-08-github-private-attachment-authority.md)
documents that narrow boundary and source/body binding.

For Slack and Telegram, root uploaded the same new synthetic text fixture,
asked for its content and exact original file, saw the correct values and a
native downloadable reply, and **downloaded each provider-returned copy using
the real browser UI**. Source, stored inbound blob, originating-run output
blob, and both downloaded copies are **152 bytes**, SHA-256
`e5ea1c89ad69c0ae9dffea0599c730e5d284816dbcd9dae44746c7a29f790293`.
All copies were independently rehashed. Telegram's download-event observer
timed out, but the new OS download existed and matched; root did not resend
or click again. This observer failure was not a delivery failure.

Each final publication used one attempt. Slack's accepted upload receipt was
processed once. Working and final text reused the same provider message;
file attachments appeared separately without a duplicate final or a lingering
working state. Scoped current delivery/action/wake/run/event/result/comment/
publication checks found no signed-query or credential leakage. These are
ordinary file handoffs, **not** proof of the specific attachment-reuse tool,
provider latency percentiles, or every restart/revocation case.

Functionally, the new Slack and Telegram files were useful end to end: visible
content matched and the downloaded files were usable. Their native execution
still accounted for most of the 46–55-second wait. The GitHub image path also
worked; generic private files remain a real provider limitation with truthful
feedback, not universal file support. Teams and renewed Discord browser
qualification remain separately blocked by their documented access gates.

Server 49 then passed `FINAL-GUARD-SMOKE-0908` in the existing Slack thread:
the exact requested final arrived in **17.297 seconds**, including **15.244
seconds** of native Luna execution. One working/final message was updated,
with one attempt each and no lingering working state. A fresh GitHub private
**inline review-thread** image also passed in **31.028 seconds**, including
**23.822 seconds** native execution. The stored bytes matched the new upload,
the exact review-root/source-body/current-comment binding held, and the
correct visible reply stayed in that review thread after refresh. This
qualifies the review-image path separately from the main-conversation case;
it does not replace changed/deleted-source or interrupted-download testing.

### Slow-suite Slack receipt fixture isolation

The latest broad local `pnpm test:run` stopped in general server at **8,207
passed / 30 skipped / two failed**. Both failures were strict worker-count
assertions in the Slack receipt cases, not a demonstrated duplicate live send.
The later workspace and serialized groups were not executed by that command.

An independent deterministic reproduction identified the causal chain. The
earlier rate-limit classifier fixture left its endpoint active and its
publication scheduled five seconds into the future. A later service's global
drain legitimately claimed that different endpoint's retry and its own upload,
returning two instead of one. The failed assertion then left an unprocessed
receipt, which the next test counted instead of zero. Advancing only Date by
six seconds reproduced both failures on a fresh database in **1.85 seconds**.
The same-attempt ownership guard itself remained intact.

The test-only fix wraps the classifier and four related receipt fixtures in
failure-safe teardown: stop their exact service, then pause only that fixture's
still-active endpoint. Publication/receipt audit rows and all strict counts,
retry-deadline and competing-owner assertions are preserved. An adjacent
fixture that intentionally retained a two-second retry receipt receives the
same cleanup. The deadline-crossing regression stays in the test; bounded
failure-only diagnostics report at most 20 synthetic rows. No production
worker or provider retry behavior changes.

The focused causal cohort passed **8/8**, server no-emit TypeScript checks
passed, and the repaired full integration file passed **390/390** on fresh
PostgreSQL database `_06` in **102.93 seconds** (113.74 seconds total).
The only subsequent behavior-neutral edit caps diagnostics on the failure path;
the separate classifier/receipt confirmation passed **10/10** on final bytes.
The original
failed broad invocation remains failed, not retroactively green.

Separate continuation groups passed UI **5,614/5,614**, the nine remaining
workspace-B projects **2,170 passed / 19 skipped**, and the complete DB project
with one worker **122 passed / six skipped**. The original workspace-A CLI
portion had **477 passes / two bootstrap failures**; captured PostgreSQL stderr
confirms shared-memory exhaustion. Workspace B had stopped at DB with **89
passes / 38 skips / one bootstrap failure**. A CLI rerun accidentally used
noncanonical `/tmp` and hit 14 path guards; correcting the wrapper yielded
**478 passes / one source/target database bootstrap failure**, not a complete
CLI pass. Host usage remained 30 of 32 shared-memory segments. No positively
identified database from these completed test roots remained to clean up.
Global IPC limits, unknown segments and unrelated databases were untouched.
The documented serialized group then stopped at suite **97/143** with
**1,504 passed / 21 skipped** and no assertion failures. The queued-comments
route fixture could not bootstrap PostgreSQL; **46 suites were not reached**.
Captured stderr reported `shmget ... No space left on device`, and host
shared-memory usage reached **32/32** segments. No positively identified
current-task cluster remained to clean up; no further unchanged retry was run.

### Reasoning-effort evidence correction

The live runs demonstrably use native Paperclip Runner, Codex app-server and
`gpt-5.6-luna`. Earlier notes also called them low reasoning because Maya's
agent configuration contains `modelReasoningEffort: "low"`. A final audit
found that this legacy field is **not projected by the native execution path**.
The measured timing, provider identity, bytes and delivery results remain valid;
verified low reasoning was an unsupported inference and is corrected above.

The provider resolver produces identical closed profiles for synthetic low and
high inputs: Codex, Luna and the configured approval policy. The native input
contract has no reasoning-effort field. The native Codex transport and Rust
provider omit it from thread start/resume and turn start, and the generated
isolated configuration and launch arguments add no override. Actual effort
may depend on provider defaults or resumed state; it was not measured here.
The decisive resolver, native contract, Rust provider, context materializer and
security-argument files are byte-identical to master `be6bb768b`, so this is
a pre-existing runner limitation rather than a chat transport regression.

Follow-up: if native reasoning selection is exposed, carry a validated value
through the closed provider contract, persisted execution identity and provider
request, test new and resumed sessions, and verify it with the live provider.
Do not silently inject legacy configuration into the closed native boundary
or expand the chat landing patch into an unreviewed runner protocol change.

### Changed GitHub source and renewed landing gates

The real private-image source-change journey now passes on isolated server
**50**, started from clean documentation head `179fb5a53` at
**17:39:47.681 UTC**. The native production code and signed binary are unchanged
from server 49. Root stopped the prior server only after zero active/queued
runs, uploaded a new synthetic private image through the GitHub browser while
ingress was offline, and edited that same source before recovery. The supported
App webhook API then redelivered only the exact original created event once.
The [attachment authority record](2026-09-08-github-private-attachment-authority.md)
records the exact source hashes and bounded proof.

Paperclip rejected the canonical body mismatch before selecting a signed image
target. The current input had one unavailable omission and no attachment or
view event. Native Luna took **14.881 seconds**; one final publication arrived
**17.755 seconds after ingress** and truthfully said the exact image could not
be imported. Root saw the final reply in GitHub. This is changed-body rejection,
not deleted-source or in-flight revocation qualification.

The test also exposed a separate callback failure: GitHub reported a bot-created
event **502 in 0.1 seconds**, with an empty response and no headers. Its
destination exactly matched the current App webhook and successful neighboring
deliveries. No matching request reached the local proxy or Paperclip. The later
bot-edit callback reached Paperclip and was correctly filtered, but that does
not explain the missing created callback. A bounded Tailscale/system-log query
found no matching failure diagnostic. Its pre-proxy cause remains open.

Greptile reviewed exact head `179fb5a53` at **5/5**, with zero new findings and
the previous thread resolved. CI **34257833081** failed its runner Build lane:
the real-transport **1,024-event suffix** case rejected the first close with
`NativeSessionCloseUnrecoverableError`. The runner cohort had **1,702 passed /
three skipped / one failed**; this was not an artifact-restore or database
bootstrap failure. Preserve stop/drain/suspension and ownership assertions
while investigating. Both remaining general-server shards subsequently passed;
the completed run failed only this lane and its aggregate gate. The preceding
production head's green CI does not erase this failure.

Merge `7401e6a72` then incorporated master `db85bf4b7`, preserving the simpler
production GitHub repository list and configuration link. The merge was clean;
the experimental entry-point gate is separate. Its six-file UI compatibility
cohort passed **221/221**, and all four token gates passed across 961 files.
Fresh final-head verification is still required before merge to master.

Root also repeated the real UI entry-point journey after this merge: account
menu → Settings → Experimental → Chat connectors off → Back to app →
Connectors → GitHub. It opened normal tool account setup directly, without
the chat/tool choice. Cancel created no connection. After restoring the flag,
all four active chat connections reappeared and GitHub offered the exact two
chat/tool choices. The UI uses Vite middleware and was reloaded; the backend
process stayed on server 50. Root inspected the rendered setup and chooser.
The flow was understandable and showed no error banner or unexpected sign-in
redirect. This is entry-point proof, not live permission-list population: that
upstream rendering has the separate automated coverage above.

### Explicit original-file reuse in Slack and Telegram

At **17:52:39.008 UTC**, root submitted `REUSE-ORIGINAL-LANDING-0908` once in
each existing Slack thread and Telegram bot conversation. Unlike the earlier
ordinary file handoffs, this request explicitly required `reuse_chat_attachment`
for the original `native-file-roundtrip-landing-0908.txt`, with no local copy,
regeneration or substitution. This is a focused action qualification, not a
claim that every natural-language resend request selects this action.

Both runs persisted an **applied reuse action receipt** and matching
`reusedFromAttachmentId`, `reusedFromCommentId` and `reusedFromSha256` work-product
metadata. The selected sources were the original inbound attachments on the
same tasks, not the previous generated copies. Current conversation authority
and generation matched. Native Luna used **20.647 seconds** in Slack and
**24.747 seconds** in Telegram; the downloadable files arrived **24.163 /
27.865 seconds** after submission. Each file publication used one attempt.

Root inspected the final response and native file, then downloaded each new
provider-returned copy through its UI, once. Both actual OS downloads are
**152 bytes**, SHA-256
`e5ea1c89ad69c0ae9dffea0599c730e5d284816dbcd9dae44746c7a29f790293`,
matching the source and independently rehashed originating-run output blobs.
The one-sentence final and file were useful, and no lingering working indicator
or duplicate final was observed. Scoped output checks found no internal UUID
or private URL leakage. This closes the explicit-reuse gap for these two live
journeys, not every permission-revocation, restart or provider permutation.

### Fake-provider restart state and shutdown diagnostics

The CI first-close failure above did not reproduce in an isolated 1,024-suffix
case using either the staged release runner or the existing debug runner.
Two concurrent debug fixtures then exposed a **different**, concrete failure:
one first close succeeded, but its successor correctly rejected a reused
provider-turn identity. The fake provider's state writer truncated its canonical
JSON in place, published terminal output before the final save, and silently
defaulted malformed state to a fresh turn counter. A legitimate process stop
could interrupt the write and make the next fake process reuse an old turn ID.

The fixture-only repair atomically replaces the state using a unique sibling
file, persists settled state before emitting terminal output, and defaults only
when the state file is absent. Existing malformed state fails instead of
resetting its counter. Three deterministic persistence cases failed on the old
semantics; all **seven fake-provider unit tests** pass after the fix. A repeated
pair of concurrent 1,024-suffix debug fixtures passed **2/2** in about 30 seconds
each. This proves the reproduced fake-state defect, not the original CI close
failure or machine-power-loss durability.

The transport fixture also retains bounded failure-only lifecycle, cursor,
count and stop/drain/suspend-command diagnostics, including a first-close
snapshot captured before successor archival. It preserves synthetic failed
fixture state for diagnosis without printing raw provider or control-plane
payloads. Strict suspension, identity, pending-event, uniqueness and successor
checks remain unchanged, as do their deadlines. Production runner source and
the staged/signed binary are unchanged; only the fake provider was rebuilt.
Final staged verification passed **3/3** (48- and 1,024-suffix shutdown/rebind,
plus unexpected-active resume), with the default binary resolver restored.
Final fake-provider units passed **7/7**; runner TypeScript, standalone Rust
formatting and diff checks passed. The standalone formatting result did not
match the workspace convention, as corrected below. Independent review's
malformed-diagnostic concern was
addressed: non-record command entries are excluded, emitted values are closed,
and diagnostic failures cannot replace the original exception. The merged UI
also passed its incremental TypeScript check.
The original CI failure remains unproven and requires renewed exact-head gates.

### Workspace formatting and fake-provider consumer synchronization

Greptile reviewed `a756325e0` at **5/5**, covering all 497 files with no open
finding. CI `34260240654` then failed Build and Typecheck on the same import
ordering in the fake provider. Both use
`cargo fmt --manifest-path runner/Cargo.toml --all -- --check`, with the
workspace edition-2021 convention. The earlier standalone formatter check was
not equivalent. Actual Build and release-registry steps were skipped. The
preceding runner Vitest suite passed **1,703 tests / three skipped**, including
the original 1,024-suffix case in **7.823 seconds**; that is a passing repeat,
not causal proof for the earlier CI first-close failure.

Separately, local full staged transport passed **88/88**. The Rust
`codex_provider` target then reported **59 passed / seven failed / one ignored**.
All seven failures exhausted fixed-count positive-completion polls. An empty
poll waits up to one millisecond, so 16/32 iterations assumed a small scheduling
and I/O window rather than waiting for the expected subprocess event. A
diagnostic-only continuation retained the original failing assertions: four
replacement cases observed the exact expected first-turn terminal after a
further **5, 7, 22 and 28 milliseconds**. Durable fake-state persistence exposed
these assumptions. This explains those observed consumer-wait failures, not
the older CI first-close failure.

The narrowly scoped follow-up uses bounded condition waits, preserving or
strengthening exact turn identity assertions. It does not change production
timeouts. A later missing-ID case exposed another fixture scheduling assumption:
production intentionally terminates the provider immediately after a successful
start response omits its identity. Completion emitted after that response can
legitimately be interrupted. That tuple now uses the existing pre-response
completion switch and keeps the omitted-start signal and every synthesized
start, exact turn-2 completion and exit-authority assertion. This proves retained
buffered evidence, not execution after termination. Separate fail-closed
missing-ID tests remain unchanged.

The next debug target had **65 passed / one failed / one ignored**. Its sole
failure was a recovered active turn's interrupt: another 16-poll positive
terminal wait. The existing 50-millisecond interrupt-delay switch reproduced
that assertion failure deterministically; a diagnostic continuation observed
the exact interrupted turn **65 milliseconds later**, with valid settled state.
The final fixture retains that asynchronous delay and uses the existing bounded
poll-and-ack helper, additionally asserting the exact interrupted turn identity.
The focused case passed. This brings the repair to eight positive waits; no
negative absence, receipt-limit, replay-retention or production deadline is
relaxed. The final full debug Codex target passed **66 tests / one ignored**
in **88.40 seconds**. The ignored test is its existing subprocess helper, not
a skipped qualification case. Workspace formatting now passes the exact CI
command. The adjacent debug native-backend target passed **10/10**. The exact
CI release-workspace command then passed **480 tests / zero failed / one
ignored** across 26 top-level test summaries (nested subprocess output is not
double-counted). This includes all 66 Codex cases and seven fake-provider unit
tests. The signed/staged runner hash remains unchanged. Fixture checkpoint:
`9668530e1`. The earlier failed invocations remain failed; these are separate
post-repair results.

### Run-dispatch master integration

The next master update, `f65991a5f`, includes managed GitHub sandbox PATH
preservation and extraction of scheduled retries and queued-run dispatch into
a shared module. The merge retains chat attachment omissions, exact coalesced
wake identity, current-principal validation and native ownership guards.
Cancelled interaction continuations move into the new shared classifier rather
than leaving a divergent private copy in heartbeat. Two new classifier cases
failed before this resolution; the resulting classifier file passed **16/16**.

The initial merged server typecheck also caught a missing `contextSnapshot`
bridge for run-status events. The module now carries only nullable
`contextSource` from the committed run row. The heartbeat bridge reconstructs
only that safe field; it does not reload a later row or expose the private wake
payload. Eight PostgreSQL regression cases cover chat/native sources and
absent, null, blank or malformed values. The full new adapter target passed
**19/19**, including existing lock and compare-and-swap assertions.

The pure merge cohort passed **298/298**, status/coalescing consumers **12/12**,
and module-boundary tests **3/3**. The actual module-boundary check and server /
adapter-utils no-emit TypeScript checks pass. PostgreSQL capacity had changed
from the prior exhausted host: root observed 29 of 32 segments. The new DB
target used normal harness setup and cleanup, without changing global settings
or stopping unrelated databases. Three subsequent database files ran one at a
time: retry scheduling **28/28**, stale-queue invalidation **22/22** and
task-drain admission release **2/2**, all with zero skips and normal cleanup.
They retain injected-write rollback, revalidation, adapter-handoff lock release
and deferred-wake admission checks. No startup failure or retry occurred.

The upstream dispatch transaction deliberately releases its validation locks
at adapter handoff, before the provider process starts. This preserves the new
module contract and avoids run-log self-deadlock; it does not promise that every
later permission change prevents provider startup. Tool and external-publication
authorization remain separate current checks. Independent review found no
additional lost guard.

The combined review is **500 files**. Only the superseded v3/v4 design notes
were removed from the working tree; their exact contents are linked from
`wireframes-archive.md` at checkpoint `9668530e1`. Current designs, generator
inputs and all live qualification evidence remain present.

### Merged deployment and real in-flight queue

Code head `ea8e45e17` received exact-head Greptile **5/5**, explicitly
**500 files reviewed / zero comments**, with no unresolved thread. Full
workspace typecheck and build passed. Normal build staging changed the runner
inode but preserved its signed bytes and SHA-256. CI `34262337249` was still
running without failures when this record was written; inspect the PR for its
final result rather than inferring success from these local checks.

Root verified zero active/queued runs, stopped server 50 normally, and started
server 51 from the clean merged head at **18:20:56.016 UTC**. The five-second
HTTP drain expired on remaining connections; provider shutdown completed and
the old listener closed before restart. The Board remains private and the
verified webhook proxy is unchanged. A Board reload showed the expected active
catalog, without an error banner or sign-in redirect.

One `DISPATCH-MERGE-0908` continuation was sent through each signed-in provider
UI. Slack, GitHub and Telegram returned exactly `DISPATCH-MERGE-READY` in
**16.188 / 17.441 / 14.776 seconds**; native Luna execution used
**13.622 / 12.898 / 11.510 seconds**. All used Paperclip Runner with Codex
app-server, one current wake comment, one succeeded run and one accepted
native result. Each retained its existing task/current conversation generation
and used one provider message for working→final, with one attempt per update.
There were no new attachments or work products. Scoped delivery, action, wake,
run, result, publication and 156-event checks found no matched credential or
signed-URL leakage; this is not a full independent shell-command audit.
Root inspected the rendered Slack/GitHub result and Board, and verified the
Telegram reply through its visible accessibility text. No fresh broad Telegram
screenshot was taken because its unrelated chat list was outside this check.
Only sampled transitions were inspected; this is not an exhaustive flicker test.

The first Slack follow-up pair, `QUEUE-MERGE-0908`, produced correct ordered
replies but did **not** exercise queuing: B's webhook reached Paperclip
**1.073 seconds after A finished**. It remains sequential-continuation proof.
The next pair, `QUEUE-INFLIGHT-0908`, submitted B immediately after the current
working indicator appeared: A at **18:26:29.050**, B at **18:26:31.781 UTC**.
B ingress preceded A completion by **9.159 seconds**. Its immutable receipt
recorded `deferred_issue_execution` with no run ID; its durable wake waited
**8.424 seconds**, then was claimed **39 milliseconds after A finished**.

A's run `4bf615a1-7977-4792-8491-681e874c6d4e` completed with exactly
`QUEUE-INFLIGHT-FIRST`; B's run `a6b2b7fe-a0a7-458c-a39f-1eea93a1f7c4`
completed with exactly `QUEUE-INFLIGHT-SECOND`. Both current-wake arrays
contained only their own source comment; accepted results and final replies
were ordered, with zero same-task run overlap. A finished delivery in
**12.763 seconds**. B received `Your follow-up is queued.` in **2.642 seconds**
and its final in **24.259 seconds**, including queue time. B's queued, working
and final publications all updated provider message `1788891994.388049`;
A used `1788891991.492959`. All five updates used one attempt: two bot reply
identities, not five posts. No files or work products were created.

Root saw the working and ordered final states, with the working indicator
cleared and no duplicate result or error. The brief queue notice was verified
in delivery records, not caught in the sampled screenshots. The final flow was
clear and usable: each request had its own answer and no recovery intervention
was needed. This proves the particular same-thread in-flight sequence, not
every provider, ownership-takeover or permission-revocation permutation.

## Automatic recovery of a missed GitHub callback

The later natural failure was a real user comment whose original attempt and
one operator-requested redelivery both received an empty 502 before the local
qualification proxy. Successful neighboring queue tests did not fix that
missing input. GitHub does not automatically retry these failed callbacks.
The new worker requests genuine App webhook redelivery; it does not forge a
signed request from delivery-history JSON.

Recovery is bounded to the current endpoint/runtime/credential/callback epoch,
one hour of history, three pages of 100 attempts, five detail inspections per
scan and three requests per GUID. Missing state starts at the current time.
Reconnect establishes its new floor without inheriting an old epoch's backoff.
The worker checks the installation, enabled repository, unchanged current
human comment and exact source tuple. Existing local receipts suppress remote
requests, including filtered and terminal records. A persisted denial/attempt
ledger precedes transport; uncertainty does not justify another request without
a distinct newly failed provider attempt. Delayed callbacks cannot reset local
retry budgets or move across runtime epochs. The worker runs independently of
other providers' inbound retry scans and joins normal shutdown.

### Real browser failure and recovery

Server 52 loaded the source at **19:11:40.934 UTC** after the previous server
drained with zero active/queued runs. Startup completed at **19:11:45.064**.
The signed native runner retained SHA-256
`e758b7cdb6ba7c9f176d89cbd17b98dc4c42975326012582d6a7cdf230fb0373`.
The recovery floor initialized at **19:11:42.322**. No older lost input was
adopted or repaired manually.

Root used the existing signed-in GitHub PR conversation to submit
`GH-AUTO-RECOVERY-0908` at **19:12:08.074**. An explicit ignored proxy fixture
failed only the next `issue_comment` on this exact QA endpoint, once, with a
two-minute expiry. The callback received **503 at 19:12:10.912**, before any
upstream forwarding; an immediate scoped query found no new inbox row.
The fixture's nine tests cover exact route/event scope, single consumption,
expiry, unchanged HTTP parsing/routing and closed diagnostic fields. It is
not production fault-injection code.

The normal background worker requested redelivery at **19:12:44.032** for
lossless original attempt `3841622183075921920`, GUID
`30986830-abb9-11f1-8fe9-cb257831704b`. GitHub's genuine signed callback reached
the proxy at **19:12:44.614** and received **202 in 125.004 milliseconds**.
The durable worker processed it once. One exact-comment wake started native
run `df20e1e9-86a9-4095-82db-eaee0b167a10` at **19:12:47.515**, on the existing
task key `CHA-9`, using Codex app-server and **`gpt-5.6-luna`**. The run completed
at **19:13:06.770**: **19.255 seconds** of native execution.

GitHub displayed one eyes reaction and one bot reply, `5590453600`. Root
visually observed **Maya E2E is working…**, then the same reply edited to
exactly **GH-RECOVERED-AUTOMATICALLY**. Its working and final publications
each used one attempt; final delivery completed at **19:13:07.462**. End to
end was **59.388 seconds**, including waiting for the recovery scan. The
original browser comment was `5590445656`; it was not resent or edited.
Subsequent scans retained one recovery request, one admitted wake and one run.
No operator redelivery, fabricated receipt or direct database repair was used.
The proxy was restarted without fault injection and a public Board health
request remained **404**. Existing local Board access stayed available.

Functionally, this specific lost-callback journey succeeded. It remains slower
than normal chat, since Paperclip cannot acknowledge an input it never received.
The intermittent upstream/Funnel 502 cause remains unproven. Automatic recovery
does not retroactively restore message order after later requests have run,
recover edited/deleted/lifecycle events, or scan unbounded high-volume history.

The hands-on check also found a misleading Activity row: it still said
**redelivery requested / pending** after authenticated receipt. A correlated
query's unqualified fields bound to its inner table instead of the recovery
row. An explicit alias join now keys receipt status by company, endpoint,
kind and GUID. The PostgreSQL regression went red to green; a processed
same-GUID receipt on another endpoint cannot mark this one received. Server 53
loaded the final source at **19:22:49.015 UTC**, became ready at
**19:22:54.389**, and retained the signed runner bytes. Root reopened Activity
after restart, scrolled to the recovery row and visually confirmed **received**
with the receipt-only explanation. The original row and recovery count persisted;
the screen no longer suggests an unanswered redelivery after confirmed receipt.

A normal GitHub continuation then checked all final source on server 53.
Root submitted `GH-RECOVERY-FINAL-CHECK-0908` at **19:23:27.406 UTC**, creating
comment `5590582825`. The exact-comment wake started run
`bd88474f-52be-4281-aa77-fcc394e559d9` at **19:23:31.421**, using the native
runner, Codex app-server and `gpt-5.6-luna` on the existing task. It completed
at **19:23:49.899**, after **18.478 seconds**. Working and final publications
each used one attempt and the same bot message, `5590584027`. The exact final
`GH-FINAL-CHECK-READY` was published at **19:23:50.786**: **23.380 seconds**
from browser submission. Root inspected the rendered answer. This ordinary
successful input does not need the recovery scan or a manual retry.

Final review also reproduced a staged-ingress race with the original webhook
secret unchanged. Pausing/resuming during a worker barrier previously admitted
old content through a newer runtime. The worker now carries its captured epoch
through both leased credential preflights and compares it with the selected SDK
runtime before dispatch. Existing callback transactions fence any later pause.
Explicit supersession cancels/redacts the receipt without mislabeling a legitimate
lifecycle event that itself changes generation. A cancelled minimal recovery
tombstone also stops immediately, before reading missing source metadata or
making network calls. Both real-PostgreSQL cases went red to green: zero SDK
dispatch, normalized work or wake for the stale generation; zero HTTP or retries
for the cancelled tombstone. Independent review found no remaining blocker in
this scoped change.

### Retry refusal is not successful failed-request recovery

The immutable wake audit corrected the historical Telegram Try again
attribution above. Generic manual retry lacked the exact failed comment/task
lineage and resumed an older session. A heartbeat admission guard now rejects
that unsupported chat path before writes, including retired conversation
bindings and forged caller context. Its real-heartbeat regression went red
to green and the four-file cohort passed **304/304**.

A separate generic recovery-action restore route committed task/action changes
before its best-effort wake, also without exact failed-request lineage. Five
route regressions first reproduced misleading success and mutations. A new
company-scoped guard rejects only unsupported chat `restored` → `todo` inside
the locked transaction, before task update or recovery resolution. The changed
route suite and adjacent recovery/comment routes passed **153/153**, with
ordinary non-chat hand-back and `done` / `in_review` resolutions preserved.
Positive exact-request retry and actual recovery of the damaged historical
session remain unqualified; the safe outcome here is an actionable refusal.

Root revisited the historical Telegram task through Board Tasks and clicked
its normal **Try again** at **19:18:47.586 UTC** on server 52. The UI reported
**Run retry failed** with the exact-current-request/access explanation and
directed the user to resend in the current connected conversation. No new
wake was created; the run count stayed **34**, status stayed `in_review`,
execution ownership stayed empty and the task's update timestamp was unchanged.
No native completion approval or other recovery action was selected. The
refusal text was captured through accessibility state; the later screenshot
shows the unchanged task after the toast expired. The guard prevents the
previous misleading rerun; a convenient exact-request retry is still missing.

The helper/coordinator cohort passed **97/97**, the independent combined
helper/coordinator/Activity/API/OpenAPI cohort **127/127**, and the full chat
integration file **421/421** on fresh PostgreSQL after all fixes. The latter uses mocked
provider HTTP and the existing durable wake stub; it does not substitute for
the real browser/native run above. Workspace typecheck and build passed, as
did the final server typecheck/build. The deterministic five-provider UI and
file-send browser suite passed **10/10**. Existing CI/Greptile green at
`5988fb475` precedes this slice;
new exact-head gates and required CODEOWNER approval remain necessary.

## Agent-onboarding master compatibility

After committing the recovery slice as `e72a50480`, origin/master advanced to
`ebaeba40e` (PR #13011). The merge preserves both complete HTTP credential
redaction tests. The new single AgentDetail flow and contextual sidebar retain
the default-off chat flag, loaded-state redirect checks and channel filtering,
alongside upstream label overrides. GitHub tools still bypass the chat/tool
choice when the experiment is disabled. The onboarding wizard continues to
create an agent; it does not retarget immutable chat endpoints.

Merged verification passed **110/110** server/adapter compatibility cases,
**421/421** chat integration cases on a new PostgreSQL database and **310/310**
focused UI cases. Plain server/UI typechecks and all token gates passed.
Workspace typecheck initially found a missing `channels` entry in the new
Storybook prototype's exhaustive description record. Adding that entry fixes
the consumer without weakening the production type. The superseded v2 design
note is archived with an exact Git link, keeping this one PR at **500 files**;
current design, production code and test coverage are retained.

Full merged workspace typecheck and build passed. Root reloaded the live Board
after a transient `useCompany` error during merge editing; the normal reload
restored Activity, agent overview and Channels. The overview identifies
Paperclip Runner and `gpt-5.6-luna`. The new upstream section heading duplicated
the Channels panel's own heading. A browser regression reproduced **two**
headings where one was expected. The parent now leaves this title to its
existing panel. Root inspected before/after screenshots and verified one
heading with all four active provider identities and their connection links.

The original merged deterministic suite passed **10/10**. Two new agent-route
checks cover the experiment off/on: disabled routes return to overview without
loading endpoints or showing Channels navigation; enabled routes show exactly
one title and the connect action. The first extra run failed during embedded
PostgreSQL initialization, before tests, with the host at 32 shared-memory
segments. Root used a new database on the already isolated test PostgreSQL,
without altering other clusters or global settings. The enabled heading case
then went red to green. Final full browser verification passed **12/12** in
2.2 minutes on another fresh database. Final UI typecheck/build and token gates
also passed. These browser fixtures mock provider HTTP; the live observations
above use the existing signed-in Board and provider tabs.

## Discord connecting-socket retirement

A clean restart at merged head `c52e98c9b` exposed a real process crash:
`Opening handshake has timed out`, emitted without a WebSocket error handler.
The pinned `@discordjs/ws` destroy path removed its error handler but only
closed OPEN sockets. A CONNECTING socket could remain alive until its handshake
timer fired. Adapter shutdown also raced asynchronous login and did not await
client destruction. This is a production defect, not a test-harness failure.

The pinned library patch now invalidates asynchronous connection work, closes
or terminates its socket, and retains the error handler until close completes.
The adapter waits for destruction and ignores late ready/failure notifications
after retirement. Independent review reproduced two adjacent races: a packet
resuming after asynchronous decode, and the real Discord client resuming its
outer gateway lookup after destruction. Both have regression tests and are
fenced by the repair. Genuine timeout recovery remains enabled; no global
uncaught-exception handler or weakened delivery guard hides failures.

The first four lifecycle cases reproduced the failure, including a child
process using the actual pinned library and a real local TCP socket. The final
agent cohort passed **84/84**. Root's independent Discord adapter, transport and
publication-error cohort passed **88/88**, with no skips. These include positive
Hello-timeout and handshake-error recovery controls, plus retirement during
recovery. Independent review found no further blocker in this scoped repair.

Frozen offline installation passed with zero downloads. Package/workspace patch
configuration agrees. The locally generated lockfile records previously missing
chat SDK dependencies and patch hashes: all 1,435 existing package keys remain,
99 are newly recorded, and no existing importer or transitive dependency version
changed. Full workspace typecheck and build passed. The staged native runner
still passes strict signature verification and has unchanged SHA-256
`e758b7cdb6ba7c9f176d89cbd17b98dc4c42975326012582d6a7cdf230fb0373`.

The superseded v5 surface note remains at an immutable link in
`wireframes-archive.md`; its setup audit and the v6 note/minimum-setup
specification stay in the worktree. This reserves the WebSocket patch within
one 500-file PR without removing current implementation or tests.

### Live post-onboarding compatibility

Before installing the socket repair, server 55 served the clean merged head.
GitHub comment `5590988738` produced exactly one native Codex app-server /
`gpt-5.6-luna` run (`ec9060b7-0cd3-4faa-9823-49fa4851f3a4`) and one working-to-final
bot message `5590989975`. The exact final `GH-ONBOARDING-MERGE-READY` arrived in
**21.209 seconds**, including **15.963 seconds** of native execution. Root
inspected the rendered reply. Telegram likewise returned the exact
`TG-ONBOARDING-MERGE-READY` in **18.039 seconds**, including **15.629 seconds** of
native execution, through one run and one updated provider message
`417200359:148`. Root observed its final text in the provider's accessibility
state. Both retained their current tasks, used one attempt per publication and
required no input resend or recovery. These are compatibility passes, not proof
that the separate Discord restart crash was fixed.

The existing 115-reply Slack thread remained at **Loading replies…** without a
reply composer after normal refresh/reopen attempts. No continuation was sent
there; this is not a Paperclip ingress failure. A fresh root mention in the
same authorized QA channel is the bounded post-patch alternate journey.

Server 56 loaded the frozen patch at **20:13:21.244 UTC**, became ready at
**20:13:26.601**, and connected its real Discord Gateway. Root submitted the
fresh Slack root at **20:13:50.836**. Its exact input `1788898430.940089`
created one task (CHA-28), one wake and one native Codex app-server/Luna run.
Working appeared after **2.666 seconds**; the exact `SLACK-PATCH-READY` final
published after **21.766 seconds**, including **19.926 seconds** of native
execution. Working and final each used one attempt on the same provider message
`1788898433.486579`. The task remained in progress without duplicate work.
Root opened the actual thread and inspected the reply, eyes reaction and usable
continuation composer. The initial mention autocomplete incorrectly labeled the
existing bot as not in the channel; actual mention resolution, ingress and
delivery succeeded without changing membership. The old long-thread stall and
this provider autocomplete inconsistency are not claimed fixed by Paperclip.

The final fresh PostgreSQL integration run passed **421/421**, with no skips,
in **91.49 seconds**. Its database was absent before creation and held zero
companies, endpoints or tasks before the single suite invocation. Two setup
commands failed before any test: a cleanup helper lacked its URL argument, then
an unnecessary ESM import attempt failed resolution. Neither is a product-test
failure or a retry of a populated fixture. Source and dependency patch hashes
were unchanged through the successful suite.

Root also exercised the real Discord connection's Activity controls. **Pause**
at **20:18:30.670 UTC** stopped its old listener, and **Resume** at
**20:18:51.453** started and connected a new listener inside the same server.
The endpoint returned to active without a crash or credential replacement.
This is live bot lifecycle proof, not a new user-to-bot interaction: Discord's
browser user session is logged out. The paused screenshot also exposed a
separate stale **Connected** health label, despite the paused badge and Resume
button. The Activity panel now prioritizes lifecycle state and labels retained
health as **Last reported health**. Active health/errors remain intact; no
controls, provider settings or permissions changed. Eleven new assertions
failed against the old projection; the final focused suite passed **31/31**,
including 15 new cases. UI typecheck and all token gates passed.

Root repeated Pause at **20:21:49.501 UTC**, inspected the corrected rendered
paused sentence and explicitly historical health, then resumed at
**20:21:55.661**. The real listener again stopped and a new listener connected;
the endpoint returned to active. This UI and lifecycle regression passed live.
Root's adjacent Activity/API/contract cohort also passed **49/49**; the final
UI production build passed after the presentation fix.

The post-dependency-change deterministic browser suite passed **12/12**, with
no skips or retries, in **2.3 minutes**. It used another verified-new database
on the isolated PostgreSQL server. The test web server exited and retained no
database session. Coverage includes all five providers, default-off GitHub
tool routing, agent Channels off/on, and file batches across reload and
ambiguous response loss. Provider HTTP is mocked; this does not replace the
live proofs or clear the Discord-login and Teams-tenant gates.

### CI-owned lockfile correction

Commit `55b91bedd` accidentally included the locally generated lockfile used for
packaging verification. The repository's quality gate and trusted PR workflow
correctly reject manual lockfile changes; CI regenerates and uploads its own
copy for all downstream frozen installs. The follow-up restores the committed
lockfile exactly to origin/master while retaining every manifest/patch change
and the already tested installed dependencies. The prior local frozen-install
pass applies to that generated verification copy, not the stale checked-in
lockfile. No existing dependency version was deliberately upgraded.

The freed file slot restores the v6 surface note byte-for-byte from `c52e98c9b`.
Only v5 remains archived for this fix; the combined PR still has 500 files.
The failed quality-policy run is a real failed gate, not a product-test failure
or a green full CI run. New exact-head CI and Greptile review remain required.
Server 57 started clean `55b91bedd` at **20:24:00.769 UTC**, became ready at
**20:24:05.493**, and reconnected the real Discord Gateway. The packaging-only
correction does not change those production bytes.
All five lockfile-policy/workflow tests pass, and the actual staged 500-file
diff passes the repository's lockfile check. Re-running the installed Discord
cohort after restoring the baseline lockfile still passes **88/88**, with no
skips. No install or package rewrite occurred during this correction.

## Source-file lifecycle and queued-media qualification

These live journeys used server 58, started at **20:27:40.584 UTC** and ready
at **20:27:45.773** on September 8. Its server baseline is `63c8b5d8d`; the
subsequent wireframe-only commit changes no runtime bytes. The runner SHA-256
remains `e758b7cdb6ba7c9f176d89cbd17b98dc4c42975326012582d6a7cdf230fb0373`.
Both journeys used Maya E2E, native Paperclip Runner, Codex app-server and
`gpt-5.6-luna`. They do not qualify the uncommitted exact-retry implementation.

### Slack: edited-source reuse is refused without leaking a file

Root uploaded non-sensitive `native-inbound-0907.txt` into the QA thread
`1788898430.940089` as a new disposable reply `1788900766.028899`. Its 103 bytes
have SHA-256 `6dc048b0f5c2f60a9a34eee0fc91ac52e1e4aefcdb1d47c74ffda2ec672a6fea`.
The request asked the agent to record the exact source/attachment pair
privately, without copying or returning the file. Delivery
`733050c6-da38-402e-87e0-1c4a4b2da136` produced one native run
`c0931b16-b66c-42ba-bcf9-349119dd4e22`, which succeeded from **20:52:47.674**
to **20:53:05.219**. The rendered final was **File reference recorded**.

Root edited that source through Slack's own message menu to withdraw reuse.
The exact-target `message_updated` receipt
`846eff86-d39e-4fef-a872-cf098f565bb5` processed at **20:58:25.474**. A new
browser reply `1788901129.212169` requested the exact earlier pair without
substitution, copying, or bypassing denial. Delivery
`3db2dff4-03ca-4f4a-bb11-e2005251cfc7` and wake
`4179949c-5048-4bee-9ccf-416ef4e89664` admitted native run
`16743a8a-a6f4-4cae-bee2-1aaca008fadf`, **20:58:50.632–20:59:08.807**.
Its only current input was comment `af4df257-af6c-4361-9abc-4badc39a71b8`.

The actual `reuse_chat_attachment` call at sequence 34 used original comment
`54a3c07b-2f34-4a8c-8c0e-432b4d1fa751` and attachment
`5040777e-5fa6-424c-9c50-8eb3e8cc1021`. Sequence 35 returned
`paperclip_runner_chat_attachment_source_denied`, `is_error: true`, at
**20:58:58.873**. There was one reuse attempt and zero new attachments, work
products or file publications. The original stored asset remained unchanged.
Working and final each used one attempt on Slack message `1788901131.307639`.
Root inspected the rendered final and usable composer: **The old attachment
is no longer available to reuse.** No internal IDs, error code, download URL
or substitute file appeared in the answer.

Receipt-to-final was **19.421 seconds**, including **18.175 seconds** of native
execution and **0.415 seconds** from run finish to publication. Functional
outcome and the observed refusal experience both passed this edited-source
journey. Source deletion remains separate and untested; editing is not deletion.

### Telegram: genuine queued-media admission, then native shutdown failure

Root sent a cat image through Telegram's **Photo** upload control, requesting
a description of only that current image in approximately 400 words. While A
was active, root sent `native-file-roundtrip-landing-0908.txt` through
**Document**, requesting its object/color/count and the exact original file.
No API or database write manufactured either input or result. Both belong to
CHA-26, conversation `e3ee142e-4f21-41a9-9636-7fb5770094d5`, generation 10.

| Evidence               | Image A                                | Document B                             |
| ---------------------- | -------------------------------------- | -------------------------------------- |
| Delivery               | `78763969-0116-4f4b-9f0b-977824b1244e` | `f8ef6070-61de-4eae-bd86-2cfe7717dcf5` |
| Source comment         | `0e780b80-b455-435b-af37-00a1ddeab6a1` | `17909654-58f9-4348-a5eb-ca8848b33a71` |
| Wake                   | `61580c49-cadd-44ef-891d-e6cd3796e8e4` | `e8b2b68a-93d7-45ec-aea3-12731c91d58a` |
| Run                    | `fd7011b6-323b-461a-bc43-a81835bece5f` | `fcf7adc4-39a5-4c42-8cbb-a9723ad22302` |
| Started → finished UTC | 21:04:24.679 → 21:05:15.515            | 21:05:15.547 → 21:05:15.854            |

Each run has exactly its own current comment. B's durable wake was created at
**21:04:59.772**, **15.743 seconds before A finished**, and B started **32ms**
after A finished: genuine queued admission with no execution overlap. The
visible **Your follow-up is queued** notice was published at **21:05:00.646**,
**2.177 seconds** after receipt. A's first working feedback took **3.605 seconds**.

A imported as Telegram's JPEG, attachment `1dd21c0d-f389-4226-b660-efe24cd9d71c`,
**221,327 bytes**. B imported as `f666b8ec-bd8d-4e8a-a672-b75f53153cb1`,
**152 bytes**, with the exact expected SHA-256
`e5ea1c89ad69c0ae9dffea0599c730e5d284816dbcd9dae44746c7a29f790293`.
Import and admission passed; useful completion did not.

A proposed a semantic result at **21:05:00.164**, accepted it at
**21:05:05.377**, and recorded `run.terminal` succeeded/completed at
**21:05:05.392**. About ten seconds later cleanup failed:
`provider_transport_failed: runner did not durably suspend before checkpoint`.
B then failed immediately with `runner_state_identity_mismatch`. Automatic
`issue.continuation_recovery` run `3fa4a4e7-9137-45cd-b191-c90e7c5dd057` failed
at **21:05:16.358** with `native_session_cleanup_quarantined`. All three refer
to native session `ce94db0c-3aec-40be-8caa-c80d008fcbbb`.

Five publication records, each with one attempt, updated two Telegram messages
(`417200359:150` and `417200359:152`). Both ended with **Maya E2E stopped before
completing this turn. Open the task in Paperclip:** and the correct task URL.
There were zero generated attachments, work products or file publications;
B never executed a file reuse/register action. Its actual file consumption,
returned bytes and output isolation therefore remain unqualified. This is a
**failed live journey**, not a successful media round trip or model timeout.

Root revisited the messages and inspected the linked task. Clicking Telegram's
`target=_blank` link did not expose an observable new in-app tab; explicitly
opening that exact displayed URL loaded the correct Board task. Its screenshot
showed B's queued/delivered timestamps, two failed-run notices and **Try again**
for the failed automatic recovery run. Expanding that notice exposed
`native_session_cleanup_quarantined`, without an actionable session-repair
explanation. Root did not press Try again or change recovery state. The
destination works, but the complete click transition was not verified and the
recovery experience needs improvement.

Preserve the accepted result and quarantined session evidence. A repair must
not rerun accepted A, clear quarantine optimistically, or silently start a new
conversation to turn this failure into a passing test. Shutdown ordering,
exact accepted-result recovery and the queued document still require fixes
and another real browser/native journey.

Subsequent read-only inspection found the background finalizer had committed A
at **21:06:16.107**, without provider replay. Accepted result
`48917917-bd47-4cdf-837d-3d7dd4b80f57` contains the full cat description and an
ordinary `yielded` / `response_wake` continuation. The first status decision
preserved the failed-finalization claim; the later decision
`49347a3d-a7f7-4617-ad58-e937f8dcce4d` preserves the task's newer `in_review`
state. The run became `succeeded`/`committed`, but retained stale
`adapter_failed` metadata. It still had zero authored comments and no final
publication, so the provider continued to show failure. Durable semantic-result
recovery is therefore present; useful response recovery and saved-session
recovery are separate defects, not proof that the journey succeeded.

### Control-first runner repair; recovery still in progress

Read-only inspection retained the exact A authority in quarantine: control
ACK 250, 90 unacknowledged runner deltas (251–340), 128 pending provider
events, and pending `turn.stop` / `runner.suspend` commands. The run loop
started another individually fsynced provider batch before reading those
already queued commands. A deterministic regression reproduced the ordering:
source sequence advanced from 1 to 129 before suspend could be processed.

The runner now reads authenticated control traffic before beginning another
provider batch. Ordinary output is polled only on an idle control read;
autonomous receipt-limit maintenance, event persistence, cumulative ACK debt,
command identity checks and the existing suspension deadline remain intact.
The regression now leaves the retained tail untouched and durably suspends.
This prevents a new output batch from overtaking a queued close; it does not
pretend that the previously quarantined state was safely closed.

Rust library verification passed **234/234**. Normal release build/staging and
strict signature verification passed, producing runner SHA-256
`4d06a271a91eedd4a317a59f097e39c6de5fc924296aafebf9b0d8031b6cc9aa`.
Root's first full transport run was **87/88**: an exact-resume test read its
asynchronous event journal immediately after an authenticated snapshot command.
The production contract already permits that event to follow the snapshot.
The test now waits conditionally, with a three-second bound, for exactly one
durable resume event; all provider identity and command assertions remain.
The final full transport run passed **88/88** in 64.01 seconds, including
48/1,024-delta backlog suspension and active-checkpoint rejection. Workspace
typecheck passed. This is staged-binary/fixture evidence, not a successful
retest of the damaged live Telegram conversation.

### GitHub continuation reveals cross-channel cleanup quarantine

At 21:29 UTC root used the signed-in GitHub browser on the dedicated QA
repository's PR #3. Message `CONTROL-FIRST-0908-A` requested a 500-word seed-swap
plan; a separate `CONTROL-FIRST-0908-B` requested one exact short response.
The first comment was visibly accepted before the second was sent. Both stayed
in the existing PR conversation, CHA-9, issue
`5329b4bf-6b16-40d5-ad69-65bcbeac2ab3`, conversation
`6f313c48-e684-421f-a730-dd68112c1e2c`.

| Evidence               | A                                      | B                                                                |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| GitHub comment         | `5592125256`                           | `5592126853`                                                     |
| Delivery               | `fee9ddbe-9fa1-466a-b049-97b51a3ba568` | `69cb52ff-00e5-45c6-b746-f9df5deae2f4`                           |
| Source comment         | `a0d072be-b9ee-4781-84cb-1d2d054a889a` | `906ecf81-67df-45ab-ba24-395a87e2662c`                           |
| Run                    | `75758d19-9680-4083-a0b6-2d5598d21bae` | `38dfc3ec-4fa7-4ed4-8563-7650dfce3d47`                           |
| Started → finished UTC | 21:29:33.515 → 21:29:33.835            | 21:29:41.069 → 21:29:41.079                                      |
| Failure                | `native_session_cleanup_quarantined`   | `setup_failed`: `reviewed_chat_execution_binding_not_authorized` |

A failed before B was submitted: **no queued execution was exercised**. The
runtime cleanup domain is company plus backend kind/name, so Telegram A's
retained operator-required cleanup also blocks GitHub. This does not establish
a second damaged GitHub checkpoint. B's reviewed execution binding needs a
separate diagnosis. Neither request reached native provider execution; the new
binary's presence alone is not live proof of its control-first repair.

Each input produced one published failure notice in one attempt (GitHub
`5592126063` and `5592127485`), respectively 1.812 and 2.274 seconds after local
receipt. Root read both actual rendered messages: **Maya E2E stopped before
completing this turn. Open the task in Paperclip:** with the correct CHA-9 URL.
There was no plan or requested short answer. The functional outcome failed;
the experience needs improvement because identical generic notices conceal
different setup/recovery causes and provide no usable in-channel recovery.
No repository changes, merge, session reset or quarantine deletion were made.

The shared external milestone copy now recognizes only the typed cleanup
quarantine code. It explains that an earlier session needs admin recovery,
the request is saved, and resending will not repair it. Unknown errors remain
generic, and neither checkpoint/process details nor private error text leave
Paperclip. Two exact-copy regressions failed against the old projection;
the final milestone/task-link/safe-projection cohort passed **43/43**. This
copy change is not deployed or visually retested yet, and it is not the
session recovery implementation itself.

### Exact retry and accepted-answer recovery checkpoint

Board Retry now sends only the selected failed run ID and derives the task,
original admitted comment batch and actor on the server. A separate durable
retry intent deduplicates repeated clicks and lost responses. The original
delivery is not re-armed, deferred work is not silently coalesced, and current
source/access checks repeat at admission, promotion, execution and publication.
Recovery-card resolution and intent creation share one transaction. Every
retry entry point handles an accepted queue receipt without inventing a run ID.
Native ordinary retries require proof of a safely released old owner;
integrity, quarantine, uncertain delivery and unsupported lineage stay closed.

Accepted native `yielded` / `response_wake` answers now have a separate
presentation recovery path. It verifies the committed result and its canonical
digest, exact source batch and current conversation authority, then creates the
comment, publication and selection marker atomically. It updates an existing
same-run failure notice, never resurrects a selected/deleted response, never
reruns provider work and does not erase quarantine or alter later review state.
Source and access revocation are checked again before provider dispatch.

The live GitHub B investigation also found a genuine invokability mismatch:
pre-start reviewed-chat attestation rejected `agents.status = error`, even
though canonical invocation permits recovery from that status. The helper now
uses the canonical policy while preserving exact owner/source, identity and
approval checks. Direct and answered-question positives were red before the
fix; paused, terminated and pending-approval agents still fail authorization.
The full external-chat-wait suite passed **142/142**. Its first full run also
caught an unrelated 20-bit random fixture-prefix collision; prefixes now derive
injectively from each company UUID, without changing production behavior.

Wider finalizer testing caught and fixed two regressions during this work.
Already-materialized clean successful runs must not acquire a new timestamp on
every sweep. When recovering stale failure metadata, diagnostics must come from
the current locked row, not a pre-lock snapshot. Both absent-to-new and
old-to-new concurrent error interleavings failed before the latter fix. Final
native finalizer/recovery/telemetry coverage passed **31/31**, including no
duplicate telemetry, no unnecessary writes and retained ownership guards.

Root's fresh full chat integration runs passed **498/498** twice; the second
includes the no-rewrite repair and precedes only the separately tested
current-row diagnostic refinement. Root then reran all 23 accepted-response
cases on another fresh database after that last refinement: **23/23** passed,
with 475 unrelated tests intentionally filtered. The exact route/API/UI contract cohort
passed **195/195** on an unchanged rerun after one unexplained socket hang-up.
The real throwaway-browser suite passed **21/21**, with zero retries or skips,
using mocked provider HTTP, not live provider accounts. Shared/server/UI
typechecks, normal runner build/contract checks and UI token gates passed.

These tests qualify the implementation boundaries, not the failed live
Telegram/GitHub journeys. The accepted Telegram answer has not yet been
delivered through the new recovery path. Its old session must be settled using
the separate exact-authority maintenance operation before retrying the original
queued document or GitHub B. No live quarantine or source data was rewritten to
produce a passing fixture result.

### Pre-provider retry and bounded cleanup discovery

Read-only revalidation proved Telegram A's accepted canonical digest and server
fingerprint against its actual authenticated control-plane source. Its original
photo/source and conversation generation remain current, with no selected
answer, owned interaction, source invalidation or uncertain publication. Only
the earlier progress/failure message exists. This is eligibility evidence, not
proof that the user received the answer; presentation repair has not run live.

The saved GitHub B failure happens before runtime resolution, but the original
retry allowlist rejected every `setup_failed` run. A positive regression
reproduced that refusal. The narrow repair recognizes only the exact reviewed
attestation diagnostic, its sole unauthenticated system-error row, and absence
of native/provider/process/output/result evidence. It preserves the original
source, current authorization and idempotency checks. A later provider event
invalidates an already-staged retry before any wake or receipt is created.
The final focused cohort passed **28/28**; broader verification follows below.

Two fresh full runs were not clean: first **512/513**, with the existing locked
progress issue fixture exceeding its one-second observation deadline; both
lock variants passed unchanged in isolation. The second run was **511/513**,
with that lock fixture passing but two different failures. Its log directly
shows a previous Discord Gateway renewal consuming the database transaction
failure intended for Slack's durable ingress. The subsequent failed assertion
skipped spy restoration and caused recursion in a later `/close` test. The
fault must target the intended delivery insert, and spy cleanup must execute
even when assertions fail. This is active fixture-isolation work, not evidence
of a production fix or a passed full suite. The positive GitHub retry slice is
checkpointed independently; do not relabel either failed full run as passed.

Telegram B remains a separate recovery case: an observed native coordinator
with zero attempts must not be disguised as an exhausted failure. Its retry
needs authenticated settlement of the exact inherited old session, plus proof
that B itself never started provider work. That positive path is unfinished.

Automatic cleanup discovery is joined per database, defaults to one candidate
per sweep, and advances a keyset cursor past refusals rather than repeatedly
blocking behind the first damaged checkpoint. It selects only exact committed
accepted results with the retained close diagnostic, skips any prior maintenance
attempt, and leaves lease/physical authority to the separate cleanup operation.
Startup and periodic recovery schedule this as independent tracked work, so
unrelated ingress is not held behind maintenance and shutdown still waits for
the actual operation. Discovery does not create a wake or rewrite a task/run.
The existing finalization/discovery test file passed **18/18**; its first run
passed all assertions but failed the new fixture's incorrect teardown method,
which was corrected. Physical maintenance and the live journey are not yet
qualified, and server 58 has not been restarted.

Two real heartbeat lifecycle fixture cases additionally prove that startup and
orphan reaping share one pending physical cleanup, unrelated orphan recovery
can finish, and shutdown waits for either cleanup success or rejection without
creating a provider execution, run or wake. Only the physical cleanup boundary
is deferred; accepted-result/finalizer/discovery/startup/reap/drain paths are
real. The adjacent cohort passed **11/11** and plain server typecheck passed.

The signed-in-browser recheck also confirmed Eigenjoy currently shows “Please
log in again” in Discord. No new Discord message or account switch was made.
GitHub's recently released CLI media upload was checked as a potential native
file-delivery improvement, but its official implementation explicitly accepts
OAuth/PAT credentials, not App installation tokens. It is not a supported
substitute for the bot's existing authenticated Paperclip download links:
[GitHub CLI upload implementation](https://github.com/cli/cli/blob/v2.99.0/internal/attachments/client.go).

### Already-ended provider shutdown and recovery qualification

The retained-session fixture exposed a second shutdown bug: restoring the old
Codex thread can discover that its turn already ended, but the restored
provider process still exists. `turn.stop` formerly returned `already_settled`
without stopping that process or durably preparing its checkpoint. It now
requires the same exact-generation exit proof even for an already-ended turn;
an unprepared or permanently closed executor remains a no-op and is not revived.
Active and already-ended resume tests preserve the original thread, leave the
queued event suffix intact, and prove no extra `turn/start` across drain/restart.

The complete Rust provider target passed **69/69**, with one existing deliberate
subprocess helper ignored (145.89 seconds). Earlier full attempts exposed three
pre-existing finite-immediate-poll fixture races; they passed unchanged in
isolation. Positive event waits are now deadline-bounded and yield to the fake
provider, preserving question/schema/choice, run/operation, terminal and
failed-late-result assertions. This changes no production timeout or latency
budget. The composed retained 218-event fixture also passed **2/2**, covering
both active and already-ended old turns with no new provider turn. Root's
executor/discovery cohort passed **205/205**; shared/server/UI typechecks passed.

The ingress fixture now injects its failure only into the transaction holding
the exact target delivery, explicitly exercises an unrelated competing
transaction, and restores the spy in `finally`. Its post-ack processing wait
uses a bounded five-second condition check rather than assuming completion is
observable within one second; one previous observation missed a receipt that
completed once in 985.874ms. The final ingress plus three `/close` cases passed
**4/4**. No production admission/dedupe assertion was weakened. A fresh complete
chat integration run is still required.

The server maintenance slice is not yet deployed: review identified a
crash-after-commit activation-marker retry edge and late database callbacks
that need explicit shutdown ownership after a bounded attempt expires. Both
are being repaired with regressions before the live server is restarted.
Live Telegram still shows the original A/B failure messages. Root opened B's
exact run through the task UI and verified the Retry control without invoking
it. The photo answer has not been redelivered, and the original queued file
request has not been retried; these fixture results are not live success.

### Frozen maintenance slice before live deployment

The two final integration edges are repaired. Exact failed-request retry can
recognize an intact activation marker only against the locked committed
receipt, matching run/session/thread and both digests; normal executor admission
owns its eventual removal. Older successful warm runs that share a PID do not
displace the actual cleanup owner. A released local pre-provider environment
lease is allowed only without provider ownership or pending cleanup. The
original failed run remains observed at attempt zero, with no rewritten history.
The focused native retry cohort passed **26/26**, including 13 new cases.

Maintenance timeout no longer loses shutdown ownership of an already-started
database operation. The tracked sweep joins the original retained callbacks in
`finally`; timeout still revokes authority and cannot produce a cleanup proof.
The real abort/deadline canary passed, the broader lifecycle cohort passed
**12/12**, and its final strengthened success/rejection/late-callback cases
passed **3/3**. Root's final normal staged transport suite passed **91/91**.

Root's first combined run was **524/525**, again at the held-lock fixture's
one-second observation. The row remains locked until the observation succeeds,
so allowing a bounded five-second condition proves the same nonblocking
behavior without imposing a one-second SLA on accumulated fixture history.
The final fresh database run passed **526/526** (148.87s). The deterministic
browser suite passed **21/21** with no retries/skips and mocked provider HTTP,
not live accounts. Normal runner TypeScript build and final server typecheck
passed. The release runner is staged and strict-signature verified with SHA-256
`3cb217996132fa0cbbb3fa169dacd4250e3318840ed15f3fa3d2961536f34ce9`.

The Rust repair is pushed as `4bc52cdbe`; the maintenance slice is being
checkpointed separately. Live revalidation still shows zero running/queued
runs and intact original Telegram/GitHub requests. Telegram A's accepted
digest and server fingerprint recompute correctly, but its answer is still
not presented. No live retry or manual checkpoint mutation has occurred yet.

### Server 59: recovered Telegram answer delivered, cleanup still incomplete

Maintenance checkpoint `b4b6f5777` was pushed and deployed using the normal
server entry point and the signed release runner above. Server 58 was confirmed
idle, received SIGTERM, drained heartbeat work with zero interrupted runs, and
exited before server 59 began at 22:19:25 UTC. No quarantined state was deleted
or rewritten to enable the restart.

The original accepted photo run `fd7011b6-323b-461a-bc43-a81835bece5f` now has
one selected comment (`b8148abf-e4c7-44a5-a467-aadb1c50da96`) based on the same
accepted result `48917917-bd47-4cdf-837d-3d7dd4b80f57`. Its two publications
`cd176eb6-96ce-4caf-bd27-99ba64ffffe7` and
`e882d349-68d8-4e2e-81f1-8efe48bad7e7` delivered Telegram messages 153 and 154
at 22:19:29.382 and 22:19:31.328 UTC, with one attempt each. Root read the actual
messages in Telegram and visually inspected the rendered answer. The run is
succeeded/committed with its old error preserved privately. Read-only database
revalidation found zero new heartbeat runs since deployment. This proves saved
answer presentation without another model turn, not successful physical cleanup.

The experience still needs work: old failure message 150 remained beside the
new answer. The consumed-progress-lane rule currently prevents replacing that
same-run failure. A regression must include the actual outbound message link;
the earlier fixture omitted it. Any exception must revalidate the exact selected
committed response and current source/access/epoch, and must not replay an
already-delivered response or edit another run's notice.

Automatic physical cleanup remains ineligible. A historical generic continuation
left a completely empty canonical root; the original quarantined files remain
intact. The proposed repair must verify and preserve that exact empty directory,
never replace nonempty or changed state. Inspection also found that the database
contains the normalized driver identity, not the raw wire identity expected by
the current predicate. A production-shaped proof and separate maintenance event
namespace are required before deployment, so cleanup events cannot collide with
the original driver's sequence stream.

The original Telegram document request remains failed/observed at attempt zero,
without a result; the original GitHub request remains failed before native
startup. Neither has been retried. The subsequent browser entry-point call
reported that the Mac is locked. Browser qualification is paused on that real
environment gate while the bounded fixes and automated tests continue.

### Telegram whole-message sizing

Inspecting the two delivered parts found lengths 1,223 and 762, reconstructing
the 1,985-character selected comment. The fixed 1,600-code-point threshold was
unnecessarily splitting a response that fits in one message. The
[Telegram message contract](https://core.telegram.org/bots/api#sendmessage)
permits 4,096 characters after entity parsing; the pinned adapter additionally
truncates its serialized MarkdownV2/plain fallback at 4,096 UTF-16 units.

Whole-message admission now measures both actual adapter renderings, including
emoji placeholder conversion. A medium answer or code block that fits stays
native and intact. Larger plain text retains the established durable FIFO
parts; larger structured Markdown still becomes one lossless document instead
of being cut across syntax boundaries. This does not re-arm previously sent
parts or rewrite the historical live messages.

Four regression cases failed before the fix: medium prose, medium code, exact
escaped punctuation and exact astral-Unicode ceilings. The final helper and
real pinned-adapter cohort passed **73/73**, including actual regular-message
fallback request bodies at the boundary. Fresh-database medium prose/code and
oversized FIFO/document cases passed **4/4**. The first focused integration
attempt passed 3/4; its prose fixture expected trailing whitespace which safe
publication intentionally trims. The corrected fixture ends in a final word;
the exact content assertion remains. Provider HTTP is mocked in these suites;
live sizing/recovery retests remain outstanding while the Mac is locked.

Independent review found one additional branch: unused Markdown reference
definitions can disappear from both ordinary renderings while still exceeding
the pinned rich-message source limit and truncating a meaningful trailing
paragraph. A new red-to-green test guards the emoji-converted rich source's
32,768-code-point ceiling too. Final helper/adapter coverage is **74/74**.
A read-only check against the exact original live comment now returns one
lossless native part; no provider request was made by that diagnostic.

The recovered-answer replacement regression passed **54/54** on a fresh
database. It now uses the exact current outbound failure link, selected
committed-response marker and full retained-source authorization. Another run's
failure, authored output, forged marker, changed source/principal/generation,
and unresolved same-run output do not qualify. Selection was moved under the
existing endpoint publication lease: a real competing-link fixture holds that
lease while a worker waits, changes ownership, and proves the worker does not
edit the former owner's message when it acquires the lane. No historical live
publication was re-armed or edited to test this.

The frozen combined chat UX slice passed the complete fresh integration suite
**536/536** (129.18s), the focused setup/webhook/interaction surfaces **136/136**,
and server typecheck. The first deterministic browser run had **16 passes, one
failure and four not run**: Slack's initial catalog page remained blank and
the Connectors heading timed out after 30 seconds, before any provider setup.
Root inspected the blank screenshot. This run retained no trace, so the cause
is not established. A fresh diagnostic run enables tracing without changing
timeouts, assertions or retries; its result must be recorded separately.

The diagnostic browser run passed **21/21** (3.6 minutes), with tracing enabled,
no retries and no skips, on another fresh database. All five mocked-provider
setup flows and the Board delivery/exact retry cases completed. The original
blank navigation was not reproduced; its cause remains unverified. The chat
UX fix is pushed as `93d958946`, but live server 59 remains on the prior
maintenance checkpoint until the physical-cleanup and deletion fixes are ready.

The parallel Slack review then reproduced a separate authorization defect for
both PNG and text attachments: after admission, disable the resource, receive
its verified deletion, re-enable, then invoke native `reuse_chat_attachment`.
Both calls incorrectly succeeded. A content-free, exact-source processed
deletion tombstone is being added so known deletion survives re-enable without
allowing disabled reach to fetch content, add comments, react or wake an agent.
This is deterministic real-service evidence, not a new live Slack deletion test.

### Cleanup and source-revocation deployment candidate

The normalized/raw journal binding and exact-empty-directory activation repair
passed **200/200** executor tests and **36/36** resume tests, plus server
typecheck and independent review. A real staged runner/driver/database fixture
proves that maintenance receipts use a separate source namespace, remain
idempotent, reject conflicting evidence, and do not emit chat progress. The
original raw journal is retained. The production-shaped read-only check against
the original Telegram run passes with all three relevant database rows; a
shortened diagnostic omitted the two control-plane rows needed for its accepted
result digest. No predicate was loosened to accommodate that diagnostic.

The disabled-reach deletion cohort passed **13/13**, including native PNG/text
read and reuse, exact retry rejection, no provider/storage side effects, runtime
fencing, and provider-time ordering. The complete fresh suite was **541/542**:
the ownership-attention test expected one globally queued milestone and got
four. Inspection identified the exact three new fixtures left eligible by the
deletion tests. The fix must retire those fixture conversations after their
assertions, keeping the original one-message expectation intact. Full fresh
verification is still required before deployment.

Live preflight still finds no running or queued runs, no maintenance events,
the same accepted result for Telegram A, and the untouched failed B requests.
All three original quarantine hashes remain unchanged; original runner/provider
PIDs and groups are absent. The canonical directory remains the same empty,
non-symlink inode. Server 59 still serves the earlier checkpoint. Browser entry
continues to report the Mac locked, so there is no new live UI result yet.

The fixture-only correction reproduced the exact `expected 1, got 4` failure
before passing the joint **7/7** cohort. Only the new fixture conversations are
retired after assertions; their run/audit records and the existing ownership
expectation are unchanged. The final complete fresh-database integration suite
passed **542/542**, and server typecheck passed again. This clears the scoped
deployment gate, not the still-missing original-request browser retests.

### Server 60: admitted maintenance exposed a missing launch environment

Checkpoint `9ef354692` was pushed and deployed on the normal server entry point.
Server 59 drained with zero interrupted runs and exited before server 60
(PID 11488) completed startup at 22:52:40 UTC. The staged runner digest and
strict code signature remain unchanged from the verified release artifact.

The original Telegram cleanup was admitted at 22:52:39.684 UTC under request
`native-cleanup:8065a025-239b-4f83-8589-57d58e75819e`. It persisted 91
content-free receipts—90 retained events and `runner.reconciled` sequence 341—
then ended `operator_required`, not settled. Its preserved staging copy is
`1c080549b2c4f48602d28768e62c56bbc50d48c4479e8abd8fc054a498f4b391.cleanup-A2FMbq`.
The pending stop/suspend commands failed with supervised `codex` spawn `ENOENT`.
The maintenance caller omitted the host launch environment that normal native
execution supplies, so the sanitized child had neither `PATH` nor source login
home. This is an implementation defect, not a user login request.

No provider identity or generation advance occurred; the copied provider file
is byte-identical to the original, with generation 21 and 128 pending events.
The copied runner is suspended with no outbox entries. The canonical directory
is still empty; all three original quarantine hashes remain unchanged. Database
inspection shows zero new heartbeat runs and unchanged original failed B
requests. Recovery must preserve the attempted copy and its failed commands,
prove its exact no-launch history, and continue from it rather than replaying
the older original snapshot. The browser remains locked, so no new UI retry or
live message-success claim is made.

### Slack file-only changes and disabled-reach edit invalidation

The actual pinned Slack adapter returned HTTP 200 but no lifecycle callback for
11 signed file-change cases when text and edit timestamp were unchanged. Its
content-change predicate now compares ordered stable file identity/metadata;
private URL rotation and unfurl-only changes are excluded. The real-adapter
suite passed **74/74**, including 19 new signed cases, no provider downloads,
no ordinary-message callbacks, and invalid-signature denial. Reverse/forward
patch application reproduced the tested installed bytes without a lockfile
or dependency-install change.

Real-service tests separately reproduced six failures: PNG/text edits and file
removals allowed stale reuse after reach was re-enabled, exact retry still
staged, and distinct same-text/time file edits collapsed into one revision.
Authorized edits now retain only their exact-source invalidation while reach
is disabled, never new text/files or agent wakes. Slack revisions include the
matching stable-file digest. The focused service cohort passed **26/26** and
the complete fresh suite **550/550** (107.22s); server typecheck passed.

This is not a complete source-revocation sign-off. A follow-up audit found that
an edit received while its actor is revoked is filtered, then ignored by old
file authorization after relink/regrant. Verified provider source invalidation
must be distinguished from permission to admit new edited content. That next
slice remains in progress. No new live Slack file-edit journey was performed
while the Mac is locked, and server 60 still runs the preceding checkpoint.

### Maintenance environment regression

The cleanup caller now uses the existing native host-environment allowlist for
executable and source-login discovery, with the retained workspace bound by the
server. It does not inherit arbitrary host secrets or introduce a new provider
identity. The executor regression failed before the fix; the final full executor
suite passed **200/200**. Four real staged-runner maintenance cases passed,
including a bare `codex` executable available only through the supplied `PATH`
and isolated `CODEX_HOME` auth-file discovery. Server and runner typechecks pass.

This small correction does not make the already-attempted live copy retryable.
That copy retains a failed pending terminal-delivery fence and lacks durable
evidence for the maintenance runner's exit. A cold terminal-reconciliation path
currently tries to restore a provider merely to shut it down; correcting that
producer behavior and recording future per-epoch owner retirement are separate
work. The original failed copy remains `operator_required`; neither its history
nor its commands are reset, and no repeat live attempt has been submitted.

### Cold terminal delivery is distinct from physical provider cleanup

The real composed runner test exposed an unintended cold launch: reconciling a
failed terminal receipt called shutdown, which restored Codex merely to stop
it. The producer now validates retained provider state without launching, and
both native selection wrappers forward that operation. A separate persistent
cleanup marker survives acknowledged terminal delivery. Ordinary attach/start
and provider polling remain blocked; only a new exact stop with confirmed exit
clears the marker. Replaying the original failed terminal command retains its
receipt and does not rewind the newer command cursor.

Two additional regressions were reproduced and repaired: repeated failed stops
could compact the marker's original command, and a pre-authentication timeout
could overwrite the terminal lifecycle and make its journal unreloadable.
Admission now refuses before that bounded journal eviction; transport failure
records preserve the exact terminal lifecycle and receipt. Verification passed
239/239 Rust unit tests, 70 Codex provider tests, and 10 native-selector tests.
The provider target's existing ignored subprocess helper also ran separately
and passed. Formatting and diff checks passed. The normal optimized runner
build succeeded; staging and live deployment are still pending controller-side
ownership-barrier verification.

### Original GitHub B retry: live result, 23:53 UTC

From the live Board dashboard, root opened original failed run
`38dfc3ec-4fa7-4ed4-8563-7650dfce3d47` and used its Retry control once. New run
`7c4827a6-705a-4295-8196-f51a821a4af3` retained the exact latest wake comment and
source-run link. The Board showed Paperclip Runner / Codex / `gpt-5.6-luna`,
then success in 15 seconds. In the private disposable GitHub QA repository,
comment `5593571969` changed from working feedback to exactly
`CONTROL-FIRST-B-READY`. Refresh and screenshot inspection confirmed persistence
in PR-level conversation 3, not its line-review thread.

This verifies the original request's retry end to end on server 60, not all
GitHub features. The old failed-attempt notice remains immediately above the
successful retry; the new answer is clear but the historical presentation is
not yet a polished recovery experience. Telegram's retained cleanup and file B
request remain unresolved. The browser became available again after host sleep;
no provider credential or permission change was needed for this retry.

### Revoked-editor source invalidation

A provider-authenticated edit of an already-admitted source now records a
content-free invalidation even when its actor no longer has Paperclip admission
rights. Regranting that actor cannot resurrect the stale file or make an exact
old-source retry admissible. GitHub bot edits can invalidate only an exact linked
inbound source; unknown, self and outbound echoes remain suppressed. New edited
content is not admitted, and this path creates no comments, wakes or downloads.

Focused verification passed 25/25 and the final fresh full integration suite
passed **560/560**, zero skips, in 124.07s. Server typechecking passed. The first
full attempt was 558/560: an overbroad test worker swept unrelated queued Slack
work, and a historical expectation still required filtering rather than the
new content-free processed invalidation. Exact ingress processing and stronger
before/after-regrant assertions corrected these without changing the production
fix. The next attempt was 557/560 with three timeouts; host power logs showed
matching 453-second and 186-second sleep intervals. The final run used only a
process-scoped idle-sleep assertion. No test timeout or safety assertion was
weakened. Server 60 still runs the preceding source version; live revoked-editor
qualification after deployment remains outstanding.

### Copy-only legacy recovery and durable spawn admission

The closed legacy verifier now proves the exact reviewed pre-spawn failure
using both unchanged snapshots, the complete receipt namespace, immutable
command prefixes and Rust's nullable fingerprint fields. It authorizes only a
new private copy, never reactivation or deletion of the failed evidence. The
actual 91-receipt read-only check passes with original files unchanged; pure
proof and discovery tests pass 60/60. Discovery itself grants no execution
authority and excludes all newer recorded epochs and ambiguous histories.

New maintenance persists per-epoch launch intent, spawned ownership and joined
retirement. A real held-write regression initially demonstrated that the
controller could welcome the runner before its spawned receipt committed.
Authentication now waits for that durable admission and then rechecks the exact
credential, connection, expiry and latched integrity status before consuming
the credential or sending commands. A second genuine red regression covered an
authenticated peer latching an integrity fault while its successor waited.
Failure cannot be undone by late completion of the original database promise.

Final verification: 49 controller tests, 97 transport tests, 207 executor tests,
and the 60 proof/discovery tests passed. All nine composed maintenance cases
also passed against the normal staged optimized release (no debug runner
override), including terminal-only continuation and held/failed spawned
receipts. Its SHA-256 is
`6a22b20ffd1c32a2866e804dc2b36e984618aaf8065c811533739deb79ec7d95`;
strict code-signature verification, normal TypeScript build, package no-emit
checks and server typechecking passed. This section records release evidence,
not live physical settlement; controlled idle deployment follows.

### Separate retry identities and media-format preservation

Failed native retry now checks the checkpoint's provider thread (`sessionId`)
separately from its backend account/session (`providerSessionId`). Real
distinct-account positives failed before the repair, while wrong/missing
identity negatives exposed inappropriate acceptance. Both physical helpers
now check exact independent identities without relaxing process, lease, source,
generation or cleanup-receipt proof. Ordinary checkpoints without existing
provider-session evidence remain conservatively denied.

Telegram preselects document upload for accepted audio/video formats outside
its native contracts (OGG, WAV, WebM, QuickTime and M4V). MP3/M4A audio and MP4
video retain native presentation. Tests verify original bytes, name and MIME,
including the pinned adapter's actual multipart method. No ambiguous upload is
replayed using an alternate method. Teams personal files whose safe recovery
descriptor cannot survive restart now retain bounded metadata and an explicit
current-input `download_unavailable` omission. Signed URLs remain unpersisted
and unfetched; file-only messages no longer become empty messages. This does
not claim native Teams outbound upload or live tenant qualification.

Verification: the fresh complete integration suite passed **576/576**, zero
skips, in 278.67s on `chat_adapters_media_identity_20260909_full01`. Focused
retry integration passed 39/39, physical evidence 20/20, media integration
16/16, and published-adapter/hydration/classification tests 107/107. Server
typechecking and diff checks passed. These are code-contract and integration
results, not live end-to-end proof of the changed media cases.

### September 9 live continuation: Discord and Slack remain unqualified

The user signed Eigenjoy back into Discord. New root `1547036525059907626`
created exactly one provider thread and task CHA-29. Its first run accepted a
result, then physical close failed after 36 seconds. Discord showed a failure
notice; its follow-up and Slack root `1788912694.890079` were subsequently
blocked by the runtime cleanup domain. No second Slack request was sent.
Screenshots and rendered Board inspection confirmed the poor experience.

An unchanged-text Discord update was also recorded 454ms after the first root,
with no edited timestamp. A pinned-handler probe reproduces this on metadata
changes; the exact live wire payload was not retained, so thread-creation
causality is inferred. Independently, accepted-result shutdown can block in a
redundant cooperative interrupt before exact process termination. Dedicated
regressions and repairs are in progress; current evidence is preserved.

The earlier Telegram cleanup attempt now identifies missing copied provider
history: the new private home lacked the retained rollout. Its failed epoch
also lacks a durable retirement receipt. Neither later process absence nor
another server restart grants recovery authority. Bounded home-copy and joined
termination work remain separate from the media/identity commit.

The live instance moved to dedicated loopback port **3137** after unrelated
worktree tests repeatedly took 3103 and caused automatic port fallback.
Server 63's PID 45413 and completed startup on 3137 were verified. The existing
private Tailscale Board URL is unchanged and now targets 3137; the existing
public webhook-only proxy on 3104 also targets 3137. Public host/path/method
restrictions and Funnel ports remain unchanged. No other worktree was stopped
or edited.

### September 9: inline Board uploads and real Discord/Slack delivery

Hands-on testing exposed an empty-task gap: Send to channel listed existing
task files but could not upload a new one. It now uses the normal task
attachment API directly, selects the chosen file, and keeps it internal until
the explicit external Send. Uploads disable Send until they settle; a late
upload cannot select a file in a new binding scope. Task refetch metadata wins
over the temporary local upload list, and retained publication names/IDs stay
immutable. Upload failure keeps the message editable, refreshes task files,
and does not claim a failed response proves that no file was stored.

A second live observation found "Delivery result not confirmed" flashing during
an ordinary in-flight send. That warning now appears only after an unconfirmed
response, not while Sending. Both defects have genuine failing regressions.
The existing component/retained-draft cohort passes 26/26; UI typecheck and
token gates pass. The full deterministic browser suite passes 22/22, followed
by the final changed Board-send cohort at 5/5 after the feedback repair. Its
new test uses real task file upload/download endpoints, checks exact PNG and
text bytes, and mocks only the provider-binding/publication boundary.

Live environment: server 63 on private Tailscale HTTPS, with UI source reloaded;
provider accounts are the signed-in in-app Discord and Slack sessions. Each
journey started at the provider thread's task link, expanded Send to channel,
uploaded the synthetic cat PNG and 152-byte text fixture, then explicitly sent.
Actual provider image and text previews were inspected. Discord's three parts
published once each in 2.08 seconds, comment
`371da48f-767f-4e7a-a26a-fd4a6e10c07f`, provider messages
`1547041743319339098`, `1547041746913988618`, `1547041750336675840`, in CHA-29's
existing thread. Slack's three parts published once each in 6.35 seconds,
comment `718e370c-d074-4dbf-81d4-6f5f5f73304b`, provider messages
`1788914152.507729`, `1788914157.210729`, `1788914158.401459`, in CHA-30's
existing thread. No extra agent run was created. The final Slack journey showed
the corrected Sending state without the premature warning.

Functional outcome: these explicit Board-to-provider file journeys passed.
Experience: file selection and pending/success behavior are usable, but the
historical failed agent notices remain visible. This is not a pass for agent
recovery, inbound media, or every provider. The attachment previews do not prove
remote byte hashes; exact-byte checks here are deterministic local API tests.

### September 9: repaired native queues and agent media round trips

Server 64 runs `58de1c105` on loopback 3137 with the normally built runner
`4acf2d1dbe99a6202d07b6d0be73b469ebf153103cda2bbd097e5e4233fcd57a`.
Maya uses Paperclip Runner / Codex app-server / `gpt-5.6-luna`, not a legacy
adapter. Signed-in provider UI created Discord thread `1547043763581358111`
(CHA-32) and Slack thread `1788914422.188869` (CHA-33). Initial checklist and
short follow-up turns succeeded; these first pairs were sequential, not a
claim of overlapping queue coverage.

The next pairs deliberately sent a separate follow-up while the first run was
active. All six accepted results committed successfully, retaining one task
and native session per provider conversation. There were no new edit lifecycle
events in the Discord thread, no extra task, and one provider answer per source
message; progress updates edited that same answer message. UI snapshots and
database timing agree on FIFO order:

| Provider / pair | First execution | Follow-up received before first finished | Second execution | Dispatch gap |
| --------------- | --------------: | ---------------------------------------: | ---------------: | -----------: |
| Discord C/D     |         26.716s |                                  17.489s |          11.586s |         61ms |
| Slack C/D       |         38.312s |                                  21.035s |          12.193s |         53ms |
| GitHub A/B      |         28.207s |                                  11.382s |          12.947s |         57ms |

These are execution durations, not user-visible latency; the second source
waited for its predecessor. Discord runs are `0bb4e127-8219-4ae3-add3-01a4ea14525c`
and `2a2fe013-c6cb-437c-b30d-fbbb49b5f20d`; Slack runs are
`cfe6271b-cc81-4141-be07-c5ee18bb397d` and
`cf1bf23e-54ae-49da-9cbc-a09f3e773ae4`; GitHub runs are
`ce257827-0d3e-455a-9027-10c51b682826` and
`fdaae0f8-b9bb-43dd-9b4e-0afeb7d08f70`. GitHub used only the disposable QA
repository's PR 3 discussion, not the implementation PR or its reviews.

The next user journeys uploaded both the synthetic cat PNG and 152-byte text
document through each provider's own thread composer. Each agent described the
image, correctly extracted lighthouse / amber / 63 from the new document, and
returned actual image and text attachments in the same thread. Both provider
image renders and text previews were visually inspected; no local-path-only
substitute or Board send was used. Native runs
`8ffe415c-4baa-45a2-8912-f4e0bf2d0a06` (Discord, 67.925s) and
`73d19fdf-2ff0-4251-a43f-494be5182225` (Slack, 67.801s) succeeded and committed.
Discord's final answer and two attachment messages are `1547045730311737424`,
`1547046019735355442`, and `1547046024667857037`; Slack's are
`1788914872.444639`, `1788914945.916419`, and `1788914947.702919`. Every publication
part completed on its first attempt. Final attachment delivery finished about
3.6 seconds after Discord's run and 8.5 seconds after Slack's. Provider previews
establish real delivery, not remote byte-hash equality.

Functional outcome: the fresh overlapping queues and these image/document
round trips passed. Experience: concise turns are materially faster than the
old multi-minute failures; attachment inspection/return still takes roughly
one minute and deserves further latency work. Generic progress messages were
visible before the final answer, and no failure notice appeared in these fresh
journeys. Historical failed conversations, Telegram's unproved retirement
receipt, Teams tenant qualification, other media formats and broader fault
coverage remain separate gaps. Do not call all five channels production-ready.

Canonical-source recovery now preserves an original completed owner's directory
under a durably recorded archival intent before rename. Normal admission stays
blocked across a crash until the exact archive's maintenance settles. It does
not invent retirement receipts or change historical Telegram eligibility.
Verification passed 244 executor cases and 32 real-database recovery/admission
cases, server types, and independent review; the review's duplicate-history
finding was fixed with a real-database negative. This is pre-deployment evidence,
not a live recovery claim.

### September 9: accepted open-task answers remain visible in the Board

The original failed Discord journey exposed a distinct display defect: its
accepted checklist existed in the durable native result, but blanket `yielded`
filtering showed only a 117-character preamble. A completed `response_wake`
can answer now while keeping the task open; it is not an unanswered question.

The native event projection now marks only an exact, single accepted
control-plane result with an explicit nonblank response-wake key, empty
attention, matching owner/session/turn, and a later successful same-run terminal.
The task timeline renders that accepted summary exactly once. Proposed,
provider-authored, mismatched, live, question/approval and ambiguous evidence
remain excluded. A real failing steering-boundary regression ensures that
separating acceptance from the terminal does not lose or duplicate the answer.

Verification: 282 focused cases, adapter-utils/UI typechecks, token gates and
diff checks passed. Replaying the original authoritative events returns all
1,340 characters, SHA-256
`28eaa91bed824f4a400b56b988444cf7c36dff0a8496dae890791df801091dd0`.
Live Board CHA-29 was reloaded and scrolled: all three sections and 17 bullets
are now visible, while the later failed B remains a separate failed turn.
No semantic result or external message was rewritten and no answer was rerun.

Server 65 deployed `d47f2099f` on loopback 3137 after an idle graceful drain.
Its canonical archival preserved the original Discord directory and copied
the full bounded provider home, but control-only maintenance still ended
`operator_required` (`cleanup-mZx1xU`). That failure is under read-only diagnosis;
this display fix and the fresh-thread successes do not prove historical
physical cleanup or failed-follow-up retry.

### September 9: latency attribution and provider limits

The final composed deterministic chat browser suite passed **22/22** in
2.5 minutes after the accepted-answer repair. Post-restart Discord, Slack and
GitHub replies also succeeded in the same tasks/native sessions. Execution
durations were 14.36, 13.06 and 15.92 seconds respectively. Slack's source-to-
local-ingestion delay was nevertheless about 62 seconds, under investigation;
those execution numbers must not be presented as end-to-end response times.

The preceding media runs spent 60.149s (Discord) and 55.701s (Slack) between
turn acceptance and result proposal, across 6–7 sequential tool/model cycles.
Startup was 1.954/2.933s, result acceptance 5.555/5.168s, and finalization/close
0.267/3.999s. Actual tool execution took roughly two seconds; tool-duration
measurements overlap and are not additive. Slack's close encountered a warm
teardown timeout followed by proved successful physical stop. The five-second
post-result grace waits for provider final/terminal evidence and is not being
reduced. Native media instructions now encourage batching independent reads,
preparation and registrations, preserving exact per-file receipts, distinct
stable retry identities, source authorization, approvals and helpful progress.
This instruction-only change passed 36 focused tests and server types. No
measured savings are claimed before its same-input live A/B test.

The GitHub private-document limit was verified using the existing App's exact
installation and a read token restricted to the disposable QA repository.
Comment `5589017671` returned HTTP 200 with the admitted body hash intact; its
full rendered representation contains only the original unsigned generic-file
anchor, no signed download target. Anonymous retrieval returned 404 without a
redirect; the body was not consumed. The image comparison `5589001728` exposes
an exact same-asset signed image target through the equivalent App read.
Removing the generic-file guard alone cannot fix this fixture. Preserve the
safe omission and offer direct Paperclip attachment or pasted text; never
borrow browser cookies or send App credentials to upload/CDN URLs. The focused
attachment suite passed 96/96. This is evidence for these fixtures and the
supported App-read route, not a claim that GitHub can never add another route.

### September 9: exact paginated rollout relocation

The previous filesystem-fallback assumption was wrong for Codex 0.153.4's
paginated threads: its outer resolver deliberately trusts the SQLite-selected
rollout and refuses an absent path, avoiding an older history after a revert.
Recovery now rebases only that already-proven selected path in the new private
copy, with exact thread/history metadata checks. After proved stop it rebases
the path back to the future canonical home before hashing and activation.
Original and failed-copy SQLite files are never opened or changed.

Independent review reproduced two unknown-schema side effects: mixed-case table
names bypassed trigger inspection, and foreign-key update cascades could alter
another row. Case-insensitive trigger lookup and a fail-closed mutating-FK guard
now reject both before launch. Full executor verification passed **252/252**,
server types passed, and independent review found no remaining blocker.

The opt-in actual-provider regression is now reproducible:

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs scripts/tests/native-cleanup-paginated-codex.mjs
```

It requires exact Codex CLI 0.153.4 (`PAPERCLIP_TEST_CODEX_BINARY` may select it),
uses only fresh synthetic homes, and makes no `turn/start` or model request.
It proves the real stale-path failure, successful same-thread paginated resume
after staging relocation, and successful resume after canonical activation.
The complete original fixture fingerprint remains unchanged. Root reran the
portable check twice; final thread was `01a083b4-e368-7b03-be85-d81b0eb0e12f`.
Fixture directories remain available for inspection. This is actual Codex
protocol qualification, not live recovery of the earlier failed chat sessions.

Slack's separate delayed restart request arrived with retry number 2 and
`http_error`. Source-to-durable-ingress took 61.530s; ingress-to-run took 0.792s,
execution 13.062s and final publication another 0.306s: **75.690s user latency**.
The eventual webhook returned HTTP 200 in 23ms. No request/connection reached
the local proxy around the original send; the original upstream status and
component remain unproved. Exactly one run and one final reply were produced.
Do not attribute this pre-ingress minute to the model or claim it was fixed.

Browser qualification then paused because the Mac locked. Code/tests continued,
but no further live browser action or batching A/B pass is claimed. The old
Discord maintenance runner has an exact exit-1 receipt; its failed provider
initialization does not have authenticated renewed-provider exit evidence.
Telegram additionally lacks its maintenance runner's retirement. Both remain
conservatively denied, and no historical retry eligibility was widened.

Deployment checkpoint: server 66 loaded `807e2ace2` on loopback 3137 at
01:09 UTC after server 65's zero-interruption graceful drain. Health and startup
recovery are ready. No new heartbeat was created; historical Discord/Telegram
maintenance counts remained one/two. This deployment includes the verified
paginated path fix, accepted-answer UI, batching guidance and actionable GitHub
file fallback. The last two instruction changes still await live UI retesting
after the Mac is unlocked; no measured latency improvement is claimed yet.

### September 9: reproducible public ingress diagnosis

The opt-in `scripts/smoke/chat-webhook-ingress.mjs` can compare one public Slack
webhook request with the same path on an explicit loopback target. It sends
only `{}` with a deliberately malformed Slack signature, never a real event.
It does not read credentials, follow redirects, retry, consume response bodies,
use environment proxies, or run automatically. Each target has one eight-second
deadline covering DNS, connection, TLS and response headers. Output contains
only closed outcome/timing fields, without URLs, public IDs, headers or raw
errors. An explicit public relay IP preserves the original hostname and SNI;
this distinguishes Funnel ingress from private MagicDNS routing. Debug modes
that could expose request options are refused before networking.

Root independently passed all **49/49** fixture tests and syntax checking,
then ran the frozen canary once at **01:26:34–35 UTC**. Public Funnel 8443
returned HTTP 401 in **457.815ms**, and the loopback webhook-only proxy returned
401 in **9.047ms**. Server log request IDs
`6772cb3a-4179-49d1-b6a4-b69d2866d609` and
`38653171-56e7-467d-960a-db0396237639` confirm the exact expected rejections;
live database deltas were **zero deliveries, zero runs and zero publications**.
Private Board/public webhook exposure was not changed. This proves current
route reachability and safe rejection, not signed-event admission, provider-
origin reliability, user latency percentiles or chat experience quality.

Earlier scoped probes also reached both public relay address families/ports.
The host sleep log contains no sleep/wake transition during 19:45–20:00 local,
covering the delayed Slack source. Neither that nor bounded Tailscale logs
localizes the original pre-proxy HTTP error. It remains unresolved.

The canary exposed a separate generic HTTP logging defect: raw webhook buffers
are included as numeric byte properties in warning logs. The observed body
was only the inert `{}` fixture, not an actual leaked credential. The repair
now treats the reserved webhook namespace as private for logging even for
malformed paths or rejected methods. It keeps only request ID/method, a generic
route, response status/timing and generic errors; it omits the entire raw or
parsed body, params, request/response headers and SDK prose. Actual Express/pino
regressions first failed for Buffer bytes and independent error/response fields.
Root independently passed the final **97/97** six-file cohort and server types.
Adjacent non-webhook diagnostics remain intact. Routing, signature verification,
admission and provider publication behavior are unchanged.

The diagnostic's TLS-debug guard also now rejects Node's underscore and
`=true` tracing aliases before any request. All six injected regressions first
failed, then passed; the final canary suite is **55/55**, with no real network
traffic in those tests.

Root deployed `b2e44c5b6` separately as server **67**, PID **32112**, at
01:39:36 UTC, keeping the existing normal runner artifact. Server 66 drained
with zero interrupted runs and exited cleanly. Startup recovery and private
Board health are ready. Repeating the single inert probe at 01:40:06–07 UTC
returned HTTP 401 via public Funnel in **591.593ms** and the local proxy in
**7.677ms**. The database again changed by **zero deliveries, runs and
publications**; both generic HTTP warnings now contain only the placeholder
webhook route and `reqBody: "[REDACTED]"`, not the observed raw Buffer bytes.
This verifies the deployed logging fix without publishing any chat message.
The new provider startup/attach fencing remains a separate, undeployed slice.

### September 9: actual Codex startup-failure ownership canary

`scripts/tests/native-provider-startup-codex.mjs` is an explicit opt-in check
against Codex CLI **0.153.4** and the normally staged optimized runner. It
requires `--run`, an absolute `--codex-binary` and the caller's exact
`--expected-runner-sha256`. No arguments or `--help` launch nothing. It creates
only new private synthetic homes with file-only auth storage, never reads live
credentials/history, and never sends a turn command. A recording shim immediately
execs the actual Codex binary; its PID/birth/group ledger provides an independent
process-launch observation, not a simulated provider response.

Root reproduced the final script against runner
`0ad458ece73ae9b80a6be2b584afc07b9b7ed3e5e266dd4ddfe3c6f026a922d2`.
The actual provider received exactly `initialize`, `initialized` and
`thread/resume`. The random absent rollout failed as expected. All three
startup facts committed while `session.open` was still pending; the requested
thread remained unauthenticated and the exact direct-child exit was observed.
The explicit `processTreeRetired: false` remains false. Reopening the actual
runner denied snapshot/open before a second provider launch or RPC; the launch
ledger, complete provider trace, original startup receipt and failed-command
result were unchanged. Both runner ChildProcesses were joined with exit 1.

Root fixture `paperclip-real-startup-fXxrjh` and its summary/trace remain under
the host's temporary directory for inspection; provider PID was 35821. CLI
preflight checks observed zero launches and fixture creation, and eight isolated
emergency-cleanup checks covered absent, matching, mismatched and still-live
owners. Emergency signals are restricted to an exactly matched fixture PID;
unproven cleanup is reported rather than silently accepted. This is real
provider startup qualification, not successful chat execution, a model-latency
measurement, full-tree retirement, or permission to retry historical sessions.
The broader transport suite still has separately tracked readiness and fixture
issues; this canary passing is not a release-completion claim.

### September 9: forward startup evidence and bounded warm readiness

The native provider now persists a unique startup intent before spawning,
records the exact child before initialization RPCs, and preserves a closed
failed-startup receipt before returning command failure. An unadmitted attempt
stays fenced across runner restart. Failed-command evidence drains through the
retained-only FIFO, never an implicit provider restore/poll. Direct-child exit
is explicitly not whole-process-tree retirement or historical retry authority.

Warm attachment now commits and obtains cumulative ACKs for the old authority's
events before returning its successful result and rotating. Failed/rejected
attachments do not rotate. Held and lost old-event ACKs preserve replay and
deduplication. A separate, preexisting lost **attach-result** transition remains
unresolved: safely retaining old/new authority across that boundary needs a
durable transition receipt, not merely the event-ACK fence introduced here.

Composed tests caught two regressions during implementation. Eager draining on
every successful command could starve suspend-result acknowledgement; it is
now limited to attachment. Conversely, frequent warm-readiness probes could
starve their own retained startup facts. An explicit valid quiescing snapshot
now advances at most one 128-event retained prefix, only after the old outbox
is empty and fully acknowledged. It performs no extra provider poll/launch;
the next probe recomputes readiness. Ordinary/terminal controls remain
control-first. Both failures were reproduced before their fixes; no timeout
was lengthened and the final source passed independent review.

Fixture coverage now distinguishes genuinely new failed startup (never strip
its real fence) from a separately synthesized old-producer terminal-delivery
fixture. Likewise, the 1,024-event suffix has explicit persisted-completion
success and contradictory-active-work refusal cases. Both retain the original
stop/suspend, event-deduplication and archived-source assertions. The latter
starts no successor turn. The provider's prepared-active-work guard was not
weakened to make the success test pass.

Final Rust library checks passed **247/247**, provider **74/74** plus both
subprocess helpers, native wrapper **10/10**, supervisor **5/5**, fake-provider
fixtures **10/10**, and public durable-store checks **3/3**. Root's control-plane
cohort passed **49/49**, package types/build and strict binary signature passed.
The normally staged candidate is
`2400740c02b85a0099c18c17cb8567905c8dd07fc677363c90f98d0d9b9dbbc8`.
The final actual-Codex canary also passed against it, fixture
`paperclip-real-startup-87DVmb`, provider PID 61163, with only the three expected
initialization/resume methods and no second provider launch after reopen.
The final full transport cohort passed **105/105**, zero skips, in **143.09s**
on that exact normal binary. This includes the startup/no-relaunch, legacy
terminal replay, held/lost ACK, rejected attach, both 1,024-event provider-state
variants and preexisting transport cases. Server deployment follows separately;
the Mac is still locked, so no new live chat or latency-improvement claim is made.

Deployment checkpoint: server **68** loaded `3a2a911bd` at **02:06:03 UTC** on
loopback 3137 with the exact normal binary above. Both local and private
Tailscale health/startup recovery report ready. No new run was created (286
total, zero active), and historical Discord/Telegram recovery histories stayed
at 9/11 entries and one/two maintenance attempts. A subsequent browser inventory
succeeded: the Mac is now unlocked and live provider qualification can resume.

### September 9, 02:11–02:16 UTC: live media repeat and GitHub fallback

Root used the signed-in in-app Discord thread and Slack thread as the user,
uploaded the same PNG and TXT, and sent the same media request body with a new
diagnostic marker. Each request ran alone on Maya's existing native Codex
app-server session using `gpt-5.6-luna`. Child agents had no browser surface and
independently correlated only scoped delivery, run, publication and canonical
tool metadata. No fixture outcomes were inserted into the database.

| Measurement                           | Discord before → repeat | Slack before → repeat |
| ------------------------------------- | ----------------------: | --------------------: |
| Run duration                          |       67.925 → 60.073 s |     67.801 → 51.030 s |
| Provider source → last published file |       72.840 → 64.926 s |     78.439 → 61.173 s |
| Outer model tool calls                |                   6 → 4 |                 7 → 5 |
| Underlying tool operations            |                   7 → 5 |                 7 → 5 |

Discord run `265d35e0-af1e-421b-b3e2-61ba65fcc288` and Slack run
`12d6d924-9748-4d13-ad6e-2035937e12dd` both succeeded and committed.
Preparation/read/size/hash commands fell from three to one; image inspection,
two distinct per-file registrations and the final-response protocol remained.
Slack still used separate model calls for the registrations. This is one repeat
per channel, in later same-thread context and on a newer runner: descriptive
improvement, not an isolated causal effect or a performance guarantee.

Root observed working/progress feedback replaced by the final answer, actual
returned image and text-file previews, no failure banner or duplicate answer,
and opened Discord's returned TXT full-file viewer to inspect all three lines.
All new publication parts were first-attempt with no ambiguous delivery.
Discord final message `1547066896724000940`, PNG `1547067154116124686`, TXT
`1547067156687097926`; Slack final `1788919977.524779`, PNG
`1788920033.463569`, TXT `1788920035.360249`. Discord's source eyes reaction
cleared; Slack's remained while its native Stop control disappeared on completion.
These observations are sampled transitions, not a continuous recording.

Stored returned assets match the exact received bytes. Discord's PNG matches
the original local 2,111,878-byte fixture. Slack's received PNG is 2,088,249 bytes
and differs from the local upload, but matches the earlier Slack received PNG
exactly; the returned asset matches that provider-received input. The 152-byte
TXT matches throughout. Remote downloaded bytes were not independently hashed.

GitHub's new private-file fallback request was sent through the dedicated QA
PR's comment UI, not the implementation PR. Source comment `5594742103` yielded
one native Luna run and one reply, `5594742965`, stating that the exact file
could not be imported and offering direct Paperclip attachment or pasted text.
No file content was guessed and no browser credential was borrowed. Root then
followed the paste suggestion with the complete synthetic original text and
visually verified reply `5594755807`: “Shape: hexagon. Color: teal. Count: 47.”
The paste recovery is functional. Experience still needs improvement: the
direct-attachment advice names “this Paperclip task” without a clickable task
link. A focused fix is under investigation; unavailable GitHub private generic
file import itself is not claimed to work.

### September 9: connected-task layout and stale-route admission

The real Board's connection banner became unreadable with Properties open:
action buttons squeezed “Connected to Discord” into a narrow multiline column.
Root reproduced the failure in a deterministic browser test, then grouped the
identity text and wrapped actions using existing layout tokens. The regression
checks 340-, 500- and 760-pixel test containers for single-line heading text and
contained, visible actions. Root reloaded the actual connected Discord task and
visually verified the readable header and second-row actions. Composer behavior
and explicit-only outbound publication are unchanged. Focused component/draft
tests passed **26/26**, UI types and all four styling gates passed.
The full deterministic chat browser cohort passed **23/23**, zero retries, in
2.5 minutes against its own throwaway instance, not the live provider server.

Independent route review found that warm attachment briefly registers old and
new URLs for one mutable controller. Runtime-response admission now requires
the route's run ID to match the controller's current run, before consulting
cached commands. Real controller rotation tests reproduce old cached/uncached
and premature new-route admission; rejected requests leave the journal unchanged,
while the current route retains idempotency. Root's focused server cohort passed
**65/65** and server types passed. This is a stale-admission fix, not evidence of
a provider-level authorization bypass or a complete handoff-loss repair.

The separate attach-result-loss transition is still under development and
independent review on a private runner artifact. Its first composed regression
now passes, but restart, lease and downgrade qualification remain unfinished.
The normal runner and live server 68 are unchanged. Teams Developer Portal was
also checked in the in-app browser and currently requires Microsoft sign-in;
there is still no qualified Microsoft 365 tenant/bot installation.

### September 9: durable GitHub unavailable-file navigation

The observed missing task link now has a deterministic publication fix. Only
an exact accepted native `response_wake` with a current download omission gets
the safe Board task URL; older files, response prose and caller hints are not
evidence. A server-only preparation receipt binds publication, run, result and
text digest before provider I/O. Already-present links get the same receipt
without another link. Retries retain identical text across Board-origin changes
and recheck current source, access, runtime and full coalesced-batch authority.
Board/progress/control publications and unsupported legacy finals are unchanged.

The real-service failure was reproduced before the fix. New focused cases pass
**26/26**, URL/publication units **32/32**, and server types pass. Root's full
fresh-database cohort passed **610/610**, zero skips, in **125.11 seconds**.
This is not a live deployment or a claim that unsigned private GitHub generic
files can be imported. The live paste fallback remains the qualified alternative.

Destination follow-through also found a separate existing Board defect: opening
an unprefixed task UUID while another organization is selected keeps that wrong
organization in the canonical task route. The ordinary upload then posts the
wrong company and receives **422 Issue does not belong to company**. Four real
isolated-browser cases reproduce this, including wrong-prefix identifier links
and both task interfaces. The loaded-task-company navigation/upload correction
is in progress; it is not covered by the GitHub service tests above.

The task-company correction now derives both upload IDs from the loaded task
and the canonical route prefix from its visible company mapping. Placeholder
or prior-task data cannot redirect or upload. Both interfaces, normal/uppercase
UUID links and wrong-prefix identifier links pass **6/6** focused browser cases:
the upload reaches the correct company/UUID, stored bytes match, and uploading
does not create a comment. The original immediate-upload case also passed three
consecutive repeats without an added wait.

The first correction exposed a real transition failure (3/4 passing): the old
UUID composer could open a chooser, then be replaced while canonical comments
loaded, leaving no attachment and no HTTP request. The existing noninteractive
header/loading surface now covers outgoing canonical-route/interface transitions.
This does not block on selected-company state or weaken server company checks.
Nonlegacy search/hash preservation and final organization selection are included
in the broader rerun. UI types, all four styling gates and **48/48** focused
cache/navigation/contract tests pass. Root reloaded the live canonical Discord
task and visually verified its settled header, content and composer. That is
not a live multi-company fallback or continuous transition recording.
The final full deterministic chat browser cohort passed **29/29**, zero retries,
in **2.8 minutes**, including the six new navigation/upload cases and preserved
nonlegacy query/hash and selected-organization checks.

### September 9: partial Slack/Discord file batches across worker restart

A focused real-service regression now covers a selected-file batch whose text
and first file succeed, second upload has an ambiguous socket failure, and third
file remains pending. A fresh service instance does not resend the published
prefix or advance past the unknown delivery. The authenticated status API reports
two of four publications delivered, Activity exposes explicit resolution, and
ordinary replay is rejected. An audited `retry_anyway` retries only the uncertain
file and then sends the remaining file; original text, first-file bytes, message
links and comment remain unchanged. Final attempts are `[1, 1, 2, 1]`, and another
worker pass produces no sends.

Both Slack and Discord cases pass (**2/2**) on a fresh PostgreSQL database. This
is a coverage addition, not a reproduced production duplicate-send fix. The real
service, database, access checks and publication queue are exercised; provider
I/O and its ambiguous failure are simulated. It does not establish whether an
actually timed-out provider accepted the uncertain file, which is why explicit
duplicate-risk acceptance remains required.
Root's full chat integration rerun passed **612/612**, zero skips, in
**110.37 seconds**, using fresh `chat_adapters_multifile_restart_20260909_root01`.

### September 9: crash-safe warm attachment and post-recovery lifecycle

The candidate replaces the ambiguous warm-attachment handoff with a durable
receipt binding the exact old/new run identities, attachment command and result,
event ACK cursor, endpoint, artifact and unchanged participating lease. The
runner persists preparation before returning its result; the controller persists
the result before acknowledging it. Old authority can replay only the matching
result and ACK, not admit ordinary work. New authority activates only with the
same authenticated receipt. The runner retains that receipt until it receives
the final activation ACK, so a lost confirmation remains recoverable without
treating a historical completion record as new authority.

Review and real-process regressions caught additional defects along this path:

- Resetting the local event cursor before controller activation reread the old
  run's event prefix and skipped the new run's completed events. Epoch identity
  fencing and reset after activation fix the ordinary three-turn timeout.
- A TCP FIN without a WebSocket close frame left an upgraded socket half-open
  and prevented activation-failure cleanup from finishing. The owned wire now
  closes on the remote end event.
- Recovery-only server authorization incorrectly survived successful recovery,
  rejecting later normal reconnects and warm attachments. A fresh, uniquely
  queued, authenticated new-authority snapshot now proves final ACK consumption
  before retiring that recovery-only fence. Missing/rejected/wrong snapshots,
  callback exceptions and asynchronous rejection leave ordinary work denied.
  The fence starts before asynchronous registration/bootstrap, so concurrent
  turns, attachments and runtime responses cannot race it.
- An injected crash fixture allowed a later replay to finish while its original
  process was joining. The loss is now sustained at the actual persistence
  boundary and both immutable snapshots are checked after the owned processes
  finish. No saved receipt is rewritten to manufacture the intended crash state.

The server admits only independently proved local Codex `resume_dead_runner`
recovery, including managed and projectless/transient workspaces. Real current
run ownership, frozen input, prior terminal owner, process-birth evidence,
selected artifact and cleanup boundaries are checked before registration,
bootstrap, spawn and authentication. Lease time is re-evaluated after database
lock waits. Pending evidence is preserved on denial. Surviving-runner adoption,
remote/listen recovery and historical quarantines are not enabled by this slice.

Root's optimized runner has SHA
`6279d39ac731e4565a638b64c93673b8ca23e6dfbc0870e24d48422497f1826d`.
The full optimized transport suite passed **133/133**, zero skips, in **198.64
seconds**. Independent focused recovery verification passed **26/26** in
**57.14 seconds**, controller **69/69**, optimized Rust library **248/248**, and
adjacent server tests **75/75**. Existing executor tests passed **260/260**.
The real-classifier server admission matrix passed **36/36** in **17.75
seconds** on fresh `chat_warm_transition_admission_20260909_root02` with
immutable optimized-artifact fixtures. That server seam mocks the backend after
admission: it is not server-to-provider end-to-end recovery qualification.

The real-Codex startup canary also exposed a stale test observer: atomic commits
replace command snapshots, so retaining the object returned by `queueCommand`
never observes its changed status. Reading status/result through stable command
IDs fixes the canary without weakening assertions. The genuine red-to-green
check used Codex **0.153.4** and the old qualified runner `2400740c…`, exactly one
provider process, initialization plus attempted resume, and no model turn. A
reopen sent no provider RPC and preserved the original failed-startup receipt.
Direct-child exit was observed; whole-tree retirement was not asserted.

One verification mistake was contained: `server`'s `pnpm typecheck` invokes the
full runner build and briefly staged the optimized binary. Root restored the
exact signed `2400740c…` backup and verified its hash and signature. Server 68
was not restarted; live run audit remained 290 terminal runs and zero active,
with no new run since 02:15:47 UTC. Subsequent server checks use direct
`pnpm exec tsc --noEmit` after explicit TS-only dependency builds. The Mac is
currently locked, so no new live-provider browser result is claimed here.

The native slice was committed and pushed as `2344814f2`. After scoped
formatting, root reran **55/55** selected protocol/warm cases and **260/260**
executor tests; package TS build/types, direct server types and Rust formatting
passed. Server 68 drained zero active runs and exited; the normal five-second
HTTP close deadline retired remaining connections. Root deliberately staged
and strict-verified the exact optimized `6279d39a…` artifact. Its real-Codex
canary (`paperclip-real-startup-phHTMj`) passed with exactly one provider process,
no model turn, original startup receipt retained and reopen denied before RPC.

Server **69**, PID **12088**, started **03:36:05.657 UTC**, loaded
`2026.831.0+588.git.2344814f2`, and completed recovery **03:36:09.175 UTC**.
Loopback and private Tailscale health returned 200/ready. Discord Gateway
reconnected the same bot identity. Live run counts remained 290 terminal and
zero active. The browser remained locked at the final actual probe, so this
is a verified deployment/startup checkpoint, not a new live conversation pass.

### September 9: bounded latency and native-profile audits

The long Slack and Telegram samples remain pre-ingress delays, not proved
local execution or queue delays. For the Slack sample, source-to-Express was
61.511 seconds, while its observed proxy request took 23.155 milliseconds and
Express acknowledgment took 22.525 milliseconds. The Telegram delayed sample
had source-to-ingress of 234.593 seconds but observed proxy duration of 703.024
milliseconds. Other GitHub callbacks were acknowledged during the Slack gap.
Retry headers do not establish the path or existence of unobserved earlier
attempts. No timeout or reach configuration is being changed on that evidence.

The proxy audit found a narrower diagnostic gap: invalid method, host and path
requests return before accepted-request observation is installed. An existing
keep-alive connection can therefore carry an unobserved rejection. Passive
closed-label rejection diagnostics now cover that boundary. They are local
qualification logs, not first-party telemetry, and must not record request URLs,
headers, bodies, endpoint public IDs or arbitrary error prose. Native HTTP parser
400/431 responses and streaming policy must remain intact. No result here proves
that this gap caused either provider delay.

The unchanged proxy produced a genuine failing regression: a rejected request
on the same keep-alive socket returned 404 with zero rejection records. The
portable helper suite passes **6/6**, and root independently passed **8/8**
against the actual wired proxy source using ephemeral local HTTP servers.
The latter also checks the unchanged 1 MiB ceiling and one-shot QA fault fixture.
Malformed URL parsing now returns 400 instead of escaping the handler. Method,
host and path rejection remains 404. The observer never starts reading a body,
and byte counts describe only bytes observed before finish or abort. The
running proxy has not yet been restarted to load the change; these tests sent
no request to a live provider or the live proxy.

The native reasoning-effort audit found a missing capability, not a supported
field being dropped. Maya's five latest succeeded native runs freeze a Codex
provider profile containing kind, `gpt-5.6-luna` and approval policy `never`,
without reasoning effort. Native v4 is a closed contract: injected
`reasoningEffort` or `modelReasoningEffort` is rejected, and legacy low versus
high configuration resolves to the same native profile. Only the legacy local
Codex adapter translates that old field. Claiming effective low effort for the
native runner would therefore be incorrect. Adding it properly requires an
explicit versioned contract, persisted identity and new/resumed-turn tests plus
real qualification; silently reinterpreting the old field is not this repair.

The user restored Discord login, but the subsequent actual browser inventory
still reports the Mac locked. No new live provider message was sent during
these audits. The scratch handoff has been shortened to current deployment,
remaining work and protected recovery evidence; earlier scratch checkpoints
remain available in Git at `f66bedd63`.

The rejection observer was then committed/pushed as `6c5e9c215` and loaded in
proxy PID 27961 after confirming the old proxy had no active connections. A
non-mutating GET through public Funnel at 03:51:14 UTC returned 404 and emitted
exactly one method-rejection record without request details. Server 69 and the
native runner were unchanged. This is proxy deployment proof, not a new live
provider message.

### September 9: actual Discord button-denial boundary

The new standalone test joins the installed patched Discord adapter, actual
Chat SDK and Paperclip runtime instead of stopping at a mocked SDK callback.
It showed that Gateway normalization produces plain JSON: the raw
`deferUpdate` and `isMessageComponent` functions used by the service's denial
check do not survive. A real service/database composition then reproduced the
bug: repeated delivery of a synthetic Gateway interaction created one durable
filtered denial and no wakeup, yet attempted two success acknowledgments and no
ephemeral rejection. The prior hand-built fixture invented the missing raw
functions and therefore concealed this mismatch. The runtime's foreign-guild
filter also silently resolved, causing a success acknowledgment without calling
the scoped service.

The repair assigns action transport context inside the runtime, never from
provider JSON. A denied Gateway action surfaces the existing safe rejection
sentinel after its denial audit is durable. Out-of-guild Gateway actions reject
before the application callback. Other providers and webhook filtering retain
their behavior. A held-webhook/concurrent-Gateway test verifies that the
runtime's asynchronous request context cannot mislabel the other path, and
forged payload transport fields do not supply that context.

These tests simulate Discord socket replies and do not prove that a real
provider accepts multiple replies to the same interaction token. The new
denial composition does exercise the real adapter → SDK → runtime → service →
PostgreSQL boundary; it is not a live click or native model continuation.

### September 9: Telegram photo constraints and exact document fallback

The previous classifier sent every image MIME type through Telegram's photo
method. Real generated PNG/JPEG fixtures reproduced seven failures in which
unsupported geometry, unqualified image formats, truncated headers or excessive
photo bytes still selected `sendPhoto`. Telegram separately limits photo byte
size, width-plus-height and aspect ratio; see its
[sendPhoto contract](https://core.telegram.org/bots/api#sendphoto).

The replacement makes the lane decision before provider I/O. Recognized static
PNG/JPEG containers within a conservative 10,000,000-byte budget, combined
dimensions at most 10,000 and aspect ratio at most 20 remain photos. Other
images retain their original bytes as documents. GIF/WebP document selection is
conservative, not a claim that Telegram can never decode those formats. The bounded container/header
probe does not decompress pixels: Telegram still validates the compressed
payload. Unknown formats, animation and malformed known headers fall back
conservatively. Independent review added contradictory JPEG component-header
cases, without introducing a decoder or unbounded metadata work.

Tests inspect multipart bytes through the actual pinned Telegram adapter and
the real publication service/database. Exact-limit and just-over-limit cases
are separate. A simulated uncertain photo send remains `delivery_unknown` with
one attempt and no automatic document resend, preserving the existing duplicate
risk boundary. Audio/video routing stays unchanged. No live Telegram upload is
claimed by these provider-I/O simulations.

Root's final verification passes **624/624** full chat integration tests, zero
skips, in **126.88 seconds**, using fresh
`chat_adapters_telegram_photo_20260909_root01`. The focused photo/Discord/runtime
cohort passes **199/199** in 6.27 seconds; direct server TypeScript passes.
Independent review found no remaining blocker in this bounded repair. New files
and documentation pass Prettier; existing large shared files were formatted
only within changed sections. No whole-workspace test or new live browser pass
is implied.

The changes are committed/pushed as `d5ec721f2`. Server 69 drained zero runs
and exited cleanly. Server **70**, PID **54936**, handle **62091**, started at
**03:57:19.082 UTC**, loaded `2026.831.0+591.git.d5ec721f2.dirty`, and reached
recovery-ready at **03:57:22.072 UTC**. Only the two root documentation edits
were uncommitted at startup, accounting for the suffix; implementation was
frozen and committed. The qualified native runner hash `6279d39a…` is unchanged.
Loopback and private Tailscale health both pass, and Discord Gateway reconnected
bot `1546330979860221952`. The final actual browser probe still reports the Mac
locked. User Discord login is not being requested again; OS unlock is needed
for live conversations and interaction/file retesting.

### September 9: joined question and modal coverage

Discord's existing question/continuation integration now builds the actual
service-generated card with the pinned adapter and takes its emitted button
custom ID through the real Gateway normalizer, Chat SDK and runtime. Two
concurrent synthetic clicks produce one canonical answer, one continuation
wake and one same-thread final publication. A late click does not add another
wake or final. Root's focused fresh-database run passes **2/2**, including the
parsed denial case, in **5.31 seconds** on
`chat_discord_question_bridge_20260909_root02`. The wake/result and provider
socket remain simulated; this is not a native model turn or live click proof.
This coverage addition did not reproduce another product defect.

The new Slack modal bridge uses real Paperclip form construction, signed
synthetic envelopes, the installed adapter/Chat SDK and runtime, with a local
fake Web API. It verifies opaque field IDs and wrapped private metadata,
canonical answer validation, inline field errors, corrected retries after
SDK context consumption, callback-failure 503/no false acknowledgment and
endpoint isolation. **10/10** new cases and an adjacent **116/116** cohort pass.
The final application callback is a pure validator/observer or an injected
failure, not the actual database authorization/continuation service. No
production Slack change or live-modal qualification is claimed.

The runbook now points at the current ledger and the repository's CI-owned
lockfile workflow. Unscoped “current” labels in dated provider results have
been explicitly tied to their original checkpoints. Historical September 6
setup failures and case rows remain intact, rather than being relabeled as
current success.

### September 9: editable Teams validation repair

The joined Teams task-module test reproduced a real failure: the pinned
adapter turned an `errors` response into a replacement card containing only
two text blocks. Original inputs and Submit disappeared, and the visible error
label exposed an opaque field ID. The first focused run passed 12/13, with
this missing-correction path as the genuine failure.

Paperclip now rebuilds an invalid-but-current Teams form after the existing
source, actor, destination, publication and pending-interaction checks. The
replacement preserves the original durable callback token and known choices,
uses canonical question labels for errors, and retains text up to the existing
3,000-character native-form ceiling. If that ceiling shortens a draft, the
form says so. Unknown fields/options are not reflected. Stale, expired or
denied submissions remain noneditable, and Slack retains inline field errors.
No provider-authentication checks or SDK dependencies were changed.

The actual pinned HTTP bridge, Teams event dispatcher, adapter and Chat SDK
now carry an invalid submission through the correction card and a successful
second submission, including the SDK's consumed-context behavior. The isolated
test substitutes only the instance service-token checker, explicitly not a
Microsoft tenant/JWT proof. The final callback uses the same form helper and
canonical validator, not database authorization. Separately, the real-service
Slack/Teams database cases prove invalid forms leave the interaction pending
and token issued, with no new wake, answer delivery or answered audit. Existing
denial, corrected answer, concurrency and replay assertions remain intact.

The helper/Teams cohort passes **31/31**, the two fresh-database service cases
pass **2/2**, and independent review reran helper/Teams/Slack **41/41** with no
blocking finding. Direct server TypeScript passes. These are deterministic
boundaries, not a live Teams modal or aggregate card-size qualification. Logs
are `teams-modal-editable-green-freeze-0909.log`,
`teams-modal-service-green-0909.log` and
`teams-invalid-form-independent-review-0909.log` in ignored runtime storage.

Final frozen-code regression passes **624/624**, zero skips/failures, on fresh
`chat_modal_correction_20260909_root01` in **120.61 seconds**. Root separately
reran the helper/Teams/Slack cohort **41/41** in 2.35 seconds, and plain server
TypeScript passed without rebuilding or staging the native runner. Logs:
`teams-modal-full-root-final-0909.log`, `teams-modal-root-review-0909.log` and
`teams-modal-full-root-types-0909.log`. The normal runner remains exact SHA256
`6279d39ac731e4565a638b64c93673b8ca23e6dfbc0870e24d48422497f1826d`.

The repair is committed/pushed as `efbc92616`. After checking zero active
runs at **04:14:28.148 UTC**, root gracefully stopped server 70 (exit 0).
Server **71**, PID **28614**, handle **80118**, started from a clean worktree
at **04:14:35.135 UTC**, loaded `2026.831.0+594.git.efbc92616`, and reached
recovery-ready at **04:14:37.785 UTC**. Loopback and private Tailscale health
both returned 200/ready, and Discord Gateway connected the expected bot
`1546330979860221952`. Proxy configuration and the qualified runner are
unchanged. This is deployment readiness, not a new live provider pass.

### September 9: Slack corrected modal joined to database authorization

The separate Slack bridge's callback-only limitation is now covered by an
additional real-service database regression. Existing deterministic fixtures
establish the endpoint, linked operator, conversation and published question.
From the signed `block_actions` envelope onward, the installed adapter, Chat
SDK, runtime and unmocked service callbacks carry the flow through the actual
database. Only provider HTTP and the scheduler remain simulated.

The test opens the service-generated form and submits an invalid answer. It
checks the actual SDK context row existed and was consumed, while the durable
form token remains issued and the interaction pending. Revoking the linked
user to viewer then denies the corrected submission with one filtered receipt
and no answer or wake. Restoring operator access allows canonical answers
using the original durable token despite absent SDK thread/message context.
One durable `fallback_queued` / `wake_fallback` receipt and one correctly scoped
scheduler call result. Repeating the submission clears the modal without
changing the answer, receipt, token, audit or conversation and without a
second wake. The test ends at that queued fallback, not a native model turn.

The new case plus the existing Slack/Teams database cases pass **3/3**, with
622 other cases filtered, in **7.59 seconds**. Five adjacent files pass
**140/140**, and plain server TypeScript passes. Scoped formatting and diff
checks pass. Early failures were fixture corrections, not product defects;
this addition changes no production code. Logs are
`slack-signed-modal-service-final-0909.log`,
`slack-signed-modal-adjacent-final-0909.log` and
`slack-signed-modal-service-types-final-0909.log`. The test does not qualify a
real Slack modal, provider account, public webhook route or model execution.

Root's full fresh-database regression passes **625/625**, zero skips/failures,
in **125.87 seconds** on `chat_slack_modal_joined_20260909_root01`; plain server
TypeScript also passes. Log: `slack-signed-modal-full-root-0909.log`. This run
loaded the semantic freeze before a subsequent test-only cleanup adjustment:
independent review found serial shutdown could skip closing the fake HTTP
server if an earlier shutdown rejected. Nested `finally` now always closes
it and uses the existing endpoint-retirement helper to isolate subsequent
database workers. There is no production change or new server restart.

The final cleanup source passes the focused Slack/Teams database cohort
**3/3** in **8.38 seconds** on another fresh database and plain server
TypeScript. Log: `slack-signed-modal-service-retirement-final-0909.log`.
Root independently inspected the nested cleanup, and the diff remains limited
to imports plus the one new test. The latest actual browser probe still
reports Mac locked: no Discord login retry or live conversation was attempted.

### September 9: maximal safe capability audit reopened implementation gaps

The full goal audit distinguishes a truthful current fallback from completion
of the original maximal-safe-provider requirement. The installed Discord
adapter lacks modal open/submit hooks, and the service restricts native forms
to Slack/Teams. A read-only synthetic native modal-submit probe produced no
callback or acknowledgment. Discord itself documents text/select modals over
the existing interaction transport, so the adapter omission is not a provider
or authorization impossibility. Implementation is now in progress; no new
native Discord modal is yet qualified. See the official
[modal components](https://docs.discord.com/developers/components/using-modal-components)
and [response constraints](https://docs.discord.com/developers/interactions/receiving-and-responding).

A separate Telegram parser-to-service RED uses a valid 16×16, one-second MP4
fixture whose codec/container were checked with ffprobe. The video-note input
has no MIME/name, matching the provider schema; current intake reports an
unsupported type before any storage call. The test fails on expected one
stored file versus zero. This is a real metadata-boundary defect, not a failed
provider login. Log: `telegram-video-note-red-0909.log`; fresh database
`chat_telegram_video_note_red_20260909_root01`. Telegram's
[video-note contract](https://core.telegram.org/bots/api#sendvideonote)
identifies the format as MPEG4. The correction must remain subtype- and
file-identity-bound and preserve the policy for ordinary unknown files.

Teams' personal-chat native file consent/upload flow is another missing
implementation, supported with bot credentials and the already-generated
`supportsFiles` manifest capability. It does not justify granting Graph access
for channel/group files. The installed Microsoft SDK has accept/decline events,
but the Chat adapter does not register them. The durable consent/batch status,
upload authority and uncertainty handling are being reviewed before code.
See the [Microsoft file contract](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4).
The eligible-tenant live gate remains unresolved.

### September 9: Telegram video-note metadata repair qualified offline

The pinned Telegram parser wrapper now supplies `video/mp4` only when the raw
message is a structurally valid video note and its file ID, unique ID, size and
square dimensions exactly match the sole parsed video attachment. It does not
replace a supplied MIME type or accept an ordinary unknown document. Existing
webhook authentication, current access checks and byte limits remain in force.
No generic MIME allowlist, provider credentials or durable locator schema changed.

The final six-case service run passed on fresh database
`chat_telegram_video_note_final_20260909_root01`: current intake, new-service
restart, unknown document denial, malformed note denial, declared oversize
denial before fetch, and access revoked after receipt before restart. Successful
cases assert the exact `getFile.file_id`, downloaded/stored bytes, asset SHA256,
MIME, durable descriptor and one scheduled wake. The original fetch closure is
made unusable in restart tests. Log: `telegram-video-note-final-0909.log`; 6/6
passed, 625 other cases filtered, 5.27 seconds. This is not a full-suite run.

The helper/actual-adapter/photo cohort passed 114/114, including the real
Telegram webhook secret check; plain server TypeScript passed before the
concurrent Discord edits. The valid synthetic 997-byte MP4 is embedded in a
source fixture and was independently checked with ffprobe (16×16, one second).
Root reviewed the production helper, adapter hook, descriptor preservation and
new integration cleanup, and independently passed the helper/photo cohort
40/40 (764 ms; `telegram-video-note-root-units-0909.log`). No new live Telegram
upload or bot message was made;
server 71 still runs the previously committed production code.

### September 9: full foundation regression and filtered-suite isolation

The frozen Telegram/Discord transport foundation passes **631/631** integration
cases, zero skips, on fresh `chat_modal_telegram_foundation_20260909_root01`
(119.53 seconds; `modal-telegram-foundation-full-root-0909.log`). The snapshot
loaded before Discord service/form capability activation. Source SHA256 values:

- Integration: `5fa9b2c74cd7ce3b0a7d1898d3e3627388774445292bcdd7b55ce1760e74e1a4`.
- Service: `cb965bee7ee7c9b31399a2146dae2c6d9ace378c3b489d69f1c040e5301a4747`.
- Runtime: `303fff465c815b32b572a2f13bfef6325cb13cdcdcbf8b8ca869e48887541045`.
- Form helper: `fd0e377b6dd6e33ab953a4ff0b003a344e97abe91ca1a01ee457554786559d7e`.
- Discord patch: `d22b34be175fad332ab338860a81e0f6a4161133ecaa21c7822f3ffaa7fedec4`.

The GitHub-filtered run initially passed 148/149 and failed the native progress
fixture's global enqueue count (two versus one). Read-only inspection of its
isolated database showed the additional row was a different, earlier fixture's
failed-run milestone; the current native run still had only its one expected
progress row. The full suite had already drained that work, hiding the filtered
order dependency. The fixture now settles the global collector before creating
its own run and always retires its own endpoint in `finally`. The exact 1/0
enqueue counts, one post/edit, durable key and no-private-prose assertions are
unchanged. Fresh `chat_github_parallel_20260909_root02` then passes 149/149 with
482 other cases filtered (30.01 seconds;
`github-parallel-service-root-final-0909.log`). No production selector changed.

GitHub attachment/provider-stress/setup units pass 182/182 (1.64 seconds);
shared Slack/Teams/modal-helper tests pass 41/41 (2.30 seconds). The existing
runtime Telegram test double also needed its real parser method: it previously
caused five mock-contract failures. Adding only that method and an explicit
missing-parser fail-closed case yields 66/66 runtime/video-note/photo tests.
Root independently repeated that same cohort: 66/66, 1.05 seconds,
`telegram-runtime-mock-root-0909.log`.
Production still rejects a missing parser; no silent compatibility fallback
was introduced. This later fixture-only change is distinct from the full-run
source snapshot above. These tests simulate provider I/O, not live chats.

### September 9: Teams personal-file consent transport foundation

The pinned Teams SDK returned HTTP 200 for synthetic accept/decline invokes
without invoking a file-consent callback. Two genuine RED cases established
that gap. An explicit per-App hook now projects authenticated personal-chat
consent events and waits for the caller's durable-receipt callback before
acknowledging. The contract test replaces only the SDK service-token validator;
it is not evidence of real JWT validation, a tenant installation or a live file.

The new foundation keeps upload URLs in private fields, binds consent to the
exact actor, tenant, endpoint, source and file, and snapshots and verifies file
bytes inside the upload capability itself. PUTs use bounded, DNS/socket-pinned
HTTPS requests without redirects or bearer credentials. A final upload receipt
requires bounded JSON with matching item identity, filename and size. An
ambiguous PUT is not resent; a missing upload session is not proof of failure.
Consent acceptance, successful upload and visible file-card delivery are three
distinct states. The commercial SharePoint host family is a conservative
supported policy, not an exhaustive claim about Microsoft upload hosts.
Provider basis: [Teams file consent](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)
and [upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0).

Root reviewed all production code and independently passed **81/81** in the
two new test files (639 ms; `teams-file-consent-foundation-root-0909.log`).
The owner's new-plus-egress cohort passed **119/119**, and plain server
TypeScript passed. Independent review found no additional blocker in this
inactive foundation.

This commit does **not** activate native file output. Durable encrypted
early-consent buffering, restart restoration, per-file publication intents,
current authorization, unknown-result reconciliation and UI/batch states still
must be connected. The early-accept test retains an in-memory event only; it
does not prove restart durability. Channel/group files retain their existing
fallback without new Graph permissions. Eligible-tenant live qualification
remains outstanding. No provider request or server restart occurred here.

### September 9: Discord native form workflow and concurrency qualification

The v6 pinned adapter implements native text/select modal opening and submission,
with closed rendering limits and opaque Paperclip action IDs. Discord interaction
tokens are kept out of persisted Chat SDK context. A failed or ambiguous modal
open cannot receive a second success acknowledgment or automatic resend.
Duplicate open attempts remain unconfirmed rather than fabricating success.

The real service now checks current endpoint, source publication, thread,
principal and interaction before opening or accepting a form. Invalid answers
produce a private correction action with actor-scoped, expiring retained values.
Reopening checks the original published source again. Canonical acceptance is
durable before correction cleanup; a cleanup failure cannot relabel an accepted
answer. Identical duplicate/concurrent submissions return the existing receipt;
different answers on the same token are rejected instead of claiming acceptance.
Only one canonical answer and one fallback continuation wake are recorded.

Existing connected Discord endpoints gain modal support after successful pinned
runtime initialization without reconnecting or changing reach, agent or secrets.
Review reproduced three actual lock-wait races: runtime retirement, runtime
replacement and credential-ref changes could enable a stale capability. The
upgrade now rechecks the locked active/enabled connection, its credential
fingerprint, exact runtime instance and Gateway ownership immediately before
updating the capability. The three negative cases went RED→GREEN. Later form
admission was already fenced; this repair makes capability qualification truthful.

The first root full run passed **637/638** (125.57 seconds;
`discord-modal-final-full-root-0909.log`). Its stale-generation test hook ran on
every eligible fixture endpoint and set the target's fixed next generation before
the target initialized. The hook now receives and checks the actual endpoint ID
and asserts one target invocation. The negative capability assertion was not
relaxed. Final focused service/upgrade/lock cases pass **10/10** on a fresh
database, and the owner's adjacent cohort passes **272/272**.

Root independently passes **165/165** in seven files (6.91 seconds;
`discord-modal-final-units-root02-0909.log`) and plain server TypeScript.
Four tests instantiate the actual installed discord.js button/modal interaction
classes and real response methods, substituting only REST responses. They cover
the exact modern Label payload, snake-case input normalization, private response,
failed-open single-response behavior and token-free SDK state. The composed
service tests use actual adapter/Chat SDK/runtime with real PostgreSQL; Discord
transport and the scheduler remain simulated. They stop at `wake_fallback`,
not a native model continuation or a live modal.

Final semantic source hashes before the independent full rerun:

- Service: `fa8de8cda1dcaba55be5d3cc6204786c225dfc62f047baccd253d7a759487b5f`.
- Integration: `0ff54fd645d1919325b01929836f20cb786a4d2cb7cf5ddff884b58dfd31fce3`.
- Runtime: `303fff465c815b32b572a2f13bfef6325cb13cdcdcbf8b8ca869e48887541045`.
- Patch: `e1ffaf4879f4646c73b531e8310f64fe58ce81b3fbba2c4dbf007a2dcd471e2b`.

Root verified both patch targets with an explicit repository-relative
`git apply --check --directory` against the untouched upstream reconstruction.
A plain apply check run inside the ignored scratch folder skipped both files;
that earlier zero exit code was not valid patch-application evidence. No shared
package store or other checkout was changed. The CI-owned lockfile is unchanged;
local patch materialization is not fresh-install/release proof.

The final independent full run passes **641/641**, zero skips/failures, on
fresh `chat_discord_modal_final_20260909_root02` (123.87 seconds;
`discord-modal-final-full-root02-0909.log`). It includes the final lock guards,
scoped fixture repair and composed Discord form workflow at the hashes above.
Root also independently passes the two unchanged egress suites **38/38**
(855 ms; `teams-file-egress-root-0909.log`), complementing its 81-case inactive
Teams foundation run. No real provider browser action was possible: the latest
inventory still reports Mac locked, not a Discord login failure.

### September 9: server 72 deploys Discord forms and Telegram video notes

Root pushed Discord implementation `739750c15` after the final 641-case run.
A fresh live-database check at 04:59:53.222 UTC found 290 terminal runs and zero
active runs (latest start 02:15:47.812 UTC). Validated server 71 PID 28614 exited
cleanly before root started server **72**, PID **77253**, tool handle **44437**.
It listens only on `127.0.0.1:3137`; loaded version is
`2026.831.0+599.git.739750c15.dirty`, started 05:00:10.725 UTC and recovery-ready
05:00:14.326 UTC. Log: `server-experimental-landing-72.log`.

The dirty suffix is preserved in the evidence: inactive Teams transfer modules
and schema work were present, but had no runtime/service imports or applied
migration at startup. This is not a clean-checkout release qualification.
The ordinary native runner remains the exact qualified SHA256
`6279d39ac731e4565a638b64c93673b8ca23e6dfbc0870e24d48422497f1826d`.
No other checkout or port 3103 was touched.

Loopback and private Tailscale health returned ready. Public webhook-only Funnel
still returns 404 for a Board-health GET. Discord Gateway connected bot
`1546330979860221952`; a read-only endpoint query confirmed its stored modal
capability changed from false before restart to true afterward, with status
active. This verifies deployed automatic capability upgrade, not a successful
user modal. At 05:00:24.491 UTC run counts were unchanged. The Mac lock still
prevents live browser qualification; no new chat or model turn was sent.

### September 9: bounded Teams maintenance and owned Discord registration

Teams expiry maintenance now isolates every row, advances its bounded scan past
malformed evidence, and bounds projection lock waits to 250 ms. Genuine failing
tests reproduced both oldest-row starvation and a held endpoint lock blocking
unrelated expiry. The new scheduling cursor is memory-only, shared by services
using the same database object, and conveys no authority. Failed rows preserve
their exact stored evidence. The owner's fresh PostgreSQL cohort passes
**151/151** on `chat_teams_recovery_20260909_protocol01`. Buffered acceptance
survives expiry recovery without a second consent POST or PUT; maintenance
itself never performs provider I/O.

Discord command registration groundwork now has a closed durable descriptor
for `/paperclip status`, `new`, and `close`. It preserves other app commands,
uses individual writes only, and reconciles uncertain writes with GET rather
than blindly reposting. A public ownership marker is an identifier, not a
credential; the stored descriptor and exact provider identity remain required.
Discord's name-upsert API cannot exclude a concurrent external administrator;
the helper explicitly documents that limitation. Root independently passes
**24/24** registration/Discord unit cases. This helper is not yet registered by
the live service; SDK command acknowledgement and service admission are separate
remaining work.

Teams source/worker/callback integration is concurrently under test, not yet
deployed. Its first composed Board flow passes **4/4** with actual inbound SDK
parsing, real database admission/consent/projection, and controlled provider
ports. It verifies one exact-byte PUT and one final card after acceptance plus
three missing/ambiguous-recipient fallbacks. This is not tenant/JWT/live proof.
The browser inventory still reports the Mac locked, not a Discord login error.

### September 9: awaited Discord command boundary, still opt-in

Three genuine failing tests reproduced the installed SDK returning before a
held slash-command handler, swallowing handler failure, and routing an ordinary
publication through the private slash response context. The instance-local
Discord command hook now awaits the explicit closed handler result. Its initial
private acknowledgement means processing only; void/error results never claim
acceptance. Public publications keep their normal bot route. Exact application,
guild/install context and no-argument subcommand identities are checked, and
interaction tokens never enter the normalized event or persisted channel state.

The owner's final actual-discord.js/SDK cohort passes **189/189**, including
30 new command cases. Root independently passes **125/125** across the native
command, runtime and Teams file-consent suites. Duplicate/uncertain responses
are not automatically retried. The bounded process-local interaction-ID cache
is not a replacement for durable service admission. The hook remains inactive
until the service has a verified command registration and durable authorization;
no Discord capability was enabled or provider command created in this step.

### September 9: Teams file service composition and full-suite regressions

The service now stages an atomic content-free Board file intent for an exact
admitted personal recipient, or derives native output authority from the exact
accepted committed response and its causal inputs. Every effect rechecks the
current source, actor, reach, task generation, endpoint and credential fence.
The callback records encrypted consent without taking the sender's credential
lease, allowing genuine acceptance during the original card POST. A dedicated
worker shares the endpoint concurrency limit but never uses generic replay.
Versioned operator resolution, publication state and audit commit together.
Only a confirmed final file message, or explicit operator confirmation of that
final stage, settles delivery; card/PUT receipts cannot masquerade as delivery.

The Board composition/race cohort passes **12/12** on a fresh database. It
includes cold service reconstruction, exact bytes, independent Board-author,
sponsor and linked-user revocation, old runtime callbacks, duplicate/early
acceptance, and final-card-only retry after one confirmed PUT. The native
composition passes **8/8**: the exact file's own unknown card/final stage may
re-prove its source, but sibling unknown effects, changed origin, live attempts
and generic run retry remain denied. An actual coordinator result exposed a
`sha256:` prefix mismatch in the new guard, and cold Board Send exposed missing
runtime initialization; both were reproduced before repair.

Root's first full run was **658 passed / 27 failed**, not a passing gate.
Two scheduling mistakes caused the failures: maintenance was entering the
general message scheduler on direct drains, and draft transfer fixtures were
eligible for the dedicated worker and consumed a slot on every later service.
Maintenance is now scheduled only by the periodic drain; transfer selection
requires an exact active Teams endpoint. Five new inactive-state cases plus
the existing projection suite pass **26/26**, preserving every scoped row and
zero provider calls/worker slots. The corrected full run passes **690/690** on
fresh database `chat_teams_activation_full_20260909_root02`, with no skips,
in 134.68 seconds. Its log is `teams-activation-full-green-root-0909.log`;
the original failure log remains `teams-activation-full-root-0909.log`.
The loaded service SHA256 was `db3725aac8ebc1ec485ea3a8549c4df3cdb54e0bd112358b30a3c6da50e7bcdd`
and integration-test SHA256 was `6ead09e090d777f9ee6741018e1243f8d051b94878ed358a900e8f9e67ebf0de`.

A separate genuine test reproduced unnamed assets failing before consent:
the service chose `attachment-<attachmentId>` but the protocol compared it to
the nullable filename column. Null-only normalization now matches; empty or
unsafe stored names still fail. The fresh protocol/projection/foundation cohort
passes **157/157**, including six new filename cases.

Root's browser suite passes **31/31** (2.8 minutes), followed by **2/2** consent
journeys (14.1 seconds) after shortening repeated copy on retained receipts.
The screenshots show accurate waiting/mixed outcomes, retained files and
explicit batch dismissal. These use real Board/task/upload UI with mocked
provider/model/transfer responses, not native Teams UI. Focused UI tests pass
**96/96**, OpenAPI/batch tests **44/44**; shared/server/UI types and token gates
pass. Existing broad workspace harness failures are not reclassified as passed.
Server 72, its live database and its qualified runner were not changed.

### September 9: post-composition review and Discord activation in progress

The 690-case Teams composition was committed and pushed as `693cfa888`.
A subsequent bounded review found a real conflict-state recovery gap: the
protocol supports safe cancellation, but Activity returned no resolution
actions. An authentic conflicting-consent fixture reproduced this before the
fix (`teams-conflict-cancel-red01-0909.log`). Read-only proof now checks exact
scope/version, the stored private binding and quarantine provenance, and
coherent cleared/elapsed ownership before offering only Cancel. Mutation still
requires the existing locked, audited resolution path. Fresh protocol/projection
tests pass 90/90, Board/projection composition 39/39, and existing UI/API tests
84/84. The composed cancellation performs no upload, final-card POST or wake,
records one operator audit and allows the settled mixed batch to be dismissed.

Discord service registration now has four root composition cases passing on
`chat_discord_registration_root_20260909_01` (6.70 seconds), with mocked provider
HTTP and real registration persistence. Setup commits attempted intent before
provider POST and enables the command callback only after its durable receipt.
Registration failures leave mention/thread setup usable; a later due reconcile
upgrades it. A reconstructed unknown write is resolved by GET only. A changed
external namespace disables command admission without overwriting that command.
Review also identified that downgrading this additive capability must not tear
down a healthy Gateway. A previously installed callback stays present and
denies against current durable authority; only enabling a missing handler
requires rebuilding the runtime. The five-case root registration cohort passes
on fresh `chat_discord_registration_retention_20260909_final01` (6.54 seconds),
including failed-refresh and namespace-conflict preservation of the exact
original runtime and callbacks. Plain server types pass.

The durable ownership store and its adjacent helper/parser tests pass 61/61
on fresh `chat_discord_registration_20260909_protocol02`. Generated migration
0258 adds only an instance-wide public app/opaque owner-ID tombstone, without
cascading foreign keys or credentials. Company deletion cannot erase an
uncertain write and implicitly grant a new command owner. Provider-admin races
outside this local fence remain an explicit limitation. DB build, fresh
migration chain and snapshot consistency check pass. This is working-tree
evidence, not live Discord slash-command qualification; the parallel native
command handler cohort is still being completed.

The native handler's final bounded cohort passes 15/15 against the actual
installed adapter/SDK/runtime and real service persistence (provider ports
mocked). It covers private status, guild new guidance, DM new-generation
isolation, exact-origin replay, current permission/registration/capability
denial, a runtime/lease lost during a database wait, and rollback when the
command receipt cannot be inserted. Root then formatted only changed ranges.
Plain server types and 119 runtime/helper tests pass on the formatted source.
The deterministic Board browser suite passes 31/31 again on fresh
`chat_commands_browser_20260909_root01` (2.8 minutes), without retries.

The first combined run is **707 passed / 4 failed**, not green:
`chat-command-full-root-0909.log`, fresh
`chat_commands_full_20260909_root01`, 151.08 seconds. The five new registration
fixtures stayed eligible after runtime shutdown, polluting a later test's
exact global Gateway inventory and causing three cascading assertions. The
fixture cleanup is being corrected without weakening those assertions. The
fourth failure is an existing Slack ambiguous-retry test's `socket hang up`;
its cause is still being checked. No deployment or broad-suite completion is
claimed from this run.

After fixture-only cleanup, the corrected full run passes **711/711**, no skips,
on fresh `chat_commands_full_20260909_root02` (142.31 seconds), recorded in
`chat-command-full-corrected-root-0909.log`. Its service SHA256 is
`0565ab9d494822c022d37449a89b54a0df9f95b84acf6861d3241dcca61cbf57`,
integration SHA256 `c121c1e49acd2c0d41f75e0ab24515ab0e92fefbc93e6cfa1ec484985d6d2e1b`.
The five registration plus three existing Gateway cases also pass together
on a fresh database with their original global assertions intact. The Slack
retry case passed independently (7.14 seconds) and in the corrected full run;
no Slack production change was made and the one socket failure's exact cause
has not been established. Keep its failure log as potential harness-flake
evidence instead of describing it as a repaired provider bug.

All nine new/modified standalone command, transfer and projection source/test
files pass Prettier. Shared service/integration additions were range-formatted;
their existing whole-file formatting debt is not claimed fixed. No lockfile,
runner binary or wireframe image changed. Deployment remains a separate step.

### September 9: server 73 deployed; live Discord registration verified

The combined Discord command/Teams conflict changes were committed and pushed
as `b9461c4a6`. At `06:26:25.820 UTC`, root checked zero active runs before
stopping server 72 (PID 77253), which exited cleanly. With the server stopped,
the existing JavaScript backup helper produced the private compressed database
backup `pre-73-backup.bFPVGs/pre-server-73-20260909-012635.sql.gz` (7,762,243
bytes, directory 0700 and file 0600). No existing backups were pruned. Gzip
integrity passed; a restore has not been tested. Migration inspection showed
exactly 0257 and 0258 pending; both applied, leaving 257 journal entries and
an up-to-date schema. Backup and migration metadata are recorded in ignored
`pre-server-73-migration-0909.log`.

Server 73 is PID **11923**, tool handle **73311**, listening on
`127.0.0.1:3137`. Its loaded version is `2026.831.0+607.git.b9461c4a6`, started
`06:29:02.753 UTC` and recovery-ready `06:29:06.792 UTC`. Both loopback and
private Tailscale health returned 200/ready. Public Funnel port 8443 still
returns 404 for Board-health GET. The proxy and unrelated checkout on port
3103 were not changed. Current log: `server-experimental-landing-73.log`.

Discord's existing bot `1546330979860221952` connected, then its newly verified
native-command callback was installed through one automatic runtime rebuild.
The Gateway reconnected successfully. At `06:29:05.036 UTC`, the service stored
processed registration action `6900a77f-147b-407a-89f7-04398d73b8f0` with phase
and outcome `registered`, and real provider command ID `1547131713472430131`.
Its instance-wide ownership row points to the original company/endpoint/action;
the active endpoint now exposes slash commands and ephemeral messages. This is
real provider registration through existing secret references, not a mocked
receipt. It does **not** prove the live `/paperclip` invocation, private reply,
DM-new or close experience; those still require browser qualification.

The safe run inventory at `06:30:30.324 UTC` remained 290 terminal runs
(262 succeeded, 26 failed, two cancelled), zero active, with the latest start
still `02:15:47.812 UTC`. No new model turn or provider conversation was sent.
The qualified runner SHA256 remains
`6279d39ac731e4565a638b64c93673b8ca23e6dfbc0870e24d48422497f1826d`;
lockfile SHA256 remains
`47a7c09302d47843054d0301f8f52f3da935b9c6ac771bace0409da752b6af7f`.
Historical ambiguous deliveries and native recovery evidence were not manually
modified. The latest actual browser inventory still reports the Mac locked.
Discord login was already restored; only OS unlock is needed to resume browser
work. Teams additionally requires the previously documented eligible tenant.

### September 9: lossless text and Teams inline-picture repairs

A parallel acceptance audit after server 73 found two omitted behaviors, not
live provider failures: the safe projector silently truncated long text at
40,000 characters despite the 100,000-character Board contract, and Teams
channel/group pictures were treated as unsupported arbitrary files.

The long-text RED run reproduced all four Slack/GitHub new/existing-comment
tail losses on fresh `chat_long_publication_20260909_red01` (28.11 seconds,
`long-publication-red01-0909.log`). Removing truncation alone was insufficient:
existing-comment roots had PostgreSQL microsecond timestamps while generated
children used JavaScript millisecond timestamps, which could sort children
before their root. New transport children now preserve the exact database
timestamp. Complete source slices, closed generated Markdown fences, actual
pinned converter limits and durable per-part state preserve the safe output.
Discord/Telegram retain their existing long-Markdown file paths. Neither
prepared parts nor retries use artificial character-by-character streaming.
Previously truncated or delivered publications are not automatically rewritten
or replayed; the repair preserves newly projected complete output.

The expanded long-text cohort initially passed 11/14: three Teams cases had
invalid test setup, missing an enabled channel resource and canonical root
thread. After fixing fixtures without relaxing production reach, all 19
joined cases passed, including the three existing Discord/Telegram transports.
A 100,000-character tiny-paragraph adversary then exposed 5–6 seconds of CPU
parsing, prompting grouped whole-block processing and a per-split converter
cache. The repaired measurement was below one second for that corpus; final
formatted verification is still pending at this checkpoint. These local CPU
numbers do not explain or qualify the older provider-ingress delays.

Teams outbound initially failed both native picture cases
(`teams-inline-picture-red-root-0909.log`). The current joined cohort passes
13/13 on a fresh embedded database (10.25 seconds,
`pictures-text-outbound-composed-root-0909.log`): channel/group pictures,
actual pinned SDK/App HTTP serialization, unsupported-image fallback,
source/reach withdrawal, lost/empty receipts without resend, and a combined
100,000-character Board send followed by its exact original PNG. Picture
messages use original bounded PNG/JPEG/static-GIF bytes, not a public asset
URL. Personal-file consent remains a separate staged path. A successful SDK
call with no usable message ID now remains `delivery_unknown`.

Inbound source-bound pictures passed an initial 18-case service/reference
cohort and 83 helper/runtime checks. Review then reproduced two further edges:
a pending source edit/delete could arrive while image download held the
conversation drain, and the SDK could await token acquisition before applying
its HTTP timeout. Both require explicit new-lane guards and regression tests;
do not treat the earlier green cohort as final signoff. The final combined
integration/browser run and deployment are still pending.

Supporting root checks pass shared/UI types, 85 focused UI tests, eight
OpenAPI route checks and 107 adjacent picture/consent/Discord command tests.
An initial root Vitest invocation used a nonexistent project filter and ran
no tests; the corrected server-directory invocation produced the 107 passes.
No live tenant/browser picture journey is claimed. The Mac remains locked;
Discord login itself was already restored. No runner binary, lockfile,
wireframe image or historical recovery evidence was changed.

Final source is now frozen and independently reviewed. The intake fixes pass
21/21 joined service/reference tests and 84/84 helper/runtime tests. Exact
pending source edits/deletes invalidate download registration at each short
authorization gate. The actual SDK held-token regression proves the outer
deadline settles and a late token release cannot issue HTTP. The two-image
service case injects budget expiry to prove only one shared budget and no
second request; it is not a real ten-second timing benchmark. The budget
applies only to token/download work, not DB/storage commit cancellation.

Root's final combined integration run passes **749/749**, no skips, on fresh
`chat_pictures_text_full_20260909_root01` (177.75 seconds), recorded in
`pictures-text-full-root-0909.log`. The deterministic browser suite passes
**31/31**, no retries, on separate fresh
`chat_pictures_text_browser_20260909_root01` (2.9 minutes), recorded in
`pictures-text-browser-root-0909.log`. This uses real Board/task/upload flows
with simulated provider/model ports, not live-account qualification.

The formatted final helper/runtime cohort passes **163/163** in seven files
(11.34 seconds). Shared, server and UI plain TypeScript checks pass. Eight
standalone source/test/type files pass Prettier; new shared service/integration
ranges were formatted without rewriting their existing whole-file debt.
An initial style check caught a new test file's formatting; that was corrected
before the final helper run. Full workspace build/test was not rerun and is
not claimed. The qualified runner and CI-owned lockfile remain unchanged.

Final tested source SHA256 values:

- service: `e60faa5dbee6e54642f336fed6a768104f34c178e3664bd128a2c0cb8342a0aa`
- integration: `3a7c57bd2fccbb439335d80de3e2e2882fc92a5248a22c4c168bba580e0418db`
- runtime: `76aa0ae12faa310ca510a36c78a2befb467a1d245ec1bfe8774353980974cfb1`

At `07:05:05.965 UTC`, the live inventory still showed only the same 290
terminal runs (262 succeeded, 26 failed, two cancelled) and no active run.
Deployment remains a separate next step; no old failed or uncertain turn was
manually rewritten or replayed to manufacture this result.

### September 9: server 74 deployed after full regression

Committed and pushed `cfbda24be` with the verified long-text and Teams-picture
changes. At `07:06:44.529 UTC`, a fresh inventory showed zero active runs before
server 73 (PID 11923, handle 73311) received SIGTERM and exited cleanly. With it
stopped, the existing JavaScript backup helper produced
`pre-74-backup.MYm5xK/pre-server-74-20260909-020706.sql.gz` (8,035,012 bytes,
private directory 0700/file 0600). No backup was pruned. Gzip integrity passed;
restore has not been tested. Migration inspection remained up to date with
257 journal entries; no migration was applied for this change.

Server **74** is PID **7070**, handle **34451**, listener `127.0.0.1:3137`,
loaded version `2026.831.0+609.git.cfbda24be`. It started at `07:07:32.964 UTC`
and reached recovery-ready at `07:07:39.382 UTC`. Loopback and private
Tailscale health returned 200/ready; the public Funnel Board-health check
returned 404. The existing Discord bot reconnected its Gateway. The API still
reports the original Discord, GitHub, Slack and Telegram endpoints active.
This is server/configuration readiness, not a newly sent provider conversation.

At `07:08:52.041 UTC`, the live database still had 290 terminal runs
(262 succeeded, 26 failed, two cancelled), zero active; the latest start was
still `02:15:47.812 UTC`. Native runner and lockfile hashes remain unchanged.
The proxy and unrelated checkout on port 3103 were not touched. Runtime log:
`server-experimental-landing-74.log`; backup/schema metadata:
`pre-server-74-backup-0909.log`, both ignored local artifacts.

A fresh post-deployment browser attempt again reported the Mac locked and
automatic unlock unavailable. Discord login was already restored; OS unlock
is the remaining browser gate. Teams separately still needs an eligible
tenant. No new live model/provider result, historical recovery or complete
production-readiness claim is made from this deployment.

### September 9: truthful Teams pre-send file guidance

The restored Discord login was acknowledged, but the signed-in browser tool
still reported an OS lock. Read-only checks confirmed server 74 (PID 7070,
loaded `cfbda24be`) ready and all four original configured endpoints active.
No live message, credential change or restart was performed for this check.

Source inspection found that the Board composer still promised a consent card
for every Teams file even after channel/group pictures gained direct transport.
The updated assertion reproduced that mismatch (one failed Teams case, one
passing GitHub case; 25 unrelated cases filtered). Corrected guidance separates
personal consent from supported channel/group images and private-task fallback.
The complete composer component suite then passed **27/27**; both deterministic
Teams file-consent browser cases passed on fresh
`chat_teams_guidance_browser_20260909_root01` in 14.1 seconds, with no retries.
Root inspected the pre-send screenshot: guidance is readable and unclipped;
selected files and the still-disabled empty-message Send control remain clear.
This is local Board UI evidence with simulated publication, not live Teams.

Logs: `teams-file-guidance-red-root-0909.log`,
`teams-file-guidance-green-root-0909.log`,
`teams-file-guidance-browser-root-0909.log`. Screenshots remain ignored test
artifacts, not repository wireframes. Token gates and targeted Prettier checks
pass. Slack receipt and Telegram media repairs are proceeding independently;
their findings and eventual verification must be recorded separately.

### September 9: Slack receipt latency and source-bound Telegram media

Two bounded parallel audits produced new reproducible defects, independent
of the blocked signed-in browser. No claim ties them to the historical
61.5/234-second pre-ingress delays.

Slack's nonessential acknowledgement shared the endpoint credential lease
with final output and used the ordinary 45-second message timeout. A held
reaction regression kept an already-ready same-endpoint final absent after
3.5 seconds. The new reaction-only transport has a two-second abort deadline,
awaits local headers/body transport settlement before releasing authority,
keeps an 8 KiB response ceiling and exposes only closed error codes. Durable
receipt actions own retry; the helper does not retry itself. An independent
review probe caught HTTP 429/503 carrying `already_reacted` being mistaken for
acceptance; those now remain HTTP failures.

One-shot receipt cleanup now includes Slack. Exact final-run input selects
the admitted delivery even when final output beats creation of its add row.
The durable terminal marker suppresses a late original add and leaves another
message's receipt alone. Same-source native retries do not mint new eyes;
native Slack status owns working-state feedback. This is not a claim of
atomic remote ordering after an ambiguous transport or that every task/file
operation ended with the text response. No new per-run reaction protocol or
row lock across provider I/O was introduced.

Slack's frozen cohort passes **9/9** joined tests and **89/89** helper/adjacent
tests, plus plain server TypeScript. Logs: `slack-receipt-held-red-0909.log`,
`slack-receipt-cleanup-red-0909.log`, `slack-receipt-frozen-joined-0909.log`,
`slack-receipt-frozen-units-0909.log`, `slack-receipt-frozen-types-0909.log`.
Two expanded filtered cohorts hit an older session-status fixture's pending
milestone before a later global count assertion. Their failed logs remain;
older assertions were not changed. New fixtures retire their own endpoints
and synthetic retry state. The full suite still supplies the ordering verdict.

Telegram's four initial service regressions rejected valid video/voice with
omitted optional MIME, dropped Live Photo parts, and advertised a 25 MB limit
despite the deployment default. Runtime-owned source provenance now binds the
exact media subtype, file IDs, author, message/topic and current endpoint
credential generation. A closed durable locator survives restart; its digest
detects corruption but is not authorization. The service separately rechecks
the exact admitted descriptor and current source/reach before download, after
download and before attachment registration. Ordinary unknown documents do
not enter this lane. Bounded MP4/Ogg-Opus/MP3/GIF inspection identifies supported
missing-MIME media; it is container screening, not complete codec decoding.
Live Photos retain their video and optional original static photo.

Review reproduced an Office-filename inference bypass; identification now
uses original missing/generic MIME, not the filename-inferred type. Valid MP4
named `.docx` imports as video; invalid bytes with that name are rejected.
Corrupt restart locators and malformed Live Photos produce an explicit
omission rather than an empty agent wake. Failure guidance uses the configured
attachment ceiling. The pinned attachment-factory seam is checked at startup.

The final Telegram cohort passes **21/21** (14 new, six video-note and one
existing media case) on fresh `chat_telegram_optional_media_20260909_final01`;
helper/runtime checks pass **85/85**, and plain server TypeScript passes.
A separate fresh process with `PAPERCLIP_ATTACHMENT_MAX_BYTES=2097152`
passes its service rejection case with 2 MB guidance. Logs are
`telegram-optional-media-{red01,final01,units-final,types-final,cap01}-0909.log`.
Independent review found no remaining code blocker. Provider HTTP is simulated;
no Telegram/Slack live conversation, historical replay or deployment is implied.

Root has started the final full integration/browser regression on separate
fresh databases. The test-it-for-real live journey remains blocked by OS lock,
not another Discord login. Runner/lockfile hashes remain unchanged.

The first combined full run returned **767 passed, three failed** in 162.54
seconds on `chat_receipts_media_full_20260909_root01`. One older Telegram test
still expected 25 MB. The Slack denied-action test saw two scheduled callbacks
instead of one after terminal cleanup was added, and the new Telegram video
test observed two wake callbacks after draining global pending deliveries.
Those counts require source-specific diagnosis; they are not waived as flakes
or fixed by weakening the assertions. No deployment followed this failure.
Log: `receipts-media-full-root-0909.log`.

Separately, the full deterministic browser suite passed **31/31**, no retries,
on `chat_receipts_media_browser_20260909_root01` (2.8 minutes), and the final
six-file helper/runtime cohort passed **127/127** (6.86 seconds). Shared,
server and UI plain TypeScript checks pass. Six standalone changed files pass
Prettier; shared file formatting is limited to the edited ranges. The initial
root helper command included two nonexistent filters and ran four actual
files, passing 98 tests; the corrected six-file result is the final cohort.
Logs: `receipts-media-browser-root-0909.log`,
`receipts-media-helpers-final-root-0909.log`, and
`receipts-media-{shared,server,ui}-types-root-0909.log`.

Diagnosis of all three full-suite failures was test-only. The Slack test
reproduced in isolation: setup-final publication legitimately scheduled its
new one-shot receipt cleanup. The corrected fixture proves the exact setup
removal settles before starting the denial scenario; its original one-task,
one-ephemeral-notice and no-redelivery assertions remain unchanged. Fresh
RED → GREEN and the final ten-case cohort pass, with server types clean.

The preserved failed database shows exactly one wake receipt for the new
Telegram video. The second global-sweep callback belonged to an earlier
Slack `deferredChatQueueFixture(admissionFails=true)` source
`C-DEFERRED-NOTICE:1999000.1`, in a different company and agent. This was not
the denied-action test's cleanup and was not duplicate Telegram admission.
The Telegram replay now targets its exact delivery and still requires one
wake, the correct agent and one matching durable receipt. The stale 25 MB
test now uses the actual configured limit and retires its fixture reliably.
The repaired 22-case Telegram cohort passes on a fresh database under a
2 MiB configured ceiling; server types also pass. Production source did not
change for these test repairs. Logs: `slack-denial-scheduler-{red,green,final,types}-0909.log`,
`telegram-optional-media-repair01-0909.log`, and
`telegram-optional-media-repair-types-0909.log`.

Root's fresh full-suite repeat uses `chat_receipts_media_full_20260909_root02`.
Frozen source SHA256 values at start:

- service: `5d4222782cba6036626bed6c413e059183838b2a21d751e8a27c4188d146825d`
- integration: `b3c3ba9944a88ecf550035d723a91a18f6eb5af69d8e1cf04b2ebf5459fc6145`
- runtime: `6dea30a19246d50c4274cf37adaa769d973098e7ba515caf009a7e14bbe8daaa`

The full-suite repeat passed **770/770**, zero skips, in **149.26 seconds** on
`chat_receipts_media_full_20260909_root02`; log
`receipts-media-full-final-root-0909.log`. The three source hashes above remain
unchanged. The failed first run remains preserved rather than reported as a
pass. The 31 browser and 127 helper/runtime passes stand; test-only repairs
also passed plain server TypeScript. Full workspace build/test was not rerun
and is not claimed. Runner binary and CI-owned lockfile remain unchanged.

A read-only live inventory at `07:36:42.375 UTC` still showed the original
290 terminal runs, zero active; the latest start remained `02:15:47.812 UTC`.
Deployment follows a separate fresh quiescence check. No provider result or
historical recovery was manufactured to obtain this verification.

### September 9: server 75 deployed after the corrected full pass

Committed and pushed `33b2be903`; the earlier Teams copy fix is `bc232f2b0`.
The listener identity, loaded version and live run inventory were rechecked
at `07:37:35.378 UTC`: server 74, PID 7070, had zero active runs. SIGTERM
completed with exit 0. Its stopped database was backed up to private
`pre-75-backup.PHjeDm/pre-server-75-20260909-023746.sql.gz`, 8,246,249 bytes,
directory 0700/file 0600. Gzip integrity passed; restore remains untested.
No backup was pruned. Migrations were already current with 257 journal entries.

Server **75**, PID **23408**, handle **4206**, started at `07:38:05.805 UTC`
with loaded version `2026.831.0+612.git.33b2be903` and reached recovery-ready
at `07:38:09.706 UTC`. Loopback and private Tailscale health returned 200;
public Funnel Board-health remained 404. Discord Gateway reconnected the
existing bot. All four original configured endpoints remained active.

At `07:38:31.515 UTC`, the database still showed 290 terminal runs and zero
active, with latest start `02:15:47.812 UTC`. The qualified runner and CI-owned
lockfile hashes are unchanged. The proxy and other checkout on port 3103
were not touched. Runtime and backup metadata logs are
`server-experimental-landing-75.log` and `pre-server-75-backup-0909.log`.

No new live provider conversation was possible: the in-app browser continued
to report a locked Mac, although Discord login had been restored. This is
deployment/configuration evidence, not proof of provider UX or completion.
The current handoff also records the bounded read-only Telegram 10.3 audit's
separate rich-input, ephemeral-identity and draft-stop qualification gaps.

### September 9: remove artificial completed-response pacing

The ready-publication producer inserted 75 ms between 280-code-point chunks
even though the complete externally approved answer already existed. Actual
pinned Slack and Telegram native/group adapter regressions observed ten such
waits for a 2,880-character answer. This is 750 ms of avoidable requested
producer delay, not an explanation for the historical minute-long delays
before Express ingress. The original RED log is `ready-stream-red04-0909.log`
(four failures, including the batching regression; 19 existing passes).

The producer now defaults to zero delay and 2,000-code-point ordinary batches.
Native adapter backpressure, Telegram draft/edit pacing, rate-limit handling,
and awaited final receipts are unchanged. The stream receives only projected
publishable text, never model reasoning or run/tool events. Explicit internal
pacing options remain bounded and tested.

Independent review found that a larger batch of cached Slack mentions could
expand past the documented native limit: 1,996 source characters became a
12,974-character chunk with a synthetic 21-character Slack ID. The actual
pinned Web API buffer/serialization test reproduced that failure in
`ready-stream-mention-red-0909.log`. Literal `@` and conservative `&` content
therefore retain the prior 280-code-point batch. Encoded-mention probes did
not expand in the current renderer; the ampersand guard is conservative.
The separate existing unbroken-paragraph expansion case is not fixed here.

The final six-file repeat passes **161/161** in 9.68 seconds
(`ready-stream-final-0909.log`), including provider-sized cached mentions,
Unicode/fences, ordinary paragraphs, Telegram rich drafts/group final pacing,
projection, transport errors, text parts and published-adapter tests.
The actual service safe-projection case passes on fresh isolated PostgreSQL
(`ready-stream-joined01-0909.log`, 7.16 seconds); its larger fixture still
asserts multiple bounded chunks and exclusion of private reasoning.
The running server is still 75; this is not a live latency/UX qualification.
Plain server types and targeted formatting passed. The isolated fix is
committed/pushed as `a5ac8c7cc`; no runner/lockfile change was staged.

### September 9: isolated PostgreSQL interruption and recovery

The shared local PostgreSQL log records backend PID 23977 killed with SIGKILL
at `07:49:34.230 UTC`, followed by automatic process restart/WAL recovery and
readiness at `07:50:13.305`. The sender/cause of the signal is unknown; a narrow
macOS log lookup did not identify it. Disk and current memory inspection did
not show exhaustion. No manual database reset or server restart was performed.

Boole's rich-content final-01 compatibility run failed all 32 cases at fixture
seeding with `57P03`, before behavior assertions. Its log/database remain as
failure evidence and were not reused. At `07:51:06.576`, root verified the
database was no longer in recovery, server 75 returned healthy/ready, and
the live inventory remained 290 terminal runs (262/26/2), zero active. The
fresh final-02 compatibility repeat subsequently passed 32/32 in 7.46 seconds;
the rich helper/runtime suite passed 96/96 and plain server types passed.

### September 9: bounded rich input and private callback responses

Committed/pushed `b9802d9e4`, not yet deployed. Boole's rich-input normalizer
restores ordered quotation/credit/paragraph content and native rich document
attachments before the pinned parser. Unknown, malformed, overly deep/large
content produces an explicit omission; draft-only thinking and private button
capabilities never enter the projection. Rich file paths, IDs, metadata,
author/message/topic and source revision remain bound through restart and
current-source rechecks. No generic unknown-document MIME allowance was added.

James's private-notice transport is callback-only. Actual authenticated
Telegram dispatch creates opaque immutable provenance; stored receipts alone
do not confer send authority. Group replies use explicit recipient-bound
ephemeral parameters, while verified exact-actor private chats retain ordinary
DM notices. Both use fixed neutral text, current identity/reach/credential
checks, and the first service-entry 15-second deadline. Neither unknown
acceptance nor expiry permits public or unsolicited-DM fallback. Native
ephemeral input cannot enter ordinary work under the reused `chat:0` identity;
private commands and the generic ephemeral capability remain disabled.

Independent review found and fixed two regressions: the initial implementation
lost safe DM denial notices, and taking the clock after a slow body read could
extend the window. Genuine RED→GREEN tests cover both. The clock also begins
before service endpoint/lease/runtime-readiness awaits; a joined delayed-
readiness case proves no extension. API receipts prove acceptance, not that a
recipient's client displayed the message.

Final fresh Telegram integration: **154/154**, 44.67 seconds
(`telegram-private-all-telegram-final-0909.log`). New private plus retained
legacy cases: **20/20**, 8.18 seconds
(`telegram-private-service-clock-final-0909.log`). Runtime/helper/mock suite:
**51/51**, 1.41 seconds (`telegram-private-runtime-final-0909.log`); plain
server types passed. The actual webhook DM fixture now includes the required
bot-authored source/receipt and a genuine same-ID retry; its one-notice and
durable-write-failure 503 assertions remain. Invented action-only Telegram
fixtures retain token/audit/continuation assertions but no longer assert a
public fallback without authenticated provenance.

A final read-only trace found a separate retained-input gap: older queued
Telegram `chat:0` messages lose raw ephemeral markers during hydration, and
processed deliveries with pending wakeups bypass hydration entirely. That
targeted admission/wakeup repair is in progress before combined verification
and deployment. No live rows are asserted to have that condition, and no
historical input/comment/run was rewritten.

### September 9: retained Telegram zero-source recovery fencing

Older normalized Telegram message-ID-zero receipts could bypass the new
authenticated ingress guard after restart, because hydration restores
`raw: {}`. A processed receipt with a pending inbound wake also bypasses
hydration. Genuine RED cases covered received/retry/stale-processing input
and issued wake authority; positive and nonnumeric legacy controls remained
admitted.

The repair rejects exact numeric zero identities, independently retained
zero sequence/event identities, and direct raw message ID zero. Cold recovery
filters with a fixed reason before message/attachment hydration; a processed
pending wake independently rechecks zero-source authority. Original normalized
evidence, task/comment history and action payloads remain unchanged. Rejection
cannot launch an agent, create work or publish provider feedback.

Root found a precision flaw in the first filter: comparing a PostgreSQL
microsecond timestamp against its JavaScript Date round trip could match no
row, while still continuing settlement. An actual `123456`-microsecond
regression failed with the receipt still processing
(`telegram-zero-micros-red01-0909.log`). The final filter uses a scoped
`FOR UPDATE NOWAIT` transaction, revalidates current source/state/thread and
claim readiness, and requires `UPDATE RETURNING` plus successful commit before
settlement/cache removal. Lock contention stops that drain; it does not settle
another worker's action. A freshly committed claim and a replaced positive
source are preserved.

Fresh `chat_telegram_zero_micros_20260909_green01` passes **47/47** in 9.07
seconds: 15 recovery cases and 32 adjacent rich/media cases
(`telegram-zero-micros-green01-0909.log`). Plain server types pass
(`telegram-zero-micros-types-final02-0909.log`). Independent review found no
additional blocker. Root's separate 13-file helper/runtime repeat passes
**298/298** in 14.70 seconds (`private-rich-helpers-root-0909.log`). Combined
full integration and deterministic browser verification are still running;
server 75 remains unchanged. No new live-provider UX is asserted.

### September 9: confirmed remaining Slack rendered-chunk boundary

James's bounded read-only probe used the actual pinned Slack adapter 4.39 and
Web API 7.19 with the committed publication producer. An unbroken
`@x `.repeat(900) paragraph plus a tail marker, with a normal-length cached
Slack ID, expanded from 2,704 source characters to one 13,504-character native
chunk despite source batches at most 280. A multi-paragraph control remained
bounded. The renderer holds an incomplete paragraph until completion, then
resolves cached mentions; the Web API streamer flushes the whole buffer.

A local native stub enforcing Slack's documented 12,000-character boundary
accepted an earlier prefix, then rejected the oversized chunk. The path threw
without a final receipt or fallback. This is deterministic evidence of a
remaining partial-response failure, not a live provider test. The narrow next
repair is after mention resolution in the existing Slack adapter patch, with
the Web API's pending buffer included in the bound. Preserve exact text,
codepoints/provider tokens and per-fragment confirmed-send state so a later
failure never duplicates an accepted prefix through fallback. No patch or
installed dependency was changed during this read-only review.

### September 9: combined regression and server 76 deployment

Root's fresh `chat_private_rich_full_20260909_root01` passes **812/812** chat
integration tests in 185.47 seconds (`private-rich-full-root-0909.log`). The
separate fresh `chat_private_rich_browser_20260909_root01` passes **31/31**
deterministic browser cases in 2.8 minutes
(`private-rich-browser-root-0909.log`). The 13-file helper/runtime repeat
passes **298/298**; shared/server/UI plain types pass. These suites simulate
provider/model boundaries and do not qualify a new live conversation.

Root preserved unrelated existing formatting in the large integration file
and verified the new retained-zero section against Prettier. The final service
and integration hashes exactly matched Boole's independently reviewed freeze.
Service formatting and `git diff --check` pass. No full workspace build/test
claim is made; the guarded native runner and CI-owned lockfile were not rebuilt
or modified. Recovery fencing is committed/pushed as **`52a46cbf6`**, following
the already-pushed rich/private and ready-output fixes.

The live inventory at `08:14:57.129 UTC` remained 290 terminal runs (262
succeeded, 26 failed, 2 cancelled), zero active, with latest start
`02:15:47.812 UTC`. PostgreSQL was not in recovery. Root stopped only server
75 PID 23408; its graceful drain interrupted zero runs and handle 4206 exited
zero. The stopped database was backed up in private
`pre-76-backup.gKWl0c/pre-server-76-20260909-031506.sql.gz`: 8,498,228 bytes,
directory 0700/file 0600, gzip integrity passed, restore untested, zero backups
pruned. Migration inspection was up to date, journal count 257; no migration,
database reset or historical replay was performed.

Server **76**, PID **45500**, handle **38031**, started at
`08:15:25.777 UTC` and completed startup recovery at `08:15:29.173`.
Its loaded version is **`2026.831.0+616.git.52a46cbf6.dirty`**; the suffix
reflects only three in-progress documentation files, not uncommitted runtime
source. Loopback and private Tailscale Board health returned 200/ready;
public webhook-only Funnel Board health remained 404. Discord Gateway
reconnected bot `1546330979860221952`. At `08:15:48.704`, the original four
configured endpoints were active and the run inventory remained unchanged.
Runner SHA256 `6279d39ac731e4565a638b64c93673b8ca23e6dfbc0870e24d48422497f1826d`
and lockfile SHA256 `47a7c09302d47843054d0301f8f52f3da935b9c6ac771bace0409da752b6af7f`
are unchanged. Proxy 27961 and the other checkout on 3103 were not touched.

Live provider UI remains unverified for these changes: the in-app browser
still reports a locked Mac, despite restored Discord login. Native Telegram
generation-stop and the reproduced Slack rendered-paragraph limit remain
open work. Teams still requires an eligible tenant. This is a verified
deployment checkpoint, not completion or production-readiness certification.

### September 9: preserve chat patches in the published server package

Root and independent review confirmed a release-path gap: the server bundled
only ACPX. `createBundledInstallManifest` removes other dependencies during
bundle staging, and `selectBundledDependencyPatches` applies patches only to
bundled package names. npm consumers do not inherit this repository's pnpm
patch policy, so ordinary dependency installation would lose the five adapter
patches and Discord transport patch.

Seven new contract checks failed before the manifest repair
(`chat-packaging-red-0909.log`). The server now bundles all five exact 4.39.0
adapters plus an explicit exact `@discordjs/ws@1.2.3`, retaining ACPX. Tests
require every configured patch to be selected, preserved in the publish
manifest and passed to the corresponding staging target, and reject a wrong
transport version. The existing vendored-runner fixture was extended for the
additional bundled packages without dropping its ACPX assertions. Final
packaging checks pass **22/22** (`chat-packaging-final-0909.log`).

For stronger artifact evidence, root used the actual production staging
helper in isolated `chat-release-stage-OMXfFR`, with a minimal application
entry point, the changed server manifest, and a frozen snapshot of patches
at `1a0a77025`. npm installed 290 packages with lifecycle scripts disabled;
all seven full patches applied. The initial inspection used CJS resolution
for an ESM-only adapter and failed; that probe was corrected without
reinstalling or modifying the staged package. The final ESM-aware inspection
confirms Discord's actual `discord.js` resolves the patched top-level
`@discordjs/ws/dist/index.js`, not a nested unpatched copy. npm pack dry-run
lists all seven bundled package manifests among 21,852 files. Entry-point
hashes and paths are recorded in
`chat-package-stage-inspect-root01-0909.log`; the installation/patch log is
`chat-package-stage-root01-0909.log`.

This qualifies the dependency-bundling path at that frozen patch snapshot,
not a full built-server clean installation or the in-progress newer Slack and
Telegram patches. Live node_modules, server 76, the guarded runner and
CI-owned lockfile were not changed. Full clean-install/lockfile reconciliation
remains a release prerequisite.

### September 9: Slack rendered stream bounded after mention resolution

The final pinned-adapter baseline fails 28 cases and passes 10; the candidate
passes all 38. The repair splits the rendered output after mention resolution,
accounts for Web API buffered tails and preserves exact text, Unicode scalars,
Slack tokens and escaped entities. An indivisible oversized token fails before
its send. Once any prefix is accepted, subsequent iterator, rendering, lookup,
append or stop failures remain ambiguous delivery rather than replayable failure.

Native start, append and stop receipts must be coherent: explicit success,
nonempty numeric timestamp, consistent message identity and matching channel
when provided. The first start receipt is checked even when all content remains
buffered. Unsupported-method fallback requires an explicit coherent provider
rejection before any effect; a malformed HTTP-success error body cannot trigger
a second send. Independent review supplied two genuine regressions for those
partial-prefix and malformed-error boundaries.

Candidate and adjacent checks pass 106/106; plain server types pass. Root
backed up the installed single-link Slack leaf and applied only the reviewed
delta with `apply_patch`. It exactly matches candidate SHA256
`79040db22140a2969eb4c5d0e93334e2e1c632615608b2c8a474901f5c2354f2`.
The default-import installed-adapter repeat passes **192/192** across six files
in 8.44 seconds (`slack-rendered-installed-root01-0909.log`). This is stronger
than a candidate override but is still deterministic SDK/provider-stub evidence.
Server 76 has not been restarted; do not call this fix deployed. The guarded
runner and CI-owned lockfile hashes remain unchanged.

James independently downloaded the pristine public Slack 4.39.0 tarball,
verified npm's SHA512 and applied the full patch with the production bundle
helper in isolated `slack-release-final.HcIlHL`. The resulting entry point
matches `79040db2…`; packaging contracts pass 22/22 and real SDK checks pass
38/38. A real npm 10.9.7 pack/extract contains all seven bundled packages;
Slack and its Web API/shared/chat dependencies resolve inside that archive,
and the same 38 checks pass from the extracted bytes. Logs are
`slack-release-{packaging-tests,helper,staged-stream-green,archive-inspect-final,archive-stream-green}-0909.log`.
This still uses the minimal server-entry fixture, not a new production server
build, and other adapters retain the prior frozen patch baseline.

The user reported restoring Discord login. The actual browser controller still
returned a locked Mac, not a provider login page; root requested an unlock and
continued the independent code/test lanes. No new Discord journey is asserted.

### September 9: exact Telegram private-draft Stop qualification

The pinned adapter did not subscribe or dispatch native generation-stop events
and allocated process-local draft IDs. The implemented handshake gives each
private approved-output draft durable, company/endpoint-scoped ownership in
`chat_actions`, binding conversation, publication attempt, runtime, credential,
bot/chat/topic and approved-text digest. The authenticated actorless provider
callback can stop only that presentation; it never cancels the current model
run or modifies the saved answer. Native draft requests enable Stop and remove
the temporary preview on Stop. The stopped outcome skips permanent publication
without inventing a provider message ID or counting a cancelled part as sent.

Stop and final-send arbitrate under the same publication-first lock order.
Stop does not acquire the sender's credential lease, so a callback inside the
first draft HTTP request cannot deadlock against it. Once final-send owns the
claim, a late Stop cannot pretend to undo that in-flight send. Callback commit
failure crosses the real webhook acknowledgement barrier as HTTP 503; exact
retry may commit once. Unknown final delivery remains non-replayable after
restart. Each new draft/final boundary rechecks current source and authority.

Independent review found that retaining random draft IDs in endpoint-owned
actions was insufficient: company/endpoint deletion erases those records.
The proper generated migration `0259_lively_runaways.sql` adds the content-free
instance sequence `chat_telegram_draft_ids`, positive 31-bit, cache one and
noncycling. The schema is exported; DB build, numbering/safety checks and
snapshot drift pass. A disposable fully migrated PostgreSQL regression proves
no table ownership dependency, rollback consuming an ID, 64 concurrent distinct
allocations, and two refusals after the maximum instead of wrapping. Sequence
and snapshot checks pass **2/2** in 2.26 seconds
(`telegram-draft-sequence-regression-0909.log`). Restoring an older database can
rewind the high-water mark; disaster-restore non-reuse is explicitly unqualified
in `doc/DATABASE.md`, not established by ordinary transaction rollback tests.

Fresh joined service coverage passes **13/13** in 6.76 seconds
(`telegram-stop-service-fourth01-0909.log`), covering first-request Stop, saved
answer/run preservation, cancelled batch accounting, restart/successor,
same-bot hard deletion/rebind, real verifier commit failure/retry, wrong scope,
changed source/credentials and late final. Earlier failed attempts were fixture
bootstrap, runtime-instance warming, getter arity and restart API mistakes;
their logs are retained and do not count as passes. Transport/helper checks pass
**19/19**; post-format plain server types pass. Independent frozen-source review
is clear. Root preserves unrelated formatting in the large integration file.

The full tracked patch applies with the production bundle helper to an isolated
pristine upstream package, reproducing JS SHA256
`daa1c1260e295468c4ccc86f191345988d3fdd320f099cbb9fd0b60920c53ed7`
and declaration SHA256
`8c13603cd31bc01a5e42b4aada8cf6f859a05832d85a53ef9cb88d452379c2df`.
Those materialized bytes pass 19/19, with packaging contracts 7/7
(`telegram-stop-release-{roundtrip,tests}-0909.log` and
`telegram-stop-package-contract-0909.log`). Root separately backed up the
installed single-link leaves and applied only the reviewed delta with
`apply_patch`; both match the same candidate exactly. The default-import
combined helper/runtime suite passes **348/348** across 14 files in 11.36
seconds (`native-streams-helpers-root-0909.log`). DB/shared/UI plain types pass.

Full chat integration passes **825/825** in 174.88 seconds and deterministic
browser checks pass **31/31** in 2.8 minutes on separate fresh
`chat_native_streams_{full,browser}_20260909_root01` databases, each migrated
through 0259 after confirming zero fixture companies
(`native-streams-{full,browser}-root-0909.log`). Root formatted the two new
helper files and verified identical esbuild-emitted JavaScript, then repeated
the installed transport/helper checks: 19/19. The first equivalence probe used
a compiler API unavailable in TypeScript 7; the esbuild probe succeeded without
source changes beyond formatting. Existing unrelated runtime/integration
formatting was preserved. Server 76 remains
unchanged; the live DB has only 0259 pending. At `08:44:14.406 UTC`, its run
inventory was still 290 terminal/zero active, latest start `02:15:47.812`, and
PostgreSQL was not in recovery. No live migration or new provider conversation
has happened at this checkpoint. Runbook TG4a records the required actual
client Stop journey separately from deterministic race coverage.

### September 9: existing Telegram subscription upgrade guard

After the preceding full pass, root found a deployment gap: only configure or
reconnect sent the new `stopped_message_generation` subscription. An existing
bot with an explicit older update list would advertise Stop but never deliver
its callback. This is why the passing new-connection cases were insufficient.

The safe first repair records a content-free subscription receipt only after
the exact `setWebhook` request returns literal `ok: true` and `result: true`
under the credential lease. It binds bot, current runtime generation, credential
fingerprint and expected callback URL hash. Missing or stale proof leaves
private Telegram on one ordinary complete final response—no Stop button and no
uncontrolled process-local native draft. It does not strand normal replies or
require an operator to reconnect. Automatic upgrade of existing subscriptions
is the next maintenance slice; do not call that already implemented.

Seven new cases genuinely failed without the guard. With it, all **20/20**
Stop integration cases pass on fresh `chat_telegram_stop_gate_20260909_green01`
in 8.47 seconds (812 unrelated cases skipped). These include missing proof,
stale bot/generation/credential/URL scope and malformed boolean provider
receipts, with actual pinned ordinary output retaining the complete tail and
making no draft request. Logs: `telegram-stop-gate-{red,green,types}-0909.log`.
Plain server types pass; unrelated formatting is preserved. This targeted
repeat follows, rather than substitutes for, the preceding 825/31/348 pass.

Server 76 was already stopped for cutover when root found the gap, so the
restart was held until this guard was qualified. Its last inventory at
`08:46:53.650 UTC` remained 290 terminal/zero active; graceful drain interrupted
zero runs. The private stopped-DB backup is
`pre-77-backup.RfChxI/pre-server-77-20260909-034715.sql.gz`, 8,720,075 bytes,
directory 0700/file 0600, gzip-verified, restore untested, zero pruned. Migration
0259 applied successfully, moving the live journal from 257 to 258/up to date.
The live sequence is positive 31-bit/noncycling and still unallocated. The
original four endpoints remain active; no credentials or historical run state
were changed. Server 77 startup is the next action, with automatic subscription
maintenance and actual provider UI qualification still open.

### September 9: server 77 clean deployment checkpoint

Root committed/pushed the safe gate as `9cf0a05eb`, following Slack `977d9923f`
and Telegram `8de18acf6`. Independent frozen-source gate review is clear.
Server **77** is PID **79184**, handle **31617**, loaded clean version
**`2026.831.0+621.git.9cf0a05eb`**, started `08:55:49.350 UTC`, startup recovery
ready `08:55:52.590`. Loopback and private Tailscale Board health returned
200/ready; public webhook-only Funnel Board health remains 404. Discord Gateway
connected the original bot `1546330979860221952`.

At `08:56:34.067 UTC`, the live run inventory remained 290 terminal (262
succeeded, 26 failed, 2 cancelled), zero active, latest start `02:15:47.812`.
The original Discord/GitHub/Slack/Telegram endpoints remain active. The existing
Telegram endpoint has zero subscription receipts, so its normal complete
replies remain available and Stop is not advertised. The automatic upgrade
worker is still in progress, not silently assumed to have run. Guarded runner
and lockfile SHA256 values remain unchanged; proxy 27961 and the other checkout
on 3103 were untouched.

Root retried actual browser inventory after restart; the controller again
reported the Mac locked. Discord Gateway connectivity and ready API responses
do not prove the live UI journey. No new provider conversation, successful
historical recovery or production-readiness completion is claimed.

### September 9: automatic Telegram Stop subscription repair

Existing active/enabled Telegram endpoints are now discovered by a bounded
keyset maintenance scan. A durable operation binds current generation,
credential fingerprint, bot and expected managed callback URL. Under the
credential-mutation lease, the worker verifies the bot and existing provider
webhook, preserves its explicit subscription (or default-all semantics) and
connection limit, sends the stored secret with `drop_pending_updates: false`,
then independently reads back the actual settings. Only strict boolean
acknowledgement plus exact verified current settings can establish the durable
subscription receipt. It neither repoints a foreign webhook nor guesses a
custom certificate or IP pin. Default-all and explicit subscription sets stay
distinct. Old or failed proof keeps ordinary complete replies available.

Review caught and fixed a false-positive verifier that reused the upgrading
planner and therefore appended the very subscription it needed to observe.
The final helper compares actual observed sets, ignoring order/duplicates but
not missing Stop, null metadata, or default-vs-explicit differences. Recovered
`providerConfirmed` flags are not capabilities: absent a current durable
receipt, retries perform fresh provider verification and update under current
ownership. Logs retain closed diagnostics without token-bearing URLs.

The three initial existing-endpoint restart cases genuinely failed before the
maintenance implementation. Fresh focused qualification passes **34/34**
integration cases (812 unrelated skipped; 9.37 seconds), **38/38** helper/Stop
checks and plain server types. These cover explicit/empty/omitted settings,
restart then actual verified callback dispatch, malformed provider receipts,
unsafe scope/options, uncertain retries with fresh observed settings and
concurrent deduplication. Logs are
`telegram-subscription-maintenance-{red,final,helpers-final,types-final}-0909.log`.
Independent final review verified all four frozen source hashes and found no
remaining concrete blocker in this slice. Root combined regression is pending.

Each provider request retains the existing 25-second bound; up to four requests
can hold a renewable credential lease. Ordinary same-endpoint output may
contend through the existing 10-second lease-acquisition wait and durable
retry. This is bounded contention, not a no-latency-impact guarantee. Other
inbound/recovery work still starts independently. No live mutation has been
performed for this slice yet, and this is not a native client Stop walkthrough.

Root's first combined repeat did not pass: **842/846** integration cases passed
in 180.52 seconds. The three new existing-subscription restart cases did not
observe their expected SET, and a pre-existing Teams receipt API case reported
a socket hang-up. Their causes are being investigated in separate lanes;
neither is yet classified as harmless. The separate fresh deterministic browser
suite passes **31/31** in 2.8 minutes, helpers/runtime **367/367** across 15 files
in 15.55 seconds, and plain server types pass. Logs:
`stop-subscription-{full,browser,helpers,types}-root-0909.log`. The full/browser
databases `chat_stop_subscription_{full,browser}_20260909_root01` are now
populated and must not be reused as fresh fixtures. Server 77 is unchanged.

The paging failures were traced to the exact populated fixture database: each
target had 26–35 earlier eligible endpoints, beyond a cold scanner's first
25-row page, and no maintenance action had yet been discovered for it. The
revised regression intentionally seeds a full confirmed prefix page, verifies
no early target work, and treats bounded discovery and bounded action draining
as separate steps. Provider request observations must be scoped to unique
synthetic fixture credentials; shared fixture tokens are not distinct bots.
This diagnosis has not required a production scanner change.

Independent Teams diagnosis reproduced the HTTP failure pattern using the
exact implicit-listener test shim with trivial Express GETs and no Teams,
database or provider code. The saved fresh probe reports three connection
resets in 14,185 requests; each failed server saw cleanup close but no
connection, request or client-error event. Explicit awaited IPv4 listeners
handled 10,000 GETs across 5,000 owned servers with zero failures and joined
cleanup. Logs: `teams-projection-{implicit,owned}-listener-probe-0909.log`.
The exact original kernel reset cause remains unobserved. The narrow fixture
repair uses one explicitly ready listener for its two sequential HTTP reads,
always closes it, adds no retries and preserves all status/body/privacy/no-write
assertions. The fresh projection cohort passes **26/26** in 6.08 seconds and
plain server types pass (`teams-projection-owned-listener-green-0909.log`,
`teams-projection-diagnosis-types-0909.log`). Production Teams code is unchanged.

The final Telegram fixture uses a unique synthetic token per instance and
checks exact target requests independently of unrelated endpoints. A genuine
three-case RED with 25 confirmed prefix endpoints established the old one-page
assumption; an earlier bootstrap attempt failed fixture UID uniqueness and is
not counted as that causal RED. The corrected finite-paging/fair-action-drain
cohort passes **34/34** on fresh
`chat_telegram_subscription_fairness_green_20260909_03` in 9.64 seconds, with
plain types green (`telegram-subscription-fairness-{red02,green03,types}-0909.log`).

Root's final combined rerun passes **846/846** in 157.43 seconds on fresh
`chat_stop_subscription_full_20260909_root02`
(`stop-subscription-full-root02-0909.log`). This includes both narrow test-only
repairs. Production service SHA256 remains the independently reviewed
`648ccc03460ec04d74a2da74e664a1844c32cad08f6da909ec0b7db0e684fde1`;
the final integration fixture SHA256 is
`303c9fab78a6d5803f84d93935d2006f4fa24dba7f7eb7d918d74041223dfb4f`.
The preceding 31/31 deterministic browser, 367/367 helper/runtime and plain
types passes still cover the same unchanged production candidate. Formatting
and `git diff --check` pass; runner and lockfile hashes are unchanged. The
failed first full run remains recorded above. At `09:16:48.874 UTC`, server 77
was still ready, all four original endpoints active, 290 terminal/zero active
runs, and no Telegram subscription receipt. No live update has yet occurred.

### September 9: server 78 automatic live subscription qualification

Root committed/pushed the reviewed repair as **`ea528f44c`**. A fresh inventory
at `09:17:51.382 UTC` still showed 290 terminal/zero active runs and all four
original endpoints active. Server 77 PID 79184 exited cleanly at `09:17:58`,
interrupting zero runs. The private stopped-DB backup is
`pre-78-backup.3Vhbek/pre-server-78-20260909-041811.sql.gz`, **8,876,485 bytes**,
directory 0700/file 0600, gzip-verified, restore untested, zero pruned. Schema
was already current at journal 258; no migration was applied. Backup metadata
is in `pre-server-78-backup-0909.log`.

Server **78**, PID **49120**, handle **63670**, started at `09:18:24 UTC` and
loaded clean version **`2026.831.0+623.git.ea528f44c`**. Startup recovery became
ready at `09:18:30.541`. Discord Gateway connected the original bot
`1546330979860221952`. Loopback/private Board health returned 200/ready, while
public webhook-only Funnel Board health remained 404. The proxy and the other
checkout on 3103 were not restarted; guarded runner/lockfile hashes are intact.

The original Telegram endpoint upgraded automatically on **attempt one**.
Its exact subscription receipt committed at `09:18:29.075`, and the durable
maintenance operation settled processed/provider-confirmed at `.082`. Root's
read-only check compares the receipt's current company, bot, generation,
credential fingerprint and managed callback URL hash, not just its status.
At `09:18:33.627`, it matched current authority, all four endpoints remained
active, and run history remained 290 terminal/zero active, latest start still
`02:15:47.812`. No reconnect, credential rotation, queue dropping or historical
recovery rewrite was performed. Evidence: `server-78-state-0909.log` and
`server-experimental-landing-78.log`.

Root then retried actual signed-in browser inventory once after deployment.
The controller still reported the **Mac locked** and automatic unlock failed.
That is not a new Discord-login request. Live registration/upgrade acceptance
does not establish native button placement, Stop timing, command/private-message
UX, or a new successful chat run. Those browser journeys remain open; no
all-channel production-readiness completion is claimed.

### September 9: current compiled npm-consumer qualification

At source **`d5b154e1c7`** (a documentation successor of implementation
`ea528f44c`), James freshly compiled the server and all 16 runtime workspace
dependencies into ignored staging output. All **17** explicit TypeScript
compilations passed without rebuilding or staging the protected runner.
Root separately built current UI into isolated output. The stage copied the
existing qualified runner, declared runtime assets and current DB migrations,
used the production bundle helper and materialized publish manifests only in
scratch with one synthetic sibling version. npm **10.9.7** packed all 17 and
installed **340 packages** in a fresh consumer/cache. No package was published.

The local registry trap rejected every Paperclip sibling metadata request
(18 probes, HTTP 409). The initial harness incorrectly required zero probes
and therefore failed after the install itself succeeded. Subsequent inspection
verified all 17 installed sibling lock entries point to the exact local
tarballs, with no public/nested sibling substitution and all 26 symlinks
contained. All **21** patched runtime/declaration files matched the qualified
installed bytes, including five chat adapters, Discord's transport, ACPX and
the embedded-Postgres patch. A fenced import passed across **6,259** contained
modules without starting the server, opening sockets or launching children.
Current helpers, qualified vendored-runner resolution, compiled Slack bounded
streaming/awaited completion receipt and compiled Telegram draft Stop passed
with synthetic provider transport. An explicit outside-consumer import failed
as intended. These checks do not make real provider requests or model runs.

The retained stage is `.paperclip-runtime/current-server-consumer.VjpmfK`.
Its server tarball is **45,576,751 bytes**, **26,297 entries**, SHA256
`9296a3817ea16882c78dfa4f3fc317556d399bddfc4f3201cb6a4e1b6cab28c2`.
The compiled server tree has 4,037 files, SHA256
`0eef758534f2f196dd0ebb501e72f43ccddff40f2bd7f6fd38d57b1e658b9088`;
the fresh UI tree has 387 files, SHA256
`9ad72618419a24509221278f0027e31fd1ffc14df76ac92adc607f924210b38c`.
Exact closure/hashes are in `artifact-evidence.json`; final checks are in
`install-verify-final.log`, `smoke-final2.log` and `artifact-audit.log`.
Failed harness attempts remain retained and are not counted as passes.

Two synthetic smoke fixtures needed correction. The first omitted Slack's
thread timestamp, so the adapter correctly returned null before transport and
the harness dereferenced it. The next accepted only Telegram `sendMessageDraft`
and counted all requests as drafts, incorrectly rejecting legitimate `getMe`
initialization and `sendRichMessageDraft`. Its recorded `2 !== 1` and synthetic
network warnings are retained. The final fixture supplies coherent bot identity,
accepts legitimate draft methods, verifies exactly one draft and one identity
request, checks Stop fields/draft ID and rejects permanent sends. Only ignored
fixture code changed; no product or packed artifact was altered.
Earlier assembly/validation guards also needed fixture-only correction: absent
optional declared `files` entries are now recorded rather than invented, and
the sibling-path matcher distinguishes nested third-party packages from
Paperclip siblings. Those failed attempts remain separate from final proof.

Root's packaged static-UI qualification uses a separate owned port **3221**,
fresh migrated database `chat_current_consumer_browser_20260909_root01`, and a
fresh temporary Paperclip home. Source CLI onboarding is used only to create
fixture configuration (`invokedByRun: true`, no service installation); the
server process runs the actual installed compiled entry with a resolution
guard denying outside-consumer and TypeScript-module fallback. It does not
test the published CLI. The first launch guard mistakenly rejected `@` in
the scoped package path; the second launch correctly rejected a too-short
synthetic signing key. Both stopped before tests or company creation; a
read-only zero-company check preceded the third attempt with valid fixture
keys. No production code or artifact was changed for those harness repairs.

During the third attempt, HTTP GETs of `index.html`, `sw.js` and the main
`assets/index-7u1MFQgd.js` returned 200 with the correct MIME types and exact
staged byte hashes. The proof is in
`.paperclip-runtime/current-chat-ui.MnjT3M/static-http-proof.log`;
the fresh Vite build log is alongside it. Existing large-chunk and mixed
static/dynamic import warnings remain, not a clean-bundle-size claim.
The packaged browser suite passes **31/31** in **2.0 minutes**, exit 0, without
retries. It covers the default-off experiment gate preserving GitHub tool
setup, all five provider setup/management UIs, task-bound uploads, pending
consent and file-batch state across reload, uncertain delivery and exact failed
run retry feedback. Its `page.route('**/api/**')` fixtures mock Paperclip's
chat-control-plane routes, not just remote provider requests. The compiled
server handles unmocked bootstrap/company/agent/catalog requests and serves
the current built UI. This does **not** establish compiled chat-backend or
real-provider end-to-end delivery. Log: `consumer-browser-03.log`; earlier
launch failures remain in `consumer-browser.log` and `consumer-browser-02.log`.
The owned test listener exited and port 3221 was released. The fixture DB is
now populated and must not be reused as fresh qualification.

Independent review confirmed all recorded module realpaths and patched
adapter/Discord transport resolutions are inside this consumer. It also found
that deleting keys from Playwright's `webServer.env` would not scrub inherited
values because the launcher merges over `process.env`. Root verified the seven
named auth/run/Node/runner override keys were all absent in the launching
shell (`launcher-env-presence.log`) and hardened the scratch config to explicit
empty overrides for future use. That post-launch harness edit is not described
as changing the successful process or as a new test pass. No fallback was
observed in the qualified run.

This is current local macOS consumer evidence, not a CI-owned frozen-lockfile
install, a cross-platform native rebuild, published-CLI qualification or live
provider UX. Normal build outputs, installed dependencies, protected binary,
lockfile and live server 78 remain untouched. The signed-in browser controller
again reports the Mac locked; the remaining real provider journeys have not
been replaced by this automated package check.
At `09:40:04.794 UTC`, the post-consumer read-only check still found server 78
ready on loopback/private Board, public Board health 404, all four configured
endpoints active, the exact current Telegram subscription receipt intact, and
290 terminal/zero active runs with no newer start. Evidence:
`post-consumer-state-0909.log`. Runner and lockfile hashes remain unchanged.

## September 9, 12:45–13:10 UTC: actual browser qualification resumed

The Mac became available and the user restored Eigenjoy's Discord login.
Root operated the signed-in in-app browser for every provider action below;
parallel agents correlated only the exact fresh tasks, receipts and files.
These observations are on **server 78**, loaded `ea528f44c`, with the retained
qualified runner and Maya's native `paperclip_runner` / Codex / Luna path.
They supersede the earlier locked-browser state, not the historical failures.

### Slack: one thread, FIFO, real files, actual Stop and continuation

Fresh source `1788957912.689909` created CHA-37 (issue
`6fc3059c-5a87-4124-8cb7-af8fdec7e391`) in the authorized private channel
`C0BUT55N9RV`. [Open the actual Slack thread](https://papercliplabs.slack.com/archives/C0BUT55N9RV/p1788957912689909).
The provider UI's “1 member” and autocomplete “not in channel” labels were
misleading: normal authenticated `auth.test`, `conversations.info` and member
reads confirmed the current bot `U0C05EDC10R` was already a member. No access
or invitation was changed to make the test pass.

| Fresh source | Native execution | Source to final | Observed outcome |
| --- | ---: | ---: | --- |
| A, `1788957912.689909` | 27.341s | 29.147s | Requested Before/During/After checklist |
| B, `1788958021.531449` | 16.266s | 17.914s | Requested five-point rollback checklist |
| C, `1788958027.297669` | 11.789s | 23.945s | Exact `SLACK78-C-READY` |
| Files, `1788958237.920639` | 56.099s | 66.789s through both files | Correct image/text facts and two actual attachments |

C arrived while B was active and waited 11.315s; its run began 54ms after B
finished. A/B/C stayed on one task, native session and runner instance. Their
progress/final publications edited one message per turn, all on attempt one;
receipt reactions were removed. A duplicate source webhook was ignored.
Source-to-HTTP ingress was 528–636ms, local acknowledgement at most 34ms. The
file test's post-run delivery tail was 8.379s; its principal latency was native
execution, not a multi-minute provider queue.

Root uploaded the PNG and TXT together using Slack's actual file chooser,
waited for upload completion and sent one new source message. The reply
described the orange tabby and correctly read lighthouse / amber / 63. The
returned image preview and full TXT preview were visually inspected. Normal
authenticated file reads, hashed in memory without retaining credential URLs,
proved both output files match the **Slack-stored input** bytes:

- PNG source `F0C0NHCVBL1`, output `F0C0QA0G5FW`: 2,088,249 bytes,
  SHA256 `005f8dabdb19ef786c0e2e76695596d22c1d0bb53de374e0be209cc6d89851c9`.
  Slack changed the uploaded local PNG before Paperclip received it; the local
  file was 2,111,878 bytes / `7693966f…`. Do not claim original-local byte identity.
- TXT source `F0C0NHDCA81`, output `F0C0593M2R5`: 152 bytes,
  SHA256 `e5ea1c89ad69c0ae9dffea0599c730e5d284816dbcd9dae44746c7a29f790293`.

Root then requested a deliberate long response and clicked the actual native
**Stop maya-e2e** button. Action `f560df89-2dac-4dc6-8016-b01269469385`
was recorded at 13:00:23.366 and targeted only run
`d6334d4f-5417-4fbe-b10b-8ce1a0e20e55`, cancelled at 23.523.
The working message `1788958811.634929` became “Maya E2E stopped at your
request” at 24.239; reaction cleanup completed at 24.531 and the working
control disappeared. A separate AFTERSTOP source was admitted at 13:00:51.085;
run `7f5ad557…` succeeded at 13:01:03.274 in the same native session, and
its own message returned exact `SLACK78-RESUMED`. This proves an actual Stop
and a healthy successor, not late-duplicate/revoked-identity simulation or the
oversized cached-mention boundary.

### GitHub: fresh replies pass; real fallback finds two deeper failures

Root created disposable [issue 4](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/4)
and sent A as a native bot mention, then unmentioned B. Both mapped to CHA-38,
issue `350675e8-ce15-44f7-a995-d8f55f9b2d6d`, and one native session. A's
source comment `5602056149` received exact `GH78-A-READY` at 12:46:24.538
(19.538s from source; native execution 14.723s). B's `5602076726` received
exact `GH78-B-READY` at 12:47:56.926 (18.926s; native execution 14.082s).
Each progress/final pair used one provider message, one attempt.

C (`5602115684`) attached the fresh TXT through GitHub's real chooser. The
native run correctly refused to guess unavailable attachment contents, but
its 12:51:08.147 final said that no task link could be provided immediately
before Paperclip appended the correct task link. Root verified the actual
DOM and screenshot. Native-only guidance fix **`d399d7a41`** is committed and
pushed: explain service-owned navigation, conditional on current-source
authorization and a safe configured Board URL; do not invent or promise a
URL. Fresh/resumed GitHub tests fail before the fix; the final focused cohort
is **58/58** with plain server types. This code was not loaded by server 78.

Root clicked the actual appended link, reached the right company and CHA-38,
and uploaded the same TXT through **Attach file**. Attachment
`7c8d6a34-ac6a-432b-ba2b-2a602d38d53c` was stored at 12:56:08.044;
the exact stored object's 152 bytes and full SHA256 match the original.
The UI showed a usable file card. Upload alone caused no provider publication.
Root submitted an internal Board comment `f372ea91…` explicitly requesting
the new file's facts and keeping the task open, without using Send to channel.

This complete journey **failed** despite the successful upload. Native run
`feef0e1c-1dcf-4494-b36d-3effd729ef35` could not read the attachment. The
composer discarded the uploaded attachment ID and sent only its Markdown
URL; the stored attachment remained unbound to the comment. Existing exact
comment/run staging correctly refused the unbound file. The fix under test
carries explicit uploaded IDs through the UI into the existing atomic comment
binding; it must not parse arbitrary Markdown as authority or broaden the
historical chat attachment reader.

A separate recovery defect then compounded the failure. The accepted
blocked/current-track result invented an alternate productive continuation;
the recovery wake omitted the Board comment, built a contract from the old
issue title and ran `fca4d57b-7f1e-4990-9823-5da6926f8ef7`. It repeated
`GH78-A-READY` and marked CHA-38 Done despite the current keep-open request.
The fixes under test preserve a Board-owned unblock request and require
current-source/assignment/status checks before legacy recovery changes state.
All of this Board content remained internal: zero new GitHub publications.
The unchanged public fallback and the two deeper repairs still require one
coherent deployment and repetition of the complete browser journey.

### Discord: native commands, files and choice pass; next form reveals resume failure

Fresh Clawd root/thread `1547228059797561475` created CHA-39 (issue
`9e0afdaa-b34d-40c0-a01c-c25dafcf6c5e`). A returned exact
`DISCORD78-A-READY` at 12:52:09.364, 13.782s from ingestion. The actual native
picker displayed `/paperclip status`, `/paperclip new`, `/paperclip close`.
Root invoked status and guild-new. Both visibly said “Only you can see this”;
status action `8a2af942…` processed at 12:56:08.225 with no run, ordinary wake
or public publication. Guild-new explained how to create a new root and did
not replace the current thread's task. DM-new and bound-thread close remain
separate unverified permutations.

The new FILES message `1547229385327644683` was ingested at 12:57:11.879.
Run `d36085c2-3eb1-44f3-95c4-336ad1229e8e` executed from 12:57:13.084 to
12:58:04.949, returned accurate image and TXT facts, then actual PNG and TXT.
Root visually inspected the returned cat image and native text preview.
Independent bot-authenticated exact-message reads and their CDN bytes proved:

- Output message `1547229615515500666`: PNG 2,111,878 bytes,
  SHA256 `7693966f6c2b4aaebf9e46359f715fdaede021346bcd926078bb331b1dddc3c1`.
- Output message `1547229617432043531`: TXT 152 bytes,
  SHA256 `e5ea1c89ad69c0ae9dffea0599c730e5d284816dbcd9dae44746c7a29f790293`.

Both match the exact local/imported source bytes. The bot's eyes reaction was
absent from the source message. No tokens or signed attachment URLs were
retained as evidence.

The next QUESTION source produced actual Morning/Evening buttons. Root chose
Evening. Interaction `6d984be7…` was answered at 13:00:23.193; exactly one
response delivery woke run `d1a37d8a-604c-40fa-b126-3606d9b4f857`, completed
at 13:00:37.110. The card became “Answered: Evening.” and the final was
`Evening DISCORD78-CHOICE`; the sibling choice expired.

The subsequent native free-text FORM request did **not** display a form. Run
`4e200a4d-0d58-41de-870e-ae702a061603` failed from 13:01:07.909 to
13:02:32.754 with `native_session_retry_exhausted`: `run.attach` rejected an
unsettled provider session. The visible failure message and task link were
verified. Read-only examination found the prior question's semantic result
command already completed before about 98 drain commands and suspension, yet
its event suffix remained pending. On the successor, the old result's inner
correlation was retained but its envelope had the new run identity. The Rust
`runner.drain` command was a no-op and could starve ordinary provider FIFO
polling. A bounded durable-drain/close-fence repair and causal regression are
now being developed; do not discard the old receipt, force replay, or label
this a successful form or recovery test.

### Telegram: fresh generation and media; stale reactions and unobserved draft Stop

Root sent actual `/new` at 12:51:38. It processed once and completed generation
10 without replaying CHA-26's protected work. Generation 11 is CHA-40, issue
`3c303ad2…`. A's run `78abbf77…` completed in 20.008s; progress/final updated
one provider message `417200359:158`, final at 12:53:37.614 (21.388s from
ingestion). Exact `TG78-A-READY` was visually verified.

Root uploaded a new photo with its own caption, then a separate TXT. Photo
source `417200359:159` arrived at 12:58:36.825. Telegram converted the PNG to
a 221,327-byte JPEG (`1d22f8c0…`); the prepared output retained that received
file, not the original local PNG. Its run finished at 12:59:19.245 and photo
published at 21.548. The TXT source `417200359:162` arrived at 12:59:25.537,
after the image run finished: **no concurrent FIFO claim**. Run `3b0ac2f5…`
executed for 40.951s, read lighthouse / amber / 63 and prepared the exact
152-byte/e5ea1c89… TXT; output `417200359:164` published at 13:00:09.859,
44.322s from ingestion. Root visually verified the photo and document cards.
Unlike Discord, no arbitrary Bot API get-message read was available; this
combines visible output, exact prepared bytes and provider publication receipt,
not a newly downloaded Telegram output-byte assertion.

Root saw the bot's eyes reaction remain after these finals. This was a genuine
missing feature: terminal cleanup admitted Slack/Discord but excluded Telegram
even though the pinned adapter supports `setMessageReaction` with an empty
reaction list. Fix **`9afdf3232`** is committed/pushed, not yet live: exact
source-bound cleanup, final-before-add marker, restart/generation/retry fences,
and no transient eyes for control-only acknowledgements. Six cleanup cases
and seven control cases genuinely failed first. The final **20/20** cohort
passes on fresh `chat_telegram_receipt_final_20260909_01`, with plain server
types. Provider HTTP is simulated through the actual pinned reaction method;
historical live reactions were not manually cleared.

Root also sent a bounded synthetic Board publication through **Send to channel**
to exercise native private-draft presentation. It reached Telegram as a real
message, but completed before a Stop control was observed/clicked. This is
**unobserved native Stop**, not a pass. No artificial callback or task/run
cancellation was substituted. Microsoft Teams still requires an eligible
work/school tenant and authorized Entra/Azure/custom-app setup; these other
provider results do not satisfy its live qualification.

## September 9, 13:20–13:52 UTC: Discord DM queue and close-loop counterexample

All provider actions used the already signed-in in-app browser, Eigenjoy's
account and the existing Maya bot. The live process still loaded server 78
(`ea528f44c`), with `paperclip_runner` / Codex / `gpt-5.6-luna`.

DM command attempts at 13:20 and 13:25 were rejected before Paperclip because
Discord required a shared guild with DMs enabled. They later appeared as
“The application did not respond”; no corresponding Paperclip action existed.
Clawd's original Direct Messages setting was off. Root temporarily enabled
that server's switch for the DM test, verified the checked state, then restored
it off after the test. Message requests became disabled again; activity
sharing/joining were unchanged. A first click did not persist the toggle;
keyboard Space did. No other server or global privacy settings were changed.

The successful `/paperclip new` at 13:28:33.828 produced a private recorded
acknowledgement and the normal “Send your request” confirmation. The next
message created CHA-41, issue `20e15668-0011-4dd0-85db-528fc226d546`, conversation
`cb6becfa-fbb2-4f7e-9f91-eb37f26e8e1a`, generation 2, provider DM
`1546815225334865972`, native session `27bb1ebd-798b-47bf-93a8-13ae10c28423`.

| Message | Native run interval (UTC) | Ingestion to final | Provider response |
| --- | --- | --- | --- |
| A | 13:29:28.841–13:29:46.973 | 19.447s | `1547237514740506736`, exact `DISCORD78-DM-READY` |
| B | 13:31:17.785–13:31:56.566 | 40.028s | `1547237970732384266`, Before/During/After checklist |
| C | 13:31:56.668–13:32:10.843 | 38.792s | `1547238037023363112`, exact `DISCORD78-DM-C-READY` |

C was sent while B was confirmed running. It started **102ms after B ended**,
with roughly 24.120s of real queue wait. Each progress/final used its own same
bot message with one publication attempt. Screenshot inspection showed clean
bullets; commas in the accessibility representation were not a visual defect.
B did include the odd phrase “Revoke the token [REDACTED] compromise is
suspected.” A focused check of the public text projector did not reproduce
that replacement; its cause remains unresolved, not justification to weaken
secret redaction. Native status at 13:37:06.074 was correct and private.

### Close is a failure despite the visible confirmation

Native close action `779a01af-3e8b-43f9-85b7-1741209beadf` and authorization
`699e7ec6-5a57-485e-9c51-69c2b02b7874` were recorded at 13:38:58.480.
At 13:38:58.759 the conversation became `completed`, and Discord received
“This task is closed. Send another message to start a new task.” The task
itself was never closed: it remained `in_progress`. Do not describe this as a
successful close or silently repair its database state.

At 13:39:02.931 run `3a1aea22-1df9-4d8a-a002-b18b1eb783c1` started from generic
`issue_continuation_needed`, retrying the last real chat run
`6e26321c-dc95-4621-b14b-1b0122737620`. It no longer had the chat presentation
context. Its yielded `response_wake` then materialized an immediate
`native_status_decision` continuation instead of waiting for a real message.
Subsequent runs repeated roughly every 30 seconds. Provider publication fences
kept their output out of the closed DM, but did not prevent wasted execution.
This is a recovery/admission bug, not slow Discord transport.

Root paused only Maya through `POST /api/agents/:id/pause` (HTTP 200), stopping
the loop. The follow-up scoped read proved `paused` and zero queued/running
runs. All rows/journals remain available; no fabricated completion, manual
receipt cleanup or provider replay was used. A production repair must honor
the exact committed close/new request and source generation at recovery and
dispatch, without suppressing later authorized Board work or claiming that a
conversation close satisfies a task's completion/governance contract.

### Other current boundaries

Teams' actual signed-in profile still says **Personal** and offers no other
work tenant. Eligible work/school tenant and authorized bot-installation setup
remain unqualified; no purchase, tenant change or self-message substituted.

Root full chat run01: 856/860. Corrections in `5232fb22b` retain all exact-byte
assertions using `Buffer.equals`, stop expecting eyes on command-only Telegram
messages, and advance bounded worker pages until the fixture's first repair
attempt. Focused 23/23 passed. Full run02: 859/860; the remaining raw-webhook
test ended with `socket hang up`. Full run03 uses a new database and unchanged
source to investigate that isolated failure. Logs are retained in ignored QA
runtime storage. These results are not full workspace/build/CI verification.

## September 9, 14:10 UTC: frozen fixes and continued qualification

No live deployment occurred. Maya remains paused with no queued/running runs;
the original lockfile and installed runner binary retain their protected hashes.

Board fixes are frozen in local commit `ae21fd9e2`: 350 focused units, all 11
real native/legacy browser journeys, UI types and token gates passed. Fresh
isolated PostgreSQL avoided the earlier embedded-database setup failures. The
browser tests prove byte-identical TXT/PNG receipts, reload persistence, real
comment binding, accepted-but-response-lost handling, explicit review/discard,
known-rejection retry and pending/failed attachment removal. This is not a
cross-tab atomicity or server-idempotency claim. Screenshots and all failed
attempts remain under `.paperclip-runtime/board-receipts-browser.bzXvpe/`.

Runner fixes are frozen in local commit `c76988f93`: 227 serial source tests
and 27 composed tests against the actual optimized release binary passed.
Strict codesign passed. Release binary SHA256 is
`6844f20ee4a5fb7f7963117263a384f520054b4bd1e0f812fc58a4f34808b503`.
The earlier concurrent 220/227 result still exposes the two-second maintenance
ACK deadline under load; no production deadline or assertion was weakened.
Old quarantined semantic-result/session evidence is untouched.

Full chat run03 ended 859/860 with three globally observed credential-lease
tokens in a two-worker fixture. Commit `e67df56fa` scopes that barrier to the
two workers' individual async call chains and preserves the exact one-lookup,
one-attempt assertions. The raw-webhook test now owns a single ready listener;
it had passed unchanged in run03. Both repaired fixtures passed focused tests.
Run04 also ended 859/860 (368.18s tests): both fixes passed, but another Telegram
restart test assumed its maintenance action appeared on the first global page.
It now uses the existing bounded first-attempt helper. The full Telegram draft
Stop/restart group passed 34/34; do not combine these partial suites into a
fictional full green result. All databases were newly created per attempt.

`e67df56fa` also corrects close wording and provider command descriptions:
closing a chat conversation does not claim a Paperclip task status change,
nor does it imply physical Discord-thread or Telegram-topic archival. Six
fresh-database control tests and 62 focused unit tests passed; task status is
explicitly checked unchanged. These words are not yet deployed. The causal
close/recovery guard has two clean failing tests and is under independent
review for ancestry, reassignment, fresh Board work and claim/dispatch races.

## September 9, 14:20 UTC: final full-suite fixture isolation

Full run05 finished 859/860 (295.43s tests), with all earlier fixture corrections
passing. Its remaining Discord Gateway `file_revisions` case had three received
lifecycle rows with zero attempts. The preserved database and log identify an
initial inbound-wakeup NOWAIT failure: the fixture's automatic root drain
competed with its explicit replay/setup mutation, and the legitimate FIFO gate
held subsequent edits behind the unadmitted source. The fixture now owns its
scheduled-work boundary and explicitly proves the original wakeup is processed
before exercising actual Gateway normalization/update callbacks. Both metadata
and file-revision cases passed on a fresh PostgreSQL database. No queue safety
rule or production retry deadline was loosened. Full run06 remains required.

The odd “Revoke the token [REDACTED] compromise is suspected” sentence is already
present in run B's persisted native result and run result, before the matching
publication. The standalone external-text projector preserves the ordinary
unredacted sentence. This localizes the symptom upstream of publication, but
does not establish whether the model or earlier native sanitization caused it.
It remains a quality follow-up, not a reason to weaken credential redaction.

The exact qualified release binary was copied to private ignored
`qualified-runner-79.z262Ty/paperclip-runnerd` under the live QA runtime root.
Its SHA256 still equals `6844f20ee4a5fb7f7963117263a384f520054b4bd1e0f812fc58a4f34808b503`;
mode is 0500 and strict codesign verification passed. It is **not activated**.
No installed binary, live server, old runner journal or agent status changed.

### Full run06 passed

Fresh database `chat_snapshot_full_20260909_root06` passed all **860/860** chat
integration tests (177.16s tests, 185.33s total). The exact log is
`.paperclip-runtime/chat-adapters-live/chat-snapshot-full-root06-0909.log`.
All previous RED logs/databases remain. UI/shared TypeScript checks also passed.
Recovery's separate full file passed 183/183 before its final durable admission
marker was added. That last change addresses a newly prepared native turn
crashing before its close check, then entering the protected same-run recovery
path. New runs need a server-owned required/admitted record, while historical
or already-admitted owners must not be falsely retired from missing evidence.
Its final verification and live cutover are still pending.

## September 9, 14:40 UTC: close/recovery admission qualified

Final full heartbeat qualification passed **194/194** (83.66s tests, 89.50s
total) on fresh `chat_close_recovery_20260909_full02`. Adjacent pure tests
passed 87/87, queue/batching 38/38 and an unchanged isolated PostgreSQL repeat
19/19; plain server TypeScript passed. The first combined adjacent attempt
exceeded the existing 20-second embedded-database startup hook before those
19 assertions. That failure is retained; no timeout or assertion was relaxed.

The required/admitted marker has a genuine RED regression: restoring the old
blanket native-recovery exemption dispatched one provider attempt after close.
The final cases compose real preparation with the real `bootstrap_incomplete`
restart classifier. They do not simulate or claim a real OS crash. Independent
review checked exact-run identity, profile preservation, fresh Board causes,
and historical/admitted-owner compatibility under unrelated lock contention.

Root's read-only invocation against original live CHA-41 data resolved the
original run `6e26321c-dc95-4621-b14b-1b0122737620`, first automatic descendant
`3a1aea22-1df9-4d8a-a002-b18b1eb783c1` and final descendant
`27d1a2cb-62ef-4429-976f-5be3f3063028` to the same proven stop publication
`cce4ddfc-b17b-46f6-95a5-8b46d263db17`. No live rows or historical journals
were changed. This checks actual historical receipt compatibility, not live
provider behavior after deployment.

Maya was verified paused with zero queued/running runs. Server 78 received
SIGTERM; the HTTP drain used its existing five-second timeout and the Gateway
shut down. An initial consistent database dump began during that drain and
was retained. A second dump was taken after verifying the process and listener
were gone: `pre-79-backup.0ig3uu/pre-server-79-20260909-094005.sql.gz`,
12,094,060 bytes, directory 0700/file 0600, gzip verified, restore untested.
Schema remained up to date with 258 journal entries; no migration was applied.
Runner `build:typescript` passed after shutdown. New server startup and fresh
Discord question/form/close, GitHub fallback and Telegram Stop tests remain.

### Server 79 — September 9, 14:42–15:17 UTC

Server 79 loaded `3f2387073` and was ready at 14:42:46.023 UTC on the same
isolated loopback 3137 listener. Maya was resumed through the audited Board API.
The activated private, mode-0500 runner has SHA256
`6844f20ee4a5fb7f7963117263a384f520054b4bd1e0f812fc58a4f34808b503`;
the protected installed runner and lockfile were not replaced. The rebuilt
runner transport TypeScript SHA256 is
`745cd802efe0720ff68770b5b0c699dd26824912ebc25cfcc730c03018728771`.
The private Board URL and webhook-only Funnel boundary remain unchanged.
No historical quarantined owner/lease/journal was cleared to make a test pass.

**Discord actual guild UI:** fresh source/thread `1547256172023779448` created
task `5b6e36e2-f7e7-497a-8238-f2c2a62cb815`. The native question appeared;
clicking Evening produced `DISCORD79-CHOICE Evening`. A later free-text request
produced the native Release codename modal. Submitting `Amber Lighthouse 79`
gave a private receipt, an Answered card and
`DISCORD79-CODENAME Amber Lighthouse 79`. Four successful runs took 12.672,
15.777, 12.753 and 14.545 seconds. This is real provider interaction, not an
injected interaction response.

The subsequent native `/paperclip close` interaction `1547257864891142196`
arrived at 14:50:21 but remained “thinking.” There was no durable command action
or close effect. The stored command receipt matched the exact previous close
description; a current-definition-only parser rejected it, and initialization
left the SDK with an unhandled deferred command. The repair always installs a
guarded private denial callback. Maintenance can migrate only an explicitly
known, registered prior definition after checking retained ownership, remote
version and complete remote shape. Unknown/foreign definitions and uncertain
writes remain closed. Genuine REDs precede 47/47 real-PG composed tests,
76/76 helper/wire/parser tests and server types. Live redeployment is pending;
the fresh close journey is not yet passed.

**Slack actual thread:** CHA-44/source `1788965244.059229` completed A–E on
one native Luna session. B/C did not overlap and are not counted as queue proof.
D ran **14:51:00.502–14:52:00.848 UTC**. E arrived at 14:51:17, received a
queued acknowledgement, and started at 14:52:01.333, 485 ms after D finished.
Its final appeared at 14:52:20.334. Each source has one delivery/wake/run and
each progress/final stage one attempt; finals edit their own messages. Eyes and
working controls cleared. Short runs took 13–16 seconds; longer replies took
32–60 seconds after native admission. This does not establish uniformly fast
response latency.

At 15:09 the real native Stop button cancelled run
`88303bc0-01dd-4dc2-bc80-f52ed1ec33b7`. The action receipt was created at
15:09:31.293 and the run became cancelled at 15:09:31.458 (165 ms).
The same bot message changed to “Maya E2E stopped at your request”; eyes and
Stop controls disappeared. Fresh follow-up `21babf1b-6839-4697-be80-33cd6850814d`
ran 15:10:03.589–15:10:19.840 and returned exactly
`SLACK79-AFTER-STOP-READY`, without resuming the checklist.

**GitHub private-file journey:** actual issue
<https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/5> and comment
`5603841952` admitted CHA-45. The final replaced progress comment `5603843439`
after 21.701 seconds from ingress, truthfully reported the private upload
unavailable, and exposed a working stable “Open this Paperclip task” link.
Root clicked it and uploaded the original 152-byte TXT through the actual Board
composer. Attachment `398ed177-8316-4cf3-8ed5-4d5e6ce7fd82` remained bound to
comment `4da2353e-1888-411e-b931-39c1563cbb06`; stored SHA256 was exactly
`e5ea1c89ad69c0ae9dffea0599c730e5d284816dbcd9dae44746c7a29f790293`.
The agent read lighthouse/amber/63 correctly.

However, the accepted passive Board `response_wake` from `be171a62…` scheduled
an unwanted child `dc37e6cc-0cdf-45fb-a772-266f07f6d53d`, which marked the task
done at 14:55:07.734 despite the user's “keep open.” That full journey fails
quality acceptance. The repair binds passive waiting to the durable user wake,
accepted native result and current source; private answer and decision commit
together. Superseded passive origins must suppress old work without granting a
new answer or execution. Genuine joined REDs, focused controls, independent
review and the full recovery suite are being completed before deployment.

Root then explicitly selected the same bound file in Send to channel. The
request at 14:57:27 returned 409 before any comment/publication persisted, but
the UI claimed delivery was uncertain. No unchanged retry was performed live.
The repair retains a content-free negative receipt under the original request
key, including after owner-comment deletion or restart. A savepoint rolls back
the failed new comment before the rejection is committed. Only the exact
request-scoped 409 allows explicit correction; generic errors remain uncertain.
The UI now refreshes attachment binding after ordinary/reassigned comments and
removes stale unsent selections without changing an immutable in-flight send.
Focused server tests passed 5/5; UI/page/OpenAPI passed 148/148 and UI types/token
gates passed. A narrow formatter range briefly introduced invalid punctuation;
typecheck caught it, it was fixed, and the clean checks were rerun. The first
new browser test passed after that repair but saw the transient compile error;
a new full browser run is required and underway. Browser provider responses
are fixture-backed; real transactional rejection behavior is separately tested
with PostgreSQL. The live GitHub explicit-send journey remains pending.

**Telegram:** fresh `/new` acknowledged at 14:56:48, followed by a long native
answer delivered as `paperclip-response.md` after exceeding the message limit.
This was not a draft Stop test: the ordinary answer replaces progress, and the
overflow is an attachment. Telegram draft Stop is a presentation control, not
an agent-run cancellation. No Stop success is claimed. Teams work-tenant/admin
qualification is still unavailable with the current personal account.

At 15:22 UTC, final local verification completed: fresh root07 **866/866** chat
integration, passive Board wait **217/217** full recovery + **94/94** adjacent +
**23/23** final focused, UI/page/OpenAPI **148/148**, and UI/server types plus
token gates clean. Independent passive-wait review found no remaining blocker.
The full deterministic chat/Board browser run passed **43/43** on fresh final04
in 5.1 minutes, without the earlier transient compile error. Root inspected the
rejected-send screenshot: the draft and exact filename stay visible, the send
remains locked, and “Edit rejected send” is the enabled recovery action.
These results precede server 80 live deployment, not provider acceptance of it.

Next quality gap identified read-only: GitHub terminal reaction cleanup excludes
GitHub, leaving the bot's eyes after its completed response. A safe fix must
identify the exact bot user (not the App registration ID), respect original
credential/source ownership, page reactions completely within bounded limits,
and never report incomplete cleanup as success. No live reaction was removed
manually and no repair source is included in this checkpoint.

### Server 79 native Luna latency: bounded read-only measurement (2026-09-09)

Exact run events, performance spans, ingress/interaction receipts and published
outbox rows were correlated for the following real Slack and Discord journeys.
These are server 79 observations, not server 80 qualification or latency
percentiles. All eight persisted `nativeExecutionInput.provider` descriptors
identify `codex` / `gpt-5.6-luna`, with native `codex_app_server` execution.
They contain no explicit reasoning-effort field; the applied effort is unknown.

| Case / heartbeat run ID | Run start → finish | Runner startup | Provider submitted → started | Provider started → accepted result | Source → visible result |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slack A `5c27b8d6-bf69-4057-999c-a03233866c94` | 15.587 s | 1.683 s | 0.792 s | 12.643 s | 17.071 s |
| Slack C `81133e00-e330-4fca-b0f1-de02d5b3ae0a` | 13.184 s | 0.665 s | 0.552 s | 11.370 s | 14.298 s |
| Slack E `29073090-1139-4ca5-a3c4-75a1d3898f62` | 18.531 s | 2.111 s | 0.729 s | 13.366 s | 62.822 s |
| Slack after Stop `21babf1b-6839-4697-be80-33cd6850814d` | 16.251 s | 1.561 s | 0.697 s | 13.181 s | 17.460 s |
| Discord question `3d3de750-a61e-48cc-83cf-c19277d1289f` | 12.672 s | 2.105 s | 0.888 s | 7.703 s | 13.526 s |
| Discord choice `c7d2aeaf-8aea-45c3-97c7-12a5e46508ea` | 15.777 s | 1.554 s | 0.826 s | 12.385 s | 16.269 s |
| Discord form `a9efa97a-b470-44a2-94a0-d5c024bba996` | 12.753 s | 1.777 s | 0.905 s | 8.457 s | 13.399 s |
| Discord form answer `f2535ba3-cac2-4cfd-973b-3c0f89aee024` | 14.545 s | 0.985 s | 0.532 s | 12.104 s | 15.077 s |

“Source” is durable ingress, except choice/form answer, which start at durable
interaction resolution (14:45:30.863 / 14:48:18.253 UTC). “Visible result” is
the published final reply or governed question/form card, corroborated by the
actual UI journey above. Provider milestones use recorded event `emittedAt`;
database timestamps measure durable application receipts. The provider interval
includes native tool/protocol work, not exclusively model generation. These
intervals overlap and must not be summed.

Slack E spent **42.664 seconds from processed source to run creation** behind D;
its run started 485 ms after D finished. Safe queued/working presentation for
message-source cases appeared 1.615–2.234 seconds after ingress. Completed
replies reached final publication 0.316–0.657 seconds after run finish, all on
attempt 1. Question/form cards were published slightly before their governed
waiting runs finished. The selected short turns do not reproduce a three-minute
native execution delay; this does not dismiss delays outside this sample.

Slack reused session `22aa5a8d-57bf-425d-bec9-408def421758` and runner
`2e89ad9f-8b35-4484-858a-d8a6186ca43c` across these turns. A bootstrapped; C, E
and after Stop resumed, with approximately 77%, 88% and 90% first-round cached
input respectively. Discord question/form reused one session, while
choice/form-answer reused a separate interaction-continuation session. Thus
repeated cold starts do not explain the observations; cache reuse alone does
not establish a causal speed benefit or a context-size bottleneck.

Two trace boundaries require care. `provider.time_to_first_agent_event` was
reasoning in these samples, **not safe text shown to the user**. Also,
`native-session-executor.ts` starts `native.result.finalize` at session execution
when `turn.completed` is absent. Consequently the governed question/form spans
report 11.143 / 11.800 seconds that include session work, not an isolated
finalization delay. No tracing fix, model/effort change, FIFO relaxation, native
acceptance bypass or live mutation was made. A user-visible speed improvement
has not been demonstrated by this read-only diagnosis.

### Server 80 cutover and real provider retests (2026-09-09, 15:23–15:33 UTC)

Loaded source is `9531f6e386e41d6bd433fe1ca58deb812c0ddfba`, following
the private Board-wait commit `2f3c587d8`. Server 79 had zero active/queued
runs before Maya was paused through the audited Board API at 15:22:53.
SIGTERM was sent at 15:23:01; the five-second HTTP drain limit elapsed, then
Gateway/plugin shutdown finished normally at 15:23:06. The old process and
listener were verified gone before taking a quiescent backup.

Backup `pre-80-backup.rEh4re/pre-server-80-20260909-102312.sql.gz` is
12,873,482 bytes in ignored runtime, directory mode 0700/file mode 0600.
Gzip verification passed; restore was not tested. Schema was up to date at
258, so no migration ran. Server 80 PID 74752 became ready at 15:23:42 on
127.0.0.1:3137. Maya resumed idle after the endpoint check. The same private
mode-0500 native runner SHA256 `6844f20ee4a5fb7f7963117263a384f520054b4bd1e0f812fc58a4f34808b503`
passed strict codesign. The protected installed binary and lockfile were not
changed. Historical quarantined ownership was retained. Loopback/private
Board health passed; public webhook-only Funnel still returned 404 for
`/api/health`. No root push or provider credential rotation occurred.

**GitHub rejected send → correction → actual publication: PASS.** The old
retained request key `2f68792b-e28b-4156-a4db-4836946019f1` was retried once
through the real Board UI. It durably recorded processed negative action
`ea1a7b02-ed6b-4669-8596-032a9c0b6ba4` at 15:28:34.070, before any new
comment or publication. “Update was not sent” and the exact locked message/
filename survived reload. Explicit “Edit rejected send” preserved the body,
removed the already-bound selection and explained the fresh-copy/task-link
options. Root uploaded a fresh synthetic 152-byte TXT through the chooser,
then sent once with new key `ab57a871-24f0-4a5d-a817-1b2ece106a15`.

One Board comment `10519b6a-48f8-4f87-93ba-f8f2d675cf5e` owns the new
attachment `2a3880ef-297f-44f6-9ca0-389c4eeccb11`. The original
`398ed177-8316-4cf3-8ed5-4d5e6ce7fd82` binding was not changed. Actual GitHub
comments [text](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/5#issuecomment-5604427235)
and [file fallback](https://github.com/cryppadotta/paperclip-chat-e2e-enabled/issues/5#issuecomment-5604427382)
were visible after refresh. Both publications succeeded on attempt 1 by
15:29:35.618. The file fallback truthfully links to the stable authenticated
Paperclip task; it does not claim GitHub App comment-file upload support.

**Discord close: PASS; fresh-after-close publication: FAIL.** The old cached
Discord client initially did not show current command suggestions. Reloading
the actual signed-in thread displayed the updated “Close the current chat
conversation” description. The historical server-79 command then displayed
Discord's expired “The application did not respond”; it was not erased or
presented as repaired retrospectively.

Fresh interaction `1547267750916001954` produced a private “Close request
recorded” acknowledgment and the visible public terminal receipt
`1547267759266734101`. Durable action `f7267c9c-2fc0-4f45-9554-c19b5f3fedd3`
and publication `5094ffa3-1e34-4912-aee9-42c209e07a48` passed. Conversation
`c5deacdf-1c5c-4ce1-a173-8ce59dbab066` became completed at 15:29:40.680;
there were no new runs before the subsequent actual user-source message.

That fresh source `1547268226424250419` correctly reopened the same CHA-43
task/conversation at generation 1. Delivery `2749957f-1b3e-4547-a171-435422efe628`
was processed and one wake created run `a61e09f0-2130-4eac-af68-50b2e7af2510`,
which succeeded from 15:31:33.079 to 15:31:46.407 (13.328 seconds). However,
no working or final publication was created, and the actual UI showed only
the source eyes reaction. This is a real fresh-after-close regression under
independent diagnosis, not a successful chat response.

**Private Board passive reply: PASS in this live case.** New GitHub comment
`5604432927` naturally reopened the existing CHA-45 task. Run
`9f3519c1-600b-4110-a0be-f59a4e58ea7e` returned `GH80-A-READY` in 13.961
seconds. Its final edited provider message `5604433759` took two publication
attempts, with no retained final error; this differs from the attempt-1
latency sample above and must not be represented as such.

The next actual private Board chooser upload created attachment
`18a0c3b3-8817-4f48-be7d-1f6a60647b56`, matching the original 152-byte TXT
SHA256 `e5ea1c89ad69c0ae9dffea0599c730e5d284816dbcd9dae44746c7a29f790293`.
Run `0df1daff-9171-456e-b83d-32b6be7f53fe` completed in 28.039 seconds.
The accepted yielded/response-wake result and applied `board_response_waiting`
decision kept `in_progress → in_progress`, effects empty. Exactly one private
`internal_agent_write` answer `b5dbdca1…` reports the correct three fields.
The actual Board showed that answer. Independent read-only verification more
than 71 seconds after completion found no successor run/wake, no publication
since the Board source, and no outbound message link on the private answer.
The earlier server-79 erroneous automatic completion was not manually reset.

Remaining: diagnose/fix the Discord reopened-turn egress failure, implement
and test GitHub own-eyes cleanup, qualify Telegram draft Stop if observable,
and complete eligible Teams tenant testing. Landing continues separately;
these observations are not a whole-product production-readiness claim.

### Telegram DM navigation and bounded draft observation (15:40 UTC)

The actual Board's conversation list and task banner exposed
`https://t.me/cryppadotta/168` as “Open Telegram” for a bot DM. That is the
human sender's username, not the bot conversation. Telegram documents
[message links](https://core.telegram.org/api/links#message-links) for groups
and channels; a bot DM should use its bot username link. The helper now
handles explicit private chats and positive DM IDs before considering raw
chat usernames. The conversation-list projection also corrects retained DM
URLs using the current endpoint bot username, without rewriting stored
provider receipts. Missing bot username returns no link rather than the
known-wrong historical URL. Public/private group and forum links are unchanged.

Three new helper cases genuinely failed before the fix; the seven-case helper
suite now passes. One composed ingestion/list regression failed on fresh
`telegram_dm_links_20260909_red01`, then passed on fresh
`telegram_dm_links_20260909_green01`, verifying new ingestion, retained-link
projection, unchanged stored URL and missing-bot fallback. Other cases in that
file were filtered, not rerun. Plain server TypeScript passes. This fix is not
yet deployed, so the real UI still displays the old URL until the next cutover.

Separately, an actual explicit Board send to active Telegram CHA-46 published
a 3,484-character synthetic draft as message `417200359:171`. Publication
`f7bc452a-ca7c-4ed4-a299-add7a2c8bed9` was created at 15:39:38.465 and published
at 15:39:39.956, attempt 1. Draft action `5ac70d6e-5faa-4cd8-8f23-a584bf731b28`
completed its draft phase in 1.001 seconds. No agent run was created. The
actual Telegram Web view displayed the complete text, but no Stop control was
observed/clicked before completion. This proves delivery, not Stop handling;
no artificial production delay or repeated send was introduced to manufacture
a visible Stop test.

### Private Board response ownership and live hydration (15:57 UTC)

Refreshing CHA-45 exposed one persisted answer rendered twice: native run
`0df1daff-9171-456e-b83d-32b6be7f53fe` had selected exact comment
`b5dbdca1-e123-46dd-bfb6-89f6ae1699b9` in its presentation decision, and that
comment correctly retained `createdByRunId`. The page only inferred its
`runId` from comment-added activity, however. Internal passive finalization
does not emit that activity, so the settled transcript and independent
comment both displayed the answer. No duplicate comment existed in storage.

IssueDetail now uses an agent comment's durable authoring run ahead of the
activity projection. Human comments are not inferred from matching text or
timestamps. Two genuine RED cases cover missing and conflicting activity;
both pass after the fix. The existing response-wake rendering test now also
covers a persisted selected private comment owning the answer. Actual browser
reload, accessibility, DOM ownership and screenshot checks confirm the
15:31 answer appears once. This dev instance serves current UI source through
Vite; the backend remains server 80 from `9531f6e38` until an explicit cutover.

Fresh private follow-up `034468d5-627b-4f70-b55b-0efda7f72067` started run
`dd11fcef-d60a-4756-b0fb-c71943278c49` at 15:50:36.182, ending at
15:50:51.224 (15.042 seconds). Its exact answer `BOARD80-FRESH-READY` was
persisted as `cd2a8c7a-91fb-4f1d-b790-153dd90840eb`, with
`board_response_waiting` and no external publication. This confirms a real
new Board source resumes work after the earlier passive wait.

That turn exposed a second issue: terminal events refreshed run/activity
queries but not the canonical comments, leaving message controls absent
until reload. A genuine RED terminal-cache test now passes; only terminal
events refresh comments, while queued/running/progress events do not. A new
actual request (no reload after sending) ran as
`a0533c85-87ec-4248-bdca-bd0c92367f25`, 15:53:43.143–15:53:58.997
(15.854 seconds). Its private comment `ae4ab6af-ef45-45f8-9ba9-a78634c2cf28`
showed `BOARD80-HYDRATED` once with Copy/Helpful/Needs-work controls. At
15:56+, the task was still in progress with no execution run and no
publication created since either private source. No provider message or
historical data was edited to create these results.

A third, independently reproduced race kept both the settled activity and
old live tail visible while the canonical comment fetch was slow. Both
normal completion and accepted response-wake tests genuinely failed with
two progress lines. The UI now records when the settled projection actually
contains a final reply and lets that reply own the turn immediately. Delayed
comment arrival then replaces the fallback without duplicating the answer.
Pending questions and incomplete runs do not acquire this final-reply signal.
The focused RED/GREEN logs are retained under the ignored runtime directory
as `board-reply-{projection,hydration,settlement}-*-0909.log`; these UI changes
do not grant any external publication capability.

The final four-file UI cohort passes 324/324 (IssueDetail, TaskChatThread,
live updates and transcript adapter), and UI TypeScript passes. Independent
read-only review found no blocker in the six changed UI files. The slow-fetch
race was verified deterministically, not claimed as an artificially delayed
live-provider test. Real-browser refresh and no-reload hydration observations
above remain separate evidence.

### Fresh-after-close causal publication repair (local `69710d5fd`)

The old query suppressed every source in a conversation that had any earlier
published close/new control. The exception now requires the exact complete
admitted inbound batch for the current run, matching scheduler receipts,
unchanged comments with no pending edit/delete/restore lifecycle, current
thread/session/credential generation and every current principal's authority.
Both retained provider time and server receipt time must be strictly after
every published close/new boundary. Missing or ambiguous chronology, old
sources first delivered late, copied-source children, mixed coalesced batches,
revoked access and reassignment remain denied. Active state alone grants
nothing. Candidate dedup avoids repeating the entire batch proof per link.

Fresh `red03` reproduced the exact close→fresh-source missing-publication
failure. Final `final02` passes all 36 Discord command cases (19 new,
17 existing), and plain server types pass on the final source. Four adjacent
files passed 194/194 before the semantic-neutral candidate-dedup change;
that is not claimed as an exact-final full-suite run. Two independent code
reviews are clear. Read-only use of the candidate resolver on live run
`a61e09f0-2130-4eac-af68-50b2e7af2510` returns only its correct conversation,
but no answer was manually published and the live backend is not yet upgraded.

### GitHub own-receipt cleanup before cutover

Terminal publication previously excluded GitHub from eyes removal. The new
path retains the exact numeric bot-user and reaction IDs, resolves identity
from the current App rather than an App ID or environment-supplied username,
and routes issue/PR-conversation versus inline-review reactions correctly.
Removal reads every bounded page before deleting only that bot's eyes;
unknown identity, incomplete pages or lost authority cannot become success.
The pinned adapter supplies offline App JWT signing, while token exchange and
reaction HTTP use a bounded fetch path that awaits local abort settlement.
Every request checks the renewable credential lease and current generation.

Fresh composed tests genuinely reproduced missing cleanup, then passed 12/12,
including a held token exchange and held add. Final publication cannot pass
the shared credential lease until add settles; the final then stages exactly
one removal before releasing its lease. Restart, credential rotation,
newer-source isolation and failure cases are included. Additional genuine
RED tests caught expiry during the last asynchronous authority check and
loss of HTTP 429 Retry-After for malformed, truncated or oversized response
bodies. The fix retains only safe status/backoff, never provider body prose,
and rechecks the deadline after the authority await. The final helper/runtime/
classifier cohort passes 88/88 (31 helper cases). The earlier 12-case joined
run preceded that final bounded-backoff extension; a combined full run is
still required. Independent final code review and a separate no-network
truncated-body RED→GREEN probe are clear. No live reactions were removed
manually, and this source is not yet running in the provider-connected server.

### Additional live timing checks (16:04 UTC)

Independent inspection explains GitHub final `30c6aee6…` having two attempts:
server-80 log records a temporary local authorization lock and explicitly no
provider delivery on the first attempt. The retry policy waited 250 ms;
publication completed 1.596 seconds after the 13.961-second run. Working and
final publication retain provider message `5604433759`, with one outbound
link updated to the final. This is a safe local retry, not a duplicate post.
The exact competing lock owner was not logged and is not inferred.

A fresh actual Slack follow-up in CHA-44, source `1788969713.397849`, again
asked for no continuation of the old stopped checklist. Luna run
`9d736242-40ca-46d0-841d-3e278e305931` ran 16:01:54.854–16:02:09.320
(14.466 seconds). Working `595df82a…` and final `f524603a…` both published
on attempt 1 to the same message `1788969715.799459`; final published at
16:02:10.576. The actual Slack thread shows exactly `SLACK80-READY`, no
resumed checklist and no remaining eyes on this source. No active/queued
Maya run remained at the subsequent read-only check. This is server 80
evidence, not a premature claim for the pending server-81 cutover.

The full deterministic chat/Board browser suite subsequently passed 43/43
on fresh `board_receipts_browser_20260909_final05` in 6.1 minutes, with no
retry. It loaded combined source `19ebc99e7`, before the subsequent Teams/
Telegram timestamp-provenance hardening. Provider transport is mocked in
those browser tests; real Board upload/storage/receipt paths are exercised.
The separate full server suite was still progressing at this checkpoint.

At 16:03 UTC the user merged runner #13092 (`fac07b42…`) and changed the
landing requirement to two remaining chat PRs. The separate landing lane
verified/fetched the merge and is recomposing the full frozen source on
current master. Earlier runner-base/chat-top counts and reviews do not
satisfy the new plan; both chat PRs need their own exact-head gates.

At 16:07 the full server cohort completed successfully: **898/898** on fresh
`chat_snapshot_full_20260909_root08`, frozen source `19ebc99e7`, 480.77 seconds
of tests and 491.03 total. The slower runtime is retained as observed; no
failure, skipped case or timeout retry was hidden. A read-only check during
the quiet output interval found no blocked PostgreSQL locks and observed
fixtures continuing to complete. The final summary is retained in
`chat-snapshot-full-root08-0909.log`. Plain server types also passed. The
subsequent timestamp-provenance change requires its own targeted verification
and is not attributed to this earlier loaded-source suite.

### Provider chronology freeze before server 81 (16:14 UTC)

Real pinned Teams parsing substitutes a display-time local clock when its
activity timestamp is missing. The real signed Telegram `/task` path also
allowed a missing raw date to reach a display-time fallback. Genuine RED
tests reproduced both; those clocks must not authorize a source after a
published close/new boundary. Intake now retains only the actual raw Teams
activity timestamp or Telegram message date, with an explicit provider-source
marker. Missing, malformed and calendar/hour-rollover values remain unknown.
Historical markerless values cannot be retrospectively promoted to provider
chronology; ordinary work with no historical close remains unchanged.

The final focused cohort passes **35/35** on fresh
`chat_provider_timestamp_20260909_green02` (28.36s total), with plain server
types passing. It includes 11 new tests covering 15 raw timestamp inputs,
historical missing/wrong markers, modern positive provenance, unchanged
no-close admission, recipient restart, all fresh-after-close cases and real
Telegram group/topic controls. The other 874 cases were filtered, not run.
Teams parser-to-service coverage is not live tenant/JWT qualification; the
malformed ordinary Telegram parser boundary is explicitly distinguished from
the real signed `/task` webhook path. Final logs are retained as
`provider-timestamp-final02.log` and `provider-timestamp-types-final02.log`.
Independent source review is clear. This targeted result does not rewrite the
earlier 898-case frozen-source result. No live state was mutated by these tests.

### Server 81 live cutover and fresh Discord/GitHub proof (16:19 UTC)

Maya had no running/queued runs or queued/claimed wakes. The audited pause
succeeded, server 80 PID 74752 shut down normally after its 5-second HTTP
drain, and both PID and listener retirement were checked. The quiescent
pre-81 backup is `pre-81-backup.rTBhiF/pre-server-81-20260909-111517.sql.gz`,
13,400,752 bytes, directory 0700/file 0600, gzip verified, restore untested,
zero pruned files. Schema was already current at 258 journal entries; no
migration was applied. Qualified private runner SHA `6844f20e…` and strict
code signature remained valid. Original protected binary and lockfile hashes
remain unchanged.

Server **81**, PID **44402**, loaded clean source **439e8472a** and became
ready at **16:15:43.931 UTC**. Maya resumed through the audited API. Private
Board health returned 200; the webhook-only public Funnel still returned
404 for `/api/health`, as intended. No historical owner claim was cleared.

Fresh actual Discord `/paperclip close` interaction
`1547279491607437352` returned a private receipt and public confirmation
`1547279493977210942` at 16:16:18.642. A later explicit source
`1547279569520824380` started run `1d4162d4-d0b5-43f9-9b6c-422febc8514a`
on the same CHA-43 issue, 16:16:37.320–16:16:52.243 (**14.923 seconds**).
Working publication `2ef76993…` and final `4c33f042…` both published once
to message `1547279577766699062`. The actual Discord UI shows exactly
`DISCORD81-REOPENED`, with eyes removed. This closes the fresh-source
missing-answer regression observed on server 80; it is actual provider proof.

Fresh actual GitHub source `5605072434` started run
`4f434628-6a84-4e07-9a42-f3a5e2607181` on CHA-45,
16:16:40.764–16:16:54.623 (**13.859 seconds**). Working `727233db…` and
final `76d9781d…` both published on attempt 1 to the same comment
`5605073496`; the actual issue shows exactly `GH81-RECEIPT-READY`.
Receipt add `df3359db…` and removal `9dcd7071…` each processed on attempt
1, retaining numeric bot-user `325786510` and reaction `413949627`.
The browser first observed eyes during work, then reload confirmed no eyes
on this new source. Historical server-80 eyes were not manually removed.

Two additional live findings remain open rather than hidden by these passes.
The Telegram task banner still returns the historical human URL despite the
corrected conversation-list projection; its separate issue-binding projection
is now under RED→GREEN repair. Startup also blocked three otherwise waiting
tasks while Maya was paused: the existing non-invokable-assignee branch runs
before passive-wait classification. A narrow durable-receipt-qualified paused
case is being tested without relaxing genuine stranded-failure escalation.
Startup created no model run/requeue/reap, retained six old blocked native
claims, and naturally published an old Discord terminal fallback; this generic
fallback is not counted as successful delivery of that old requested answer.

The separate Telegram binding repair reproduced the actual Board route's
wrong human link, then passed on fresh
`chat_telegram_binding_green_20260909_qualification01`: 1/1 regression,
908 filtered, 10.56s, plus helper 7/7 and plain server types. It reuses the
existing provider-link helper for Telegram DM issue bindings; current bot
username or null is projected, never rewriting historical rows. Route and
direct binding, wrong-company denial, missing-bot null and legitimate group
link preservation are covered. Unrelated formatting was restored and an
independent review is clear. This source is not yet deployed on server 81.

Discord source `1547280183478976513` then uploaded a fresh synthetic PNG
and TXT in the reopened CHA-43 thread. Run
`5e3d0deb-cc30-4f45-802f-e993bcde84fb` completed
16:19:04.999–16:19:58.969 (**53.970 seconds**). Actual Discord shows the
correct orange-tabby description and lighthouse/amber/63, one final response
on existing progress message `1547280198834069515`, then real image
`1547280428027879584` and TXT `1547280434126258197`, all publication attempts
1. The expanded image viewer rendered the correct cat; the document preview
contains the exact synthetic text and eyes disappeared. Local hashes of
received and prepared output storage bytes match: PNG 2,111,878 bytes,
`7693966f…`; TXT 152 bytes, `e5ea1c89…`. These are storage-byte checks plus
actual provider presentation, not a claim of independently downloaded hashes.

Slack source `1788970785.056649` explicitly continued after restart without
resuming the old cancelled checklist. Run
`814e1eb9-45b3-4fc5-9b61-40d193d51d33` completed
16:19:46.655–16:19:58.940 (**12.285 seconds**). Working `5795595d…` and
final `051419b4…` published once to the same message `1788970787.474679`;
the actual thread shows exactly `SLACK81-READY`, with no eyes or extra work.

The landing lane created two chat PRs after runner #13092 merged:
foundation #13100, 136 files at `29c48d25d19a0c70c05f5e966afff293de6dd831`,
then integration #13038, 366 files at `f9250078581dba0741d6a926eb361fee6210193f`.
Both require fresh exact-head checks/review, and new live repairs must be
composed before final qualification. No chat merge is claimed here.

### Telegram close semantics and an additional cleanup defect (16:27 UTC)

Root's attempted slash `/stop` test was not valid: this connector registers
`/task`, `/status`, `/new`, and `/close`, not `/stop`. Telegram correctly
returned its supported-command guidance. The preceding 600-word run
`3800f242-6645-49b7-921c-35ae022b3a7c` had already finished in 42.457s
and delivered a message-limit explanation plus an actual Markdown attachment;
neither its late unsupported command nor this overflow proves native draft
Stop. That client-native feature remains unobserved.

A separate active-turn test used the supported `/close`. Run
`823185aa-4648-4e13-89b0-0f3b8a7d4603` started 16:24:05.219 on CHA-46.
Close `ea6960ee…` published as `417200359:180` at 16:24:17.645 and the
actual Telegram chat confirmed that the next message starts a new task.
The launched run continued internally and succeeded at 16:24:52.599;
there was no later final publication into the closed conversation. This is
the intended conversation-only closure, not cancellation of Paperclip work.

The exact already-published working message `417200359:178` nonetheless
remained "Maya E2E is working…" after the run finished. Independent code
and durable-receipt inspection identify a real cleanup gap: close posts a
separate control and prevents later output, but does not retire the existing
placeholder. A narrow close-owned current-progress replacement is being
tested. It must not overwrite an authored final, including an ambiguous
delivery, and must not guess among multiple independently owned lanes.

### Paused-maintenance repair frozen (16:33 UTC)

The exact native Board and chat passive waits each genuinely failed the
baseline restart sweep: a paused assignee was checked before the durable
passive decision and the task became blocked. The narrow repair now skips
that escalation only for a paused agent with the same current assignee,
in-progress issue, succeeded native run, accepted completion-contract result,
committed finalization and currently applied passive-wait status decision.
Current unchanged sources, destination and all external principals are
revalidated. Newer requests, edited/deleted source, pending governance,
reassignment, termination, failed runs or incomplete receipts retain the
existing recovery behavior. This grants no execution/presentation permission,
creates no child work and does not repair historical blocked tasks.

Root review caught a loose UUID-shape guard that could admit a malformed
source ID into a PostgreSQL cast. The strict shape and a no-throw negative
are included. Final **45/45** focused tests pass on fresh
`chat_paused_passive_20260909_final02` (16 new and 29 adjacent cases,
21.96s tests/46.34s total), with plain server types passing. Repeated sweeps
preserve comments, recovery actions, runs and wake counts; there are no
provider calls. An earlier widened run exposed missing approval-fixture
cleanup, which is fixed without changing production assertions. Logs retain
that failed attempt separately. This source is not yet deployed on server 81.

### Runtime replacement and close transport qualification (16:43 UTC)

Foundation review identified a real registry lifecycle race: a replacement was
published before its predecessor finished shutdown, and a failed shutdown lost
ownership of that predecessor. Six new regressions genuinely failed on the
baseline. The repair serializes lifecycle operations per endpoint, hides retiring
instances, retains failed retirement ownership for an explicit retry, and fences
superseded replacements/removal/global shutdown. Shutdown joins every owner even
when one fails. A seventh positive checks that a later explicit replacement after
removal works and another endpoint is not blocked by the first endpoint's drain.

Initialization remains caller-owned: the service installs callback context before
starting the Discord gateway, and the pinned SDK already initializes its webhook
path lazily. Moving initialization into the registry would violate that service
boundary. No new runtime is constructed or made available until retirement succeeds.

Final runtime plus pinned adapter tests pass **112/112** (5.93s); plain server
types and diff check pass. Logs retain six baseline failures separately from the
final result. Three of the adapter tests independently exercise actual pinned
Teams transport: exact-ID progress edits send a fresh text activity with no old
card controls, never edit a separate authored answer, and do not fall back to a
new POST after an uncertain edit failure. Those tests cover personal/channel/group
transport shapes with simulated HTTP, not live tenant installation or rendering.

The close-placeholder selector separately passed **35/35** focused and adjacent
integration cases on a fresh database. Independent review is now investigating an
ambiguous interaction-prompt consumer alongside the already-covered unknown final;
the full combined test/cutover waits for that review. Multi-lane or unowned
placeholders remain a documented conservative fallback, not a blanket cleanup claim.

### Fresh Telegram task after close and feature-gate repeat (16:46 UTC)

Actual Telegram source `417200359:181` requested a fresh task after close and
did not resume the old checklist. It created CHA-47 (`4c1ccf5e-a76b-47f7-bd97-0795d7e78514`),
conversation `f249aaa6-a29b-4629-8a3d-67536f75933c`, generation 13. Native Luna run
`114e6eeb-fdad-40da-84ee-709254f2125a` succeeded
16:29:32.542–16:29:52.840 (**20.298s**). Working `1d8e5a08…` and authored final
`a1f904b0…` both own provider message `417200359:182`, each attempted once;
final publication completed 16:29:55.295. The actual bot conversation shows
exactly `TG81-NEW-READY`. End-to-end publication was about 24s after the source,
not merely the 20s model run. The task remains in progress with passive decision
`30a0aafd-6f71-4185-85af-5a170c57e60d`, suitable for the next maintenance-pause check.

Repeated experimental settings, catalog, connection routing and agent-sidebar
tests pass **154/154** across four files (7.13s). This independently checks the
default-off chat surfaces and production tool routing on the original source;
the recomposed two-PR landing still requires its own exact-head verification.
Protected lockfile and original packaged runner hashes remain unchanged.

### Close-owned progress cleanup frozen (16:52 UTC)

The final narrow selector replaces one exactly owned plain progress message when
closing Telegram, Slack, Discord or Teams. It requires the current outbound link,
current publication ownership and historical same-run milestone proof. It refuses
multiple lanes, cards, authored finals and possibly delivered consuming questions.
After a confirmed close commit it removes only that run's owned receipt reactions;
the Paperclip run continues internally under the existing close semantics.

Independent review reproduced four pending/unknown question or confirmation
consumer cases that the initial final-only veto missed. A second root review then
reproduced two public `resolvePublication(cancel)` paths: a final or confirmation
edit had been attempted and its receipt lost, but cancelling retries made the new
selector incorrectly eligible to overwrite it. Attempted cancelled/failed consumers
now veto cleanup too; a never-attempted cancelled consumer does not. The resolver's
behavior and provider authority have not changed.

Final generic close-owned **32/32** tests pass on fresh
`chat_close_cancel_20260909_final02` (38.40s total/21.49s tests), with plain server
types and diff check passing. Earlier nested 28/28 excluded the separate pinned
Discord four and is retained as narrower evidence. Baseline Telegram/Slack/Discord
failures, four interaction-consumer failures and two public-cancellation failures
are preserved. The latest tests use real persisted service paths with mocked
provider effects; they do not claim a live crash/network-loss reproduction.

Source hashes: service `4eedcdfd3416c99f65ad2f8f01e3a3f9946b68ec765a550b50d2f15f14c22def`,
integration `d338227a3c2b1efc93bcb0018b0ef66b3056496c3a72b762bd06a71bdcbb6dca`.
Root's full integration and browser repeats loaded this close source at 16:50 UTC
with runtime `653722c59`. Independent review subsequently found a separate held
initialization/retirement race; its forthcoming runtime-only fix is not covered by
that already-running snapshot. Server 81 remains unchanged until qualification.

### Initialization/retirement boundary and browser assertion (16:59 UTC)

The registry queue repair alone did not own an in-flight SDK initialization.
Three genuine held-initialization regressions showed remove/replacement/shutdown
could finish before initialization and leave an orphan Discord gateway. A runtime-
local permanent retirement fence now joins the exact initialization operation and
retains failed shutdown ownership for explicit retry. Webhook-triggered implicit
SDK initialization shares that ownership inside the existing ingress deadline,
without automatically starting the caller-owned Discord gateway.

Independent review also isolated both outer-await gaps: initialization can finish
its internal check before retirement starts in the microtask preceding Gateway
startup or before the deadline wrapper invokes the webhook handler. Explicit
checks at those exact boundaries are covered by separate baseline failures;
one original Gateway variant also exposed a shutdown deadlock. Final runtime and
adapter tests pass **119/119** (6.96s), plain server types and diff check pass.
Runtime SHA `4ea0aaa69a4abd29cc60eb8bcf69b49e722f1dd31937a788dd394a7c1ad7a84b`;
test SHA `af0440806ffebafb6742dbfc97812c9f13eed32695c0b7a22de1386f9d1a763e`.
Two fixture-only missing guild IDs were fixed after the first typecheck failure;
the production source and assertions were unchanged. No live restart yet.

Browser repeat `board_receipts_browser_20260909_final06` finished **42/43**, not
green. Telegram's generic zero-alert assertion raced with the expected next-step
identity-readiness alert after setup had succeeded. The retained trace shows
"Try Maya in Telegram" and "Link the account you're testing", not a connection
error. The test now scopes its alert to "Connection failed" and waits for the
next heading; all existing token-redaction and required identity-warning checks
remain. The complete Telegram catalog/setup/detail case passes **1/1** on fresh
`board_receipts_browser_20260909_final07` (35.8s total/26.8s case). This is a
test-only correction, not a production UI change or a replacement full-suite claim.

### Landing composition: immutable recovery input (17:07 UTC)

The merged native continuation path appended a new prompt to an already persisted
execution input, including when no newer user input existed. The bootstrap's
whole-input equality guard correctly rejected that mutation. Same-run recovery
now retains both the originally admitted input and its completion contract. A
stored idle checkpoint is not sufficient authority to revise them: the provider
can have started a turn before the database checkpoint was persisted.

Newer independently admitted user input remains a separate durable wake. The
joined service regression covers old active recovery, a stored-idle/fresh-active
crash gap, and the original flag-off no-new-input case. Both newer-input cases
inspect the actual separate `startTurn` envelope, one accepted successor result,
the unchanged old contract, and repeated reconciliation without a duplicate.
The full resumption plus existing continuation-helper cohort passes **15/15**
(23.09s); plain server typecheck passes. No new mutation/lease-claim helper or
general promotion/finalizer override is introduced.

Intermediate failed fixture attempts are retained: an incorrect deferred-context
key, a fresh-run rollout flag left disabled, and a mock missing native runtime
context capabilities. Their corrections preserve the existing closed checks.
These focused results are not the final composed repository or CI verdict.

### Final-source fixture correction and browser repeat (17:09 UTC)

Full service repeat `chat_snapshot_full_20260909_root09` finished **934/941**,
seven failures, in 591.51s. It loaded close cleanup `42d48cbdf` and runtime
`653722c59`, before the later initialization fence. Five old Telegram/Teams
fixtures supplied only SDK metadata dates, not actual provider timestamps;
the stricter retained chronology correctly refused those synthetic dates.
An adjacent Slack assertion then saw a Telegram wake from the preceding failed
fixture's incomplete cleanup. Correct raw timestamps and explicit provenance
assertions now pass **23/23** targeted and adjacent cases on fresh
`chat_timestamp_fixtures_20260909_green01` (21.50s), with server types passing.

The seventh failure was the Discord close fixture's fabricated run referring to
a setup source whose inbound wake was still issued/retryable. The database had
no receipt reaction for that source, so production correctly did not invent a
removal. The test now delivers a fresh source and proves its processed wake and
processed receipt before constructing the run and checking close cleanup.
The complete close-owned cohort passes **32/32** on fresh
`chat_discord_close_fixture_20260909_root01` (26.44s), with server types passing.
These are test-only corrections; production chronology and cleanup guards remain
unchanged. The original seven-failure log is retained, not reclassified as green.

The complete deterministic browser repeat now passes **43/43**, zero retries,
on fresh `board_receipts_browser_20260909_final08` (6.2 minutes), loading runtime
`b5a9f9e10` and the scoped Telegram connection-error assertion. The earlier
42/43 trace remains retained separately. A new complete service repeat on an
unused database is required for the final combined source; no broad workspace
or live provider success is inferred from these mocked-provider tests.

### Live server 82 cutover and actual close/reopen proof (17:19 UTC)

Server 82 loads `d3a648139` on loopback 3137 (PID 60999), ready at
17:09:36 UTC. Before stopping server 81, the QA agent had no queued/running
runs or queued/claimed wakes. The audited pause completed at 17:09:04.581,
followed immediately by graceful shutdown. The stopped-database backup is
14,019,566 bytes in ignored `pre-82-backup.LuMJCC`, mode 0600 in a 0700
directory, gzip verified, restore untested, zero pruned backups. Schema 258
was already current; no migration, secret rotation or historical owner reset.
The qualified private runner is unchanged and still passes strict codesign;
the protected original runner binary and lockfile hashes are unchanged.

While Maya remained paused through startup and more than one heartbeat interval,
CHA-43, 44, 45 and 47 retained their exact in-progress status and existing
passive-wait decision IDs. Their run/comment/wake counts stayed respectively
7/13/7, 9/18/9, 8/16/10 and 1/2/1. No new execution owner appeared. The
separate already-closed CHA-46 was escalated under the existing lost-authority
rule; this is not a claim that all historical tasks were exempted. Resume was
audited at 17:10:18.426. Six quarantined historical owners remain untouched.

The untouched CHA-40 Board page now actually shows Open Telegram pointing to
`https://t.me/MayaPaperclipQA1234bot`. Independent database inspection confirms
its stored historical URL is still `https://t.me/cryppadotta/162`; the successful
projection was not manufactured by rewriting that conversation.

Actual active-close tests passed in the signed-in provider browser:

- Telegram source `417200359:183` started run
  `bd7534aa-c469-49b8-83f8-302331b11255`. Close publication
  `9accd0e9-0f51-4835-88a1-2f629cb1e4de` edited the same working message
  `417200359:184` at 17:10:57.527, and its source reaction removal completed
  at 17:10:58.043. The old run finished internally in 39.452s with committed
  finalization but no authored comment, external final or retry child.
- Discord source `1547293240846319657` started run
  `721693a6-4aea-45b5-854d-29c65fd34969`. Native command
  `1547293405057654834` produced a private acknowledgement, while close
  publication `a3df4db6-8607-4b38-bfc7-7d3d1490a0d0` edited the same working
  message `1547293249075679335` at 17:11:35.836. Eyes cleared at 17:11:36.022.
  That run also finished internally (42.079s) without an external final or
  retry child. The browser showed a closed confirmation, not stale progress.
- Fresh Telegram source `417200359:186` created CHA-48, generation 14, and
  returned `TG82-FRESH-READY` once in message 187. Run
  `973708c7-7955-4853-80aa-f658606dd857` took 14.041s; ingress-to-final was
  15.790s. Fresh Discord source `1547293547504468090` reused CHA-43,
  generation 1, and returned `DISCORD82-FRESH-READY` once. Run
  `3b63c2c0-11a0-4838-9812-ba7635d16c83` took 20.094s; ingress-to-final was
  21.587s. Both new tasks/turns wait for the user rather than resuming the
  closed checklist. Every final publication used its first attempt.

GitHub A/B each produced one native-Luna reply and cleared the owned eyes.
A run `e0b86b7f…` ended at 17:12:37.453; B arrived at 17:12:41.614, so this
pair did **not** exercise overlapping queue admission despite the browser
briefly still showing A's working text. A deliberate C/D overlap is separate.

Slack source `1788973941.613929` (SLACK82-A) is still unreceived: it survives
a full provider-page reload, but neither proxy nor server recorded ingress.
The configured stable callback and required event subscriptions are correct.
A separate real mention and subsequent unmentioned follow-up both succeeded
once with exact eyes cleanup: runs `0ddb1473…` (11.802s) and `09491b27…`
(10.941s). The mention had an HTTP retry and the later unmentioned event's
first locally observed request already carried `retry_num=1/http_error`;
all locally observed responses were 200. This points upstream of the local
proxy, not to lost thread subscription, but does not establish the precise
network/provider cause. No blind replay of the missing original was attempted.
The unchanged callback edit draft was discarded without saving configuration.

Full service repeat `chat_snapshot_full_20260909_root10` finished **940/941**,
one failure, in 411.29s. The retained original invocation from the repository
root found no files; the actual run used the server directory and an untouched
fresh database. The failed lock test's exact final and question publications
had already succeeded under the held lock (~1.57s), but its assertion waited
for the entire global sweep through accumulated fixture history. A narrow
receipt-scoped assertion correction is under independent qualification; the
five-second bound and held-lock requirement are not being relaxed. This full
run remains red; another final-source full repeat is required.

The exact-receipt lock-test correction is now frozen: **11/11** target and
adjacent cases pass on fresh `chat_progress_lock_20260909_final01` (14.65s
total/4.30s tests), plain server types and diff check pass. A separate fresh
original two-case baseline also passes, consistent with accumulated-history
sensitivity; the unrelated sweep tail's precise cause was not instrumented.
The test still holds the lock until both exact durable receipts and provider
effects are confirmed, checks the blocked lane is untouched, releases in
finally, joins the complete flush and propagates its error. Source test SHA
`fec6ca9839f13eee2123be77b97f43fce17154c6aee23f78a0a2dbde324411f9`;
production service remains `4eedcdfd…`. No timeout increase or production change.

### Optional Slack delayed events boundary (17:22 UTC)

Independent primary-source review found Slack's
[delayed-events retry option](https://docs.slack.dev/apis/events-api/#delayed-events-retry):
after the normal three retries it retries hourly for 24 hours and permits
events more than two hours late. The documented configuration path is the
Event Subscriptions UI; the
[manifest reference](https://docs.slack.dev/reference/app-manifest/#settings)
does not document a corresponding field. No guessed field, full manifest
replacement, different configuration-token authority or provider change was used.

The option remains off intentionally. Current permission and duplicate-source
checks are necessary but not a blanket stale/supersession policy for ordinary
messages first seen many hours late. Ordering open retained deliveries does not
compare every old unseen prompt with already completed newer work. The existing
delayed-Stop test covers control authority, not arbitrary old message admission.
Before automatic enablement, qualify unseen old ordinary messages after newer
work and `/new`, across restart, alongside positive new-source, duplicate and
previously admitted-work cases. This is a documented unqualified extension,
not a claim that delayed events caused or would repair the missing Slack source.

### Late first deliveries resolved by normal provider delivery (17:24 UTC)

The missing Slack A was not permanently lost. Exact source `1788973941.613929`
first reached the proxy at 17:19:58.081 with `retry_num=3/http_error`, and its
durable delivery arrived at 17:19:58.097: **456.484 seconds after the provider
timestamp**. Run `4dc1ae1a…` then succeeded from 17:19:58.919 to 17:20:13.444
(14.525s). One final `83fc3805…` published at 17:20:13.808, editing working
message `1788974399.841109` to exactly `SLACK82-A-READY`; eyes cleared at
17:20:14.043. Every publication/reaction attempt was 1. No queued/running run
or pending/new interaction remains in that Slack task. Root actually saw the
late answer after previously confirming the original message survived reload.
This recovery used normal retries, no blind resend and no setting change.

GitHub C/D also require a precise distinction. C run
`7af6a321-2bf2-4746-811d-87ad5b29c883` was independently observed running when
root sent D at 17:18:56. C finished at 17:19:43.708 (53.430s), with one
checklist final at 17:19:44.490 in provider comment `5605905477`. D source
`5605906590` first reached the proxy at 17:19:50.296, **54.296 seconds after
its provider timestamp**, then reached durable intake at 17:19:51.048.
Its run `1a004cab…` took 11.177s and one final at 17:20:03.857 edited provider
comment `5605918558` to exactly `GH82-D-READY`. Both cleared their exact owned
eyes and used one final attempt. The provider page shows checklist then answer,
but local admission did not overlap; this is not a FIFO-overlap pass.

The proxy socket carrying D was itself accepted only at 17:19:45.413 and
handled D in 32ms with 202. Other requests were served during the delay.
Together with Slack retry headers and zero corresponding earlier local ingress,
this localizes substantial latency before the proxy. It does not prove whether
provider delivery or Funnel's external path caused that latency. The optional
24-hour setting remains off, and a same-active-thread late backlog answer is
not by itself proof of an authorization violation. Explicit `/new`/`/close`
late-source boundaries are being reviewed separately without inventing an age
cutoff or silently discarding legitimate user requests.

### Final combined integration green (17:26 UTC)

Full `chat-channels.integration.test.ts` passes **941/941**, zero skips, on
fresh `chat_snapshot_full_20260909_root11`, loading frozen `bc70b12e9`:
327.62s total, 319.65s tests. The final source includes both the strict runtime
initialization fence and exact-source close cleanup, with the provider-date,
accepted-Discord-source and receipt-scoped held-lock fixture corrections.
The earlier 934/941 and 940/941 logs remain retained as failed full attempts.
Plain server types pass, runtime/adapters119, targeted timestamp23, close32,
held-lock/adjacent11 and experimental UI154 are separately scoped green gates.
Full deterministic browser43 at `final08` loaded the same production source;
later changes were integration-test and documentation only. Neither live Teams
nor native Telegram draft Stop is inferred from any mocked-provider gate.

Both chat PR file lists were independently checked at their published heads:
foundation has zero image paths; integration contains only three production
brand SVGs (Discord, Teams, Telegram). No wireframe image or gallery remains.
Required exact-head CI/reviews and dependency-ordered landing are still separate
gates; no chat merge or broad whole-workspace pass is claimed here.

### Provider-owned delivery evidence and control-boundary RED (17:32 UTC)

Read-only GitHub App delivery diagnostics used the user-supplied PEM privately,
first verifying exact App 4853886 / `paperclip-maya-e2e-0906`. No credentials,
headers or full request payloads were emitted, and the diagnostic requested no
redelivery or configuration change. Source D `5605906590`, GUID
`8ab03910-ac72-11f1-9e07-66a68432143c`, has two provider delivery records:

- `3841793140612685824`, 17:18:58.559: `failed to connect to host`, recorded
  status code 502, duration 0, empty response, not a redelivery. This is GitHub's
  failure classification, not proof an upstream HTTP server emitted a 502 body.
- `3841793250094514176`, 17:19:50.434: successful 202 redelivery, 0.54s duration.

Paperclip recovery action `050f9df7…` began its scan at 17:19:48.249, requested
the exact redelivery at 17:19:49.491, and confirmed that request at 17:19:49.688.
The callback reached the proxy at 17:19:50.296. Thus the existing scheduled
repair genuinely recovered this failed callback. The normal 60-second scan
cadence explains most of the wait. GitHub recommends
[scheduled recovery of failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries);
it does not impose that particular 60-second interval. Current scans perform a
config GET and one to three delivery-list GETs before candidate checks, roughly
120–240 GETs/hour per active endpoint. A lower cadence needs actual App-budget,
conditional-cache and backoff qualification, not a blind constant change.

Funnel inspection found the correct 8443→3104 route. All 36 local proxy requests
in 17:09–17:20:59 completed with 200/202, max 725.390ms, without local rejection,
abort, upstream timeout or socket error. The 198 Tailscale connection refusals
targeted 3137 directly during the deliberate pre-ready restart, not the public
webhook route. Later GUI/XPC errors had no request correlation. No precise
Funnel-side failing hop has been established; no configuration was changed.

Separately, actual service regressions now reproduce the previously static
explicit-control intake gap: fresh `chat_first_seen_control_20260909_red01`
finished **6 failed / 2 passed** (10.02s). Unique Slack/Telegram messages whose
authentic provider chronology predates `/close` or `/new` were processed when
first received afterward; same-second older Telegram message IDs are included.
The two no-control delayed-backlog positives pass. The guard is being added
before task mutation and checked again under its existing endpoint lock, with
independent review. This new work is not covered by the preceding 941-pass
baseline. No publication-only test is being misrepresented as intake protection,
and no general age cutoff or automatic backlog discard is being introduced.

### Recovery-budget inspection (17:42 UTC)

A separate read-only diagnostic verified App 4853886 again and requested only
`GET /app`, `GET /app/hook/config`, and a one-entry webhook-delivery list. All
three returned 200. None exposed `x-ratelimit-limit`, `used`, `remaining`,
`reset`, `resource`, `retry-after`, or `x-poll-interval`; all exposed an ETag.
Only the allowlisted non-secret response metadata was emitted. The PEM, App JWT,
request authorization and provider payloads remained private. No redelivery,
configuration edit, polling change, or conditional-cache behavior was tested.

The [App webhook API](https://docs.github.com/en/rest/apps/webhooks) requires an
App JWT, explicitly excluding installation/user tokens for these endpoints.
The documented installation-token quota therefore is not evidence for this
JWT request budget. ETags alone do not prove quota savings for this auth path.
Keep the faster recovery followup open, including bounded request budgeting and
[provider-directed backoff](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api),
rather than infer an unlimited quota from absent headers. Current production
cadence remains unchanged while the explicit-control correctness fix is tested.

### Frozen intake guard and predeployment history checks (17:51 UTC)

The new guard uses proven, committed close/new records as a denial boundary
before task mutation and again under the endpoint lock. It does not infer a
control from a manually completed task or an uncertain provider send, discard
ordinary delayed backlog on an active task, or replay already committed work.
Operator-confirmed delivery is valid without inventing an outbound message ID.
All matching historical controls are checked in UUID-keyset pages, so a late
confirmation of an older control cannot weaken a newer boundary. The hot-path
projection contains IDs and chronology, not historical text/attachment payloads.

Independent review also covered actual paused-duplicate redaction (including
retained principal and changed handler-kind metadata), Teams regional routes,
and native Discord controls. Discord's documented
[snowflake format](https://docs.discord.com/developers/reference#snowflakes)
contains worker/process bits above a per-process counter: within one millisecond,
only identical worker/process plus a higher counter proves the accepted tie.
A numerically larger ID from another worker/process is not accepted as newer.
Telegram uses its actual date plus message sequence; Slack requires its actual
message timestamp, while authenticated Slack app slash controls explicitly use
their durable local receipt boundary rather than inventing a provider timestamp.

Production is frozen at SHA256
`979be218014f0869cce27f3b81c678b9fa908511bb03a683a3e51184efc8bbdf`.
Plain server types pass. The first expanded/adjacent run is **60/64**, not green:
three older fixtures lack real Slack/Telegram chronology, and one incorrectly
expects a newer publication to bypass an older delivery-unknown FIFO head.
Test-only corrections preserve chronology and FIFO assertions. Full root12 and
browser final09 are running against the frozen production; no server-83 cutover
has occurred and none of these in-progress checks is a passing gate yet.

A separate read-only check of the actual live82 records confirms both historical
control proofs satisfy the new joins. Discord close `a3df4db6…` retains its exact
processed authorization, native command, principal, thread and generation 1
despite the conversation now being active again. Interaction
`1547293405057654834` dates to 17:11:35.087, before receipt at 17:11:35.433 and
confirmation at 17:11:35.836. Telegram close `9accd0e9…` retains its exact
processed source and authorization in generation 13: provider message
`417200359:185`, actual date 17:10:55, received 17:10:55.956, confirmed
17:10:57.527. Neither requires a fallback clock. No live data was changed.

The corrected focused/adjacent run on fresh
`chat_first_seen_control_20260909_final02` passes **64/64** (36.14s tests,
48.10s total), with plain server types and independent final review clear.
The older-control confirmation test now uses normal Board task completion,
a new DM generation, its newer close, then confirmation of the old unknown
publication; no FIFO bypass or fabricated transport receipt. Final test SHA256
is `84ed28cc3e506b85360744089a244291ba21159256bcfdce634d5499bc157b03`;
production SHA above is unchanged. Logs are `.paperclip-runtime/first-seen-control-final02.log`
and `first-seen-control-types-final02.log`. Root12 retains the earlier test
snapshot; its in-progress result is not the final repeat of these corrections.

### Full guard rerun and confirmation-gap RED (17:59 UTC)

Root12 completed **964/968** on the original test snapshot in 452.85s, with
exactly the four previously classified fixture failures and no additional
failures. Log: `.paperclip-runtime/chat-adapters-live/chat-snapshot-full-root12-0909.log`.
The full deterministic chat plus Board attachment/receipt browser run passed
**43/43**, zero retries, in 5.8 minutes on fresh
`board_receipts_browser_20260909_final09`, against the frozen production guard.
Log: `.paperclip-runtime/board-receipts-browser.bzXvpe/channel-and-board-full-browser-final09-0909.log`.

An additional consistency probe is genuinely red, separately from the 64-case
green cohort. The real-shaped native Discord close command dates to
17:57:17.994, its next source snowflake and SDK date to 17:57:17.995, provider
confirmation to 17:57:18.026, and first source receipt to 17:57:18.080. The exact
delivery/action/wake/run was admitted, but presentation returned
`internal_agent_write`, not `allow_chat_run_presentation`. The existing check
requires provider source time after publication confirmation, unlike the new
command-clock admission proof. The test establishes the exact admission/run
prerequisites; it does not separately instrument every later grant predicate.
Fresh DB: `chat_control_confirmation_gap_20260909_red01`; log:
`.paperclip-runtime/control-confirmation-gap-red01.log`; test 666ms, total10.11s.

The planned correction shares the exact read-only command-chronology proof.
Affirmative presentation additionally requires proof coverage for every
published control in the exact bound conversation; an older proven control
cannot mask another published but unproven control. Existing server receipt
after every confirmation, full causal batch, current permission, generation,
and old-run suppression checks remain. The shared implementation is not yet
qualified, and none of the preceding green runs is represented as its proof.

### Shared chronology proof focused qualification (18:06 UTC)

The shared reader passes **69/69** on fresh
`chat_control_chronology_shared_20260909_green02` (34.31s tests, 42.83s total),
with plain server types and independent source review clear. The original
command-to-confirmation gap is now positive. A source actually received before
confirmation, missing control authorization, and mixed proven/unproven
published-control histories remain negative. Intake treats absence as no
boundary; presentation requires the explicit affirmative proof, complete raw
published-candidate inventory, and all previous causal/current-authority guards.
An earlier 68/69 run failed constructing a null NOT NULL issue ID; its corrected
negative uses another real same-company issue, without changing production.
Logs: `.paperclip-runtime/control-chronology-shared-green02.log` and
`control-chronology-shared-types-green02.log`.

A separate Teams native-thread probe failed before presentation: `/close` there
is normal content, not a supported linear conversation control. That failed
premise is not evidence of a route-authority bug and does not justify relaxing
route checks. One final bounded check compares accepted linear-command
whitespace with persisted history proof before the full frozen-source repeat.
Server82 remains deployed; these focused checks are not full-suite or live83
qualification.

### Accepted control whitespace regression (18:09 UTC)

The bounded probe confirmed a real mismatch: actual Telegram `/close\n` was
accepted and published, but proof used PostgreSQL's space-only `btrim`, allowing
an older first-seen source to be processed. The one-case RED took 559ms;
log `.paperclip-runtime/control-whitespace-red01.log`. The narrow correction
uses the exact ECMAScript trim-character set in SQL, retaining the same anchored
command and bot-suffix grammar rather than accepting new command shapes.
The truthful Teams personal close → regional service URL → new-generation
presentation positive also passes (644ms tests, 10.92s total), log
`.paperclip-runtime/teams-post-close-route-green01.log`, without a route-authority
production change. The combined final cohort and full suite are still pending.

Root full integration `chat_snapshot_full_20260909_root13` and deterministic
browser `board_receipts_browser_20260909_final10` started at 18:09:44/45 UTC
against frozen helper `ed01066a…`, service `836d899c…`, issues `65d79903…`,
and test `e17162c4…`. They are pending, not passing gates. The exact whitespace
parity probe found all 25 ECMAScript trim characters and matching SQL results
for nine valid/invalid command shapes; log
`.paperclip-runtime/control-whitespace-parity-final01.log`.

Final focused/adjacent repeat passes **71/71** (35.12s tests, 43.01s total) on
fresh `chat_control_chronology_shared_20260909_final01`, with plain server types,
diff check and independent final source review clear. Logs:
`.paperclip-runtime/control-chronology-shared-final01.log` and
`control-chronology-shared-types-final01.log`. The four frozen hashes are
unchanged. Full root13 and browser final10 remain in progress; no live cutover
or merge is implied by this focused result.

At 18:12:47 UTC, the frozen reader was additionally checked against actual
live82 history inside a database-enforced read-only transaction. Latest
processed sources in Discord CHA-43 and Telegram CHA-48 return
`after_all_proven_controls`; Slack CHA-44 and GitHub CHA-45 correctly return
`no_proven_control`. This checks chronology only, not the complete run-level
presentation grant, and changes no live state. Log:
`.paperclip-runtime/chat-adapters-live/control-chronology-preflight-83.log`.
The isolated qualified runner's SHA256 remains `6844f20e…` and its strict code
signature check passes; tracked runner binary and lockfile remain unchanged.

The full deterministic chat/Board receipt browser repeat completed **43/43**,
zero retries, in 5.3 minutes (exit 0) on fresh
`board_receipts_browser_20260909_final10`. All four frozen source/test hashes
remain unchanged. Log:
`.paperclip-runtime/board-receipts-browser.bzXvpe/channel-and-board-full-browser-final10-0909.log`.
Full root13 remains pending; server82 is still the live process.

### Full shared-proof run and bare-control fixture correction (18:18 UTC)

Root13 completed **970/975**, exit 1, in 452.06s (443.90s tests). All five
failures are the provider-timestamp binding fixture's Teams valid/date-object/
display-override and Telegram ordinary/task positives after directly inserting
`control:close:timestamp-fixture:*`. That record has neither a real command
source nor a processed control authorization. The strict shared reader correctly
denies it even when the later provider timestamp is valid. The original SDK
clock/marker assertions and ordinary no-control presentation all passed.
The narrow test-only correction retains those assertions and the legacy-marker
negatives, explicitly checks missing authorization, and denies presentation
after this unproven published record. It does not manufacture a supported Teams
native-thread close or relax production authority. The 71 genuine-control cases
remain separate coverage. Log:
`.paperclip-runtime/chat-adapters-live/chat-snapshot-full-root13-0909.log`.
Fresh root14 is being prepared; server83 remains undeployed.

The test-only correction is green on fresh
`chat_timestamp_proof_fixture_20260909_final01`: **82/82** (the previous 71 plus
all 11 timestamp-provenance cases), 48.90s tests/60.99s total, plus plain server
types. Test SHA256 is
`ddab366732298fa43e8272d824eef516ad7be42f29a56b6b5450aea5e2c8d3ec`;
all production hashes remain unchanged. Logs:
`.paperclip-runtime/timestamp-proof-fixture-final01.log` and
`timestamp-proof-fixture-types-final01.log`. Fresh full root14 started at
18:20:15 UTC and is still pending. Root13's failed result is retained; no
production fix, full green claim, or live cutover is implied by this correction.

### Full integration and live server83 qualification (18:35 UTC)

Fresh `chat_snapshot_full_20260909_root14` passes **975/975**, no skips, exit 0:
409.45s tests/422.95s total. Production hashes remain `ed01066a…` helper,
`836d899c…` service and `65d79903…` issues; test `ddab3667…`. This joins final10
browser **43/43**, zero retries, and the 82-case focused/types gate. Log:
`.paperclip-runtime/chat-adapters-live/chat-snapshot-full-root14-0909.log`.
The earlier root13 970/975 result remains recorded rather than overwritten.

At 18:27:38 UTC the exact QA agent was idle with zero queued/running runs and
queued/claimed wakes. An audited pause rechecked both sets before SIGTERM of
server82 PID60999. Backup
`.paperclip-runtime/chat-adapters-live/pre-83-backup.1FdJts/pre-server-83-20260909-132744.sql.gz`
is 14,920,506 bytes, directory0700/file0600, gzip verified, no pruned backups;
restore was not tested. Schema258 was already up to date, so no migration ran.
Server83 loaded root `0c7f29207`, PID2295, loopback3137; proxy3104 and shared
PG55439 stayed running. The private signed runner SHA `6844f20e…` and tracked
runner/lockfile hashes are unchanged. Across startup and the paused maintenance
cycle, CHA-43/44/45/48 retained their exact status decisions and run/comment/wake
counts. Maya resumed at 18:29:04.855.

The first 250-word requests completed before their close publications committed;
they are not counted as close-while-running proof. The longer follow-up pair
provides that proof. Discord run `e2946b56…` was active when native close
`a08471ae…` edited its exact working message `1547313267343499264` at
18:30:47.974; its eyes reaction cleared at48.141. Telegram run `f42e9234…` on
CHA-49 was active when close `ac9d7743…` edited exact working message193 at
18:30:49.033; eyes cleared at49.303. Both finished internally with zero authored
comments, no old external final and no retry child. This is conversation close,
not native run cancellation.

Fresh Discord source `1547313499208683542` continued CHA-43 and answered once
as `1547313508213985301`. Fresh Telegram source195 created CHA-50 and answered
once as196. Actual browser text and durable receipts agree. All thirteen live83
runs record `runtime_mode=native`, `driver_kind=codex_app_server` and persisted
execution-input model `gpt-5.6-luna`; no raw reasoning or tool logs were posted.

| Short request | Ingress-to-final | Run time | Publication attempts |
| --- | ---: | ---: | ---: |
| Discord fresh after close | 21.654s | 20.305s | 1 |
| Telegram fresh after close | 16.418s | 14.519s | 1 |
| Slack A | 15.126s | 13.836s | 1 |
| GitHub A | 15.403s | 13.520s | 1 |
| GitHub B | 13.336s | 11.246s | 1 |

Unlike live82's provider-delayed overlap attempts, live83 proves actual local
FIFO overlap in both Slack and GitHub. Slack C ran18:32:28.998–18:33:25.741;
D arrived18:32:46.678, its queued notice published48.236, and D began only at
18:33:25.858. Its answer `SLACK83-QUEUE-D-READY` published18:33:41.239 using the
queued notice's message `1788978768.146339`. GitHub C ran18:32:31.487–18:34:02.721;
D arrived18:32:48.522, queued notice published50.678, and D began18:34:03.306.
Its answer `GH83-QUEUE-D-READY` published18:34:17.484 using queued message
`5606833788`. Each source produced one run and one authored final, in order.
The deliberate 700-word C turns took56.743/91.234s; D's own runs took
14.775/13.144s. Queue-inclusive D latency was54.561/88.962s, not an unexplained
model-start delay.

GitHub C's final `8c65d4d1…` safely deferred at18:34:03 because authorization was
temporarily busy; the server explicitly records no provider delivery attempted.
Attempt2 published the final at18:34:05.210. This is not an ambiguous replay.
All scoped publications/actions settled, all receipt removals processed, and
actual Slack/GitHub browser final text matches the receipts. Sources:
`.paperclip-runtime/chat-adapters-live/live83-final-receipts.json`,
`live83-queue-overlap-receipts.json` and `server-experimental-landing-83.log`.
No new live Teams or Telegram native draft-Stop qualification is claimed.

### September 9, 18:55 UTC — foundation landed; terminal-backlog CI investigation

Foundation PR #13100 merged at18:49:13 as
`6abeb67334348dcb6fde2d591a27ffc7efc7118d`, after required CI, human approval
and the current-head5/5 summary explicitly naming `1c3c34c9`. A single targeted
dashboard Re-review queued the previously stalled review; no configuration,
permission or review-gate changes. Integration `ac71491df` had393 files and no
wireframe images. Its notification finding was withdrawn by Greptile after the
actual mounted event pipeline passed53 tests with unchanged production logic.
The automatic post-squash retarget requires a new base composition and fresh
final-head gates; neither this withdrawal nor the earlier score qualifies it.

Integration CI run34390326914 Build job102597103530 failed runner verification:
1,897 passed, three failed, three skipped. Actual checkout was synthetic merge
`ab19c4ad` (ac714 into1c), Ubuntu24.04.4 and Node24.20.0. The affected runner
transport and test blobs are identical to merged runner `fac07b42a`. The first
failure was the retained `holdSpawned` case: suspended runner, terminal ACK
timeout, outbox43/acked55/next99, provider pending128/queued5, exact
`runner.suspend` still pending in the controller and epoch0 exit1. Subsequent
homeScoped/terminalReplay cases reused its sticky quarantine domain and were
correctly denied before start; the actual startupFailureProof case passed.
Unique per-row fixture identity has a causal RED-to-GREEN test and leaves
same-row quarantine behavior intact. It does not fix the primary timeout.

Root reproduced that primary failure in the isolated physical foundation
verification copy, using its qualified runner SHA `cd1c10cb…` and the existing
owned debug fake provider. Original source, live server83 and its artifact were
not changed. Unmodified focused fixture passed1/1 in7.52s test time. An ignored
preload then instrumented only private fixture control-plane file/directory
fsync calls. With zero added delay it passed1/1 (9.30s), recording500 calls and
about2.949s cumulative fsync time across the entire fixture. Adding10ms to each
target fsync reproduced the same terminal failure twice; the evidence repeat
took5.99s and retained outbox35/acked63/next99, provider pending128/queued5 and
the exact unacknowledged suspend. Worker progress records prove the injection
was active; parent-process exit reports with zero calls are not worker stats.
This isolates sensitivity to storage latency, not the exact CI host bottleneck.

The proposed repair is narrow TypeScript maintenance support for a completed
terminal receipt from a prior, fully validated and retired epoch in the same
invocation. Rust already supports delivery-only replay without provider launch.
No timeout, total budget, epoch limit, command order, authority or quarantine
rule may be relaxed. Implementation and negative qualification are pending;
no success or live deployment of that repair is claimed. Ignored evidence:
`terminal-ack-holdspawned-baseline-0909.log`,
`terminal-ack-fsync-zero-evidence-0909.log` and
`terminal-ack-fsync-ten-evidence-0909.log` under
`.paperclip-runtime/chat-adapters-live/`.

### September 9, 19:11 UTC — terminal replay, queue drain and final authority qualified

The narrow repair now passes19/19 real maintenance cases (110.52s test time,
111.22s total),80/80 control-plane tests and plain package types. Two genuine
runner ACK-loss cases retain controller-pending and controller-completed
receipts, then replay only their exact completed result without another
provider launch. Initial copied receipts and19 altered-evidence controls per
positive case remain denied; repeated ACK loss also stays quarantined. No
terminal deadline, maintenance budget, epoch count or command order changed.

Independent review found that socket close did not join the old JSON processing
chain. Real authenticated two-frame/held-callback tests reproduced2 REDs. The
explicit drain now joins already-admitted callbacks before retirement state is
fingerprinted, refuses active/reopened ingress, and preserves ordinary stop
behavior. The maintenance caller bounds and retains an unfinished drain, so
it cannot authorize a replacement while a late old-state write remains possible.
Both committed and rejected suffix cases, held authentication and ingress
controls pass in the80-test core suite.

Two further final-authority negatives genuinely reproduced: revocation during
the final retirement callback, and a final authorizer that aborts but returns a
resolved promise. Reauthorization after retirement plus synchronous checks
after the awaited authorizer now deny both. Abort during retirement was already
denied and is retained as a control, not presented as another production bug.
The three authority cases and the final19-case table are green. Earlier test
selector/all-skipped and assertion-reason mistakes remain in local logs and do
not count as production REDs.

Root independently repeated the original delayed-fsync case on final source:
1/1 passed,16.67s tests/17.41s total. The same10ms injection recorded525 target
fsyncs and about9.383s cumulative latency across the fixture. Evidence is
`.paperclip-runtime/chat-adapters-live/terminal-ack-fsync-ten-fixed-authority-final-0909.log`.
Frozen SHA-256 values:

- Transport: `266dfb99e6a5a022e9994a6af7bb919451b6d07ada6a02d383f2495634866392`.
- Transport test: `60adbfb4ac79fee32ed56c0dc93d2caf0caf504337320f3e0fe2d06f33e3952d`.
- Core: `88cbe405f905297813a5ba58acce9858a96c04fb7184bae5c97e4730bf57fb96`.
- Core test: `f4779869e4615367f0bcf900271ccdf90816566483f7a887a2967a040d809e84`.

The prior ac714 CI finished982/982 chat integration tests; only runner Build
and dependent verify were red. The actual post-foundation base composition has
workspace-wide types and40/40 master queue/batching tests green. Strict fixture
cleanup needed exact agent runtime-state and company-skills deletion after a
real process; the original FK failures and downstream duplicate-prefix errors
are retained, and no route/schema behavior or assertion was weakened. Full
runner qualification and the final rebased remote update/review are still
pending. Live server83, its runner artifact and the original worktree source
remain unchanged by this isolated repair.

### September 9, 19:21 UTC — broad candidate check remains red; macOS fixture causes isolated

The physical post-foundation verification copy first failed a Node package
contract because its copied installed Codex ACP executable predated the tracked
current-master dependency patch. Applying only the two missing tracked hunks
to that copy's verified single-link inode restored the expected `c4538599…`
digest; reverse patch validation and the nine package cases passed. Neither
the original checkout's dependencies nor its lockfile were changed. The initial
failure remains recorded, not relabeled as a passing first check.

The repeated broad check passed38/38 Node contracts, then Vitest reported
1,890 passed,14 failed,10 skipped and five unhandled errors in244.24s. The
repaired transport passed171/171 and core80/80 within that same full run.
The failing files were artifact metadata, local runner, installed-provider
integrity and Codex credentials. The10 skips are three opt-in benchmarks and
seven Linux-only cases; Linux/x64 CI skips only those same three benchmarks.
No skip was added by the candidate. Evidence is the landing worktree's
`.paperclip-runtime/landing-20260909/integration-base-verify-YAhDBQ/final-runner-check-all02.log`.

The artifact failure compares `/var/folders/...` with its intended production
`realpath` result `/private/var/folders/...`; SHA, byte size and metadata all
match. An unchanged canonical-TMPDIR control passes4/4. Credential test hooks
also compare noncanonical fixture homes against canonical production paths;
the injected filesystem operation is never intercepted. One unchanged
directory-open case reproduces RED at5.01s under normal TMPDIR, then passes
in328ms with only process-local canonical TMPDIR. These are causal fixture
defects, not grounds to loosen production durability or integrity checks.
Minimal test-only canonicalization is being qualified.

The credential fixture also encountered `EADDRINUSE` on its deliberately
occupied quorum port before calling production staging. Its former owner is
unknown; no unrelated listener was killed. The local first-command receipt
timed out at its unchanged3s deadline; the installed Claude graph at5s.
Unchanged isolated controls pass local-runner10/10 and installation41/41
executed cases (six platform skips,1.75s tests/1.92s total). Three real local
runner samples completed in22–24ms. Local Vitest defaults to17 workers on this
18-core Node26.4 macOS host, unlike the CI environment, but isolation success
does not uniquely establish contention as either timeout's cause. All broad
REDS and their unresolved attribution are retained. Root's installed-provider
logs are `claude-installed-graph-final-candidate-focused-0909.log` and
`claude-installed-graph-final-candidate-file-0909.log` in the ignored live
runtime evidence directory. Live server83 is healthy and unchanged.

### September 9, 19:38 UTC — local component qualification complete; fresh remote gates next

The canonical fixture fixes preserve every integrity and fault-injection
assertion. Credential fixture homes now resolve to their actual canonical path;
the artifact test captures its canonical expected path before its source-swap
getter runs. The silent-primary quorum fixture reserves only handles it owns,
tries at most eight fresh homes on setup-time `EADDRINUSE`, and joins cleanup
before retry. It invokes production staging exactly once outside that loop.
New real-listener tests retain the foreign owner and verify partial-reservation
cleanup on exhaustion. The remaining release-to-bind race is explicitly not
hidden by retries. Credential tests pass 41/41; artifact/local-runner tests pass
14/14. Types and independent review pass. Final SHA-256 values:

- Credential test: `62f9198a593deb02d4ca518cc27b247b24a36c9be7937570bf6c95bc3e8cced4`.
- Artifact test: `4e6d875c015132d6c17560b08c908350cd62c1b371d58697a528193c0509de2f`.

Private post-base candidate `090cde514` contains 379 changed files; its production
bytes are identical to workspace-build-qualified `66cab99df`. Its complete
TypeScript runner suite passes 1,906 tests in 325.96s with explicit
`VITEST_MAX_WORKERS=1`, plus the same 38 Node contracts and current replay
goldens. The 10 skips are unchanged guards, not new exclusions. This flag only
controls Vitest; the subsequent Rust tests still used their default parallel
scheduling and the overall command exited 101. Keep that command RED.

The Rust failure is the first five-second loop of
`durable_descendant_lineage_survives_capacity_and_provider_restoration`, before
restoration or capacity assertions. That target reported 80 passed, one failed
and two ignored helper declarations in 82.37s; its 8,190-turn rollover passed.
The saved fixture `paperclip-runner-codex-descendant-restoration-89523-52` has an
active root, 255 descendants, no pending or queued events, next event sequence
259 and no receipt-limit interrupt. The 128-events-per-poll limit accounts for
the exact prefix: root turn-start plus 255 descendant starts make two batches.
Each descendant is persisted with file and directory `sync_all`; the test checks
its deadline only between whole polls. The processed prefix was acknowledged,
but the next batch was not consumed before the test window ended. This is not
evidence of lost root-terminal authority or failure of the 4,096-child fence.

The unchanged existing-release-binary case passes alone in 3.64s, including
all later restoration/capacity assertions. No Rust file differs from actual
merged master `6abeb6733`. The landing checkpoint at 15:18 records the same
parallel test-window failure before this candidate. Concurrent durable I/O is
a plausible explanation, not an instrumented measurement of the exact delay.
No source or test deadline was changed for it.

The full unchanged release Rust workspace subsequently passes with explicit
`--test-threads=1`: 533 top-level executed tests plus two executed subprocess
helper checks (535 pass lines), two parent-harness helper declarations ignored,
zero failures; summed target durations are 127.73s. Remaining conformance 1/1,
replay 11/11 and actual runner-to-HTTP API-authority 870/870 checks also pass.
This is complete component qualification after a halted command, not a claim
that the original default-concurrency `check:all` passed. Local scheduling is
not CI parity: the actual prior job used the public `ubuntu-latest` runner class,
whose [documented specification](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
is four CPUs, not the previously assumed private-repository two-CPU class.

Evidence in the landing physical verification directory:
`final-workspace-build.log`, `final-runner-check-all-serial.log`,
`final-rust-workspace-serial.log` and `final-runner-remaining-checks.md`.
The landing owner will append final documentation, publish once and require
fresh exact-head CI and Greptile 5/5. No second chat merge or new live deployment
is claimed. The original worktree's lockfile and runner artifact, and live
server83, remain unchanged. Teams work-tenant and Telegram native draft Stop
qualification are still open.

### September 9, 19:55 UTC — fresh CI exposes timing-dependent ACK-loss fixture

Integration #13038 was published as
`585be75a2fe6380ec91ff3ddca44eec3896bfa8a`, based on the merged foundation,
with 379 changed files. Root requested one fresh dashboard review; summary
comment 5587250594 at 19:44:26 explicitly records this exact head and 5/5.
All review threads are resolved. This does not override required CI or
outstanding human CODEOWNER review.

Fresh CI run 34396401936 Build job 102617366004 reports 1,911 TypeScript passes,
two failures and three existing opt-in benchmark skips in 225.49s. Both failures
are the completed terminal ACK-loss fixture. The pending case has only the
normal durable-identity-restored diagnostic, not the asserted terminal ACK
timeout. The repeat case returns a valid maintenance proof instead of the
expected refusal. The original fixture added 20ms to each real controller save
and assumed the finite prefix would cross the unchanged Rust 2s ACK deadline.
Faster durable saves can finish that prefix before the deadline: the test did
not establish its intended fault. No production regression is proven here.

Root ran one bounded causal control against the exact old physical test SHA
`60adbfb4ac79fee32ed56c0dc93d2caf0caf504337320f3e0fe2d06f33e3952d`.
A process-only preload removed only 20ms `Atomics.wait` calls with this test
file in their stack; every other wait and real runner deadline remained intact.
The exact pending/repeat rows reproduce both CI assertions: **2 failed**, 169
unselected tests, 17.58s test time/18.44s total, exit 1. The log confirms the
fixture-only intervention. This is causal diagnostic RED, not qualification,
and the preload is not installed in any server or subsequent qualification.
Evidence: original worktree
`.paperclip-runtime/chat-adapters-live/terminal-ack-fast-save-old-fixture-0909.log`.
The physical source and release binary were not edited for this control.

The proposed test-only correction uses the existing public authenticated-wire
interface. It withholds result intake only after an exact completed suspend
result is durably journaled while the controller remains pending. The repeat
negative must lose inbound result delivery in both epochs; if the controller
already completed, a later welcome can legitimately reconcile the receipt.
The completed positive instead withholds outbound ACK after durable controller
completion. Exact epoch/direction/command/sequence and actual withheld frames
are asserted. Provider state, no-new-turn, copied-initial-receipt denial,
altered-evidence negatives and all real deadlines remain unchanged. Independent
source review is clear; real-runner test qualification is pending. The existing
CI run is being allowed to finish, not cancelled or relabeled successful.

Supplemental live Discord inspection at 19:47 used the existing signed-in IAB
and previously produced live81 media, not a new run or deployment. Native PNG
message 1547280428027879584 renders an orange tabby correctly in the provider's
image viewer. TXT message 1547280434126258197 renders the complete synthetic
lighthouse/amber/63 file inline and in View whole file. One ordinary Download
click did not produce an observable IAB download event or a matching new file
in Downloads. The effective download interface exposes no local-path accessor;
no downloaded-byte hash is claimed and no provider defect is inferred from
that observation. No fallback account/browser, raw HTTP or repeated downloads
were used. Detailed ignored evidence:
`.paperclip-runtime/chat-adapters-live/discord-existing-media-recheck-0909.md`.

### September 9, 20:01 UTC — deterministic terminal-loss fixture qualified

The exact corrected fixture is frozen as SHA-256
`0792548df13dfec0be511d7f1966f4fcaf8d1b922d34648981b64bc87a3c4d79`.
It passes all **171 transport tests**, including all 19 maintenance scenarios,
in 226.74s tests/227.68s total, exit 0. That physical run used the current-base
staged release runner
`ea9b3abfe98b5ba752ad492a1a6e413e4f6afd1e8b5da812902999e334f1452e`,
not the earlier foundation-only artifact. Root's exact old-fixture fast-save
RED also used this staged current-base artifact. No original/live runner was
rebuilt or replaced.

The full-suite test source was `c7fd8dbd…`. Normal Prettier 3.9.4 formatting of
the three changed complete statement ranges produced the final `0792548d…`;
canonical whole-file formatter outputs before and after compare identically,
and independent review finds only whitespace, wrapping and trailing commas.
After mirroring that format-only delta, the exact final source passes all three
affected actual-runner cases again against the same staged artifact: **3/3**,
19.52s tests/20.24s total, exit 0. Final types and diff checks pass. No timing
guess, assertion removal, journal forgery, extra recovery epoch or production
deadline change was used to obtain these results.

Production transport remains SHA-256
`266dfb99e6a5a022e9994a6af7bb919451b6d07ada6a02d383f2495634866392`.
The code delta is one existing test file. Final independent source review is
clear. Evidence under the landing worktree's physical
`.paperclip-runtime/landing-20260909/integration-base-verify-YAhDBQ/`:
`terminal-ack-wire-full171-final01.log` and
`terminal-ack-wire-focused-final.log`; owned formatting evidence is
`.paperclip-runtime/landing-20260909/terminal-ack-wire-format01.log`.
The initial three-case run on the earlier `cd1c…` artifact passed separately,
but is not substituted for this current-base evidence.

The landing owner will commit the test and compose this documentation before
one new remote update. The successor must receive fresh required CI and exact
head Greptile 5/5; neither the historical successful review nor earlier broad
passes override those gates. No second chat merge, live deployment, or missing
provider qualification is implied. Original worktree runner `6279d39a…` and
lockfile `47a7c093…` were reverified unchanged; a database-enforced read-only
check at 19:55:39 found no new scoped live deliveries, runs, publications or
actions since 19:00.

### September 9, 20:04 UTC — completed CI exposes one reaction-test completion race

The last 585 server shard finished with **2,968 passed, one failed, five existing
skips** across 123 files in 1,132.00s. Its chat integration result is **981/982**
in 631.155s. The sole server failure is Telegram close-owned progress retirement
at the immediate `removedReactions` assertion. At assertion time Vitest reports
one setup-reaction entry; its later formatted diff also contains the exact
expected `telegram:77118896` / `77118896:930` / `eyes` entry. This is concrete
evidence that the mutable result changed after the assertion, not proof that
the requested removal was wrong or lost. Log:
`.paperclip-runtime/landing-20260909/ci-585-server4-job.log`.

Source inspection confirms the relevant asynchronous contract. After terminal
publication and action durability, the service schedules non-critical receipt
cleanup without awaiting its provider I/O. The ordinary reaction sweep selects
received, retryable-failed or stale-processing work, excluding a fresh action
already owned by that scheduled callback. Therefore awaiting publication and
then one sweep does not prove that callback has finished. This preserves the
intended property that a slow reaction endpoint cannot block the reply lane.

The test lane is constructing a held exact provider-removal call to prove that
publication completes while the removal action remains processing, and that a
second sweep does not become its completion barrier. After releasing the owner,
the test must wait for that exact durable action to become processed before
asserting the exact provider effect. All run-still-running, closed conversation,
suppressed late final and no-duplicate-publication assertions remain required.
Independent adjacent review found only the Slack and Discord close-working
positives share this false-barrier assumption; the other scoped receipt cases
already capture scheduling or await exact durable results. Qualification is
pending, and the next remote update is held. No production synchronization or
deadline change is justified by this test race.

### September 9, 20:07 UTC — held reaction owner reproduces and closes the test race

On fresh migrated `chat_close_receipt_20260909_red01`, the exact Telegram
provider `removeReaction` call was held after its durable processing claim.
The close publication completed; an exact-action sweep returned zero. The old
immediate provider-array assertion then failed exactly as in CI. Releasing the
latch in `finally` also reproduced the confusing later-formatted array containing
the expected effect. Result: **one failed**, 981 unselected, 539ms case time,
10.20s total, exit 1. This is a causal regression, not a repeated run until green.

The fixed test retains the held call and proves that the publication is already
published, the exact action is processing, the sweep returns zero, and the
provider effect is absent while held. After release, it locates precisely one
removal by endpoint, thread, source message, operation and reaction, validates
its delivery-derived action key, and waits for that exact ID to be processed.
The original exact provider-effect assertion then runs, followed by unchanged
run-still-running, conversation-closed, late-final suppression and publication
idempotence assertions. The two audited Slack/Discord working positives use
the same completion helper. No production hook or behavior was added.

Fresh `chat_close_receipt_20260909_green01` passes the complete affected and
adjacent close-owned cohort: **32/32**, 950 unselected, 9.54s test time/21.33s
total, exit 0. Plain server types and diff checks pass; independent final
source review is clear. Final integration test SHA-256:
`9bd5f108d0790731a5816df31dddf715df8c85af38f429b9b8e1d182cfdeacc9`.
Production service remains
`b9ad5151cb91b72f97a7fe24773021e6eb72350639bfee84c5adef5998b2b008`.
Logs in the landing `.paperclip-runtime/landing-20260909/`:
`close-receipt-held-red01.log`, `close-receipt-held-green01.log` and
`close-receipt-types01.log`. Earlier complete 585 CI remains failed; a new
exact-head full CI run is still required. Original/live state is untouched.

### September 9, 20:13 UTC — latest-master provider-event changes reconciled

Before publishing, the landing lane found master had advanced to
`5cb4f061dd185955255099ae95348b3d4a16d7c0` (#13109). Its nine changed files
improve provider-notice normalization/display and hide routine completion calls
from the task feed while preserving raw events. The merged private candidate
is `90e72524a1b8f3db32df3341f0113489d3416eee`, clean and 379 changed files
against that master. The adjacent test-group merge conflict preserved both
sets of tests. Root's original worktree was not rebased or pushed.

Independent review confirms the upstream change does not alter terminal
receipt authority, authenticated wire recovery, epoch limits or the processing
drain. Dynamic tool notices become canonical tool-activity events without
gaining semantic-tool input or terminal-tool authorization. The UI preserves
the upstream notice summary and completion-call filtering alongside the chat
accepted-response-wake marker/final-response handling. The upstream delta adds
no external chat publication entry point. No raw provider traces were posted.

The private release runner was rebuilt on that merged source, staged SHA-256
`895a20cd7115db1c502b7f3127b39401753f020836645b4aac60e6651c9653a5`.
Rust provider-event tests pass **11/11**, TypeScript provider-event tests
**25/25**, and runner types pass. The exact final `0792548d…` transport fixture
passes its three ACK-loss cases against this new artifact: **3/3**, 19.68s
tests/20.34s total, exit 0. An initial selector matched zero rows and is recorded
as zero execution, not qualification. The earlier full 171-test proof remains
attributed to its previous staged artifact; it was not silently relabeled as
new-binary coverage.

Root independently ran the combined UI cohort on clean `90e72524…`:
`TaskChatProtocolActivityRow`, task-chat transcript adapter, native-run events,
native-run boundary golden, and `TaskChatThread`. All **257/257** tests across
five files pass in 4.84s. Token gates pass with 109 existing allowlist entries.
The initial shell output redirection targeted a missing directory and started
neither test command; the executed runs used the existing evidence directory.
No source files were edited during this verification.

Evidence under the landing physical `integration-base-verify-YAhDBQ/`:
`master-5cb-terminal-ack-focused-corrected.log`,
`upstream-5cb-composed-ui-cohort.log`, and `upstream-5cb-token-gates.log`.
The landing owner will append this documentation, publish once, and require
fresh exact-head full CI and Greptile 5/5. Existing CODEOWNER requests are not
treated as approvals. No second chat merge or live deployment is claimed.
Original lockfile `47a7c093…` and staged runner `6279d39a…` remain unchanged.

### September 9, 20:29 UTC — CI exposes a genuine visible-task notification defect

Integration head `89270d75fab79a7ffe6bda19e826fab26d4ec169` has a fresh
Greptile **5/5** summary updated at 20:17:40 UTC. Root requested exactly one
re-review at 20:15:06 after verifying that no review was queued or running.
That review does not override the failed browser check in fresh CI run
`34399838600`, job `102628990333`. The process composer Stop journey reaches
cancelled parent/child runs, dead process PIDs, a paused subtree and an
unaffected unrelated running task, then fails its unchanged zero-notification
assertion. The screenshot shows the redundant informational parent-run
cancellation toast. The later archived-company toast is teardown output, not
the original one-toast failure. No websocket trace was uploaded by that job,
so exact packet attribution is inferred from source and causal reproduction.

The visible route uses the task identifier, whereas IssueDetail fetches linked
run history under the canonical UUID. The resolver learned both aliases but
read run caches using only the route identifier. A rich terminal event correctly
suppressed its toast and evicted company live membership. The retryable terminal
delivery intentionally lacks issueId; it then missed durable UUID-keyed history.
A mounted actual-provider/socket regression against exact 892 production fails
with one bodyless informational cancellation toast: one failed, nine unselected,
921ms total. This establishes a UI product bug, not a flaky assertion.

After the root-alias fix, a separate ordered child regression also fails: rich
child cancellation suppresses, live membership is evicted, refreshed descendant
data clears executionRunId, canonical linked history remains, and the no-issueId
retry produces the same incorrect toast. That RED uses exact root-only production
`fd247c75170d9a3dfbba9637c7f61b37d131f74f98864183950e2464f580676b`:
one failed, 15 unselected, 1.00s total. It is separately reproduced, not claimed
to be the particular parent toast observed in CI.

The final two-file fix reads active/live/linked run caches through known root
aliases and id/identifier pairs of current exact company/root descendants. Child
IDs contribute only to subtree notification membership, not root invalidation.
No global cache scan, same-agent run inference, persistent suppression registry,
browser assertion relaxation or deadline increase was introduced. Controls retain
notifications for explicit unrelated tasks, unrelated same-agent runs, background
pages, and children removed from the subtree despite their retained cached history.

Final production SHA-256:
`9c3621eb72f173388f9c05ea7e63ad80b5f39900c1b29b97ddef81911270ebe8`.
Mounted test SHA-256:
`9bd4fa6af84e6e1ec7c281e31694d029e2d3ab0d632d72cc915aa4cedd1b7880`.
The final cohort passes **70/70**, two files, 1.19s tests/2.27s total; plain
UI types, scoped formatting and diff checks pass. Root independently verifies
hashes, reviews the source and runs token gates successfully. Independent child
scope review is clear. Logs under landing `.paperclip-runtime/landing-20260909/`:
`composer-stop-toast-alias-red01.log`, `composer-stop-toast-child-red01.log`,
`composer-stop-toast-child-green-final.log`, and
`composer-stop-toast-child-types-final.log`.

The unchanged process browser journey is pending on a separate fresh database
and dedicated local server. Full 892 CI remains under collection before any
successor push. Its review cannot qualify the uncommitted fix. Original source
and protected artifacts, live83, provider credentials and provider messages
were not changed by this repair. Human CODEOWNER approval and separate Teams /
Telegram native draft Stop qualification remain open.

### September 9, 20:31 UTC — rendered browser review catches the uncached-child case

The root-only `fd247c75…` process browser journey passes **1/1**, 59.0s test /
1.2m total, zero retries. However, its final actual screenshot visibly contains
the child-run cancellation toast after the final Cancel subtree operation. Root
and the landing owner independently viewed that screenshot. This was not the
teardown notification and not a clean UX pass. An initial anchored test selector
selected zero tests; that attempt is recorded as zero execution, not coverage.
The corrected selector was list-verified before the actual journey.

The combined known-history `9c3621eb…` source then passes the existing assertions
**1/1**, 47.2s test / 57.9s total, on a separate fresh database. Its final actual
screenshot still contains the same child-run toast. That result disproves full
acceptance of the history-only correction despite its passing mounted cases.
The root-only browser trace shows parent identifier/UUID history requests but
no child route or per-child run-history request: this is a never-visited child.
After its live membership and execution lock clear, no cached history remains
from which the client could infer the association.

The previously unasserted final screenshot endpoint now has the same exact
zero-Dismiss-notification assertion as the earlier Stop checkpoint. Only three
lines were added, for both adapter rows; no assertion or deadline was weakened.
Spec SHA-256 `2530ade6a755f9ccbab9b9c08bf4e471ecc2a5ace566777f6860a888f8d3b5ff`.
The next repair carries only safe exact task-routing metadata on the retryable
server status delivery, rather than adding a global or indefinite UI suppression
registry. Server redaction/retry and mounted uncached-child regressions are
pending; the strengthened exact-source browser journey must then pass visually.

Browser evidence under landing `integration-base-verify-YAhDBQ/` is retained in
`composer-stop-root-alias-artifacts02` and `composer-stop-combined-alias-artifacts01`,
each with the actual `process-cancelled.png` and trace. No successor was pushed.
The ongoing 892 CI has now passed runner verification, clearing its earlier
ACK-loss failure area, but the known failed browser shard still prevents a green
overall result. Remaining independent jobs are being allowed to complete.

### September 9, 20:42 UTC — safe retry routing qualifies; full CI exposes a separate deadlock

The retryable status delivery now projects one additional nullable scalar,
`issueId`, from an existing same-company issue. A left join uses nativeIssueId
first, otherwise a JSON-string legacy context issueId. Text equality avoids
casting malformed input; missing, deleted, malformed or foreign associations
yield null, with no fallback from a present invalid native association. The
query never selects the complete context, errors or provider output. The existing
company/run/delivery-marker comparison-and-set and crash/retry semantics remain
unchanged. This is presentation routing, not new execution authority.

Fresh `chat_close_receipt_20260909_status_route_red01` reproduces the missing
field in the existing after-publication crash/retry test: one failed / 25
unselected, 5.57s total. Fourteen bounded association cases cover native and
legacy positives, native precedence, missing/nonexistent/deleted/foreign values,
malformed strings, objects, arrays, numbers and JSON null. They assert the exact
payload allowlist, absence of credential markers and foreign task IDs, preserved
run set and no provider dispatch. The original durable-marker crash/retry test
retains its no-duplicate-child checks. A standard optional external-database
harness uses a fresh caller-migrated database and closes only its owned client;
the default embedded-database path is unchanged.

The full **40/40** server file passes on separate fresh
`chat_close_receipt_20260909_status_route_green02`: 1.07s tests / 8.23s total.
The mounted never-visited-child and explicit-unrelated-task cases join the
existing cohort for **72/72**, 1.25s tests / 2.05s total. Plain server/UI types,
diff checks and independent final source review pass. Final server source hash
is `cd3cc5478473f5b5af8ccf855d9935c3a80b8108e4dd4128d35bcfe1b927eeba`;
server test `8c1e884894ace5de25d7911f1f4f13ec7a5bdc51b9e9a6551344aad90c6a4189`;
mounted UI test `1aa4fbac37cb1e48fca5ce06765f7e2591f2d417121df8b226319aad2439e457`.
UI production remains `9c3621eb…`; initial strengthened spec remains `2530ade6…`.
Logs in landing runtime: `status-route-red01.log`, `status-route-full-final.log`,
`status-route-ui-final.log`, and `status-route-{server,ui}-types-final.log`.

The five-file candidate passes the strengthened actual process browser journey
**1/1**, 45.0s test / 59.9s total, zero retries, on fresh
`chat_stop_toast_20260909_landing03`, dedicated port 3233. Root and the landing
owner both view a final screenshot with cancelled parent/child, completed
unrelated child and the independent live run retained, without a cancellation
toast. Whitelisted status metadata captures exact issue IDs on parent/child
retry deliveries after reload; it does not retain raw frames, logs or messages.
The final resumed child has a captured rich cancellation, but the run ends
before that generation's next retry. A precise final-generation retry gate is
being added before the existing final zero-notification assertion; no provider
delay or change to the effective 120s test deadline is required. Evidence is in
`integration-base-verify-YAhDBQ/composer-stop-status-route-artifacts01` and
`composer-stop-status-route-final01.log`. Local landing commit `2fb894c3f` is
not a remote update.

Full 892 CI completed at 20:34:41 UTC with the browser failure and a second
independent server-shard failure. The build job genuinely passes all runner
checks: 38 Node contracts; 1,914 executed TypeScript tests with three existing
benchmark guards (233.39s); 533 top-level Rust tests plus two executed subprocess
helpers, no failures; conformance 1/1, replay 11/11, API 870/870; then the full
workspace build passes. These are actual default-concurrency CI results, not
the older local serialized approximation. All other independent jobs are green.

Server shard 4 has 2,968 passed / one failed / five existing guards in 1113.49s;
chat integration is 981/982. At 20:17:45.99 PostgreSQL reports actual `40P01`
during the second same-delivery Slack INSERT ON CONFLICT DO NOTHING. The first
failed insertion was intentionally rolled back, its fault spy restored, and
the first retry returned 200 with one processed delivery. The later duplicate
returned 503 instead of 200. Processes 2784 and 2791 wait on each other's
transaction ShareLocks; the available trace identifies one statement as the
chat_deliveries unique-index insertion but not the opposing SQL statement.
An adjacent receipt-reaction warning alone does not identify that other owner.
Root queried all CI artifacts: only browser reports and the PR lockfile remain,
not PostgreSQL server stderr. Raw evidence is retained in
`ci-892-server4-job.log`, lines 494–545. A controlled actual-transaction
interleaving is being prepared; no generic deadlock retry, assertion relaxation
or speculative source change has been made. The next remote head remains held.

### September 9, 20:50 UTC — exact delayed-event browser acceptance and lock-order repair

The process browser observer now keeps only whitelisted status metadata for
its own company and exact run. It requires the final newly resumed child to
receive an actual `cancelled` retry delivery with a nonempty deliveryId and its
exact issueId, then checks zero notifications and captures the final screenshot.
The bounded 20s observation covers the existing 15s status sweep; the effective
120s per-test deadline is unchanged. Raw websocket frames, provider output and
errors are not retained in this metadata attachment. An early selector that
could select a preceding nonterminal delivery was tightened to cancelled status.

Fresh `chat_stop_toast_20260909_landing04` passes **1/1** (1.3m total): its
new child cancelled at 20:43:34.078, with the real retry observed at
20:43:48.062. Final spec SHA-256
`4fa2eac8c480efb9cad93ab992acaea4733132d45064e4a6f95815586a1c72ff`
then passes **1/1** again on fresh `chat_stop_toast_20260909_landing05`
(1.1m test / 1.3m total), zero retries. The final child `90cf6890…` cancelled
at 20:46:21.009, retry `c211907a…` arrived at 20:46:34.784 with exact child
issue `86c79dc1…`, and the notification assertion and screenshot followed.
Both root and the landing owner inspected both clean final screenshots. The
second run's first composer click reached its request in 257ms and stopped in
another 197ms. This is actual local process-adapter/browser qualification,
not a native model or live provider Stop claim. Logs and trace/screenshots are
under physical `integration-base-verify-YAhDBQ/`:
`composer-stop-final-generation{01,02}.log` and
`composer-stop-final-generation-artifacts{01,02}`. The locally committed spec
is `6787c34bc`, after routing commit `2fb894c3f`.

The deadlock audit found a concrete reverse order in provider-effect reply
settlement: successful settlement locked delivery before endpoint, while
duplicate admission held endpoint before the unique-index delivery INSERT.
Health-changing failure settlement had the same inversion. A regression uses
the actual empty-mention service callback and provider-reply path, holds only
the return of the real successful delivery UPDATE, and queries
`pg_blocking_pids` to observe the actual blocked admission statement. Releasing
the old-order settlement produces real PostgreSQL `40P01` at that INSERT:
**one failed / 982 unselected**, 1.53s tests / 12.37s total, retained in
`deadlock-red01.log`. It does not fabricate ledger state or provider authority.
This is a public service-callback regression, not an authenticated live webhook.

The production change moves the existing runtime endpoint lock before action,
conversation and delivery settlement in success and relevant failure branches.
Provider I/O remains outside the transaction; lease checks, runtime generation,
credential fingerprint, attempt/state comparison-and-set, stale-runtime health
behavior and ambiguous-delivery handling are preserved. No generic retry or
deadline relaxation was added. Final service SHA-256 is
`0a45a0c4d4e98fd7a6aa548feaa3f2ff08a52a5bbc18193708a1b2de226190c7`;
test SHA-256 `a3af6d994d4308c8f0b937ac8198e9c018530d29031bc4c44a4eebe50b91c216`.
The final matrix uses success plus structured Slack invalid_auth and
channel_not_found errors, checking exact health outcomes and no duplicate
reply/task/wake. The broader cohort passes **14/14** (17.04s total), including
the unchanged original webhook durability case. The exact formatted matrix
passes **3/3** (10.41s total); plain server types, diff checks and independent
review pass. Logs: `deadlock-adjacent-final01.log`,
`deadlock-final-formatted03.log`, `deadlock-types-postformat.log`.
Only the success branch was exercised against old production for the causal RED;
the two failure branches are additional post-fix qualification.

The repair is provider-effect reply settlement, not receipt-reaction cleanup,
despite the abbreviated local commit wording in `e879212f0`. The original CI
ordinary-message trace still lacks its opposing SQL, so that exact attribution
remains unproved. The bounded ordinary-message audit found no further proven
inversion: admission and task mutation lock endpoint first; wake acceptance
uses an endpoint NOWAIT lock before delivery; receipt settlement has no endpoint
row lock; standalone SDK state writes do not touch deliveries. Implicit foreign
key checks on reaction insertion did not establish the missing cycle. No further
production change is justified by this audit. The reproduced reachable cycle
and its repair do not erase that limitation; a fresh full integration run remains
required on the composed candidate.

Related master changes #13108 and #13110 landed as
`3b550c80facbbb1c35a5ae0ccf00613735712605`. Independent reviews found no
terminal/recovery-authority conflict. Composition must preserve authoritative
provider completion instead of semantic-result grace cancellation, exact-thread
durable history, Codex startup trust and the existing retained-session close
fences. A fresh private runner/fake provider build, composed types and focused
history/maintenance/full transport checks are next. A direct/remote same-run
usage baseline edge is being tested separately; the current runnerd thread/read
does not return tokenUsage and is not evidence for that accounting issue.
The exact-base official CI-generated lock is eligible only for temporary private
dependency materialization, with original bytes restored before commit. No
original/live lockfile, live83 process, provider credential or message changed.
No successor push, fresh-successor review or second chat merge is claimed.

### September 9, 20:59 UTC — related-master composition and same-run usage repair

Private composition `4bcd4e78fc5fe3185e205ccb0a6395836e45b98d` has exact
parent `3b550c80…`. Two repeated-context materialization hunks were caught by
the landing owner's diff check and corrected before any test or build. Incoming
native-session-runtime source is byte-identical to master; obsolete semantic
result grace cancellation is absent, and the server's runnerd-specific
`requireSessionCloseBeforeReturn` fence remains. Final private checkpoint
`2175d35231b8243ef7a1eb52cbf175477a58c526` adds the accounting pair and root's
qualification notes, stays clean, and changes **384 files** against master.
Its image changes are only the three provider SVG icons; no wireframe raster
images returned. Archived wireframe generator source remains.

The related dependency was materialized only in the physical stage using
official Refresh Lockfile run `34401941642` and bot commit
`7c54d45a29be9d214b935beff41659a44557fe94`: root independently verifies its
parent is exact `3b550c80…` and its sole change is pnpm-lock.yaml. CI lock
SHA-256 is `384784943b5a63fb7b351187c0f3dbb1e9f3e61f70e7bee3c435c302f8aedea6`.
It resolves the new smol-toml dependency to 1.8.0; no version was guessed or
tracked lock regenerated. The restoration trap returns the stage's tracked
lock to exact `822ecb8c…`; root verifies that hash and an empty lockfile diff.

The new private release runner build passes in 26.68s and the debug fake
provider build in 13.14s. Staged runner SHA-256 is
`9e87775afcc83404e473ba9bf4534dcd723d1875eba4015420718f51f03cef16`.
Fresh Rust startup trust, lightweight history, resume diagnostic, no-cold-launch
terminal receipt, retained Stop and same-thread active resume checks pass
**9/9** with explicit one test thread and unchanged deadlines. The server
executor cohort passes **313/313**, 6.84s tests / 11.94s total.
Root's composed UI cohort passes **329/329** across seven files, no skips,
3.07s tests / 7.83s total, plus plain UI types and all token gates. The initial
`--project ui` command selected no named project and executed zero tests;
the retained corrected run uses the UI project directory. Logs under physical
`integration-base-verify-YAhDBQ/`: `upstream-3b-runner-build.log`,
`upstream-3b-rust-focused.log`, `upstream-3b-server-executor.log`,
`composed-3b-ui-final02.log`, `composed-3b-ui-types-final01.log`, and
`composed-3b-token-gates-final01.log`.

The upstream review also reproduced a distinct accounting defect through the
actual TypeScript driver lifecycle with simulated provider RPC: first run uses
100 input tokens, second run reaches cumulative 140, then an active same-run
JSON-checkpoint recovery reads cumulative 140. Baseline identity and no-new-turn
checks pass, but raw reconciliation overwrites runDelta 40. The one-case causal
RED and full baseline file's one failed / two passed results are retained in
`codex-same-run-reconcile-usage-red01.log` and
`codex-same-run-reconcile-usage-baseline-file.log`. This affects direct/remote
reads containing usage, not the current native runnerd read that omits it, and
does not establish a recovery-authority or terminal-fence failure.

The narrow repair applies the existing monotonic observer only to Codex with an
existing persisted baseline, then overlays run totals/delta on bounded provider
metadata. It preserves no-baseline and other-facade behavior, history validation,
run identity and execution ordering. Tests cover thread- and response-level
usage, repeated/lower/higher totals, a second genuine checkpoint/recovery, old
checkpoint immutability and no fresh turn. The other-facade retained field is an
explicit negative fixture, not manufactured positive recovery proof. Final
source SHA-256 is `28fe20467ad91b7678544e7f840db9f651258d4924f21001700efdda3fb80426`;
test SHA-256 `a312dec52c341cab88e983da04a94e7efae6ae7afae118413de8f90c4eb8fa63`.
The final five-file cohort passes **77/77**, 148ms tests / 1.68s total; plain
runner types, scoped formatting, diff checks and independent review pass.
Logs: `codex-same-run-reconcile-usage-final.log` and
`codex-same-run-reconcile-usage-types.log`.

The final nine-file runtime/backend/Codex driver cohort passes **289/289** on
clean `2175d352…`, 2.85s tests / 4.89s total. Plain server types also pass.
Logs: `upstream-3b-runtime-driver-final.log` and
`upstream-3b-server-types-final.log`. The 77-case accounting cohort overlaps
this broader driver coverage; the counts are not an additive unique-test total.

Independent release-gate review and focused tests also pass: **23** UI cases
(117 filtered), **five** settings API/service cases (81 filtered), and **one**
shared-schema case (22 filtered). Default-off hides chat catalog entries,
the chat/tool chooser and direct setup/detail/identity routes, while ordinary
GitHub tool identity/setup remains available. The client gate fails closed on
missing/loading/error/refetch state and hides cached entries when disabled.
This visibility gate intentionally does not interrupt an already connected
provider's delivery. No wireframe raster or binary additions are present.
Logs: `release-gate-ui-final01.log` (6.78s), `release-gate-api-final01.log`
(4.21s), and `release-gate-shared-final01.log` (220ms). These are scoped contract
checks, not a claim that all tests in those filtered files were rerun.

Fresh full chat integration passes **985/985**, no skips/exclusions/retries,
409.74s tests / 421.61s total, exit 0, on retained database
`chat_close_receipt_20260909_full_3b01`. The run started at `4bcd4e78…` and
ended after the physical documentation/HEAD alignment to `2175d352…`; its
service `0a45a0c4…`, integration test `a3af6d99…` and tracked lock `822ecb8c…`
were byte-identical before and after. Its exact-database read-only observer
retained two blocked/blocking snapshots: an advisory wait and duplicate
endpoint FOR UPDATE wait. No `40P01` or observer error occurred. The expected
NOWAIT denial and injected scheduler outages are passing negative cases, not
discarded failures. PostgreSQL collector settings remained unchanged; server
stderr is not SQL-accessible. Evidence is landing runtime
`chat-full-3b01-observed.log`, SHA-256
`044b8948ee586d9b4f5620b6b6052ea753f57af9017479e5dea1b55200808a9e`.
This full green result does not retrospectively identify the missing ordinary-CI
opposing SQL statement.

At the final 21:05 UTC collection, full transport passes **171/171**, no skips,
229.57s tests / 230.36s total, against the exact new `9e87775a…` staged runner.
Plain runner types then pass and the complete command chain exits 0. Logs:
`upstream-3b-transport-full-final.log` and `upstream-3b-runner-types-final.log`.
This is fresh-artifact coverage, not reuse of the earlier binary's 171-test proof.
All requested local gates are green, with source unchanged after qualification.
The landing owner will append these two final documentation files and publish
one consolidated update. Fresh exact successor-head full CI and Greptile 5/5
are required; older-head green jobs or review do not satisfy them. Existing
human CODEOWNER requests are not approvals. Live83, original lockfile
`47a7c093…`, original runner `6279d39a…` and all provider accounts remain
unchanged. No second chat merge or new live deployment is claimed.

## Official lock refresh and measured CI allocation — September 9, 21:34 UTC

The published integration head is `ed1b6a6eb9ed1c94c39c963f33912241387bcb79`,
384 files. Its fresh exact-head Greptile review completed at 21:11:27 UTC with
**4/5**, identifying the tracked lockfile's missing `smol-toml` resolution.
The raw-head frozen-install inconsistency is real; the broader claim that CI
cannot build overlooks the existing trusted workflow's downstream lock refresh.
The review and its finding are preserved, not replaced by the previous head's
5/5 result. Root requested exactly one review of ed1.

Official master `7cf9a377964b295df8ed40d5e4392d06bcb44fdf` already merged the
CI-generated lock refresh from `7c54d45a29be9d214b935beff41659a44557fe94`.
The private merge `672366e0f5b04adcf844e1a6f2f2c78a52e045d6` has parents ed1
and that exact master. Its only tree delta from ed1 is the official lock,
SHA-256 `384784943b5a63fb7b351187c0f3dbb1e9f3e61f70e7bee3c435c302f8aedea6`;
there is no lockfile change in the PR's three-dot diff. Actual pnpm 9.15.4 /
Node 24.21 frozen installation with `--ignore-scripts` passes for all 36
workspaces in one second, without fallback or regeneration. Existing staged
dependencies were present; this does not establish a clean-room lifecycle
bootstrap. Log: physical `integration-base-verify-YAhDBQ/official-lock-frozen-install-final.log`.
Its complete tree matches the current CI merge tree `aed58114…`; the successor
still requires its own exact-head checks after publication.

CI run [34405038082](https://github.com/paperclipai/paperclip/actions/runs/34405038082)
ended **cancelled**, with required `ci / verify` failed. Neither root nor the
landing owner cancelled it. GitHub's annotation for general-server shard four,
job `102646337040`, states that its 20-minute maximum elapsed. The test step
itself finished successfully at 21:28:12 UTC: **123 files, 2,972 tests passed**,
five existing guards, 1,144.21s total. Cleanup reached the job's 20-minute edge.
The chat cohort passes **985/985**, 629.654s test time, with no observed `40P01`.
These passing assertions do not make the job or full CI green. Its retained
log is `ci-ed1-server4-job.log` in the landing runtime.

All other jobs pass, including all three browser shards and `ci / e2e`,
typechecks, release registry and workspace build. The build includes 38 Node
contracts, 1,944 executed runner Vitest tests plus three existing benchmark
guards, 538 top-level Rust tests plus two explicitly invoked helper checks,
one conformance and 11 replay tests, and 870 API authority checks. The native
process-composer Stop browser case passes in CI. None of these is Telegram's
native client Stop test or a deployment of the new runner to Live83.

The allocation defect is concrete: the general-server duration manifest lacked
the new chat suite, so it received the median **1,307ms** weight. The actual
first-suite serial cost is **645,354ms**, conservatively rounded from Vitest
RUN at 21:09:07.5491992 to completion at 21:19:52.9026416. Adding that one measured
entry lets the existing longest-processing-time scheduler reserve one existing
shard for the chat suite. General shard counts change from 112/121/124/123/123
to **1/144/151/154/153**. The exact union of all 603 general suites is preserved,
without duplicates; all 144 serialized suites remain separate and unchanged.
No scheduling algorithm, workflow, isolation rule, job limit or test timeout
changes. Applying the new mapping to observed suite costs predicts
645/518/780/564/608 seconds, an estimate that still needs fresh CI.

The missing-measurement regression genuinely fails before the fix. The final
CI-script cohort passes **35/35**, no skips, independently repeated by root in
2.445s. Manifest SHA-256 is
`3265d9749510c699f3314924be6240ffbb76f832bd52d09bd0fa3380fbe312bb`;
test SHA-256 `3ca033f38774929f5c79c533e8bcadca3fe4f82aa3c82f1693ff92ba488b97d7`.
The full mapping ledger is physical `integration-base-verify-YAhDBQ/chat-duration-shard-ledger.json`.
These two existing script paths increase the integration PR to **386 files**,
still below 500. They and the official lock merge will join the updated
qualification documents in one successor, followed by fresh CI and one fresh
exact-head Greptile review. Actual human CODEOWNER approval remains required.

## Native Telegram client login and bounded draft journey — September 9

The previously installed macOS Telegram app is the separate Swift client,
bundle `ru.keepcoder.Telegram`; its profile and installation are unchanged.
For this native-only journey, official Telegram Desktop **7.2.7** was staged
separately with its own private profile. The release DMG's SHA-256 is
`7957739d238f466c131c0eca7e05bf3ba188c440380921e250caf5a437f21e8e`, matching
the official release digest. The app's deep/strict signature passes and Gatekeeper
accepts its notarized Telegram FZ-LLC Developer ID, team `C67CF9S4VU`. No
quarantine bypass, profile import or notification/contact grant was used.
The user completed the QR login, and natural search plus the visible profile
verified the exact QA bot username. No unrelated device alert was confirmed.

Source review establishes the acceptance boundary: ordinary first agent replies
typically edit the same run's working/queued message and intentionally bypass
native drafts. A new text-only explicit Board publication in a private chat,
over 280 characters but fitting one provider message, is the natural eligible
journey. The SDK's 250ms update throttle is not a guaranteed Stop-button dwell;
already-approved text is emitted without simulated generation delays. Native
Stop affects that presentation only, not the saved answer or the agent's task.
The current Live83 startup-resolved adapter contains the durable draft patch,
and the exact endpoint's current generation-two Stop subscription is confirmed.
This is source/startup-resolution evidence, not a live heap-inspection claim.

Root followed the real Board UI from the existing task's **Connection** link
to **Conversations**, opened active CHA-50 and expanded **Send to channel**.
The destination, explicit-send copy and staged text were visually inspected.
The 2,791-character synthetic plain update contained no attachments, task
request or private data. The actual send click occurred at 21:32:50.995 UTC.
Publication `9485a2e9-2643-4c01-8539-9ab0a5de2f58` was created at 21:32:51.220
and published at 21:32:52.683, attempt one, provider message `417200359:197`.
It saved comment `9134d24e-c961-4236-a256-6a7f9faa1089`. Durable draft action
`237b332d-ef88-486d-a883-ed11cd2a8822` bound draft **3** to that publication,
attempt, bot, chat, runtime generation two, session generation 16 and text
hash, and settled as published. There was no replacement message, new run or
incoming Stop delivery. The exact existing task remains in progress and its
conversation active. Root inspected the saved Board message and cleared send
form after completion; paragraph structure and the ending marker are visible.

The native observation actually began at **21:32:54.013 UTC**, 1.330s after
publication completed, despite the earlier coordination message. No Stop was
observed or clicked. Later native access returned `noWindowsAvailable`; no
usable final native screenshot was retained. Thus functional Board-to-provider
delivery has a durable receipt and saved Board rendering, but the final native
rendering and native Stop interaction are **unverified** for this attempt.
It is a missed observation window, not proof of an unsupported client or a
successful cancellation. The next bounded check must confirm native window
availability and start observation before the send in one synchronized
interaction. No artificial producer delay or repeated blind sends are justified.

## Completed CI and post-login live qualification — September 9, 22:16 UTC

Integration PR #13038 head `2148ea2f50cdc547cc33456b91c7ad2095bfa676` contains
386 files. [CI run 34407804049](https://github.com/paperclipai/paperclip/actions/runs/34407804049)
completed successfully at 21:53:03 UTC, all 24 jobs green. The isolated chat
suite passes 985/985 with no skips, 591.97s test time / 604.32s total, within
its 10m55s job. The slowest general shard takes 14m53s with unchanged limits.
Exact-head [Greptile review](https://github.com/paperclipai/paperclip/pull/13038#issuecomment-5587250594)
completed 5/5 at 21:41:57 UTC, accepting the official lock and measured shard
allocation. Human CODEOWNER approval remains missing. This supersedes the
earlier cancelled run, not its recorded outcome. No bypass, self-approval or
merge is claimed. New local follow-ups below are not part of this reviewed head.

### Telegram native Stop: button proved, suppression not proved

A second bounded attempt synchronized actual Board and native Telegram UI in
one controller. Root clicked Board Send at 21:36:28.076 UTC, observed and
clicked the native **Stop** button at 21:36:29.152, and saw the draft disappear.
Publication `e15ac3d2-257d-4807-bca2-1855510b6484` nevertheless published at
21:36:29.791, attempt one, provider message `417200359:198`. Root subsequently
visually confirmed the permanent text and ending marker. The exact endpoint
webhook request `df963df1-2263-4267-99f2-404af84ca5d2` arrived at 21:36:30.108,
317ms after publication and 956ms after the click, and returned HTTP 200.

The request log deliberately omits raw update kind and draft ID. Late Stop is
consistent with these observations, but its exact authenticated callback and
the earlier overwritten final-claim timestamp cannot be reconstructed. No
task/run changed, and no artificial streaming delay or message deletion was
introduced. The button exists and responds locally; **pre-final suppression
remains unqualified**. The client hiding a draft is not proof of cancelling a
task or suppressing a provider send. A pure adapter probe also showed that
smaller producer chunks still coalesce to two draft RPCs, not a reliable wider
native Stop window. No third blind attempt was made.

### Telegram silent MP4: received, inspected and returned

The exact existing synthetic fixture, `synthetic-teal-one-second.mp4`, is 997
bytes with SHA-256
`908f7f60a20a29309d24fe2a2b81f23baa458e4f3f31aeec58633c1b89a512ca`.
It is one second, 16×16, one uniformly teal frame, no audio. Root selected the
file using Telegram Desktop's actual attachment picker. The preview showed
**Send a video file**, with **Send as a document** unchecked. At 21:53:43.345,
root sent it once with marker `TG-LIVE83-0909-VIDEO-A`, asking the agent to
inspect only this attachment and return its original received bytes unchanged.
The sent native UI labels it **GIF**: this is silent-MP4/animation coverage,
not an assertion that the inbound payload was exactly `message.video`.

Delivery `0666424f-a400-40f2-8afd-a767a5cd8082`, source `417200359:199`, arrived
at 21:53:44.385 and processed on attempt one at 45.663. The current comment
owns attachment `98dd8a43-7b51-4d0f-a69b-46aa8ee656fd`; its bytes match the
fixture. Native `codex_app_server` / `gpt-5.6-luna` run
`7d003f86-755b-4c90-b20d-6c6476d8ceb4` started at 45.691 and succeeded at
21:54:46.360. Working and progress updates reused message 200; the final
description edited it at 47.033, correctly describing the one-second teal
clip. The eyes reaction cleared at 47.294. Exactly one returned file appeared
as message 201 at 48.044, publication `7fb2b7ab-5d7f-411c-b61d-4387ce111b3b`.
Its attachment `7d8ee2d8-1d26-4df2-8d31-8dd77a1d4a25` is bound to this exact
run and matches the current received file's complete bytes and hash.

Root saw the native **Video** card (997B, 16×16, 00:01), opened its actual media
viewer and inspected the teal frame and playback end. Click-to-file was
64.699s: 1.040s ingress, 1.306s ingress-to-run, 60.669s execution, 1.684s
finish-to-file. The provider turn itself took 58.026s. The trace shows one
mistyped workspace path followed by recovery; it does not establish a precise
latency split for that mistake. This is useful working media delivery, but the
minute-long agent execution is still noticeable. No independently downloaded
return hash, exact raw inbound subtype, named reuse-tool invocation, or full
Telegram media-family qualification is claimed. Same CHA-50 and generation16.

### Telegram 100k Board publication: complete downloaded bytes

Root used CHA-50's explicit **Send to channel**, not its ordinary agent
composer. The actual textarea was read and hashed before sending: 100,000
JavaScript characters (99,999 code points), 100,009 UTF-8 bytes, SHA-256
`60bc818abdd3c9954ad58fe717a8813bbcc4ae5ee2df2240b4a68fdd801a4be3`.
The synthetic Markdown includes Unicode, escaped punctuation, a closed code
block, and `TG-LIVE83-0909-LONG100K-A` BEGIN/MIDDLE/END markers at JavaScript
indices 0, 50,001 and 99,971. Root clicked Send once at 21:58:32.325; the form
showed Sending, then cleared and collapsed. One comment `2e22643d…` was saved
at 32.371; one publication `e3965a83…` published at 33.520 on attempt one,
provider message 202, `telegram_markdown_attachment`, part 0 of 1. No agent
run or wake was created. Click-to-publication was 1.195s.

Native Telegram showed the downloaded 97.6KB Markdown file and an accurate
complete-response caption. The actual Telegram Web Instant View reader opened
the file; root visually inspected beginning/Unicode/escaped punctuation/code
formatting and the ending marker. The middle marker was present in the actual
reader accessibility tree, not separately screenshotted. The native downloaded
`paperclip-response.md` is exactly 100,009 bytes and has the complete source
hash; root and an independent agent read and verified it. The independent check
also validated UTF-8 and all marker positions. Source text existed only in
memory before the provider download, not in a precreated local lookalike file.

This qualifies **new explicit Board publication** end to end. Publishing an
already-existing comment is a distinct API path. The current native Board chat
UI exposes only the new-send composer, not an existing-comment publish action;
no second new comment was passed off as that journey. The existing-comment
path retains deterministic coverage but remains live-unqualified.

### Discord current reach: private denial and exact restoration

The existing Clawd QA thread `1547256172023779448`, under #general
`1457808933082108089`, remained bound to CHA-43. A read-only preflight confirmed
no running/queued agent work or unsettled provider effects. Root used Discord's
real native command picker to invoke `/paperclip status` at 22:02:30.612 UTC;
the private reply identified CHA-43 / in_progress. Root disabled only
**Enable #general** at 22:03:52.783, verified OFF after reload at 22:04:11.181,
and invoked a fresh native status at 22:04:18.858. The actual private response
was: “This command is not available here. Open the Paperclip task or ask an
operator to link this account.” It showed **Only you can see this**.

Root restored #general at 22:06:55.237 (persisted at 55.261), reloaded and
verified ON at 22:07:05.842. All ten other channels remained OFF and DMs ON.
A fresh native status at 22:07:27.846 again returned CHA-43 / in_progress
privately. The 22:07:47.488 screenshot shows baseline, denial and restored
responses together. An independent 22:08:08.184 read-only snapshot confirms
the original endpoint/runtime/identity/settings and unchanged task state:
50 company tasks, 222 channel comments, 94 runs, 103 wakes, 266 endpoint
publications and 120 deliveries; no pending work. Only the two successful
status receipts were added. This tests current destination authorization, not
actor-role revocation, Discord-side 403 or an in-flight race.

Functional access enforcement passes and the original settings are restored.
Experience quality needs two repairs: an already-linked owner receives
misleading account-linking guidance, and resource changes have no
actor-and-before/after activity history. Route, service, middleware and actual
activity rows confirm the latter; successful HTTP PUT logs and `updatedAt`
are not an audit trail. Local fixes are being qualified separately from the
published head. The generic response is being changed to ask an operator to
**check your chat access**, retaining privacy and no disclosed rejection
reason. Its exact real-discord.js boundary expectation genuinely failed first;
after the change, 100 focused native-command/runtime checks pass, independently
repeated against the final local source in 4.08s.

The atomic resource-audit repair now passes **13/13** focused integration tests
on fresh fixture database `chat_resource_audit_20260909_green02`, 8.12s total /
1.04s test time, with 972 cases not selected. Ten new cases cover real manager
PUT and authenticated actor, secret-free exact net deltas, empty/same/replayed
and duplicate no-ops, foreign/unavailable batch rejection, audit-insert and
post-audit/precommit rollback without events, injected precommit versus
postcommit lease-guard failure, a real blocked-row snapshot, and concurrent
identical/opposite changes. Three existing controls cover manager authorization,
canonical resource identifiers and disable during a held Slack publication.
The actual route test first failed because a successful mutation produced no
activity row, on separate fresh `chat_resource_audit_20260909_red01`.

The implementation preserves lease-row → endpoint → sorted-resource locking
and validation of every submitted enable, including intermediate duplicates.
Only net original-to-final changes enter an allowlisted audit payload. The
audit is durable in the same transaction as the resource change; activity
notification occurs after commit, even if the outer lease guard subsequently
fails. Live event delivery retains the existing best-effort semantics, not a
new crash-proof outbox guarantee. The transaction-spy rollback case is distinct
from the injected lease-guard cases; neither establishes actual lease takeover.
The blocked-row case proves a locked current snapshot, not a newly attributed
provider-lifecycle race. Final plain server typecheck, scoped formatting and
independent review pass. Frozen SHA-256 values: route
`2c5663f1b83d3c39cbeb4377a3870342dd01442581174585899b072dddd0d596`, service
`b6e78b2a72a85991cb4ded67aa606853d2507285cf3ccbc76394d7c0426a5a68`, tests
`c4b19c8ba222c7af8379bfcc0d3fa058d93fdc52a372fa142979b6f75e052bdc`.

Neither fix has been deployed to Live83 or included in reviewed 2148 yet. The
landing lane must apply only this follow-up delta, preserving its newer service
and integration fixes, then qualify the full composition. Any successor needs
fresh CI and exact-head review; human CODEOWNER approval remains required.

## September 9, 22:27 UTC — composed resource audit qualification

The landing lane applied only root commit `2af25c89514be5591205180eeac63b9575c9ea0e`
relative to its `a185ba071` parent onto reviewed head `2148ea2f`. The seven-file
patch merged cleanly without replacing root snapshots over newer landing
fixes. Application candidate `3afad5f3e42810bc433b5337c2063c3bc88d7001` changes
388 files versus the incorporated master. The additional two diff paths are
existing foundation runtime/native-command test files, not new files. Only
three production provider SVGs remain in the image diff; no wireframe images
returned. The official lock and private runner artifact remain unchanged.

Fresh full chat integration passes **995/995**, no skips or retries, in
280.58s tests / 289.48s total, exit 0 at 22:26:44 UTC. It used retained database
`chat_close_receipt_20260909_full_resource_audit01`. The existing 250ms observer
read only that test database and recorded four ordinary lock waits, no
`40P01`, and no observer errors. No database settings or deadlines changed.
The initial two migration-launch attempts could not resolve a root-level
`tsx`; neither started a database or test. The physical DB package's installed
`tsx` then created and migrated the fresh database successfully.

Additional exact composed checks pass: four native-command/runtime files
**100/100** in 5.20s; adapter bridge and default-off route checks **82/82** in
1.39s; three CI partition/config files **28/28** in 1.75s. Plain server types
and diff checks pass. These counts describe separate selected cohorts, not
additional unique coverage beyond the full repository.

Composed source SHA-256 values stayed unchanged before and after the full run:

- Service: `08ca2017a996a513f436642bd22039696a2bd23f02f9567db9bbe56e86370308`.
- Integration: `70707a17b1de36bd4bdde6191c54cf1844ca6d474d6c261f87c7b10c3391c9bc`.
- Route: `2c5663f1b83d3c39cbeb4377a3870342dd01442581174585899b072dddd0d596`.

The service and integration hashes differ from root's qualified hashes because
the composed files retain the newer landing-only fixes. The follow-up diff
itself has identical per-file additions and deletions. No runner rebuild or
live deployment was needed for these server-only changes. The new audit UI
remains live-unqualified. Publish only one successor update to #13038; fresh
exact-head CI and Greptile review, plus human CODEOWNER approval, remain gates.

## September 9, 22:42 UTC — Settings saves only the selected destination

The audit/copy candidate was published as `3614340933c2d2f53230a8163bbec21970cba01b`
before the newly issued UI hold arrived. Its CI was still running at this
checkpoint; the completed red result is recorded below. No new Greptile
request was sent. Root then proved three distinct old-UI failures:
two actual Settings pages with separate caches reverted an unrelated grant or
revocation, and a 501-resource inventory made a single toggle exceed the
500-entry request bound. All three failed at the intended state assertions on
fresh `chat_ui_partial_20260909_red01`. Earlier launch failures at a busy
default port and embedded database startup did not execute these cases.

Root commit `72238a84ec772088aba809c7cdb9321ada3b70a8` changes only the existing
Settings component and browser spec. Each click sends one typed resource
update. Successful responses still refresh the full cache, errors remain
visible, and pending controls stay disabled without claiming an unsaved value.
It does not change same-destination last-write semantics or the partial-batch
server API. The five existing provider management assertions now require the
exact singleton payload.

The fixed nine-case root browser cohort passes with no retries or skips:
five provider catalog/setup/management journeys plus four new cases. A final
four-case repeat adds the exact error-toast opacity assertion before the
rejected-state screenshot; its earlier screenshot caught the transparent
entrance frame despite DOM visibility. This strengthened repeat passes in
22.2s. Root independently inspected pending, rejected and reloaded saved states.

The landing composition is `fee3e9c6b05056a35a2704cf7b7bed1a520b2fa4`, 388 files.
Both transferred paths were byte-identical to root before the patch and match
the frozen final hashes afterward: UI `93b96459ffd593b2a8beec16b446349acb5693f0bb0bfd1983801d05b47a14cc`,
spec `c4c8ac470487d5bfef29948a5044c5fcbff1330501eb36d49fee583dba9e5f52`.
The composed four-case repeat passes in 49.2s, zero retries/skips, on isolated
port 3278 with fresh `chat_close_receipt_20260909_ui_singleton01`. Its server
shut down normally. All 64 selected UI units, plain UI types, token gates and
diff checks pass. Server, runner and lock bytes remain unchanged; the earlier
full 995-case server pass remains attributable to those exact bytes.

The landing owner also inspected all three actual screenshots. The pending
state retains both unchecked values; the rejected state has an accurate,
fully opaque, unclipped error; one explicit retry saves only the selected
destination and survives reload. The test uses real browser pages against a
mock control-plane resource fixture. It is not live-provider permission or
real database concurrency qualification, nor a claim about every transition
or accessibility property. The API's atomicity has separate real database
coverage above. No new images are tracked, and no live instance was changed.

The next remote update must retain the complete 361 CI record and resolve any
concrete failure, then obtain fresh exact-head CI and Greptile review. Human
CODEOWNER approval remains required; no bypass or third chat PR is authorized.

## September 9, 22:47 UTC — complete 361 CI retains a Rust failure

Run `34412429534` completed red without cancellation. All independent jobs
except Build passed, including every server/browser shard and required E2E.
The verification aggregate correctly failed. Full chat integration passes
**995/995**, no skips, in 576.43s tests / 591.09s total. The last general
server shard passes 1,973 cases with five existing guards.

Build passed 38 Node contracts and the runner TypeScript suite: **1,944**
executed cases plus three unchanged opt-in benchmark guards, in 223.67s total.
The Rust `codex_provider` target then finished with 83 passed, one failed and
two helper declarations ignored. The failure is
`ambiguous_replacement_turn_adopts_one_later_completion_identity`, at the
assertion `observe replacement completion for malformed-error-with-completion`.
This is not automatically a five-second timeout: the fixture also stops
polling immediately when it sees an exit. Later runner checks and repository
build stages did not execute after exit 101.

The actual CI checkout is `840914a3c28879451d0314177c72a19474858f5c`, merging
361 into master `3bc60dd8bf7bdef654553c7175e018f00b7a864c`. The failing test
blob `c2246dc1281e5fab10c26dc8ab9f9316fe0a1665` is identical in incorporated
master, published 361 and that current master; the chat branch has no Rust
delta. This is source provenance only, not proof of flakiness, environment
cause or irrelevance. A bounded provider-event/exit-order investigation owns
the failure. The qualified singleton UI source remains frozen locally at
fee3, with no new push, review request, deadline change or blind CI rerun.

## September 9, 22:58 UTC — controlled Codex reader-tail repair

The unchanged original release test passes alone in 0.09s. That does not clear
the CI failure. A new per-instance, test-only receiver proxy holds the actual
terminal frame after the owned child has exited. The old production code
reports exit before that held frame reaches the parser: the new assertion
genuinely fails in 0.02s. This establishes a concrete reader-ordering defect,
without claiming a trace of the exact CI scheduler sequence.

The bounded repair touches only existing `codex_provider.rs` and
`process_supervisor.rs`. EOF and reader failure remain sticky across both
receiver APIs; a read timeout is not EOF. Codex waits for its stdout tail
before certifying exit, bounded by the existing shutdown grace for that
process generation. A continuously writing descendant cannot keep the wait
alive indefinitely. If the bound expires, the provider is not certified
successful or safely reconciled; a terminal result already observed remains
recorded. Quarantine still cannot interpret new frames. No global hook,
provider fixture reordering, deadline increase or live binary replacement.

The final six controls pass with zero ignored tests (269 unrelated tests
filtered), in 6.04s. They cover the held actual terminal, sticky EOF with live
stderr, reader error, generation/buffer boundaries, observed-terminal timeout
semantics and an actual continuously writing descendant. Root and the
independent reviewer approve the final hashes:

- Codex: `0521d39e201163a7cd60cee14a38fe176d40a2b5a53d214618009a5851e4b394`.
- Supervisor: `aeb00cd65932c50d553e8ac1e691f0bc5998843e1ca3e2a2ec5b7e6046910680`.

Private commit `3bb4716f1ebde1c29f8c7b2b4099810c6587e7fb` adds only these two
files to the qualified Settings composition. The comparison is 390 files,
still below 500. Current master remains `3bc60dd8…`, with no newer runner
overlap. The locked release Rust workspace is running at default concurrency;
new artifact, transport, authority and type qualification must finish before
publication. Original/live files, binary, dependency lock and server remain
unchanged. Existing 995-case server and Settings receipts retain their exact
source attribution; they do not qualify the new Rust artifact.

The first default-concurrency release run is retained as **red**. The new six
controls and original ambiguous-replacement case pass, but the unchanged
descendant-restoration fixture fails its initial `assert!(completed)` at
source line 5833. Its target reports 83 passed, one failed and two helper declarations
ignored. The saved state contains 255 of 300 descendants, still active with
no terminal: two 128-event poll batches including the initial root event.
This matches the same pre-repair local failure boundary. An unchanged isolated
run with the new release test binary passes in 3.51s; no source or deadline was
changed. It is not proof of the exact local scheduling or storage bottleneck.
An explicitly serial full Rust component run is the next qualification; the
default failure will not be relabeled green. Fresh required Linux CI must
exercise default concurrency. No unrelated fixture rewrite is justified by
the observed partial-progress boundary.

## September 9, 23:10 UTC — final isolated artifact qualification

The explicit `--test-threads=1` locked release Rust workspace passes **546
top-level tests plus two invoked subprocess-helper checks**, zero failures.
The two helper declarations are ignored only in their parent harness and are
executed separately. Both the original ambiguous-replacement case and the
lineage case pass. The Codex integration target passes 84 cases in 98.72s.
This is component qualification with explicit serial scheduling, not a claim
that the default-concurrency run passed or a change to CI scheduling.

Locked release/debug workspace binaries were rebuilt only in the isolated
copy, then the runner was staged through the existing signing script. Its
SHA-256 is `5ba0b273086e48ac1be07186083f75b6eb64a7157bf0663609f52c944f310443`.
The full transport file passes **171/171**, zero skips, in 225.88s tests /
226.43s total. The required actual runner-to-HTTP authority cohort passes
**870/870** in 13.74s total. Conformance and replay parity pass **1/1** and
**11/11**. Plain runner and server types pass. Final source, staged artifact
and official tracked-lock hashes remain unchanged after the checks.

The final remote overlap check found master `5488a79e…`, whose only addition
since `3bc60dd8…` changes Docker publishing to native architecture runners.
It does not overlap the Codex/supervisor repair, so no recency-only merge was
performed. The code candidate remains `3bb4716f…`, 390 changed paths. The
Settings browser and 995-case server receipts above retain exact unchanged
source attribution. No live deployment or unrelated qualification was added.
The next single update to #13038 still requires fresh exact-head CI,
Greptile 5/5 and actual human CODEOWNER approval before normal merge.

## September 10 — passing CI and subsequent master reconciliation

Published head `3e4e1c1cee05737fd5193e141ccd52f8815c7854` passes every PR
workflow job in [run 34415826820](https://github.com/paperclipai/paperclip/actions/runs/34415826820),
completed September 9, 23:28:50 UTC. Required `ci / verify` and `ci / e2e`
are green. The Build log independently confirms both the originally failing
ambiguous-replacement test and the descendant-lineage test pass; its Codex
target is 84 passed with two parent-only helper declarations ignored and
separately invoked. The unchanged Linux scheduling gate is now proven for
that published head, not merely inferred from local serial results.

Work was interrupted after publication. The requested three-hour merge
target elapsed without a merge. On resumption, master `018ca5da…` contains
new ACP Stop, mobile layout, runner vendoring and official lock changes.
Its seven conflicts require a real composition rather than a blind CI retry.
The existing isolated checkout is being reconciled; the original feature
checkout, live server, provider accounts and live runner remain untouched.

The actual frozen installation succeeds with the inherited local store and
the official master lock; no lock regeneration. The initial command ended
at a noninteractive store-purge prompt and is not counted as installation
proof. Packaging Vitest checks pass 11/11; an earlier accidental Node-test
invocation of that Vitest file failed at harness initialization and is retained.
Adapter/shared typechecks pass.

The first unchanged four-file adapter cohort reports 183 passed and three
timeouts. macOS power logs prove an idle sleep from 22:08:54 to 22:13:44 CDT,
290 seconds; the three affected tests span 287–292 seconds. With a temporary
sleep-prevention guard, the same files and concurrency pass **186/186** in
22.98 seconds. No timeout, assertion, fixture or production change was used
to obtain that repeat. These results qualify the adapter composition, not
the still-pending server/UI conflict resolution or all live channels.

The completed reconciliation preserves upstream opt-in ACP cancellation and
its verified cleanup alongside the existing process cancellation owner and
separate native path. An adapter that already finalized Stop does not repeat
the downstream lifecycle side effects. UI composition preserves mobile
layout, the visible execution blocker, chat routing, and exact response/retry
state. Layout is byte-equivalent to master except for the reserved chat path.

Independent review found a real adoption overlap: generic queued-comment
adoption could consume a dedicated external answer or add unrelated input to
that answer. Two actual-service tests genuinely fail before the guard. The
fix excludes interaction donors and respects a recipient's non-coalescing
contract. Retained donor status, run identity and full payload remain exact.
The fixed four-case cohort passes, including upstream ordinary adoption and
adapter Stop. No provider source or session context is replaced by bare IDs.

The final full heartbeat suite passes **257/257** in 107.94 seconds total
(103.69 seconds tests), on a fresh database. Adjacent queue/control passes
**24/24** in 11.34 seconds. Focused UI passes **448/448** across eight files;
plain server/UI types, token gates and diff checks pass. Independent source
review is clear, with source hashes unchanged through the checks.

The merged-code browser cohort passes **4/4** in 1.4 minutes, no skips or
retries, on a fresh disposable PostgreSQL database and isolated port. It
covers all three upstream ACP Stop paths: same-session queued continuation,
an unknown action remaining blocked, and paused work requiring explicit
Resume. The existing actual-process journey also passes queue, composer
Stop, subtree pause/cancel, reload and resume. The inspected final screenshot
shows Cancelled, a paused subtree, preserved input, and no error toast.
These are real local fixtures, not live provider or complete visual-transition
qualification. The next exact published head still needs fresh CI and review.

## September 10, 03:42 UTC — green CI, confirmed registration race

The master reconciliation is published as
`a95d42e58afa35cf4ecf1a39cbd96f06523b90ec`. Its
[CI run](https://github.com/paperclipai/paperclip/actions/runs/34433249742)
passes all 24 PR jobs and both required aggregates. UI CI passes 2,768 cases;
browser shards pass 104 with four explicitly skipped optional cases. Those
skips are not live or native-runner qualification.

The one requested exact-head Greptile review completes **4/5**, identifying
a real Stop-registration race outside the diff. Stop can snapshot no control,
then wait for its database terminal write while a readiness callback registers
and reads the old running state. The later Stop commit uses the earlier
no-owner decision, allowing provider startup after acknowledged Stop. The
simpler ordering where Stop commits before the callback was already safe.

The fix records exact-run no-owner Stop barriers and awaits them before a
readiness callback publishes its control. Registration and the final empty-set
observation are synchronous together. Duplicate Stops cannot join an adapter
whose readiness waits for those same Stops. Each single/bulk owner releases
in `finally`, including failures; registered-before-Stop retains verified
abort/cleanup joining. Native execution and non-opting plain processes retain
their separate paths. No late terminal rewrite or invented ACK is required.

Controlled database tests hold the real run row and prove that Stop's update
is waiting, invoke the real readiness callback, and assert no early readiness,
published joinable control, provider dispatch, or returned Stop. After release,
the callback observes committed cancellation and the engine-equivalent dispatch
gate remains closed. Both single Stop and agent pause cases genuinely fail
against exact `a95` heartbeat source and pass with the correction. These
service fixtures do not themselves invoke a live ACP provider.

The final full suite passes **265/265** (259 heartbeat and six control cases)
in 106.79 seconds total / 102.28 seconds tests, on a fresh database. Plain
server types and diff checks pass. The first exact-old-source replay did not
reach tests because `git show` exceeded its subprocess output buffer; that
startup failure remains retained separately. Increasing only the ignored
replay config's read buffer permits the genuine two-case red comparison.
No tracked source was reverted, deadline enlarged, or fixture race hidden.

Independent final review strengthens the post-drain assertion from partial
matching to exact equality of terminal status, error fields, and result JSON.
An added late acknowledgment would now fail the test. Those final two cases
pass again on a fresh database in 6.61 seconds total; plain server types pass
again. This is a test-only strengthening after the full 265-case run, not a
claim that the full suite ran again. Final recovery-test SHA-256 is
`522b581a67e908e249e1a96359a5c0ab66df1a71a36a39c4a60d97223bcbbb38`.

The unchanged frozen production then passes all four actual local process/ACP
browser paths in **1.3 minutes**, with no skips or retries, using fresh database
`chat_stop_registry_browser_20260910_01` and port 3282. The final screenshot
shows Cancelled, a paused subtree, retained input, and no error toast. These
are local fixtures, not new live-provider or native-runner deployment proof.
Production heartbeat SHA-256 is
`66f9c0c316d7aac970b74fbc2e1412e61a5d206dbb8b8ac9d8dbbaed3ba4f343`;
the control helper is
`a705ed33233b31537292ff9ca1782ba4d115866ed67cb94f67a9da4c576e3ff1`.
Publish one successor with 392 files, then require fresh exact-head CI and
review. Normal GitHub policy remains authoritative; no bypass or self-approval.

## September 10, 04:03 UTC — final gates passed; new master conflict

Published `7c6d36e0d7d343709f10b533a0c29dc2409f7b2b` passes all 24 jobs in
[CI 34434501548](https://github.com/paperclipai/paperclip/actions/runs/34434501548),
including both required aggregates. Full UI is 2,768/2,768; browser shards are
104 passed with four existing optional skips. No retry or deadline change.
The one exact-head Greptile review completes **5/5** at 03:48:23 UTC, explicitly
accepting the registration barrier and finding no new actionable failures.

The normal `--squash --match-head-commit` merge refuses to proceed: master
advanced during CI to `6dd48cad439eaafc5666df122d40ca45f166c0c3`, extracting
deferred-wake release into a module. This creates actual conflicts in heartbeat,
issue service, and batching tests. The PR remains open, not merged. No admin
bypass, self-approval, forced master update, or automatic conflict acceptance.

The existing checkout now reconciles the extraction with the exact chat
retry authorization and native recovery guards. Independent review checks
policy placement and lock order. The test merge preserves every prior batching
test byte and adds the two upstream deleted/self-authored wake cases. Issue
service preserves the new company-scoped wrapper with its chat rules unchanged;
19 focused tests pass. Initial pure module tests pass 37/37. These preliminary
checks do not qualify the still-changing combined module or permit a merge.

## September 10, 04:15 UTC — extracted module composition qualified

The completed integration preserves all three established chat safeguards:
exact retry promotion authority and lineage without normalization/reopening;
retired question-source proof before native incident creation; and denial of
generic failed-chat/nonretryable recovery after independently admitted deferred
input has had its chance to promote. The adapter carries exact database facts
through the module's ports. It does not turn serialized hints into authority.
Existing issue-to-wake lock ordering, company guards, dedicated-answer adoption,
Stop-registration barriers, and ordinary post-commit dispatch remain intact.

Final module tests pass **49/49** across four files, including eight real
embedded-PostgreSQL adapter cases and four added use-case controls; 6.69 seconds
total. Plain server types pass. The combined recovery, batching, queued-comment
and Stop-control suite passes **307/307** in 136.37 seconds total / 127.94 seconds
tests. Full chat integration passes **995/995** in 238.45 seconds total /
231.97 seconds tests. These use fresh databases, not reused populated fixtures.
All final local cohorts have no failures, retries, or skips.

All four actual local process/ACP browser paths pass again in **1.3 minutes**
on fresh database `chat_merge_6dd_browser_20260910_01`, port 3283. The inspected
final screenshot shows Cancelled, a paused subtree, retained input, and no
error toast. This is local fixture evidence, not new live-channel qualification.
Independent source review is clear. Before/after hashes match; heartbeat is
`26825ecc83f758738ab5d93d9bf9daa1ec36d6175ec4383b101d1aa500e2002a` and the
module adapter is `0de02024c6d6e3c6f5de525c3a73e62ba0695123e468ef90b74a679a41861821`.
The original checkout, live server and runner remain untouched. The single
successor has 397 changed files and still needs fresh exact-head CI and review.

## September 10, 12:19 UTC — subsequent master queue refactor

The preceding composition was published as
`e02a63d462ce5d47433b0aeb632bb6fd20aab1ba`. Its
[CI run](https://github.com/paperclipai/paperclip/actions/runs/34436462958)
passed all 24 PR jobs, and its exact-head Greptile review completed 5/5.
Normal merge remained blocked by required CODEOWNER review; no bypass or
self-approval occurred. Master then advanced to
`2a05b5ed3457ea33efd6895520447d1d97fe98d8`, creating six new conflicts.

The new reconciliation retains upstream's host/transaction split and extracted
admission use case. Chat admission carries its own durable receipt identity,
actor partition, and non-coalescing contract through those ports. A merge into
an existing deferred wake still inserts the incoming receipt in the same
transaction; a real PostgreSQL regression forces that insert to fail and
verifies that the preceding target update rolls back. Upstream company and
status compare-and-set guards remain intact. All previous release guards,
dedicated-answer adoption rules, and Stop-registration barriers survive.

Upstream's stricter module-boundary check initially fails because the new
application code imports a service helper. That helper only strips inherited
fields, while this call supplies a fresh six-field normal-model context.
Removing the no-op wrapper/import preserves the exact context without adding
another port or relaxing the scanner. The initial failed log is retained.
The repeated workflow/module-boundary cohort passes **24/24**. Plain server
and UI types pass. All four queue-module suites pass **89/89**, including the
real rollback case, with no skips in 8.74 seconds total / 2.42 seconds tests.
The preservation audit confirms prior chat guards and incoming upstream tests
are retained; batching adds one upstream case without deleting prior tests.

Independent review of the frozen production and test hashes is clear. Fresh
recovery/batching/queue/control verification passes **308/308** in 139.98 seconds
total / 130.33 seconds tests. All four actual local process/ACP browser paths
pass in **1.4 minutes**, without retries or skips, on their own fresh database.
The inspected final screenshot shows Cancelled, a paused subtree, retained
input, and no error toast. These are local fixtures, not live-channel proof.
Full chat integration passes **995/995** in 249.35 seconds total / 241.04 seconds
tests on its own fresh database. There are no failures, retries, or skips in
these final local cohorts. Before/after source hashes match the reviewed
freeze: heartbeat `65bdfb994130b16dcc3d29a353219868f6e265e7c9882da877a79e272c181b6e`,
adapter `88d0e8669f53bb97e39714af242228a847ab18969b981650b0eafaecc176c998`.
The successor has 398 changed files, without wireframe images or HTML galleries.
Auto-merge is disabled until fresh exact-head CI and review complete. The
original checkout, live server, and runner remain untouched.

An additional exploratory `tsc --noEmit -p server/src/__tests__/tsconfig.json`
fails and its log is retained. The new configuration is byte-identical to
master and was added to govern orphan test transformation, not to join the
server build/typecheck graph. Invoking it as a standalone project produces
625 outside-root diagnostics and other broad existing test-type errors.
All seven wake-queue diagnostics are outside-root errors. No standard CI,
workspace typecheck, or build command invokes that project directly. No
configuration, test, or standard gate was changed to conceal that failure;
the normal server and UI typechecks passed as reported above.

## September 10, 12:44 UTC — CI exposes an imprecise Discord race fixture

The reconciliation is published as `102fa25b87b70d6346d569a5bef7553a4b980185`.
GitHub reports it conflict-free, with 398 files. Exact-head Greptile review
completes **5/5** at 12:34:58 UTC without actionable findings. Fresh
[CI 34477184777](https://github.com/paperclipai/paperclip/actions/runs/34477184777)
then fails the chat shard: **993 passed, two failed**, in 693.19 seconds total.
The failures are the replaced-runtime and changed-credentials variants of the
Discord modal connection-lock race, at the pre-mutation waiting assertion.
The completed run has **22 successful jobs**; only this shard and its required
verification aggregate fail. Build (including runner verification), typecheck,
canary, all other test shards, and the browser aggregate pass. Browser shards
pass 104 cases with four existing optional skips. No rerun, merge, or approval
bypass occurred.

Both relevant production and test files are byte-identical to the preceding
head. Independent investigation identifies two fixture problems: the default
one-second wait starts before the database-wide reconciliation scan reaches
this endpoint, and the query recognizes any backend blocked by the held row.
Earlier command authorization also reads that row under lock, so this does not
uniquely prove the modal-upgrade boundary claimed by the test. The failure is
not evidence that a revoked runtime actually gained the capability.

A test-only correction gates the exact modal statement and transaction PID
before executing it, acquires the actual connection row lock, releases that
statement, and proves the precise blocking relationship before mutation.
The original prepared statement still executes unchanged. Matching includes
the modal projection and exact company/connection parameters; the PostgreSQL
observation includes database, transaction PID, SQL text, and blocking owner.
Real locks, the one-second lock observation, the overall 15-second test bound,
and final state assertions remain unchanged. Gates are released, transactions
joined, and spies/listeners restored even on failure.

Strengthening the old fixture's assertion to require the actual modal query
produces **three failures** in 10.69 seconds total / 3.33 seconds tests. This
is a controlled stronger-boundary comparison, not an unchanged-old-source
replay; the original CI already supplies the unchanged two-case failure.
The corrected three races and five adjacent capability cases pass **8/8** in
6.70 seconds total / 0.471 seconds tests, with 987 intentionally unselected.
Plain server types pass, and independent final review is clear at test hash
`90c49c38579163598626b07057fab4ac8867d3a036d1cc7adef77c21d69984d6`.
Production hashes are unchanged. The failure logs remain retained. Full chat
integration then passes **995/995** on a fresh database in **287.16 seconds**
total / 280.53 seconds tests, without skips or retries. The test hash still
matches the reviewed freeze. The successor changes only this fixture and its
verification notes; the full PR stays at 398 files. Require fresh exact-head CI
and Greptile review before normal merge, without bypass or self-approval.

## September 10, 13:08 UTC — cold route-module setup exceeds a body deadline

The Discord fixture successor is published as
`a8a32c60d2034e7b0efb4eb7d1dde585a75c509b`. Exact-head Greptile review completes
**5/5** at 13:00:16 UTC without actionable findings. Fresh
[CI 34479680858](https://github.com/paperclipai/paperclip/actions/runs/34479680858)
fails serialized server shard 1 on the first agent-skills route case, which
exceeds its explicit ten-second body timeout. The following **35 cases pass**.
The first app-construction log arrives more than eleven seconds after the
Vitest run starts, and the reported transform time is 7.71 seconds. The test
file is byte-identical to current master; no production regression is
established by this setup timeout. The original failed job log is retained.

A temporary timing-only probe measures actual module import, app construction,
and HTTP request separately. Its first attempt passes but emits no timing
records, so it is not phase evidence. The second attempt passes both cases
and records first import **4528.985 ms**, app **7.466 ms**, HTTP **8.600 ms**;
the second import is **127.798 ms**, app **2.973 ms**, HTTP **3.017 ms**.
Neither local probe reproduces the CI timeout, and neither changes a deadline
or adds a sleep. Both diagnostic logs are retained and all instrumentation is
removed from the final source.

The test-only correction prepares actual route and middleware exports inside
the existing asynchronous per-case setup, after every module reset and mock
default. Each test still constructs its own Express app and route factory
after applying its case-specific mock overrides. There is no suite-wide module
cache across resets. The explicit first-case ten-second timeout, existing
hook bound, all route/security assertions, and production code remain unchanged.
Final qualification passes **141/141** in five separate cold Vitest forks:
skills **36/36** (7.20 seconds), permissions **63/63** (3.23 seconds), cross-tenant
authorization **13/13** (3.42 seconds), adapter authentication **14/14** (4.74
seconds), and adapter routes **15/15** (2.60 seconds). There are no retries or
skips. Plain server types pass. Independent review is clear at the frozen test
hash `ca857aef342ccfa36d6c27a1da0d38bede609e9c82bc109ca63473a21c303c24`.
The reviewed heartbeat, chat service, and corrected Discord integration hashes
remain unchanged. This successor changes only one test and its two qualification
notes; the full PR becomes 399 files. Require fresh exact-head CI and review
before normal merge. No live server, provider credentials, or runner deployment
changes occur.

## September 10, 13:12 UTC — real-runner durable receipt observation

The remaining `a8a32c60d` CI jobs prove the Discord fixture correction:
full Linux chat integration passes **995/995** in **657.63 seconds** total /
642.50 seconds tests, with no skips. Build then fails native-runner verification
at the real-process kill/resume case. Its two-second checkpoint poll sees only
the initial open-run state, not the expected durable governed effect. That
runner Vitest cohort reports **1943 passed, one failed, three existing skips**.
The real-process case fails before the explicit kill and receipt/recovery
assertions. The complete job log is retained; it is not a passing build.
The completed run has **21 successful jobs**. Build, the agent-skills serialized
shard, and the required verification aggregate fail; all other jobs pass,
including typecheck, canary, all other server/workspace shards, and the browser
aggregate. The browser shards pass **104 cases** with four existing optional
skips. No CI rerun or merge bypass occurs.

The unchanged failing case passes locally once: **1/1**, 30 intentionally
unselected, 4.67 seconds tests / 5.24 seconds total. The staged runner hash is
`5ba0b273086e48ac1be07186083f75b6eb64a7157bf0663609f52c944f310443`, matching the
previously built and qualified artifact; the corresponding Rust source is
unchanged. This is not a local reproduction of the original CI failure.

There is an independently verifiable fixture clock mismatch: its two-second
poll begins at `sendMessage`, whereas the provider's two-second turn deadline
is armed after bounded workspace admission. The nominal workspace bound is
100 milliseconds, and the original CI snapshot alone does not establish how
much time that phase consumed. Do not claim an unmeasured production cause.
The test correction instead observes the actual durable store save completing
for the exact session, run, active turn, effect, and process identities. It
races real turn failure and the existing test-abort signal. Actual save/fsync,
the provider two-second deadline, overall thirty-second deadline, process kill,
thread recovery, and duplicate-effect assertions must remain unchanged.
A controlled mutation acknowledges before the real save finishes; it fails
the held-save assertion in 2.14 seconds. This is causal evidence for the
durability boundary, not an unchanged reproduction of the CI scheduling issue.
The corrected focused cohort passes **5/5** in 6.77 seconds. Controls also reject
six identity/effect/process mismatches and a rejected save, fail on actual turn
failure or unexpected completion, and remove their abort listener. A new
assertion requires the turn to remain unsettled immediately before SIGKILL, so
a prior provider timeout cannot masquerade as the intentional termination.
Cleanup joins the owned turn and preserves the resumed generation's checkpoint.

The frozen full affected suite passes **35/35** in **24.70 seconds** total /
24.14 seconds tests, without skips or retries. Plain runner types pass and
independent review is clear at test hash
`be8beacc62d3ff937cbffabab2c52668cc007adbb523b9d3be561e41bda6ff75`.
Production and the staged binary remain unchanged. Together with the preceding
route setup correction, the next push changes only two test files and their
qualification notes; the full PR is **400 files**. Both original CI failures
remain recorded. Fresh exact-head CI and review must pass before normal merge;
no approval bypass, self-approval, or live deployment occurs.
