# Speko voice connection: implementation and E2E runbook

Date: 2026-09-11; updated 2026-09-12. Status: native browser milestone proven;
telephone and full E01–E16 qualification outstanding. See the
[native qualification report](2026-10-09-speko-pr-qualification.md).
Branch: `codex/speko-chat-connection`.
Base: `d10cbde81523a13344fc18a1f70a76edac8a93fc` (clean current master).

## October 9 live-call push

Telephone replies now use `POST /v1/calls/{id}/messages` with `mode: "respond"`.
Keep the call open after submitting work and verify automatic output without
`get_updates` polling or a result-ready hint. Check the durable action receipt
and task reply separately from confirmed spoken playback. A 409 ends delivery;
uncertain requests must not be automatically resent. Browser result hints are
unchanged. See the [live-call push qualification](2026-10-09-speko-pr-qualification.md)
for the real-provider text-input proof, timings, reproduction and remaining
PSTN/interruption qualification.

## October task-parity qualification

Updated 2026-10-07: September's browser proof is historical. The current task-parity
implementation still requires live audio requalification; see the
[October qualification report](2026-10-09-speko-pr-qualification.md).

Run deterministic integration without a Speko account, microphone or public tunnel:

```sh
npx --yes pnpm@9.15.4 --filter @paperclipai/ui build
npx --yes pnpm@9.15.4 exec tsc -p tests/speko-native/tsconfig.json
npx --yes pnpm@9.15.4 exec playwright test --config tests/speko-native/playwright.config.ts
npx --yes pnpm@9.15.4 exec playwright test --config tests/speko-native/playwright-auth.config.ts
```

The first suite uses loopback ports 3480/3481 and a fresh local-trusted instance.
It covers delayed work, deduplication, route navigation, repeat, reload cleanup,
explicit new conversations, end/rejoin, results completed after hangup, and typed
questions answered through canonical task interactions. The fixture supervisor
retains the database across app restarts; external fixture state survives separately.
Only deterministic stub mode accepts the local restart signal. The test verifies
that an open call survives an orderly app restart, its repeated answer callback
uses the original receipt, and explicit Repeat retrieves the saved response
without creating sessions, comments or runs. The
second uses 3482/3483, real Better Auth signup and invitation APIs, and separate
operator/member/outsider/anonymous contexts. It checks two-company isolation,
private tasks, caller ownership and mid-call membership revocation. Only Speko
transport/media and execution are stubbed. No Paperclip API response is mocked.

Each suite shuts down its own server/database. Its generated HTML report stays
under `tests/speko-native/playwright-report/` or `playwright-report-auth/`.
The integration report includes synthetic durable records and a screenshot;
authentication traces are off so session cookies/passwords are not captured.
Do not count these fixture runs as live audio or full E01–E16 acceptance.

## Native browser acceptance commands

Use pnpm 9.15.4 to honor this checkout's dependency patches. Build the static UI
before starting the temporary server:

```sh
npx --yes pnpm@9.15.4 --filter @paperclipai/ui build
SPEKO_NATIVE_PORT=3449 SPEKO_NATIVE_CALLBACK_ORIGIN=https://your-test-origin.example \
  server/node_modules/.bin/tsx tests/speko-native/server.ts
```

The launcher creates a fresh OS temporary home and embedded PostgreSQL database,
removes inherited database/worktree configuration, and binds the app to loopback.
The parent owns the database; the child watches app code for restart tests. Expose
only `/api/voice-webhooks` through the explicitly configured HTTPS origin. Preserve
other services on any shared proxy. Do not run builds or edit server imports
during a live call. The static UI avoids Vite reloads interrupting media tests.

In the temporary UI, create an acceptance company and existing agent. The harness
substitutes only the `process` execution adapter with a 61-second fixture. Other
adapters, including the catalog template's `claude_local`, remain real. Install
the optional receptionist template through the team catalog when testing that path; Apps setup selects an existing agent. Give it an
isolated working directory with an `ACCEPTANCE.txt` file containing the synthetic
word `marigold`; do not point acceptance work at private project files.

Create a dedicated hosted Speko persona per endpoint. Its signed tools are managed
by the actual setup UI. Save a private fixture at
`~/.paperclip/speko-proof/native-fixture.json` (existing agent) or
`native-template-fixture.json` (template), mode 0600:

