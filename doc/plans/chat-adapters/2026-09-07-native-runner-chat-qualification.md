# Native Paperclip runner chat qualification — 2026-09-07

## Scope and runtime

The live Maya E2E fixture was switched from legacy ACP/Sol to
`adapterType: paperclip_runner`, Codex provider, model `gpt-5.6-luna`.
The isolated instance has native execution enabled. Persisted run records
confirm `runtimeMode: native`, `driverKind: codex_app_server`, and the explicit
Luna model in the native execution input. This is not an inference from the
agent's display name. No global model defaults were changed.

The native runner uses its per-turn lifecycle. The legacy agent configuration's
reasoning-effort field is not propagated by the current native input contract;
these measurements must not be described as native low-effort measurements.
Terra has not been needed for the text cases below and has not been qualified.

Tests used the existing linked operator identities and existing private test
threads. Guest isolation and permission requirements were not relaxed.

## Why the earlier turns were slow

Earlier legacy runs spent most of their time in extra model/tool round trips,
not in the provider transport or queue. Examples of successful media turns took
150–183 seconds while their actual tool execution totaled under two seconds.
Generic operational instructions also asked agents to repeat checkout, comment,
and status work already owned by the chat harness.

The new narrow external-chat response contract is enabled only after validating
the company, immutable agent, active endpoint/conversation, exact issue, inbound
comment lineage, known provider, and harness checkout. Governed, held, recovery,
truncated, and otherwise ambiguous contexts retain the normal workflow.
Self-contained replies need no redundant control-plane calls. Files and real
work still require the authorized tools and normal safety checks.

## Live native text results

After restarting with the latest-message fix, each provider received
“What is 61 + 8? Reply with only the number.” Telegram's wording additionally
made explicit that this was a new message. All four provider UIs showed `69`.

| Provider | Native run ID                          | Agent runtime | Send to publication acknowledgement |
| -------- | -------------------------------------- | ------------: | ----------------------------------: |
| Discord  | `a37453a9-9a01-42bc-a6c2-73b1a1793761` |      11.169 s |                            13.472 s |
| Telegram | `b950314c-1a62-4046-8db7-2dd31f1fc27a` |      12.288 s |                            14.743 s |
| Slack    | `9001a484-ce26-489f-99f9-26446d979447` |      11.015 s |                            13.554 s |
| GitHub   | `7ba05f32-5cb4-4477-b3a5-1c07d537a8e9` |      11.493 s |                            16.467 s |

Agent runtime is persisted `finishedAt - startedAt`. The final column is the
browser send timestamp to Paperclip's provider publication acknowledgement,
not a measured client-render latency. Run-row queue delays were 8–11 ms.
These are small local qualification samples, not production percentiles or an
SLA. Images, files, investigation, and externally delayed callbacks can take
longer.

### Correctness failure found and fixed

The first native Telegram turn answered an old task-title instruction instead
of the current arithmetic question. Its run was
`63477f30-2f08-4644-9ec8-516ecbde2b89`. The wake comment was correct; the native
structured title and completion objective repeated the old imperative.

Verified external-chat turns now use neutral structured native task fields.
The canonical task title/description remain background context. Completion
contracts target the latest message, and coalesced comments become ordered
criteria. Resumed eligible chat turns use the safe compact context selector.
The succeeding Telegram run above returned the correct current answer.

### Live burst/queue test

Three messages were submitted rapidly in each provider's existing thread:
requests for `ALPHA-0907`, `BETA-0907`, and `GAMMA-0907`. In all four provider
UIs, the first run answered ALPHA and the following run answered BETA and GAMMA
together. The latter run's persisted wake IDs contained both pending messages.
No requested marker was omitted and no duplicate final answer was observed.

| Provider | First run                              | Coalesced follow-up run                |
| -------- | -------------------------------------- | -------------------------------------- |
| Discord  | `948adf45-9264-4060-84fd-66dcdb2ffb5b` | `1e4b610e-a61e-4054-b3b3-adb1c2b6d241` |
| Telegram | `61044c8b-a6ab-4f7a-afa5-41aa3239b00c` | `efb8fee1-15ad-4b83-bd62-aa6a8a7e1895` |
| Slack    | `838b739d-0361-4a01-bc3f-48703b65d426` | `bccb60a2-4f52-4153-b1e9-62354b8dbe27` |
| GitHub   | `abed454d-5e7c-45d1-a4b1-80b152beb160` | `8ddd5631-54f2-4c3b-b3d2-41dbd8002fa9` |

