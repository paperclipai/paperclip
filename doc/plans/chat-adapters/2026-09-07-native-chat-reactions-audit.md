# Live native chat reaction audit — 2026-09-07

## Environment and journey

Isolated Board `http://127.0.0.1:3103`, company Chat Adapter E2E, native Maya
E2E (`paperclip_runner` → `codex` → `gpt-5.6-luna`). The running backend was
`639bf1a20`; the updated UI was served through the development middleware.
These tests do not start model turns and do not qualify model quota recovery.

Using the signed-in in-app browser, added then removed only our thumbs-up
reaction on existing admitted human test messages in Slack's private
`pc-chat-live-0905b` thread and Discord's Clawd test thread. Inspected provider
state, connector Activity, and durable delivery metadata. No credentials,
message bodies, or model reasoning were copied into this evidence.

## First-cycle result

| Provider | Event  | Browser action UTC | Received → processed UTC    | Delivery ID                            |
| -------- | ------ | ------------------ | --------------------------- | -------------------------------------- |
| Slack    | Add    | 18:27:38.318       | 18:27:39.413 → 18:27:39.415 | `7d36d051-02e2-49b1-b53a-518bfc432403` |
| Slack    | Remove | 18:28:12.516       | 18:28:13.527 → 18:28:13.529 | `e0595765-cb21-4aee-b699-6a13108409df` |
| Discord  | Add    | 18:27:43.071       | 18:27:43.593 → 18:27:43.594 | `d39b9424-8270-437a-91b8-1a39a4447437` |
| Discord  | Remove | 18:28:18.539       | 18:28:18.818 → 18:28:18.821 | `015aceb0-c6b3-459f-a39a-81bb6902d97c` |

All four were processed, bound to the existing conversation, and had no error.
From **18:27:28.160** through **18:29:52.686 UTC**, counts remained Maya runs
**86**, company tasks **17**, internal comments **216**, and publications
**200**. Reactions were not interpreted as a message, answer, or authority.
The test reactions were removed; the bot's existing eyes reactions were not
changed.

## Activity refresh defect and fix

The initial live visit could show the earlier addition even after the removal
was durably processed. Chat detail queries inherited the global 30-second
fresh cache and had no periodic refresh; callbacks do not necessarily emit a
Board activity invalidation. The deterministic Slack browser regression failed
before the fix: a new fixture event never appeared within eight seconds while
Activity remained mounted.

Commit `2a554ce22` refreshes mounted Activity and Conversations queries and
their endpoint health every five seconds, with background polling disabled.
Freshness is zero on those operational queries so reopening a view also checks
current state. No new setting, visual token, or provider request was added.

The five-provider deterministic browser suite passed **5/5**, including
conversation-state, new-activity, and endpoint pause/resume changes without
reload or tab navigation. UI contracts passed **26/26**; UI TypeScript and token
gates passed. Those provider responses are mocked, separate from the live
evidence here. An intervening test run failed on an incorrect capitalized
`Waiting` selector; the actual existing badge text is `waiting`.

Live Slack retest used a fresh Board Activity view (tab 55) and the same test
message. Added thumbs-up at **18:33:54.321 UTC**; delivery
`88ab7e27-6ef9-4cb8-9f9b-400a81842026` was received at **18:33:55.201** and
processed at **18:33:55.204**. Without navigating or reloading that Activity
view, the new row and callback-health timestamp were visible at **18:34:07.073**.
Removed the reaction at **18:34:07.139**; delivery
`39b4632e-ee2a-4874-94d8-b5fa7d33d643` was received at **18:34:07.888** and
processed at **18:34:07.890**. The removal was also visible without
navigation at **18:34:31.803**, and both rows were visually inspected after
scrolling. These observation times establish automatic updates, not a measured
five-second end-to-end latency guarantee or a comprehensive transition audit.

## Repeated Discord cycle defect

Repeating the same Discord thumbs-up at **18:31:01.614** and removing it at
**18:31:19.087** produced no additional delivery rows. A later add at
**18:32:59.051** also produced none. This is distinct from the UI cache defect:
the database itself still held only the original add/remove pair. All added
test reactions were subsequently removed.

The provider event ID hashes the raw reaction payload. Discord's repeated
payloads had the same fingerprint, so event-kind plus payload distinguished
addition from removal but not a later occurrence of either. Qualification of
repeated Discord reaction cycles is failed at this checkpoint. The follow-up
must retain stable provider dispatch identity so actual duplicate delivery is
still deduplicated while distinct add/remove cycles remain auditable. No
history row was fabricated or replayed to claim a pass.

The follow-up adapter revision `paperclip-discord-v5` preserves the Gateway
session fingerprint, shard, event type, and sequence with the exact raw packet.
Only a one-way session fingerprint is carried, never the resumable session ID.
A packet-scoped WeakMap and a guarded, synchronous packet-handler wrapper keep
identity intact when discord.js buffers startup events. Suppressed SDK events
cannot leave a stale identity for the next event. Resumed duplicate dispatches
keep their identity; a new READY session receives a different fingerprint.
The wrapper is restored during shutdown and missing pinned hooks fail closed.

After synchronizing the installed package with the tracked patch, its complete
reverse dry-run passed and focused adapter/runtime tests passed **110/110**,
including buffered processing, suppressed callbacks, replay, session replacement,
and hook restoration. An initial reverse check differed only in the formatting
of the existing `ensureRootThread` helper; no semantic change to that helper was
needed. Live repeated-cycle qualification still requires the restart below.