```json
{
  "companyId": "temporary-company-uuid",
  "companyPrefix": "SPE",
  "agentId": "selected-agent-uuid",
  "agentName": "Existing Paperclip Agent",
  "providerAgentId": "agent_dedicated_persona",
  "endpointId": "optional-resumable-endpoint-uuid"
}
```

Omit `endpointId` for new setup. The live harness fills the real masked setup form
using `SPEKO_MCP_API_KEY` from `~/.secrets` and persists only the endpoint ID in the
fixture. Do not record Playwright traces around credential entry.

Prepare synthetic input using `say` and `ffmpeg`, saving mono 48 kHz signed 16-bit
little-endian PCM files under `.paperclip-local/speko-proof-audio/`:

- `start.pcm`: “Start the test.”
- `followup.pcm`: “Add a follow-up.”
- `template-start.pcm`: “Read ACCEPTANCE dot T X T in your working directory and tell me the verification word.”
- `template-delayed-start.pcm`: “Run python three voice underscore acceptance underscore benchmark dot py in your working directory. It computes for sixty five seconds. Wait for the command to complete, then tell me the verification word from its output.”
- `template-delayed-followup.pcm`: “Add another instruction to that task. Include the phrase silver lantern in the final answer.”
- `template-followup.pcm`: “Please include the verification word in your answer.”
- `template-resume.pcm`: “Please tell me the verification word from earlier.”

```sh
node tests/speko-native/live-browser.mjs
SPEKO_NATIVE_SCENARIO=template node tests/speko-native/live-browser.mjs
SPEKO_NATIVE_SCENARIO=template-delayed SPEKO_NATIVE_EXPECTED_WORD=cobalt \
  SPEKO_NATIVE_EVIDENCE_PATH=/your/temporary/home/evidence.json \
  node tests/speko-native/live-browser.mjs
SPEKO_NATIVE_SCENARIO=template SPEKO_NATIVE_RESUME_ISSUE_ID=existing-task-uuid \
  node tests/speko-native/live-browser.mjs
```

For the delayed real-agent case, copy `tests/speko-native/fixtures/acceptance-benchmark.py` to `voice_acceptance_benchmark.py` in the isolated agent workspace. It performs a 65-second SHA-256 computation on one CPU core, then reads `ACCEPTANCE.txt`; it has no network access. Change the isolated file to the expected word before the call and allow at least 180 seconds in the selected agent runtime. The harness requires two accepted session tool receipts plus an agent-authored task comment containing the distinct follow-up phrase. Confirm the benchmark completed its computation and independently check the received audio; a transcribed follow-up alone does not prove delivery.

The script uses the real UI, server, database, queues and provider. It replaces
only microphone input, records received audio privately, and asserts live
transcript, task binding, mute state, terminal session state and stopped tracks.
Independently transcribe or listen to the received audio before declaring spoken
success. Confirm the exact provider call is ended. A matching word elsewhere in
the task page is not proof. `SPEKO_NATIVE_IDLE_PROBE=1` deliberately disables the
browser notification feed for provider capability experiments and is never a
normal integration pass.

Inspect `instance.json`, `evidence.json` and `execution.jsonl` in the temporary
home for durable session/delivery/publication/task evidence. Each browser run
writes a private source manifest, report, screenshots and received audio under
`~/.paperclip/speko-proof/native-browser-*`. The checked-in reports contain only
synthetic results and numeric references. On cleanup, end active provider calls,
stop only this launcher, and remove only this test's proxy path.

Targeted backend verification:

```sh
npx --yes pnpm@9.15.4 exec vitest run \
  server/src/__tests__/voice-session-store.integration.test.ts \
  server/src/__tests__/speko-protocol.test.ts \
  server/src/__tests__/speko-provider.test.ts \
  packages/db/src/speko-voice-migration.test.ts \
  ui/src/lib/voice-session-controller.test.ts
```

This harness is a live-provider qualification tool, not the complete deterministic
two-company E01–E16 browser suite described below.

## Product contract and gate

Build a native experimental Apps voice connection beside Slack/Discord. Speko
owns hosted audio, conversational acknowledgment, and telephony; the selected
Paperclip agent keeps its runtime, tools, task context, and work. Support browser
voice, inbound telephone, and authenticated “Call my phone.” Recommend the
optional **Speko Company Phone Agent** catalog template, while permitting any
existing agent. Do not automatically install the template in every company.