Pending messages wait for the current turn before their run is materialized;
the run-row queue metric alone does not include this intentional wait.

A subsequent ten-message Discord test reached `requestedCount: 10` with eight
inline comments. The first held turn was
`d7f361e3-0631-4ffe-975f-a331b65016ec`; follow-up
`fd08101d-66a7-4a79-b485-bfb3ff2816b7` could not access the scoped reader in its
older resumed provider session and did not produce a complete answer. This is
a failed qualification, not a ten-message success. Discord briefly throttled
the browser's rapid sends; the remaining messages were sent normally and all
ten were durably accepted before the follow-up run.

The final checkpoint fingerprint is versioned by both tool schema and
advertisement policy, including the stable, binding-gated reader. It also
distinguishes local versus remote tool sets, rejects different managed
execution workspaces, and permits projectless continuation only when both
run-local workspace placeholders and repository descriptors match. Native
overflow turns use neutral task framing and explicitly opt into the reader;
legacy adapters retain their existing authenticated API fallback.

The live retry on the new checkpoint contract was blocked by account capacity:
Slack run `6299ba19-d7ea-4182-b7b8-c401d722821e` received an actual Codex
`turn.failed` with `codexErrorInfo: usageLimitExceeded`. It was a 10,402-character
message (the Slack composer would not send the initial 17,122-character draft),
with four values spanning the truncated inline body. The final reader fix is
therefore locally verified but **not live requalified**. A paced Discord retry
also hit the same provider-capacity boundary; its ten-message test was not
completed. Follow-ups on that recovery-owned task were rejected by the staging
ownership check; those recovery-path messages need live follow-up after capacity
returns, without loosening ownership checks.

The newly observed quota failure now has a closed classification from a
committed provider terminal, stops futile automatic retries, and produces a
safe provider-facing capacity explanation. Model prose, tool output, raw
provider error strings, account details, and reset URLs are not used as public
error content. This last change is locally tested; it has not been live tested.

### Post-live failure and attachment-isolation regressions

A database-backed restart test reproduced a further capacity-error bug: after
the provider terminal was committed but the controller stopped before its
callback, replay of that exact event lost the usage-limit classification and
scheduled another attempt. The duplicate-event observer now restores only that
in-memory classification. It does not repeat logging, activity, or publication.
Both first delivery and exact replay now persist `terminal_failure`, no next
attempt or automatic wake, a board-owned capacity recovery action, and exactly
one durable provider terminal. The test seeds the post-commit crash boundary and
uses a simulated provider with real PostgreSQL; it is not a process-kill test or
a new live Codex call.

The task UI maps the closed native capacity code to “Usage limit reached” and
explains when to retry, without exposing provider account details. The explicit
retry callback remains subject to the existing server checks. The earlier live
failure retains its original recorded error; it was not rewritten to fabricate
post-fix UI evidence.

Two additional database-backed file tests place an older decoy attachment on
the same task. With a newer current-wake attachment, only the newer storage
object is read and staged; with an omission-only current wake, no storage object
is read and no file is staged. This verifies isolation, not the ability to
retrieve or resend a historical attachment on request. That separate user
journey remains unqualified.

## Slack callback recovery

The exact `maya-e2e-paperclip` app, `A0C03GA5FPU`, still had a verified Events
callback on the older `:10000` Funnel endpoint. One message arrived only after
approximately six minutes of provider retries. Its callback was changed in the
signed-in Slack configuration UI to canonical `:8443`, verified by a genuine
Slack challenge, and saved. The similarly named older app was not changed.

The app's Interactivity and existing slash-command callbacks were also updated
to the same canonical URL. A real `/maya-e2e-fjomcs status` invocation reached
the new callback. A native single-choice question rendered Red/Blue buttons;
clicking Blue reached the genuine interactive callback, updated the card to
“Answered: Blue,” and produced the native continuation answer `Blue`.
All three callback surfaces became `current`, and `callbacksNeedUpdate` became
false.

The isolated webhook-only proxy now preserves its allowlisted public HTTPS
origin, and the server trusts forwarding headers only from loopback. This also
fixes false stale-callback observations caused by rewriting the host to local
HTTP. Public Board requests and wrong-host requests returned 404; an unsigned
request to a known webhook returned 401. The Board remains private.

## Runner activity and files

