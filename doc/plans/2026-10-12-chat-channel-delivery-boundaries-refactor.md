# Chat channel callback and delivery boundaries, batch four

Base: 4b766b872993045a2e787404f0475503683e5ded. Batch three (#15995, #15996, #15999, #16001, #16002)
is merged. The service starts at 26,461 lines / 1,046,711 bytes.
This batch may create up to ten stacked PRs. Merging the new batch is separate work.

| Order / boundary | Destination | Approx. moved / net lines | Contract and state | Risks and existing verification |
| --- | --- | --- | --- | --- |
| 1. Slack callback verification | `slack/callback-verification.ts` | 250 / 230 | Pure signature/workspace/URL inspection plus signed URL verification; explicit vault lookup, URL getter, scheduling and registration callbacks | Preserve signing-secret-only setup, original request, TLS/proxy evidence and workspace checks. Signed verification and callback health cases before/after. |
| 2. Discord Gateway events | `discord/gateway-events.ts` | 200 / 185 | Runtime fence and lease-owner predicates, endpoint lookup and lifecycle callback; original per-runtime event queue and sequence | Preserve stale-owner fencing, event order, transient guild recovery and terminal revocation. Gateway lifecycle cases before/after. |
| 3. Discord root threads | `discord/root-threads.ts` | 500 / 460 | Credential lease, current principal authority, runtime, message admission and conversation drain callbacks | Preserve uncertain thread creation, restart reconciliation, no duplicate starter and pause/credential serialization. Root-thread public-service cases. |
| 4. Receipt reactions | `receipt-reactions.ts` and Slack error classifier beside Slack messages | 545 / 500 | Durable reaction claim/transport/settlement with runtime and credential fences; no scheduling owner moves | Preserve retries, legacy GitHub receipts, terminal-removal supersession and same-attempt settlement. Receipt recovery cases before/after. |
| 5. Inbound reactions | `reactions.ts` | 800 / 740 | Conversation lookup/locks, reaction admission and deferred replay together; current principal/runtime callbacks | Preserve exact event dedupe, completed generation links, bounded replay age and no task wakeup. Reaction race/restart/authorization cases. |
| 6. Inbound attachments | `inbound-attachments.ts` | 600 / 550 | Existing storage and issue service, retained source authorization and live options; return same attachment results | Preserve size limits, source authority around I/O, omissions and text delivery. Provider attachment/restart/stale-authority cases. |
| 7. Outbound attachments | `outbound-attachments.ts`; provider Markdown wrappers beside provider messages | 245 / 220 | Metadata validation and bounded integrity-checked hydration; existing storage object. Keep public hydration export compatible | Preserve stream cleanup, deadlines, byte/digest checks and retry classification. Hydration and publication attachment cases. |
| 8. Provider effects | `provider-effects.ts` | 950 / 850 | Durable reply claim, authorization, transport and settlement; endpoint/runtime/credential/principal callbacks | Preserve uncertain-delivery quarantine, credential fence and transaction ordering. Native callback, task-control and reply recovery cases. Put Telegram-only authority under `telegram/` if its contract is narrow. |
| 9. Conversation and activity reads | `activity.ts` | 540 / 520 | Endpoint lookup and read-only Teams conflict projection; return existing API models | Preserve company/endpoint joins, mixed-source cursor ties, replay eligibility and read-only GETs. Activity, file receipt projection and conversation-state cases. |
| 10. Setup probes | `setup-probes.ts` | 280 / 250 | Credential lease, current identity/principal authority, provider fetch, endpoint projection and live activation hook | Preserve real-message requirement, generation and linked-user activation. Setup-test, reconnect and authorization cases. |

Each slice must earn its place after reading its complete path and callers.
Reassess before implementation; stop short of ten if the remaining contracts are
not cohesive. Keep provider-specific code in channel folders and common durable
workflows in the shared chat-channels directory.

Receiver lease ownership stays shared: the existing Discord-named owner is also
used by Photon. Shared lifecycle/application admission, queue-drain ownership,
worker scheduling, and the largest action/message handlers remain in the service.
Do not hide their dependencies in a mutable context object. Preserve live option
hooks, runtime-map identity, partial-failure cleanup, and initialization order.

Run relevant existing public-service tests before and after each mechanical move.
Compare moved declarations and remaining statements with normalized syntax, then
run server types, module boundaries and whitespace checks. Finish local verification and a fresh
5/5 review before opening the next draft PR. GitHub runner-selection jobs remained
queued without steps for over 25 minutes in this batch. To continue the authorized
stack, publish drafts in review order while tracking CI as pending; CI remains a
merge gate. Run cumulative repository gates at handoff.
Retain failures and skipped/unrun coverage even when an isolated retry passes.
Use fixture-backed assembled service/database tests; do not claim live provider
execution. Remap LOC/bytes and the remaining orchestration after the batch.

## Slice 1: Slack callback verification

- Service: 26,461 lines / 1,046,711 bytes → 26,201 lines / 1,035,260 bytes.
- Destination: 299 lines / 13,038 bytes. Eight declarations move without body
  changes. Three existing setup types move unchanged into `runtime-types.ts`.
- The verification factory initializes after Slack registration. It receives the
  same registration object, credential resolver, live URL getter and scheduler.
  Signature/workspace/URL helpers remain callable by shared webhook orchestration.
- Nine public-service cases passed before and after on the updated master base.
  Server typecheck, module boundaries, whitespace and normalized syntax parity
  passed. Coverage includes signed URL verification, account notification,
  workspace rejection, callback surfaces, TLS termination and Cloud host evidence.
- Next: Discord Gateway event sequencing and health transitions. Keep shared
  receiver lease ownership and runtime-map lifetime in the service.

## Batch outcome

All ten candidates produced cohesive boundaries. Shared receiver ownership, queue
management and worker scheduling remain in the service. The only intentional
control-wiring change is deferred access to `stageProviderEffect` from identity
link construction; typecheck and integration tests caught the initial early read.

| Slice | Service lines after | Primary module lines | Before/after cases |
| --- | ---: | ---: | ---: |
| 1. Slack signature, workspace and callback url verification | 26,233 | 300 | 9 |
| 2. Discord gateway event sequencing and endpoint health transitions | 26,029 | 253 | 7 |
| 3. Discord root-thread admission, provider creation and durable recovery | 25,527 | 570 | 4 |
| 4. Durable receipt reaction claims, transport, retries and settlement | 24,975 | 586 | 7 |
| 5. Inbound reaction conversation lookup, admission and deferred replay | 24,160 | 891 | 21 |
| 6. Inbound attachment authorization, bounded ingestion, registration and omissions | 23,565 | 674 | 39 |
| 7. Outbound attachment metadata validation and bounded integrity-checked hydration | 23,298 | 294 | 22 |
| 8. Durable provider reply staging, authorization, transport and recovery | 22,331 | 957 | 24 |
| 9. Conversation summaries and paginated activity projections | 21,741 | 616 | 16 |
| 10. Setup message detection and credential-fenced round-trip qualification | 21,460 | 353 | 7 |

After rebasing on master `8e7b5db822`, the service shrank from
**26,493 lines / 1,048,769 bytes** to **21,460 lines /
862,284 bytes** (5,033 fewer lines, about 19%). Normalized syntax comparison
checks all 69 moved declarations/types and every remaining original statement.
Server types, targeted tests, module boundaries and whitespace checks are the
per-slice gates. Cumulative repository gates and remote reviews are recorded in
the PR descriptions as they complete.

Orchestration measurement: the service function has 150 nested functions
(19,399 lines) and 67 state/wiring statements (459 lines), versus 191 functions
(23,829 lines) and 54 statements (425 lines) at the start. Imports take 400 lines.
The remaining large paths are `processMessage` (2,166), `handleAction` (1,074),
`configureWithCredentialLease` (868), `processSelectedPublication` (729),
`handleModalSubmit` (708), `handleWebhook` (685), and lifecycle processing (657).

A future pass should inspect publication admission/transport/settlement as one
workflow, then inbound delivery authorization and drain ownership. Those cuts
need explicit ownership contracts; avoid separating individual checks from their
transactions merely to reduce the remaining line count.

The rebase preserves the merged managed Slack setup flow, including its shared
`isProvisionedSlackSetup` predicate in the extracted callback verification
module. A fresh syntax audit compares all moved declarations and retained
statement ordering with this updated master.