Before production changes, prove a hosted live conversation can wait for work
lasting at least 60 seconds, handle an interruption and additional instruction,
then automatically speak the eventual result. Tool requests have a four-second
ceiling; use quick submission and cursor retrieval with bounded waits. Browser
context injection is not a working alternative in the documented client. If the
gate fails, record the missing capability and founder questions. Do not replace
this product with after-call processing or a self-hosted voice stack.

Sources checked 2026-09-11:

- [Hosted tool calling, timeout and signing](https://docs.speko.ai/guides/tool-calling)
- [Browser data-channel limitations](https://docs.speko.ai/client/data-channel)
- [Browser lifecycle](https://docs.speko.ai/client/voice-conversation)
- [Hosted session credentials and duration limits](https://docs.speko.ai/api-reference/sessions)
- [Telephony and number requirements](https://docs.speko.ai/guides/phone-agents)
- [Lifecycle webhook delivery behavior](https://docs.speko.ai/guides/webhooks)
- [Original catalog PR #11418](https://github.com/paperclipai/paperclip/pull/11418)

PR #11418 describes the general-purpose Speko MCP catalog connection; it is
research input, not the live voice runtime. Keep general MCP tools separate.

## Implementation after gate success

1. Add explicit voice runtime/transport to the shared app/channel contracts and
   validators, database constraints, server lifecycle and UI API clients. Keep
   `enableChatConnectors` as the discovery/setup gate.
2. Reuse company endpoints, identities, task bindings, durable deliveries,
   external publications and activity logging. Vault API/signing secrets. Each
   endpoint binds one Speko persona and one Paperclip agent; preserve historical
   assignments when configuration changes.
3. Persist session company, endpoint, provider ID, caller authority, task,
   generation, lifecycle, expiry and reply cursor. Authenticated APIs create,
   inspect, approve/deny private inbound sessions and end calls. Signed callbacks
   verify raw body, time, session identity and idempotency before side effects.
4. Task entry resumes authorized work; agent entry creates one task. Follow-ups
   use existing steering/queue behavior. Playback interruption, work cancellation
   and call ending are separate transitions. Expose only permitted answers,
   questions and safe progress. Distinguish result delivery from spoken evidence.
5. Setup: credentials → select/create agent → voice → number → test. Offer
   existing Speko inventory, and guide purchase/import through Speko. Present
   actionable verification, credits, HTTPS and device errors. Add task voice
   controls, transcript, incoming-call approval, history and connection management.
6. Package the recommended agent in the existing template catalog: greeting,
   intake, clarification, delegation and concise follow-up. Creation follows
   normal company permissions and is idempotent.

Browser authority inherits the signed-in user's current access; only short-lived
media credentials enter the browser. Inbound caller ID grants no private access.
Private calls require authenticated approval of the specific live call. Guest
intake is explicitly enabled and cannot browse private tasks or approve governed
actions. Recheck current authorization throughout a session, including after a
company switch, revocation, pause or removal.

Callbacks require reachable HTTPS; local instances need a configured tunnel or
reverse proxy. No private relay is included. Retain transcripts/task history,
explain provider recording behavior and do not download recordings by default.
Set session-duration limits separately from join-token TTL and display Speko
charges separately from Paperclip agent costs. Exclude SMS, WhatsApp, campaigns,
autonomous outbound calls and general telephony administration.

## A. Deterministic UI and integrated browser qualification

Extend the existing chat UI suite for fixtures. Add a separate integration suite
with a real Paperclip server, isolated database, permissions, queues and external
publication path. Stub **only** Speko's transport and the execution provider.
Use temporary instances, two companies, operator/member/guest contexts, the
template agent and an existing agent. Do not reuse the existing UI suite's
mocked Paperclip responses as evidence that the backend works.

Every row must assert visible UI, resulting task state and durable session and
delivery records. Wait on observable transitions and receipts, not fixed sleeps.

| ID | Journey | Required evidence |
| --- | --- | --- |
| E01 | Connect through Apps | Secret masked/no browser durable key; draft persists on reload; activation requires verification |
| E02 | Recommended or existing agent | Correct assignment; creation permission; failed/retried creation never duplicates agents |
| E03 | Browser voice from task | Authorized task/session binding; short token expiry; provider key never reaches browser or trace |
| E04 | Agent entry and later resume | Exactly one task on initial admission; authorized later call resumes context without reassignment |
| E05 | Work lasts 60+ seconds | Prompt acknowledgment; safe progress; correct automatic final answer; one task and accepted request |
| E06 | Interrupt and follow up | Playback stops; ordered follow-ups reach same task; work continues unless explicitly cancelled |
| E07 | Cancel versus hang up | Independent work/call lifecycles; history and running work survive hangup |
| E08 | Private inbound | No private disclosure before approval; approve/deny/expiry; spoofed caller ID confers no authority |
| E09 | Company guest intake | Restricted intake succeeds; private task lookup and governed actions fail |
| E10 | Call my phone | Authenticated caller/task; duplicate click does not redial; ambiguous provider result reconciles first |
| E11 | Questions and approvals | Permitted question answers steer work; governed approvals retain existing checks |
| E12 | Provider/network failure | Timeouts, rate limits, credential expiry, disconnect and reload yield actionable recoverable state |
| E13 | Restart/retry | Duplicate and out-of-order callbacks plus process restart never duplicate tasks/comments or replay stale speech |
| E14 | Permissions/lifecycle | Revocation, pause, reconnect, removal and company switch enforce current access mid-call |
| E15 | History/reports | Transcript/task references agree; repeated report updates one record; no recording download |
| E16 | Media/responsiveness | Denied/missing mic, mute, navigation, unmount and end clean up media; usable narrow layout |

## B. Protocol, security and persistence

Test valid/invalid signatures, exact raw-body tampering, stale/future timestamps,
replay, secret rotation overlap, cross-company/endpoint/session substitutions,
stale generations, closed sessions, cursor bounds and replay of already spoken
publications. Verify scoped admission and current authority again at delivery.
Probe event redaction for keys, raw agent logs, tool outputs, private comments and
unapproved answers. Assert delivery and playback are separate durable facts.

Simulate concurrent delivery, uncertain outbound acceptance, reordered reports,
missing lifecycle callbacks and restart at each external-side-effect boundary.
Verify additive migrations against both an empty database and an upgraded copy;
check constraints and backfill defaults for existing Slack/Discord connections.

## C. Real-provider acceptance

Use a dedicated Speko workspace, durable reachable HTTPS callback origin and
designated phone numbers. Record exact tested commit and configuration. Complete
setup with both agent choices, then test real browser, inbound and outbound calls.
Repeat delayed work with interruption and follow-up on both browser and phone.
Demonstrate private-call approval and guest intake, hangup/reconnect/resume,
credential rotation, callback outage/recovery and revocation. Include desktop,
mobile and Safari microphone/playback behavior.

Listen to output: intelligibility, silence, turn-taking, duplicate speech,
interruption and answer accuracy. Record speech-end→acknowledgment (target ≤2s),
result-available→audio (≤5s), and interrupt→playback-stop (≤500ms) under healthy
conditions. Report actual measurements, clock sources and execution time
separately. Capture test audio only with participant consent. Keep keys/private
transcripts out of generic traces and artifacts.

Statuses are **passed**, **failed**, **blocked**, or **not run**. Fixture success
does not substitute for real audio/telephone proof. Keep Speko experimental until
all three transports and delayed-result behavior pass.

## UI/Storybook and completion gates

Use the companion component-to-story inventory. All stories render production
components with deterministic fixtures and no real microphone/provider traffic.
Add changed shared behavior, keyboard/focus/validation/control/recovery tests,
accessibility checks and design-guide examples. Run token gates and Storybook
build. Include stories in the existing Playwright visual suite, review intentional
baselines on its supported environment, and never blanket-update unrelated ones.

Before PR-ready handoff run targeted checks, integrated Speko E2E, existing
chat-provider regression, `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`,
Storybook interactions/accessibility and visual tests. Report anything blocked.
Use the repository PR template if submitting a PR.

Qualification records must include UTC date, tested SHA/dirty patch, case IDs,
fixture/live environment, roles/company boundaries, observed timings, sanitized
session/task references, screenshot/report paths, failures and reproduction steps.
The current first-gate report is `2026-09-11-speko-voice-qualification.md`.


## 2026-10-07 authorized tunnel and playback retest

The user explicitly authorized the Cloudflare test tunnel. The approved proxy
forwards only POST `/api/voice-webhooks/:publicId/tools`; board/UI routes and
all other APIs return 404. Provider signatures, session capabilities and current
company/task authority remain enforced. Quick-tunnel URLs are temporary;
verify the origin before each run and retain no promise of permanent availability.

Audit received audio independently of the UI transcript. A passing live-browser
script is provisional until the whole result and follow-up have been heard or
independently transcribed from the actual received stream. An SDK `listening`
event can occur between words; a final transcript is not confirmed playback.
The second October retest passed its script but failed this audio review.

Retrieval now batches up to eight approved publications in cursor order, stopping
at an interaction boundary. This avoids a separate typed turn for each already
queued result. Streaming publications, current-access checks, repeat semantics,
idempotent receipts and unknown playback status remain unchanged. It does not
prove that a later asynchronous publication can never interrupt ongoing speech.
Retest that case and the three timing targets before telephone expansion.

The optional template was installed through the actual UI and its real Claude
runtime completed a 65-second Python workload, accepted the spoken follow-up,
and spoke the verification word plus the requested phrase. This establishes one
real runtime journey; it does not qualify template retry/idempotency, governed
approvals, human audio, Safari or telephone journeys.


## Agent-requested callback testing — updated 2026-10-07

1. Configure and verify a dedicated Speko persona on the selected agent's native
   Apps connection. Keep experimental chat connectors enabled and expose only
   signed voice callbacks through explicitly configured reachable HTTPS.
2. In connection **Settings → Call my phone**, save your own E.164 number and
   enable **Allow this agent to call me about my tasks**. Speko charges and
   recording settings apply; Paperclip does not download recordings.
3. Create an ordinary task assigned to that agent with yourself as responsible
   person, requesting one call using the assigned `call_my_phone` connection
   tool. The tool accepts no destination parameter and returns no media token.
   Confirm actual runtime discovery, a durable gateway invocation, one task and
   one `outbound_phone` session before counting placement as passed.
4. Answer the real telephone call. Screening/mailbox, first agent audio and SIP
   answered/bridged do not prove a human task conversation. Record them separately.
   For an answered call, submit work lasting at least 60 seconds, interrupt and
   add an instruction. Assert signed callbacks, durable ordered comments,
   selected runtime execution and correct approved audio without repeated caller
   prompting. Measure acknowledgment/result/interruption with the stated targets.
5. Hang up and verify provider/Paperclip reconciliation. Rejoin only on an
   explicitly authorized fresh attempt; uncertain creation must not blindly
   redial. Revoking personal opt-in/current access must stop private delivery.
6. Retain sanitized task/session references and status. Do not include personal
   numbers, credentials or private call transcripts in general traces. Review
   consent before any audio capture; never automatically download recordings.

The integrated `tests/speko-native/integrated.spec.ts` E10 extension uses real
Paperclip routes, database, task queue, run identity and runtime MCP. Only external
Speko and execution are fixtures. It saves callback settings through the UI,
reloads, asks the execution fixture to discover/call its actual assigned tool,
rejects a simultaneous second request, verifies one outgoing durable/provider
session and output redaction, ends the call without cancelling work and disables
opt-in. It does not qualify real telephone audio or call-screening behavior.

## October 7 completion-audit procedure

Current private PSTN setup uses per-live-call approval in Paperclip; caller ID alone grants no access. A signed call creates one short-lived admission without a task. Approve its exact six-digit code while selecting an authorized task, or deny it; expiry and hangup close admission. Discard speech submitted before approval. Guest mode must be explicitly enabled and writes bounded low-trust intake without waking an agent, exposing private work or approving governed actions. Promote only the exact live call through authenticated Paperclip approval.

Phone polling is enabled in signed phone pre-call hints, never by mutating shared persona defaults on each dial. Verify that a subsequent browser call never reads idle polling instructions aloud. Provider final-report timestamps may be camelCase and durations fractional; the safe projection excludes application control hints, keys, system turns and recording URLs. Check both new and existing history entries.

Final component inventory: 141 stories and 564 theme/viewport interaction/accessibility checks. Run the existing visual suite with an external snapshot directory; review only Speko changes and publish Linux-approved baselines through the existing workflow. Local macOS candidate agreement is not CI baseline approval.

See the dated qualification report for actual provider session/task references, received-media timings, passed/failed/blocked labels and remaining E01–E16 gaps. No fixture result qualifies human phone conversation or Safari media. Do not redial an uncertain call or substitute an internal Speko agent-to-agent route for PSTN proof.

For E02, repeat a catalog import with `collisionStrategy: skip` after its first commit and assert one installed phone agent, the same ID/configuration, and unchanged historical task assignment. The Speko production wizard defaults to that policy; other catalog imports retain their existing defaults. Distinguish this committed-import recovery from concurrent general catalog transaction idempotency.

If Speko returns HTTP 402 / `INSUFFICIENT_CREDITS`, mark the affected actual-provider case blocked, preserve the rejection without keys, and stop retries. Funding is an operator action; fixture runs and UI transcripts cannot replace the blocked independent audio check.

October 7 deterministic E12: exhaust the external transport fixture's credits for one persona, start through the actual Apps UI, and require the funding message. Assert no media connection, redacted provider identity, one durable failed attempt and exactly one provider create after idempotency replay. End/cleanup may retire the local failed call without creating another provider session. Run `tests/speko-native/integrated.spec.ts` for the complete real-server journey plus E02 and E12; live HTTP 402 remains blocked until the workspace is funded.


## October 8 call Activity regression

In the real-server E15 journey, first verify that connection Settings has no Your calls region. Open the connection's Activity tab and refresh its combined feed. Find the completed incoming-call entry, expand it, and verify the saved transcript and task link against durable session/report records. Repeated provider reports must still update one record and preserve the original task assignment. Configure guest intake from Settings, then return to Activity and assert both authorized and guest call entries. Private denied/expired/missed admissions disclose no connected task.

The production feed uses existing caller-authorized history APIs and merges recent calls with connection events by creation time. Recent calls appear once on the first Activity page; older connection-event pages keep their existing cursor. History remains available on paused connections when current caller/task access permits it. History failures retain connection events and expose Retry calls.

Run the real-server native suite and the 44 page/call-entry Storybook stories. Fixtures must never request a real microphone or contact Speko. Include both themes, 390/1200 viewports, keyboard disclosure and end-call focus restoration. The October 8 run passed all three integrated journeys and 176 story interaction/accessibility checks, plus UI typecheck/build, Storybook build and token gates. Review and compare only intentional snapshots against the existing baseline directory; the complete affected visual subset has 88 theme comparisons. Whole-feature live telephone/audio and canonical repository checks remain governed by the October qualification report.


## October 8 simplified Settings regression

After activating a Speko connection, open Settings and verify the bundled provider logo and Open Speko link. There must be no browser Conversation selector, Start voice button, Your calls region or callback introduction. Save/reload outgoing phone settings and incoming number settings normally. Setup's optional voice test remains available, and assigned tasks retain their task voice launcher. E10 checks the simplified Settings surface before saving callback preferences; E08/E09 still exercise signed incoming approval and restricted guest intake.

The current private inbound flow requires the caller to also use signed-in Paperclip: enter the code spoken during this live call, select a permitted task and approve. The pending private admission expires after two minutes. This is a browser-mediated pairing flow, not sign-in by phone. Guest intake can record a message as quarantined work for review; it does not run the agent or expose private task information. This UI change preserves those authorization semantics.

The Conversations empty state now directs users to Talk to agent on an assigned task. The Settings cleanup passed three real-server integrated journeys, 180 page/form/task-launcher interaction/accessibility checks plus four long-header checks, UI typecheck/build and token gates. Test evidence uses `/tmp/speko-settings-cleanup-*.log`; microphone/provider calls were not made for this change. Visual review covers the changed header and shorter forms in both themes; broader live-provider and repository-wide acceptance remains separate.

Final Settings verification: four additional interaction/accessibility checks passed for the corrected Conversations empty state. Reviewed 70 changed candidates and both new long-header theme snapshots; after correcting the stale empty-state instruction, all 90 final affected visual comparisons passed against the reviewed local baseline directory (`/tmp/speko-settings-cleanup-visual-final.log`). No unrelated snapshots were updated. The final UI/Storybook builds passed; the dev server was reloaded and the saved connection Settings verified in the embedded browser. Linux baseline publication and whole-feature qualification remain separate.

## October 8: incoming conversation on its own low-trust task

New calls admitted with **Let callers start new low-trust tasks without sign-in** now create a task before greeting, bind every spoken request/follow-up to that task, and retrieve its approved replies through the normal chat queue. The legacy `guestIntake` wire name remains; it no longer means message-only intake for new calls. Defaults stay private; existing authenticated task approval remains available. Caller ID is never a user identity.

For E09, configure an active sandbox on the incoming line (or use the selected agent's sandbox), enable isolated workspaces, and supply an approved agent-scoped model connection. This affects only new low-trust incoming tasks; it does not change the agent/instance default environment or historical task assignments. Missing isolation fails closed. Browser/outgoing task conversations keep their existing authenticated authority.

1. Call the configured company number from a telephone. Verify the greeting asks what to work on without a Paperclip code or sign-in. Confirm exactly one new task/session/admission.
2. Submit work, interrupt playback, and add a follow-up. Verify both requests and approved agent replies remain on that task, in order. A playback interruption does not cancel work.
3. Ask for another private task or a governed approval. Verify the low-trust boundary refuses it. Do not expand privileges or copy a caller-ID identity to make the test pass.
4. End the call. The task and already accepted work survive hangup; new call requests fail. When Speko's report arrives, verify the task's **Phone conversation transcript** document contains both caller and voice-agent turns, interruptions included, with quarantined source trust. Repeated reports must not create duplicate documents or revisions. No recording is downloaded.
5. Repeat with connection pause/removal, credential rotation, altered task boundary/assignment or sandbox selection. Current authority must be checked before queue processing and reply retrieval.

Daytona cold sandboxes bootstrap the adapter's default Claude ACP server without changing engines; custom ACP commands remain setup failures if unavailable. A changed callback origin can update only tools/webhooks whose exact old definition and provider ID have completed receipts for this endpoint. Foreign integrations and uncertain creation outcomes remain blocked. For a quick Cloudflare test tunnel, expose only signed `POST /api/voice-webhooks/{publicId}/tools` and `/events`; the board API must return 404. Reconnect through the normal connection API after changing the explicit HTTPS origin.

The [dated incoming qualification](2026-10-09-speko-pr-qualification.md) distinguishes signed callback tests, actual Daytona/Claude execution and real telephone audio. Its passing backend proof does not qualify human incoming audio, Safari or the 60-second telephone acceptance case. The old insufficient-credit blocker is historical: check current Speko usage before making acceptance calls.


## October 8: live-call context and dual-model handoff

The voice model owns fast acknowledgments, clarification, and turn taking. The task agent owns work and substantive results. New public phone tasks capture the normal Speko communication guidance plus their low-trust boundary. Accepted, active voice sessions add a server-derived live-call instruction to every execution turn, including resumed sessions. Ending or expiring the session removes that instruction on the next turn; accepted work continues normally.

`get_updates` retains its durable publication cursor and adds a neutral `work` projection: idle, queued, running, pending, awaiting_reply, waiting_for_input, blocked, failed, or cancelled. These are queue/execution observations, not task completion claims or spoken playback receipts. Raw run output and provider errors are excluded. Tool retries retain the original response; use a new tool-call ID for a new status observation.

Run the disk scenario against the existing 10 GiB Daytona test task with locally generated `disk-request.pcm` and `disk-followup.pcm` (48 kHz mono signed 16-bit PCM):

```sh
SPEKO_NATIVE_PORT=3469 \
SPEKO_NATIVE_SCENARIO=disk \
SPEKO_NATIVE_RESUME_ISSUE_ID=<authorized-test-task> \
SPEKO_NATIVE_FIXTURE_PATH=<private-fixture-json> \
SPEKO_NATIVE_AUDIO_DIR=<synthetic-audio-directory> \
node tests/speko-native/live-browser.mjs
```

The fixture specifies companyId, companyPrefix, agentId, agentName, endpointId, and providerAgentId. Use an authorized disposable task already pinned to the real Daytona environment. The current disk scenario expects the test environment's 10 GiB root disk and approximately 9.7 GiB free; it is not a generic capacity test for arbitrary agents. For delayed delivery, the first recording requests a 65-second wait before inspecting only the root filesystem; the follow-up requests a one-sentence answer. Verify actual execution duration, two accepted submit_request receipts, same-task comments, urgent context in all task-markdown variants, approved publications, media cleanup, and synthetic output audio independently. A browser cascade result does not qualify telephone speech-to-speech or PSTN transport.