Native activity is durably recorded in Paperclip's run-event path and consumed
by the task transcript UI. Focused tests cover native transcript projection,
polling, and task rendering. External publication remains a separate safe
projection: coarse lifecycle status and selected final answers. Raw reasoning,
tool names/arguments/results, credentials, and internal logs are not chat output.

The live Paperclip task UI was inspected: native turns show worked duration,
expandable tool activity, and the queued/delivered timestamps for burst inputs.
The corresponding provider thread contains the selected answers, not the
internal operational commentary.

Follow-up read-only audit on September 7 reconfirmed the live agent configuration
as `paperclip_runner` / `codex` / `gpt-5.6-luna`, and the four text-run records
above as `native` / `codex_app_server`. No global defaults were changed. Focused
projection, stream, run-publication, interaction-publication, and heartbeat
summary tests passed **82/82** across five files. No live model call was made for
this follow-up because the account quota remains exhausted.

The Board's rich native activity projection is not safe to forward wholesale:
its objects can include command output, targets, and research queries. Native
`report_progress` is also Board-only for chat-origin runs. External stream
chunking presents already-selected safe prose; it is not token-live Runner
reasoning. Any richer external activity would require a separate closed,
sanitized projection, not reuse of the Board transcript objects.

A separate native execution-input, question-bridge, file-handoff, and
same-conversation attachment-reuse recheck passed **20/20** across four files
after the Slack polling change. Its disabled-runner eligibility error was an
isolated test-fixture gate, not a failure of the active live instance. These
contract/DB checks do not substitute for new model-driven live turns.

The new runner does not have the legacy operational skill or a general
Paperclip API key. Consequently, the previous shell-helper file instructions
were not a valid native-runner qualification. Native runs now receive a scoped
`register_deliverable` tool for local files and run-bound staging descriptors
for incoming attachments. Registration means prepared, not delivered; the
existing audited publication path still owns provider delivery.

### Native media evidence

| Provider / case                              | Native run                             | Observed result                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram, generated text file                | `8047d0ca-aabf-42d7-b8a9-753a84edbade` | Actual `native-telegram-0907.txt` document, 23 bytes; exact content `NATIVE-TELEGRAM-0907-OK`, no newline.                                                                            |
| Telegram, inbound text                       | `21e85d82-f13e-4e9a-9003-7f8f08834d36` | Read new 103-byte fixture and returned the correct unseen phrase `violet birch 82`; 21.099 s.                                                                                         |
| Telegram, image round-trip                   | `c7fa20f1-d2d5-4ec2-91b2-00293735e5d5` | Described the orange tabby, sofa, and plant, then returned an actual photo; visually opened and inspected. 38.885 s.                                                                  |
| Discord, generated text file                 | `d97f9736-f4be-417b-b38e-cf452f22f245` | Actual `native-discord-0907-c.txt` attachment and inline content preview; exact 24 bytes, no newline. 45.663 s.                                                                       |
| Slack, generated text file                   | `71e4a887-21b1-4ecb-8b00-8a875aef04d6` | Actual `native-slack-0907-b.txt` file with preview in the original thread; exact 22 bytes, no newline. 38.576 s.                                                                      |
| GitHub, generated file fallback              | `cf8c2192-4643-4983-905e-2258c0a4162b` | Canonical `native-github-0907-b.txt`, exact 23 bytes, no newline. GitHub explicitly reported private-task storage and that this App cannot upload file bytes into comments. 43.761 s. |
| Discord, combined incoming text/image retest | `7f6cd1db-321b-4a02-a764-8db7496b1e19` | Exact phrase `violet birch 82`, correct cat/green-eyes/plant description, and actual returned PNG; 54.778 s.                                                                          |
| Slack, combined incoming text/image retest   | `9bcc22ea-14dd-4e57-ac12-c22dad7b2f95` | Exact phrase and correct cat/sofa/plant description in the final answer, with returned image visibly rendered in the original thread; 55.855 s.                                       |

The returned Telegram JPEG matched the received image's 221,327 bytes and
SHA-256 `1d22f8c026abf16ff0dde087d6c46a3b4a41978cfb4cee62c62e159e5550ce8a`.
The inbound attachment was `b00400f3-7166-4e9c-af49-6a6091d783cd`; the
run-originated outbound attachment was `c238a817-fd79-4608-8db3-efd958efe1ee`.
Telegram may compress a newly uploaded photo, so this compares the received
provider image with the returned file, not with the original local PNG.

### Failures discovered during native qualification

