# Speko delayed voice feasibility probe

This isolated harness implements the first gate in the approved Speko connection
plan. It does **not** implement a Paperclip connection, touch Paperclip tasks,
or qualify browser/phone acceptance on its own. A hosted Speko agent must keep
retrieving a result for at least 60 seconds, accept an interruption and follow-up,
then speak the result without another request from the caller.

The harness deliberately has no UI, microphone capture, database, company
credentials, private task data, or recording download. Production integration is
gated on real-provider evidence; its tests must not be reused as claims about
Paperclip permissions, persistence, or actual spoken playback.

## Local protocol checks

```sh
cd tests/speko-voice-proof
npm install --ignore-scripts --no-package-lock
npm test
```

The delay test uses an injected clock, so it checks the 60-second withholding
contract without a minute-long unit test. It cannot prove that Speko continues
polling, that its media runtime supports interruptions, or that audio plays.

## Live setup

1. Set `SPEKO_API_KEY` or `SPEKO_MCP_API_KEY` in the shell environment from a
   private secret store. Never paste it into a command argument, fixture, trace,
   screenshot, or issue. The API key stays in the provisioning process only.
2. Run `npm run init`. State defaults to
   `~/.paperclip/speko-proof/state.json` (mode 0600, parent directory 0700).
   `SPEKO_PROOF_STATE` can select a separate private path. Initialization refuses
   to overwrite an existing run. The signing secret is generated locally.
3. Run `npm run serve`; it listens only on `127.0.0.1:3198` (override with
   `SPEKO_PROOF_PORT`). It stops after 15 minutes. Only `/health` and the signed
   `POST /speko-proof/tool` exist. Do not expose a Paperclip development server.
4. Configure an explicitly scoped HTTPS reverse proxy to this receiver. Verify
   `POST /speko-proof/tool` with an unsigned JSON body returns 401. Set
   `SPEKO_PROOF_PUBLIC_ORIGIN` to that HTTPS origin, with no path or credentials.
5. Run `npm run provision`. It creates a dedicated synthetic test persona and
   two tools. It does not provision phone numbers or place calls. Partial
   creation is recorded. If an API result is uncertain, it refuses blind retries;
   reconcile the dedicated agent/tools in Speko before clearing the pending
   marker. Use a fresh state/agent when changing the callback origin or secret.
6. Open the named **Paperclip delayed voice proof** agent in Speko. Its Browser
   test runs the hosted deployed agent. Use only synthetic test speech.

State contains secrets. Do not copy it into reports. The final `evidence.json`
contains event kinds, timings, counts, cursors, and the generated synthetic
verification phrase (never caller text). The probe
pins its first valid signed provider session and rejects other sessions; restart
the receiver between conversations. This first-delivery binding is acceptable
only for an isolated synthetic probe, **not** the production authority model.

## Conversation and evidence

1. Start the call. Note browser/device, provider session ID, UTC time, agent/model
   configuration, and whether the provider UI says it retains the call.
2. Say “Start the test.” Measure speech-end to acknowledgment.
3. At roughly 15 seconds, interrupt with “Add a follow-up.” Confirm it is accepted
   into the existing synthetic job. Do not repeatedly ask for the answer.
4. Stay on at least 75 seconds. Expect an automatically spoken, unpredictable
   four-digit verification number and follow-up count 1 after the 60-second
   delay. A fabricated number before 60 seconds is a failure.
5. Compare heard output to tool retrieval evidence and any provider transcript.
   A `result_returned_to_tool` event is **not** a spoken-playback acknowledgment.
   Record what was actually heard and how timings were measured.
6. End the call and stop the receiver with SIGINT. Preserve sanitized evidence.
   Remove only the reverse-proxy route added for this probe; never reset an
   existing proxy configuration. Do not download provider recordings by default.

Repeat for phone using a designated test number and configured Speko number.
An untested transport remains blocked. If autonomous polling stops or the worker
cannot accept follow-ups during polling, record a failed feasibility gate and
prepare the questions in the qualification report before expanding the feature.

