# Slack live qualification result — 2026-09-05

> **Status: broad current-branch live evidence plus historical core-smoke evidence, not full release qualification.** The current runs cover channel roots, DMs, FIFO follow-ups, reactions, edits, pause/resume, the registered Slack command, a command-created thread, native inbound and outbound files, disabled-resource enforcement and recovery, an interleaved command/status/final race, and a complete native question-to-continuation round trip. Slack is still missing the complete governance, failure-injection, reinstall, and cleanup matrix.

## 2026-09-06 merged-build ingress and FIFO retest

The live-tested merge commit is `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`. A first pair of direct messages sent against that build exposed the expected weakness of the temporary test ingress rather than an adapter failure: Cloudflare had retired the account-less quick-tunnel hostname, so Slack accepted the messages while Paperclip received no callbacks. After a new tunnel was created and Slack's Events API and Interactivity URLs were both re-verified, Slack's enabled delayed-event recovery delivered those two missed events. Paperclip processed each once and returned exact `SLACK-MERGED-A-0906` and `SLACK-MERGED-B-0906` responses in order. Later implementation revision `83018c688` changes only Discord log redaction plus documentation and setup copy relative to that tested Slack runtime.

A second pair sent 300 ms apart on the healthy ingress returned exact `SLACK-MERGED-C-0906` and `SLACK-MERGED-D-0906` responses in FIFO order. Because Slack DMs are a linear conversation, both messages intentionally used one active Paperclip task and serialized two agent turns. Each turn first published `Maya is working…` and then edited that same Slack message in place to the exact final. Across the four deliveries, the durable ledger contains four processed inbound rows and eight published rows (four working/final pairs), all with `attempts=1`, no error, and no pending, retry, failed, or ambiguous publication. This is positive recovery and queue evidence; the expired hostname confirms that a stable HTTPS origin is mandatory for production.

## 2026-09-06 answer-handoff and channel-root retest

The later release-candidate working tree retained endpoint `2782e758-8e1e-47e3-a5aa-6a8359b1c23c` and repaired all three Slack callback surfaces after the development tunnel changed. Slack accepted the current Events API, Interactivity, and slash-command URLs, and delayed-event recovery remained enabled. This is useful current-provider evidence, but the temporary Cloudflare hostname is not a production ingress qualification; a stable deployment must keep a durable HTTPS origin across restarts.

The first DM answer retest (`CHA-82`) exposed a real handoff delay: an external answer stopped only native-mode source runs, so the legacy source continued until cancellation fallback and the continuation did not begin for about 23.5 seconds. The fix now cancels both native and legacy question-source runs and uses a compare-and-set terminal write so cancellation cannot overwrite a genuinely completed run.

The post-fix DM retest (`CHA-84`) showed the source run cancelled about 61 ms after the answer publication was created and the dedicated continuation queued about 93 ms after cancellation. Slack rendered exact `SLACK-HANDOFF8-Violet` about 20.8 seconds after the click; all five publications completed in one attempt, the task finished, and no generic or late duplicate followed. That elapsed time includes agent execution and publication, while the measured control-plane handoff itself remained sub-100 ms.

A separate enabled-channel root (`CHA-83`) produced one native Slack thread and one Paperclip task, then returned exact `SLACK-CHANNEL-FINAL-0906` in that thread with no cross-publication. The provider reply appeared about three seconds after the root. A live `+1` add and remove each produced one processed reaction delivery in roughly 3–4 ms of server handling, with `attempts=1` and no error.

## 2026-09-06 current-build interactive and reaction closure

An earlier pre-merge live retest ran the uncommitted release-candidate working tree based on `77ad5383e` after restarting the server with the same instance home and its then-current public webhook URL:

- Paperclip updated and Slack verified all three ingress surfaces: Events API, Interactivity, and `/maya-fdhjew`. A fresh direct message returned exact provider-visible response `SLACK-CURRENT-BUILD-0906`, and the registered `/maya-fdhjew status` command returned the current task without creating a task solely for the control.
- A live question whose optional `allowOther` field was omitted initially degraded to a link-only card. The shared schema defines that field as optional, so omission must mean a closed question unless it is explicitly `true`. After the fix, the same natural request rendered native **Red** and **Blue** controls. Selecting **Red** changed the card to **Answered: Red**, scheduled one continuation, and produced exact provider-visible `SLACK-RETEST-Red`; the generic completion did not race or follow it.
- A top-level DM reaction initially reached the Slack webhook but was discarded because the SDK supplied `slack:<DM>:<message-ts>` while Paperclip's linear DM binding is `slack:<DM>:`. The first fallback still chose the newest task generation and missed reactions on older linked messages. The final implementation resolves the exact owning generation through the durable message link, keeps the endpoint/reach/principal checks, and permits completed DM generations only for this audit-only event. A final live `+1` add and remove each produced one processed delivery; neither created a comment, task, run, wake, approval, or governed action.
- Heartbeat's resolved final-assistant presentation is now externalized only when the run has an exact causal chat binding. Ordinary internal runs keep `internal_agent_write`; chat-origin and native-interaction continuation runs receive the narrow `allow_chat_run_presentation` reason. This closes the earlier continuation gap without exposing reasoning, tool traces, or logs.
- When a chat-origin run creates a provider-visible native question or confirmation, that original prompt now consumes the run's external presentation slot. The run's meta-summary remains an internal Paperclip comment, the generic completion is suppressed, and only the distinct post-answer continuation may publish its final response. The rule keys on the exact source run and survives a fast-answer race.

## 2026-09-06 native file and action follow-up

Earlier provider checks on pre-merge revision `77ad5383e3a8badf7b1b0933a7e9c66469186d55` refined the evidence boundary:

- The disabled-resource negative and recovery path passed live. While the Slack resource was disabled in Paperclip, the provider message did not create a task or produce bot work. Restoring the permitted resource allowed a later request through without replacing the endpoint or losing its existing resource identity.
- The older `CHA-68` attempt is **not** outbound-file proof. Its explicit publication delivered text, but the separately created attachment was not bound to that comment's publication lineage, so Slack never received the intended native file. This exposed an implementation defect in the Paperclip comment/attachment handoff rather than a Slack transport rejection.
- After the explicit attachment binding fix, fresh task `CHA-71` passed the live outbound-file check. Paperclip bound the attachment to the explicit comment before publication; Slack then received the text followed by the native file, with each durable publication completing in one attempt.
- On `CHA-70`, selecting **Blue** on the native question card was accepted exactly once, the unselected sibling action expired, and Paperclip scheduled exactly one continuation. That older attempt exposed the missing continuation lineage. The current-build **Red** retest documented above supersedes it: the accepted-state update and exact continuation response both completed without a generic completion.

## 2026-09-06 final live extension

The active endpoint `2782e758-8e1e-47e3-a5aa-6a8359b1c23c` added the following current-provider evidence:

- Slack accepted the manifest with reaction and lifecycle subscriptions. At `08:36:54Z`, one-attempt `group_left` delivery for `C0BUT55N9RV` marked the resource unavailable. At `08:37:33Z`, one-attempt `member_joined_channel` restored it, hydrated the label to `#pc-chat-live-0905b`, and preserved the operator's enabled choice. The self-removal subscription and label-preservation defects found here were fixed; this was not an account or permission gate.
- Edits on `CHA-29` and `CHA-47` each produced one `message_updated` delivery and one internal system edit comment. Deleting the source message for `CHA-64` at `08:39:16Z` produced one one-attempt delivery and one internal deletion comment; deleted content was not republished.
- Repeated natural and slash-command DM generations worked. The latest natural DM, `CHA-67`, processed once at `08:42Z`, showed the receipt reaction, and returned exact final `slack-dm-live-final-0906` in about two seconds. An idle `status` returned `No task active` without creating a task.
- Inbound attachment proof includes the earlier 67-byte `text/plain` file on `CHA-52` and the current 41-byte file on `CHA-64`; both were persisted and read successfully, and the latter returned exact marker `paperclip-live-telegram-media-proof-0906`. The separate outbound proof remains `CHA-71`, where the explicitly bound Paperclip attachment reached Slack as a native file.
- `CHA-42` received two replies 144 ms apart. The second run began only after the first succeeded, and each run retained its own coalesced placeholder/final message. Four reaction-add and four reaction-remove callbacks also processed once each.
- Forty-five provider duplicate callbacks folded into 38 existing delivery rows without duplicate tasks or comments. All 97 earlier publications were `published`; all 44 runs after the isolation configuration succeeded. For the post-`05:00Z` sample, 24 processed inbound events averaged `0.702s` (`p50 0.781s`, `p95 1.146s`, maximum `1.646s`) and 25 publications averaged `0.488s` (`p50 0.315s`, `p95 1.103s`, maximum `1.127s`), all published.

The outbound-file and tested rich-interaction gaps are now closed. Broader modal/form behavior still needs live coverage. Earlier low-trust failures were governance isolation, and two old synthetic-command receipt warnings are preserved pre-fix evidence; neither is a current Slack account gate.

## Current source and evidence boundary