## Telegram prior-generation reaction defect

In the same signed-in browser, added thumbs-up to the native file-reading reply
at **18:39:26.594 UTC** and removed it at **18:40:13.685**. Telegram showed the
reaction, but Paperclip recorded neither event. That provider message
`417200359:43` belongs to completed DM generation **5**, conversation
`3f13f43b-b9a7-44d9-9b8c-846ce77b0305`.

As a control, reacted to the newer native image-reading reply at
**18:40:25.370**. Its message `417200359:45` belongs to active generation **6**,
conversation `2b080821-103d-478e-b421-462014db7b30`. Delivery
`ef99baa0-19f9-43e2-bd17-ec3fc3426a5f` was received at **18:40:25.557** and
processed at **18:40:25.559**, with no error. Removed this test reaction at
**18:40:49.340**; delivery `31f43dcc-2d99-4f13-b6ba-f9dbced3dcf5` was received
at **18:40:49.533** and processed at **18:40:49.535**. No message was sent and
no bot acknowledgement was changed.

The reaction handler chose the newest conversation before checking the exact
message link, so an older generation's message was silently dropped. The new
regression failed before the fix with zero rows instead of four. The fix
resolves the conversation through its exact, company/endpoint/thread-scoped
message link before choosing a generation. Existing current reach, principal
authorization, runtime fencing, and conversation-state checks still apply.
The first focused PostgreSQL reaction run passed **9/9**; this is local
supporting evidence, pending live retest on the restarted backend.

## Follow-up integration checkpoint

The full PostgreSQL chat integration suite passed **266/266** on fresh migrated
database `chat_adapters_test_20260907_latency_13`, including distinct Discord
cycles, exact replay suppression, new-session identity, old Telegram DM
generation ownership, wrong-thread rejection, and revoked DM reach. Server
TypeScript and `git diff --check` passed. The preceding full run passed 265
cases and failed only because the new test used an unsupported `toHaveSize`
assertion; it was corrected to inspect the Set's size before this clean run.

The lockfile was not changed. The only newly fetched upstream commit,
`392ab26b1`, changes that file alone and was not applied under the explicit
instruction to leave it untouched.

## Final live retest on the reaction fix

Commit `dde176bbc` was pushed and the isolated server restarted after verifying
zero active runs. Snapshot 10 started at **19:18:20.078 UTC**, with loaded server
version `2026.831.0+396.git.dde176bbc`; startup recovery reached ready and the
Discord Gateway connected. Existing recovery-blocked history was not edited.

The same signed-in browser repeated two thumbs-up add/remove cycles on each
original test message. Every event below was processed once with a null error.

| Provider | Event    | Browser action UTC | Received → processed UTC    | Delivery ID                            |
| -------- | -------- | ------------------ | --------------------------- | -------------------------------------- |
| Discord  | Add 1    | 19:18:51.109       | 19:18:51.537 → 19:18:51.539 | `324d147a-6ace-44fe-9952-529a02bfaced` |
| Discord  | Remove 1 | 19:18:56.075       | 19:18:56.336 → 19:18:56.338 | `d98047bd-9efb-48b4-98b5-ed79f2aea964` |
| Discord  | Add 2    | 19:19:10.424       | 19:19:10.661 → 19:19:10.663 | `71185c1a-bf33-4b75-87d9-9ba530c417e1` |
| Discord  | Remove 2 | 19:19:15.631       | 19:19:15.826 → 19:19:15.829 | `8e45ba6c-94f7-40cb-b4f3-d62a681fcfc7` |
| Telegram | Add 1    | 19:19:31.957       | 19:19:33.065 → 19:19:33.067 | `5e1a4207-cbb0-49ff-87c7-c400f2cde12c` |
| Telegram | Remove 1 | 19:19:52.642       | 19:19:52.854 → 19:19:52.856 | `e3494e32-9841-4f6e-894b-d1d65ac26eb0` |
| Telegram | Add 2    | 19:20:15.526       | 19:20:15.711 → 19:20:15.714 | `e41b4e64-750d-4ae0-a59d-66f37edba765` |
| Telegram | Remove 2 | 19:20:33.120       | 19:20:33.386 → 19:20:33.387 | `267118ca-5d62-4c57-8856-eeaf55f6400b` |

Discord's second pair appeared in its already-open Activity view by
**19:19:21.917**, without reload/navigation. Telegram's first pair appeared
after navigating from the catalog into Activity; no automatic-refresh claim is
made for that first pair. With that view kept open, its second addition was
visible at **19:20:28.587** and removal at **19:20:40.938**. Both providers'
latest rows were visually inspected. All four Telegram receipts belong to
completed generation 5, not the newer active generation 6.

Between **19:18:41.974** and **19:20:57.941 UTC**, counts stayed **86 Maya runs,
17 tasks, 216 comments, 200 publications**. All test thumbs-up reactions were
removed; existing bot reactions stayed intact. Slack, GitHub, Discord, and
Telegram endpoints remained active. These specific functional and Activity
freshness retests pass and supersede the failed reaction baselines above.
Replay/startup-buffer behavior has deterministic coverage, not an injected
live Gateway outage qualification.

The Maya agent was rechecked as `paperclip_runner` → `codex` → `gpt-5.6-luna`.
The current Codex usage tool still reports the general weekly limit exhausted;
no reset, billing change, or model-starting prompt was attempted in this batch.

The broader provider release gate remains open, including live native model
stress/recovery and Teams tenant/admin qualification.