The full implementation and acceptance matrix is in
`doc/plans/2026-09-11-speko-voice-e2e-runbook.md`.

## Automated hosted-worker reproduction

`npm run live` starts a **paid real Speko cascade session**, with a Node LiveKit
media client and this signed receiver. It does not run in the normal test suite,
request a microphone, dial a telephone, create Paperclip work, or implement a
replacement voice worker. Do not run `serve` at the same time: `live` owns the
receiver port. Configure the reachable HTTPS callback and dedicated test agent
first, using the same private state as `provision`.

With a Speko credential already in the environment:

```sh
NODE_ENV=production SPEKO_PROOF_LLM_PROVIDER=openai:gpt-4.1 npm run live
```

The default input is native `lk.chat` text, which isolates hosted tool execution
from speech recognition. It still receives real generated speech. Set
`SPEKO_PROOF_INPUT=audio`, `SPEKO_PROOF_START_AUDIO`, and
`SPEKO_PROOF_FOLLOWUP_AUDIO` to use synthetic speech instead. Both audio files
must be raw signed little-endian 16-bit PCM, mono, 48 kHz, saying “Start the test”
and “Add a follow-up.” This input also exercises hosted STT. It is not browser
SDK, microphone, Safari, phone, or audible interruption qualification.

Optional settings:

- `SPEKO_PROOF_OUTPUT`: a **new** private directory; reuse is rejected before
  session creation. Defaults to a timestamped directory beside private state.
- `SPEKO_PROOF_PROMPT_FILE`: a per-session prompt override. The stricter tested
  prompt is `continuous-polling.txt`; it has not passed the delayed-result gate.
- `SPEKO_PROOF_STATE` / `SPEKO_PROOF_PORT`: same meaning as the CLI.
- `SPEKO_PROOF_NOTIFY_READY=1` with
  `SPEKO_PROOF_PROMPT_FILE=application-notification.txt`: send one explicitly
  labeled application notification on native `lk.chat` after the synthetic
  60-second deadline. It carries no answer or authority; the agent still fetches
  the result through the signed tool. This is a typed **user-role** transport,
  not Speko's unsupported contextual-update channel. Product UI must preserve
  application provenance rather than attribute it to something the caller said.
- `SPEKO_PROOF_NOTIFY_WEB_JOIN=1`: experimental separate, data-only participant
  obtained through SDK 0.5.3's `calls.webJoin`. Requires notifications enabled.
  No audio is published because web-join audio invokes agent takeover. A joined
  transport does not establish that the worker will consume its text.
- `SPEKO_PROOF_INTERRUPT_ACK=1`: inject the follow-up while acknowledgment
  audio is arriving, rather than after a fixed 15 seconds. Private audio-burst
  timings permit inspection of when playback stopped; this does not establish
  physical-device playback latency.

Each run journals creation intent and the resulting session ID without media
credentials. It sends two instructions and detects excess submissions, waits for
the delayed result, then asks Speko to end the session. A 180-second provider cap
bounds abandoned runs; creation is never automatically retried. SIGINT/SIGTERM
request cleanup. Verify provider termination if a process is forcibly killed.

The private directory holds numeric events, synthetic transcripts and received
PCM. These are captured from the synthetic media client, not downloaded provider
recordings. Do not use human or private input with this client. Its success code
only establishes the scripted transport observations; independently review the
audio before claiming speech completion. Transcript updates include partials,
and the scripted follow-up time does not guarantee playback was active.

Publish a restricted report without transcripts, audio, keys or caller data:

```sh
node summarize-run.mjs /absolute/private/run/report.json reports/new-run.json
```

See the [current qualification report](../../doc/plans/2026-10-09-speko-pr-qualification.md)
and [E2E runbook](../../doc/plans/2026-09-11-speko-voice-e2e-runbook.md) for inspectable
results and remaining acceptance gaps. Historical private call reports are not
included in this checkout.