- Pre-merge source revision for the historical breadth checks below: `77ad5383e3a8badf7b1b0933a7e9c66469186d55`
- Most recently live-rerun Slack source revision: `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`
- Later implementation revision (Discord log redaction and documentation/setup-copy follow-up only): `83018c688`
- The synthetic-command receipt, native thread binding, ordered task-control, coherent progress/status/final lane, explicit attachment binding, native-action lifecycle, final-presentation lineage, and top-level DM reaction-generation fixes are present in the final merge revision. The historical breadth checks exercised the pre-merge revision above; the merged-build section records the final live rerun.
- Live checkpoint: 2026-09-05 through 2026-09-06
- Current live endpoint: `2782e758-8e1e-47e3-a5aa-6a8359b1c23c`
- Paperclip issue: `d7f718da-a8da-468e-99a7-79dc337d5cbc`

No bot token, signing secret, webhook URL, cookie, password, or one-time identity-link URL is recorded here.

The sections below deliberately distinguish provider-visible proof from durable database evidence and local-only regression coverage. A successful local test is not reported as a live Slack result.

## Latest live breadth run

The latest live run added the following provider and durable-ledger evidence:

1. A channel root requesting the exact response `slack-prod-root-0906` produced one admitted mention delivery, one Paperclip task, and the exact provider-visible final response.
2. A normal DM requesting `slack-dm-prod-0906` produced one admitted direct-message delivery and one final response. Editing that source message produced one separate `message_updated` audit delivery and did not wake another agent run.
3. The registered immutable command was exercised in the real D-prefixed Slack DM. A `status` control and a following `new` control each produced one processed delivery with `attempts=1` and no error after the first receipt fix. The durable normalized record explicitly says those synthetic callbacks do not support a receipt reaction; no task was created merely to acknowledge the controls.
4. A command task requesting `slack-slash-task-a74` created exactly one `slash_task_start` action, one Slack starter message/thread, and one Paperclip task (`CHA-50`). Its working and final publications each completed in one attempt and shared the same provider message ID, so Slack showed one in-place final response rather than a progress/final duplicate.
5. A reply in that Slack thread requesting `slack-thread-followup-a74` produced one inbound delivery with `attempts=1` and no error. Because the preceding DM task was already terminal, Paperclip advanced the linear DM binding to its next session generation; that generation produced one working/final pair, again using one provider message ID, and the exact response was visible once.
6. A native file plus “Read the attached file and reply with exactly its Token value” produced one inbound delivery, one stored Paperclip issue attachment, and one final `chat-upload-a74` publication. The final publication completed in one attempt and replaced its working placeholder in place. This proves the tested Slack file-download and attachment-storage path for that file, not every Slack file type or size boundary.
7. On the final revision, `/maya-fdhjew Run sleep 12 then reply exactly slack-status-lane-6f13b` created native Slack thread `CHA-61`. While the run was active, `/maya-fdhjew status` replaced the working reply with the current `in_progress` state. The final then replaced that same reply with `slack-status-lane-6f13b`. Slack showed exactly one bot reply beneath `Starting a task…`, not stale working/status siblings. The working, status, and final publication rows all share provider message ID `1788679967.804189`; each is `published`, `attempts=1`, with no error.

### Synthetic-command receipt defects found during the run

The live command work found two related but separate bugs rather than treating the first patch as sufficient:

1. The first real DM `status` callback was represented internally by a deterministic hash because Slack slash callbacks have no native message to react to. The generic receipt path nevertheless sent that hash to Slack as a message timestamp. Slack returned `message_not_found`, leaving the processed delivery with a receipt-reaction error even though the status response itself continued. The fix persists `acknowledgement.receiptReactionSupported=false`, carries it through deferred reconstruction, and skips the reaction. A later live `status` and `new` both processed once with no error, which is live proof for this control-command branch.
2. The command-task branch had a second synthetic message after posting its real starter message. It still took the generic receipt path, so the otherwise successful `slack-slash-task-a74` delivery recorded the same `message_not_found` receipt error. The follow-up fix marks this branch unsupported too and adds regression coverage that Slack command callbacks never call `addReaction`, while Telegram commands retain their real provider message tuple and still do. The final live `CHA-61` command task and its interleaved status callback both processed in one attempt with no error and `receiptReactionSupported=false`, which is live proof of this second fix.

The earlier diagnostic rows remain preserved as bug evidence. The later clean rows, rather than rewriting history, provide the live regression proof.

### Post-run thread-binding and recovery audit