- Native direct mode originally stripped all dynamic tools. The first Discord
  file run `29ab85fc-e13a-4bbf-aa99-5d31094b0ba7` could create a file but could
  not register it. The direct-mode bridge now permits only the server-supplied
  file handoff capability, not arbitrary semantic/governance tools.
- Existing resumed Codex threads still lacked that newly added tool even when
  it was passed to `thread/resume`. Discord run `567d3ae4-7627-4805-a925-b84c194eb58b`,
  Slack run `ec6e140b-828c-4d77-ad6d-e441bb4e0ff4`, and GitHub run
  `bba6a25d-c417-4360-a6ef-e161b5858a68` exposed this. A persisted tool-contract
  fingerprint now rejects incompatible checkpoints before compact prompting;
  fresh provider sessions receive the complete context and tool set. The
  successful Discord/Slack/GitHub retries in the table above used this fix.
- A native status-decision wake could overwrite `chat:discord` provenance when
  coalescing, preventing terminal publication and leaving “working” visible.
  Exact status-decision metadata is now separate and preserves the original
  verified chat source; unmarked/unrelated sources do not get that treatment.
- Corrupt or incompatible checkpoints previously rotated the session ID but
  retained a resume-only prompt. The constructor now rebuilds full task and
  wake context. File-only comments also retain a current completion criterion
  instead of falling back to an older task title.
- Discord's first combined incoming text/image test, run
  `07a0237a-f271-4add-9889-591a3cf0a515`, exposed a MIME parsing bug:
  `text/plain; charset=utf-8` was rejected by the attachment allowlist. The
  image arrived, but Luna substituted an older generated text file. This is
  a failed content-correctness test, despite successful image delivery.
- Slack's equivalent run `812c7ea0-5341-4d55-9290-6c3d0bfe2f09` read both
  attachments correctly in private activity, then omitted the requested
  phrase and description from its semantic completion summary. The final
  answer contract now explicitly requires the requested answers in that
  summary; publishing private commentary is not the fix. Both multimodal
  cases passed the unchanged live request after the MIME and current-attachment
  guidance changes, as recorded above. Terra was not needed. Each returned
  image exactly matched its provider's incoming bytes and SHA-256: Discord
  2,111,878 bytes, `7693966f6c2b4aaebf9e46359f715fdaede021346bcd926078bb331b1dddc3c1`;
  Slack 2,088,249 bytes, `005f8dabdb19ef786c0e2e76695596d22c1d0bb53de374e0be209cc6d89851c9`.

GitHub browser qualification briefly encountered a different active signed-in
account (`forgottendev`). The existing account switcher restored `cryppadotta`;
the stale page's optimistic comment was not treated as a successful delivery.

After the native Telegram file and image turns, the server-created local
staging slot was verified to contain zero bytes. Cleanup retains exact file
descriptors rather than deleting mutable paths. The final cross-process design
also skips live/unknown foreign owners and handles PID reuse. Opaque zeroed
directories remain per server restart; a process reuses its own slots, bounded
by its peak concurrent staged attachment count, not by sequential turns.

## Verification checkpoint

- Full chat integration suite on fresh PostgreSQL database
  `chat_adapters_test_20260907_latency_03`: **263/263**.
- Repeated full chat integration on fresh
  `chat_adapters_test_20260907_latency_04`: **263/263**.
- Final full chat integration on fresh
  `chat_adapters_test_20260907_latency_06`: **264/264**, including Discord MIME
  parameters and durable attachment-omission notices. The intervening `_05`
  run exposed two fixture scheduling races; the cold-start and restart tests
  now synchronize/seed their intended crash boundary without weakening their
  acknowledgement-budget or revoked-access assertions.
- Repeated final full chat integration on fresh
  `chat_adapters_test_20260907_latency_07`: **264/264** after the final native
  compatibility, framing, and capacity-error changes.
- Adapter utility and ACP execution tests: **261/261**.
- Focused server/native/UI transcript tests: **206/206**, before the subsequent
  native file-handoff changes.
- Capability inventories/contracts regenerated from the changed operational
  skill; drift checks pass and validator self-tests pass **4/4**.
- Deterministic connector browser suite: **5/5** (provider APIs are mocked in
  this suite; the live evidence above is separate), repeated after the native
  file and reader changes.
- Native latest-turn, checkpoint fallback, and heartbeat context tests:
  **51/51** after the file-only/current-context fixes.
- Native handoff/executor tests: **145/145**; Codex driver tests: **65/65**.
- Server TypeScript and runner build (including Rust binary and generated
  contract/replay checks) passed, repeated after the generated skill contracts.
