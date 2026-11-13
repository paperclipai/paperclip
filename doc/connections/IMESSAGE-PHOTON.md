# iMessage Photon

**Status: experimental. Live-provider qualification is pending.**

This channel connects one agent to Photon Cloud. Pro shared allocation supports
DMs; dedicated lines also support explicitly enabled groups. A linked
Paperclip person can send a DM, exchange files, answer questions, and respond to
ordinary confirmations. Each conversation remains attached to a Paperclip task.
The connection is a channel with `chat_sdk` transport, not an MCP tool connection.

## Prerequisites and setup

1. Enable the existing experimental chat-connectors setting. Open **Apps →
   iMessage Photon**, or the agent's **Channels** panel.
2. In the [Photon dashboard](https://app.photon.codes/), obtain a project ID
   and project secret. Paperclip checks the project's actual allocation. Pro
   shared allocation is eligible for DMs only. Enroll each sender in the Photon
   project's **Users** page and find their assigned number in **Get started**.
   This enrollment does not authorize them in Paperclip. See Photon's
   [line model](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing).
3. Choose one invokable agent. Enter the project ID and secret, inspect the
   allocation. Connect shared DMs, or select a dedicated line. A single eligible dedicated line is selected
   automatically. A number already reserved by any non-archived endpoint in
   this instance cannot be selected, including a paused or revoked endpoint.
   Shared projects have the same exclusive reservation by project ID. Their
   assigned numbers may differ by sender and are not represented as owned numbers.
4. Send a fresh message to the displayed dedicated number, or to the sender's
   assigned number from Photon for shared DMs. Link the discovered Messages
   identity through Paperclip's identity confirmation flow. Send another fresh
   message from that linked person. Setup completes only after a task is created
   and an actual agent response is published successfully.
5. With a dedicated line, to use a group, add the number in Apple Messages and send a message to discover
   it. Enable the group in Paperclip's Settings page, then send a fresh request.
   Discovery does not enable a group or replay the discovery message as work.

The server needs outbound HTTPS to `spectrum.photon.codes` and TLS gRPC to the
selected `<line-id>.imsg.photon.codes:443` endpoint, or
`imessage.spectrum.photon.codes:443` for a shared project. No public webhook, Mac Messages
permissions, Spectrum application runtime, or additional agent loop is needed.

Project secrets are write-only and vaulted. Inspection is restricted to connection
managers and returns project identity, line IDs, phone numbers, and eligibility;
it does not return credentials or line tokens. Agents never receive the project
secret. The server holds short-lived line tokens in memory, renews before expiry,
and checks that the project, line, and number have not changed. Every operation
uses that selected line. Replacing credentials must preserve the same identity;
connect a different identity with a new endpoint.

Setup and inspection distinguish credential/allocation errors (HTTP 422), quota
limits (429), temporary provider outages (503), and invalid upstream responses
(502). An outage does not mean valid credentials need replacement. A failed
reconnect leaves the existing credential binding intact.

## Conversation and access rules

DMs are enabled by default. Dedicated groups start disabled; shared channels
reject groups at admission, publication, and settings changes. Unlinked people cannot
start work unless an operator explicitly enables that setting. Identity links
use the provider-authenticated sender address and service. A phone number and an
Apple-account email are separate identities; names and group membership do not
grant Paperclip authority. Revoked links and inactive/viewer memberships cannot
answer interactions. Guest work retains the shared channel restrictions.

Enabling a group makes the agent's responses visible to everyone in that group.
It does not authorize every participant to start work. Every authorized message
in an enabled group can start or continue work without a mention. Group names
and participants are displayed in Settings. If the agent's number leaves the
group, that destination becomes unavailable and publication is blocked.

DMs and groups are linear conversations. An authorized request starts a task;
follow-ups append to the current generation through the ordered delivery queue.
Completing a task ends the current turn. The next message reopens that same task,
including after a server restart. Incoming messages appear live on the open task
as user bubbles labeled “Sent from iMessage.” `/status` shows the current task,
`/close` closes the conversation,
and `/new` closes the current generation so the next request starts a new task.
Quoted message GUIDs and multipart references are retained as task context.
Quotes do not create separate tasks. A quoted control from an older generation
cannot close a newer task. Outgoing echoes, reactions, read receipts, typing,
and nonhuman system messages do not start agent work.

Messages, tasks, assets, publications, identities, and state remain company-scoped.
Number and shared-project reservations are deliberately instance-wide. Task assignment, budget
limits, pauses, approvals, and native/legacy execution continue through the
existing Paperclip services.

## Questions and confirmations

Ordinary `ask_user_questions` uses native polls for closed single-choice questions
with 2–10 options. Prompts include a text alternative. Correlation uses the returned
poll message GUID and option IDs; duplicate titles and option labels are not lookup
keys. Responses from other devices, added options, missing actors, expired prompts,
and later vote changes cannot undo a completed decision.

Reply to the exact prompt, or use `/answer <reference>[.<question>] <value>`.
Numbered choices, comma-separated multiple choices, custom text, and optional
`skip` answers are supported. Questions appear sequentially. Multiple-question
sets save a separate draft for each person and require `/submit <reference>`.
Paperclip's canonical validators check required answers and selection/numerical
rules before resolution. Different people cannot contribute to the same draft.

Ordinary `request_confirmation` offers explicit Accept/Reject. A required rejection
reason is collected through a correlated text response. Target revision, audience,
current identity, task generation, endpoint status, and permissions are rechecked
at submission. Responses resolve through the canonical interaction service and
its durable continuation delivery. A terminal acknowledgement is published once.
Arbitrary “yes” messages and tapbacks never constitute approval.

Credential proposals, connection authorization, governed tool actions, and review
kinds that need the full review surface remain in Paperclip. The channel supplies
a task link and instructions. No individual-iMessage web permalinks are fabricated.

## Photos and files

Text, JPEG/PNG/WebP/GIF, allowed documents, audio, and video use Paperclip's existing
attachment policy and byte limits. Provider upload allowances do not raise those
limits. Attachments are source-bound to the selected line, chat, message, and
attachment GUID before downloading. The server verifies that ownership again on
recovery, bounds metadata, streamed bytes, time, and decoded image dimensions,
and reports rejected/unavailable files in the task. A not-yet-ready attachment
retries before waking the agent, without creating another comment.

HEIC/HEIF are included in the default attachment policy; operator overrides still
win. The original remains downloadable and a JPEG derivative supplies browser
preview and image input to the agent. The derivative records its source attachment
and hashes. Conversion runs in a separate process with input/output/pixel limits
and a deadline. `heif2jpeg@0.1.6` publishes macOS, Windows, and Linux glibc packages
for x64/arm64; it does not publish Linux musl binaries. A missing or failed converter
retains the original and reports preview unavailability. Only macOS arm64 has been
executed locally for this change; other platform binaries still require qualification.

Live Photo stills and policy-allowed companion videos are retained as attachments
on the same message. Native Live Photo reconstruction is not implemented. Outbound
files require the existing task/company/agent/originating-run authorization. The
server uploads actual bytes; it never sends private storage URLs to Photon.

## Publication and recovery

Only output classified for external publication is sent. Internal commentary,
reasoning, raw tool output, and credentials stay internal. Final responses use
normal bubbles and the channel refreshes typing while work runs. Text is split at
paragraph boundaries with a 4,000-Unicode-code-point target and preserved order.
Source-message reply references are used when the originating run identifies one.
Every text part, attachment message, poll, and explicitly staged correction has a
stable `clientMessageId` and immutable payload. Upload completion is recorded before
the attachment message is sent. Native edits have a bounded window; ordinary final
responses and acknowledgements are separate messages, never token-by-token edits.

A timeout after transmission is **delivery unknown**. Inspect the activity record
and known Photon receipts, then use Paperclip's operator resolution/retry controls.
Do not retry by creating another publication or changing its key. Explicit retries
reuse the original key and payload. Similar text is not evidence of delivery. An
ambiguous upload without a recorded receipt also needs operator review.

One elected receiver holds the endpoint lease. Live streams notify a serial
catch-up reader. The reader advances its checkpoint only after preceding events
are durably admitted or classified, including irrelevant events. It deduplicates
provider sequence and message identity independently and reconstructs chats,
attachments, and poll mappings from persisted state after restart.

Dedicated recovery requires adjacent sequence numbers. The shared gateway's
project-filtered feed has increasing, non-adjacent sequences. Shared recovery
commits its checkpoint only after the complete replay barrier and every preceding
admission succeed. Interrupted or out-of-order replay retains the previous cursor.
Shared channels do not subscribe to the unsupported group stream.

The pinned SDK's public catch-up iterator discards sequence-only/unknown-variant
frames. Paperclip's small authenticated gRPC recovery transport retains their
sequence while delegating known event decoding to the SDK. This prevents false
history gaps without silently skipping a frame. A missing/reset cursor or an
actual history gap stops in Attention. Initial historical messages establish a
checkpoint but do not create old tasks automatically.

Pause stops execution and external publication while retaining already accepted
pending work. Resume establishes a new intake cutoff, so messages deliberately
suppressed during pause do not become work. Outage recovery catches up eligible
missed messages. Disconnect archives the endpoint, stops streams, invalidates
interaction authority, and removes owned secret bindings. It does not delete the
Photon project, number, subscription, or Messages history. Hiding experimental
UI alone does not disconnect existing channels.

## Troubleshooting

| State or symptom | Action |
| --- | --- |
| Invalid project credentials | Replace the vaulted secret for the same project/number and reconnect. |
| Shared allocation | Connect shared DMs, enroll the sender in Photon, and use their assigned number. Groups require a dedicated line. |
| No eligible dedicated lines | Review the project's line allocation in Photon, then inspect again. |
| Number already owned | Use its existing endpoint or remove that endpoint before reconnecting the number. Pause retains the reservation. |
| Number changes/disappears | Review the Photon allocation. Restore the original identity or create a new endpoint. |
| No task from a group message | Groups are disabled for shared channels. For a dedicated channel, enable the discovered group, link the sender, and send a fresh request. |
| Setup remains Verifying | Complete the linked fresh-message → task → actual agent reply loop; a credential check is insufficient. |
| Quota/network interruption | Review Activity. Transient errors retry with bounded backoff; quotas are distinct from authentication failures. |
| Attachment preparing | Let the durable delivery retry; do not resend the message to force another task. |
| Preview unavailable | Download the original and verify converter support/policy on this deployment platform. |
| Delivery unknown | Reconcile the exact provider receipt or explicitly retry the same immutable publication. |
| Missing/reset cursor or history gap | Review the affected period before operator recovery. The service does not silently skip it. |
| Old poll no longer works | Open the task's current interaction. Completed/expired polls cannot reverse a decision. |

Diagnostics use existing local activity and run records. This change adds no
first-party Telemetry events. Persisted receipts/checkpoints are required for
recovery; do not manually delete provider state to resolve an outage.

## Qualification and source versions

See [implementation and acceptance plan](../plans/2026-09-11-imessage-photon.md)
and [verification record](IMESSAGE-PHOTON-VERIFICATION.md). Deterministic fixtures
and synthetic gRPC are not live-provider proof. A dedicated test line, known
participants, real iPhone HEIC, and native polls are required before claiming the
full live acceptance loop.

Pinned dependencies: `@photon-ai/advanced-imessage@2.1.0`, `@grpc/grpc-js@1.14.4`,
`nice-grpc@2.1.17`, `nice-grpc-common@2.0.4`, `heif2jpeg@0.1.6`.

First-party references inspected on 2026-09-11:
[Cloud authentication](https://github.com/photon-hq/spectrum-ts/blob/main/packages/core/src/utils/cloud.ts),
[SDK](https://github.com/photon-hq/advanced-imessage-ts),
[events](https://photon.codes/docs/advanced-kits/imessage/events),
[polls](https://photon.codes/docs/advanced-kits/imessage/polls),
[attachments](https://photon.codes/docs/advanced-kits/imessage/attachments),
[idempotency](https://photon.codes/docs/advanced-kits/imessage/error-handling), and
[HEIF converter](https://photon.codes/docs/utilities/heif2jpeg).

### Shared-gateway duplicate receipts

The Pro shared gateway has been observed returning gRPC `ALREADY_EXISTS` as SDK
`internalError`, without a receipt, when an identical `clientMessageId` is repeated.
Paperclip retains delivery-unknown state if no stored receipt exists. Inspect the
original conversation and use the existing operator resolution action. Do not
create another idempotency key or infer delivery from matching text. Photon’s
[documented idempotency behavior](https://photon.codes/docs/advanced-kits/imessage/error-handling)
says repeated writes return the original result; the live shared-gateway result
is recorded separately in the verification report.