Reviewing the pinned Slack adapter after the live run exposed a third issue that the earlier fake runtime did not model: a slash command's `Channel` wrapper returns the channel wrapper id after a root post, while Slack's returned message timestamp is the actual native thread root. Treating the wrapper id as the task boundary can make later Paperclip publications appear as new top-level messages instead of replies under `Starting a task…`. The implementation now derives the canonical `slack:<channel>:<message timestamp>` thread id from the confirmed provider message and has a regression whose mock deliberately returns the non-thread channel wrapper id.

The same audit found that DM `status`, `new`, and `close` controls synthesized a base-DM thread id and therefore could not find a task created under the slash starter's native root. Those controls now resolve the most recently active task for that DM and route the synthetic control through its exact native thread binding.

Finally, an ambiguous starter post no longer remains an unactionable Activity row. Paperclip still never replays it automatically. Activity offers an audited **Retry anyway** only when the durable action contains complete reconstruction context, warns that both the starter and Paperclip task can duplicate, and offers **Cancel task start**. The retry revalidates the endpoint, destination, and original principal, serializes against endpoint mutation, and admits at most one concurrent retry. Older incomplete rows are cancel-only. Native thread binding and ordinary command creation were retested live; the deliberately ambiguous starter-recovery branch remains local-only because the provider failure was not injected live.

### Qualification-harness restart incident

The first final-revision command attempt returned Slack's “app did not respond” notice because the restarted local server was accidentally launched against the live database without its existing Paperclip instance home and encryption-key path. Secret resolution failed closed and no task was admitted. Restarting with the original instance home restored credential decryption, after which the same scenario passed. This is not a Slack adapter defect, but it is operational evidence that database restores and process restarts must preserve the Paperclip-generated master key; the database alone is intentionally insufficient.

## Earlier current-run evidence

A signed Slack root message reached the current public tunnel and completed the provider-visible lifecycle: the bot added its receipt reaction, showed a working response, and replaced or completed it with the successful final response in the originating thread.

Earlier unlinked-guest attempts reached Paperclip but failed closed at agent execution with `low_trust_isolation_unavailable`. After identity linking, the current root interaction completed successfully. The `037e57e0d` UX change now presents that containment failure as an actionable blocked-execution explanation instead of leaving the operator with a vague stopped-run state; this is a UX correction, not a relaxation of the low-trust isolation boundary.

The rapid two-message FIFO retest also passed:

1. Slack sent follow-up one and follow-up two in the same thread at `21:06:31.005` and `21:06:31.353` respectively.
2. Paperclip processed each delivery exactly once, with `attempts=1` and no error, at `21:06:32.054` and `21:06:32.286`.
3. All three runs succeeded with exit code 0 and were strictly non-overlapping. In UTC on 2026-09-06, the root ran from `02:05:50` to `02:06:04`, follow-up one from `02:06:32` to `02:06:44`, and follow-up two from `02:06:44.544` to `02:06:58`.
4. Slack displayed the two final replies in one-then-two order.
5. The root and two follow-ups produced six working/final publications total. Every publication completed with `attempts=1` and no error, and each working message was edited in place to its corresponding final response rather than producing an extra progress message.

This is direct evidence for single-thread FIFO serialization, exactly-once delivery processing in this burst, and working-to-final in-place edits. It does not replace the unexecuted Slack capability, governance, failure-injection, and recovery scenarios listed below.

The current public tunnel also passed a reaction round trip after the FIFO run. A user `+1` on follow-up two produced one `reaction_added` delivery for provider message `1788660391.353319`; removing it produced one `reaction_removed` delivery for the same message. Both were processed once with normalized `thumbs_up`/raw `+1` metadata and no redacted error. This proves the manifest's added reaction subscriptions are active on the current setup, not merely present in configuration.

### Latest false-duplicate and pause/resume retest

A subsequent pre-merge live retest produced the following evidence in UTC:

1. A root sent at `04:28:42` completed normally. Its durable delivery recorded one legitimate ignored duplicate caused by Slack exposing the same root through overlapping subscribed event shapes. This expected provider overlap remained deduplicated after removal of the separate false internal-drain duplicate counter.
2. Follow-up one and follow-up two were sent at `04:29:27.713` and `04:29:27.857`. Each processed exactly once with `attempts=1`, no error, and `duplicateCount=0`.
3. Their runs were FIFO and strictly non-overlapping: follow-up one ran from `04:29:28.507` to `04:29:50.777`, then follow-up two ran from `04:29:50.828` to `04:30:03.065`.
4. Each working/final publication pair completed with `attempts=1` and no error. The final publication reused the working publication's provider message ID, so each response was edited in place and no duplicate external reply appeared.
5. After the endpoint was paused at approximately `04:32`, `slack-paused-should-not-run` appeared in Slack but produced no bot reaction, no bot reply, and no Paperclip delivery. After resume, `slack-resume-ok` was accepted once and published one final response.