- Final reader/storage/authority tests: **20/20**, including five reader DB
  cases and a failed receipt write that rolls back the exact storage object.
- Final executor/checkpoint/reader/native framing tests: **168/168**.
- Inline/overflow and legacy-adapter contract tests: **284/284**, plus the
  independent native overflow-framing test **1/1**.
- Final Codex driver suite: **65/65**. Shared, UI, adapter-utils, and server
  TypeScript checks passed. The operational skill validator passed.
- Final combined native runtime, reader, file-handoff, framing, capacity-error,
  adapter, heartbeat context, attachment-type, and operational skill regression
  run: **552/552**. Capability inventory and generated-contract drift checks
  passed again. These are focused tests, not a claim that the workspace-wide
  test/build gate passed.
- Post-live capacity replay, attachment-isolation, control-plane port, native
  executor/reader, safe publication, and task UI checks: **256/256** across
  seven focused suites. The replay test failed before the observer fix by
  scheduling a new attempt, then passed. Server/UI TypeScript and UI token
  gates passed. These simulated capacity cases do not replace the blocked
  live quota-recovery retest.

Broad workspace tests are not claimed green. Teams still needs the real Microsoft 365
tenant/admin setup and has not received equivalent native live qualification.
GitHub App file-byte uploads remain an explicitly disclosed private-task
fallback. Provider quota recovery, the final long/burst reader changes, and
historical attachments outside the current wake still require live qualification;
this document is not a production-readiness sign-off for all providers/features.

## Same-conversation file resend follow-up

Code review after the native live file tests found a real capability gap:
current-wake staging safely omitted older files, but native direct chat had no
bounded way to resend an earlier attachment. The follow-up adds
`list_chat_attachments` (paged metadata only) and `reuse_chat_attachment`
(exact-byte server-side copy into a new current-run attachment and final-response
selection). It does not expose storage locations, reopen general task tools, or
permit an older file to substitute for unavailable current-turn input.

Both operations verify the current native run, immutable endpoint agent,
conversation, destination reach, principal membership, and exact admitted
inbound or confirmed published file lineage. Reuse repeats authorization on
idempotent replay, rejects ask-mode mutation, and records source/new IDs and
SHA-256 in receipts and Activity. Deleted or provider-edited/deleted source
messages are ineligible. The byte handoff also works for remote native targets
without returning a local path. The native tool-contract fingerprint advances
to v3 so old provider sessions cannot silently retain the pre-resend tool set.

Supporting verification after review fixes:

- Reuse/authority/resume suites: **35/35**; the three DB cases cover byte
  identity, duplicate suppression, receipt preservation, equal-timestamp
  pagination, exact-pair lineage, and access/source revocation.
- Codex driver fresh/resumed direct-mode tool filtering: **65/65**.
- Executor, file handoff, current-wake reader, and capacity regression:
  **156/156**.
- Native chat prompt context tests: **29/29**.
- Server TypeScript and full runner build passed, including generated
  protocol/capability/semantic drift checks, workflow traceability, Rust binary,
  and replay golden checks. The lockfile was unchanged.

These are local simulated/DB tests. New live model-driven historical-file resend,
long/burst reader, and quota-recovery qualification remain blocked by the actual
Codex `usageLimitExceeded` response. Historical-file resend is not historical
file inspection: this tool intentionally returns no earlier file bytes to the
model. Teams and GitHub's private-task attachment fallback retain the limits
described above.

### Historical-file discovery and bounded storage follow-up

Commit `3e932de55` fixes a narrower discovery defect: selecting the newest
publication before excluding deleted or edited provider messages could hide an
older, still-valid publication of the same attachment. Listing now filters
invalid lineages before choosing a candidate. An explicit request using the
older known source-comment pair could already succeed; the defect was not a
blanket inability to reuse that file.

The same follow-up requires a provider message ID and publication timestamp for
confirmed outbound lineage, scopes inbound joins to the exact endpoint and
conversation, validates cursor UUIDs before querying, and bounds storage reads,
writes, and cleanup. A write that completes after its timeout schedules cleanup
of that exact newly written object.

The expanded package-local database suite passed **5/5**, covering valid older
lineage, unconfirmed publication rejection, malformed cursors, stalled writes
and late cleanup, byte identity, idempotency, and source/access revocation.
Server TypeScript passed. This is supporting local verification, not a new
live model-driven resend or quota-recovery pass; those remain unqualified.