The later run also exposed a redundant automation follow-up wake inside Paperclip: the active run's own final comment carried `resume: true`, so it queued another wake even though the same run still owned the issue. The wake was deferred rather than run concurrently, and Slack received no duplicate external message, but the queue work was unnecessary. The fix now suppresses this narrow same-owning-run case while retaining explicit resume from a completed prior run.

A post-fix live retest at `04:58:32` sent `slack-no-empty-wake`. Paperclip admitted one message delivery, processed it once (`attempts=1`, no error), published working and final states once each by editing the same Slack provider message, and produced exactly one assignment wake for the incoming message. No automation follow-up wake was inserted by the agent's own final comment. Slack displayed one final `slack-no-empty-wake` reply.

## Pre-merge local regression evidence

- On that pre-merge working tree based on revision `77ad5383e`, the full chat-channel PostgreSQL integration suite passed 183/183 on fresh migrated database `chat_adapters_test_final_20260906_0833`.
- Focused shared tests passed 11/11, focused server tests passed 194/194, and focused UI tests passed 41/41.
- The deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts` passed 4/4, and shared, database, server, and UI typechecks all passed.
- These deterministic checks support the live continuation and reaction fixes but do not replace the remaining provider cases.

## Historical-run scope

- Paperclip release base: `342c01fee`
- Provider: Slack, disposable App and private channel in the Paperclip workspace
- Paperclip endpoint: `c3c20e8d-5dbd-49b7-9d7e-14068c9ded8b`
- External conversation: `slack:C0C0NFGUYKS`
- Paperclip task: `4a6dd0ca-d022-44c6-868d-7246169f3ef4`

No bot token, signing secret, webhook URL, cookie, password, or one-time identity-link URL is recorded here.

## Historical core-smoke result

The Slack bring-your-own-App path passed the following core live round trip on `342c01fee`:

1. The Paperclip manifest created a Slack App with the exact 16 required bot scopes, including reaction read/write support.
2. Slack accepted the Paperclip request URL for Events API delivery and interactivity.
3. Paperclip rejected neither the App identity nor its scopes and advanced the endpoint to live verification.
4. A root channel mention created one provider thread, one Paperclip conversation, and one Paperclip task assigned to the endpoint's immutable agent.
5. An unmentioned reply in the Slack thread stayed in the same Paperclip conversation and task.
6. Paperclip added the processing reaction, published lifecycle messages in the originating thread, and ignored Slack retry duplicates durably.
7. An explicit **Send to channel** board publication produced a Slack bot reply in the same thread and reached `published` state.
8. The setup test completed with endpoint status `active`, the discovered private channel enabled, and all Settings, Access, Conversations, and Activity views present.

The Activity view recorded both inbound deliveries as processed, showed provider retry duplicates ignored, and recorded all outbound messages as published.

## Deviation

The isolated test instance had no sandbox workspace provider. Its automatic low-trust agent heartbeat therefore failed closed with `low_trust_isolation_unavailable`. The transport round trip was completed using the audited, explicit **Send to channel** publication path. This confirmed inbound mapping, subscribed thread replies, outbound provider delivery, deduplication, and setup activation without weakening the low-trust containment invariant.

## Cleanup

- Archived the disposable private Slack channel.
- Removed the Paperclip Slack endpoint, retiring its endpoint-owned secrets.
- Deleted the disposable Slack App, revoking its bot token and signing secret.
- Stopped the temporary public relay and isolated Paperclip process.

## Historical local regression evidence

- Shared, server, and UI typechecks: passed.
- Focused UI/OpenAPI/server tests: passed.
- Chat-channel PostgreSQL integration suite on fresh `chat_adapters_test_016`: 47/47 passed.
- Deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts`: 4/4 passed.
- Token gates and `git diff --check`: passed.

This evidence is useful for regression comparison, but it is incomplete release evidence. Identity linking was sufficient for the exercised runs, but the full permission-revocation and unlinked-participant governance matrix was not executed. Current live evidence now covers disabled-resource enforcement/recovery, one native outbound-file fixture, and a complete native question continuation. Broader modal behavior, file type/size rejection, rate limiting and ambiguous-send recovery, full App uninstall/reinstall, reconnect, and final cleanup assertions remain incomplete. Slack remains unqualified for stable release until the complete release-candidate runbook passes.
