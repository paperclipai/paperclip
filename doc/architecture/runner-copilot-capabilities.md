# Copilot 1.0.88 rich ACP capability audit

Current source candidate (2026-09-30): **Copilot profile v8 is unqualified**.
Its native executable, owned mapper and native distribution closures are unchanged
from v7, but its declaration binds the full shared ACPX patch. The patch's additive
Cursor metadata persistence changes those bytes, so v8 has a distinct command
digest and rejects v7 sessions. Copilot gains no usage or cost capability from this
change. Retained v7 paid cases below remain exact historical evidence, not v8
qualification. Fresh pack/image admission and the required exact-runtime local
and Daytona qualification remain outstanding.

Historical v7 checkpoint (2026-09-30): **Copilot profile v7 remains unqualified**. Paid controller/Product harness source is `40064d28522de25fea85c1297f35b41bb8a8897a`; runtime source is `5b8e4454ef0bf12d0bb068c2e41d8c9df9356a1c`. All three target runtime builds are complete. Local attached-async attempt `40064-copilot-async-01` passed all eight matchers on `gpt-5.6-luna`, including exact one-command identity, trusted child exit and independent completion observations before terminal settlement, one run and one exact final marker. Done was visible, and full end integrity, owned process/semaphore retirement and temporary-root cleanup passed. The exact local native-permission-deny-write case `40064-copilot-deny-01` also passed all ten checks, with no target side effect through process retirement, correlated cancellation and successful cleanup/end integrity. These two local cases pass; the provider remains unqualified. Native per-run USD is unknown; included credits stayed 16→16 after async and reached 17 after denial, with possible dashboard lag, and extra usage remained disabled at $0. Result SHA-256: `d1d074bc9df4644794dfa8b020fdeba8a9b0de4618e1f55d1845f7726a2ece33`; reconciliation SHA-256: `8e9b9233ed987e9e522b17a271922fd409d311e04ee5c3422a4b5bd1fa2fce68`. The prior exact head passed CI and Greptile for [draft #14676](https://github.com/paperclipai/paperclip/pull/14676). The earlier v6 denial pass and attached-command failures remain historical, including the doubled final marker and missing settlement observations; they do not qualify v7. See the [comparative capability report](runner-rich-acp-capabilities.md) for exact source identities and remaining local/Daytona, billing and cleanup gates.

Message identity implementation (2026-09-30, **deterministic evidence and one paid async case; full qualification pending**): the pinned 1.0.88
ACP mapper discards `assistant.message_start` and removes native `messageId`
from text deltas. The separate candidate keeps the original executable and
every embedded distribution asset, patches the hash-pinned JavaScript mapper,
and supplies its complete verified distribution through a per-spawn owned
entry shim. The shim installs the module guard before importing Copilot;
ambient distribution/version/module paths do not select executable content.
The original executable, inner archive, upstream app, patched app and complete
platform closure have independent hashes. Unknown upstream bytes are refused.

The mapping carries real message IDs on the ordered standard ACP stream,
including empty starts; completed native messages do not echo their full text
again. Distinct native messages remain distinct transcript items. Earlier
messages close as commentary, and only the last message supplies final output.
An empty final message clears preceding text. Reasoning and unidentified native
session notices are not promoted into the final answer. This does not deduplicate
equal text or infer a message boundary from a tool call.

A credential-free loopback probe through the actual pinned ARM64 process
observed three equal-text messages with three native IDs, three empty starts,
and attached-shell settlement. A separate actual ACPX transport fixture preserved
empty boundaries across three warm turns. All three platform distributions were
materialized; this is not native x64/Linux execution proof or paid qualification.
The [complete candidate inventories](../../packages/paperclip-runner/test/fixtures/copilot-message-identity-distributions-1.0.88.json)
retain platform closure hashes. Private bounded probe receipts are under
`runtime-6-6-9-eof-preparation/copilot-message-identity-candidate/` in the existing
qualification artifact collection. Copilot v7 binds this candidate to a new profile and warm identity; v6 paid
failures and missing settlement observations remain unchanged. The 1.0.89 comparison moves ACP transport into its native runtime and
does not establish that upgrading alone fixes message identity.

Initially audited 2026-09-28 against repository base `c65fc9e3c81c41aafe421aa90a00514b84343285`;
updated 2026-09-29. Status remains **candidate, not qualified**. On frozen source
`bd4cc29c3017ed5e1484423e842fd48e3b2f49f3`, profile v4 local hello, question/answer,
semantic plan, controller restart and file-edit cases passed. Daytona hello passed
one native `gpt-5.6-luna` run with six matchers on immutable image
`sha256:bff4c3f291087a0eeae37e4c20dd51857b92833eaf73ba3aca4157f37de1e109`.
Earlier question-marker, recovery, startup-timeout and PostgreSQL failures remain
retained; later success does not establish causes for unresolved earlier failures.
The earlier 2026-09-29 admission identity was profile **v5**, binding shared ACPX patch
`79aad2d688b03362e8cfcbf7a08f78a8383869f6882a9c9ed66f1d18efb94f2b`.
The native Copilot binary and permission/instruction policy are unchanged. The
new digest rejects old warm sessions; v4 paid receipts remain historical evidence,
not a claim of v5 qualification. The new native-protection Product cases below
have not run on the new source.

Daytona sandbox-specific analytics stabilized across three reads at a provisional
$0.0039682144 for the closed attempt interval; invoice finality and native per-run
Copilot USD remain unknown. The Product list-price estimate was $0.0040321867.
One exact owned sandbox was absent after the full 360-second cleanup observation;
45 local PIDs retired and semaphore counts returned 255→266→255. The conditional
720-second infrastructure bound was $0.053496. These are distinct accounting claims,
not a zero-cost assertion. The allocated provider budget remains $25 within the
shared $100 ceiling; no new paid attempt follows automatically from registration.
Mac x64, the remaining Daytona workflows, broader permissions/background variants
and complete rich-field projection remain unqualified.

## Connection policy audit, 2026-09-29

The pinned server accepts permission-changing `session/set_config_option`,
`session/set_mode`, and leading-slash CLI commands. Entering autopilot enables
allow-all; loading an autopilot conversation enables it again. A clean launch
configuration alone therefore cannot establish safe restored-session policy.

`copilot-policy.ts` and the optional ACPX `protocolGuardFactory` enforce policy
on each actual stdio connection, before bytes are delivered to the SDK or written
to the provider. Copilot admission requires the full new/load/resume result to
report the exact agent-mode URI and `allow_all: off`. Missing, duplicated,
unknown-authority, or custom-agent configuration fails closed. A connection may
select only its explicitly admitted model; a prompt requires proof of that
model. The guard rejects leading-slash commands, native mode/config controls,
and unsafe mode/config drift. Its authority is fresh for every connection and
remains invalid after a violation. It does not restore trust from cached ACPX
status. The stream errors, aborts outstanding response delivery, and terminates
the provider on violation; the existing runner owns bounded process cleanup.
Other providers do not install this guard.

The native `ask_user` and `exit_plan_mode` tools are absent from both agent and
plan mode in the pinned deterministic tool catalogs. Forced model tool calls
return explicit tool-unavailable results rather than producing a blocking
request. No `--no-ask-user` or tool-exclusion flag was used. Agent mode is the
only admitted production mode. If any native input-request event nevertheless
arrives, the guard terminates the connection; it never presents a form whose
answer cannot be delivered. This narrows the blocking-input question for the
admitted pinned mode without claiming an upstream question responder exists.

The [offline conformance record](../../packages/paperclip-runner/test/fixtures/copilot-policy-conformance-2026-09-29.json)
retains every attempt and its evidence digest, including the isolated comparison release. A protected file outside the
working directory was denied before its contents reached the fixture model.
A durable conversation was closed and loaded, then requested permission for a
shell write; `reject_once` prevented the file. The initial attempt to load an
empty conversation failed with resource-not-found and remains retained. The
second attempt seeds one text turn before close/load; it is not a retry of a
measured behavior failure. A separate
process-death attempt first performs one allowed seed append, then SIGKILLs and
replaces the exact provider using the same private session state. Load succeeds,
the seed append still occurs exactly once, and a fresh denied write remains
absent. Both native processes use permission request ID 0, proving why response
authority must belong to the current connection. These are local native
close/load and process-death probes, not final packaged Product qualification.

Production-pin probes use the verified 1.0.88 ARM64 binary; an explicitly selected
1.0.89 comparison has separately verified archive integrity. All use an explicitly constructed
credential-free environment, `COPILOT_OFFLINE=true`, and a synthetic OpenAI-style
model at an ephemeral loopback HTTP server. The synthetic `gpt-4.1` ID does not
name an authenticated GitHub model selection. Counts include the setup turn.
There are zero paid provider calls and zero model spend. Raw evidence, including
the failed empty-session attempt, stays in the private
`copilot-policy-20260929` artifact directory.

The prior Product question failure remains a model-behavior failure: the retained
snapshot contains the exact requested marker in the task instructions, the
answered Cobalt choice, and warm-session continuation. Copilot instead supplied
`[terminal marker]` to `paperclip_finish`. Neither the grader nor the terminal
marker requirement changed. A final-runtime rerun remains required.

### Final v3 Product question attempt

The [final v3 question receipt](../../packages/paperclip-runner/test/fixtures/copilot-product-v3-question-2026-09-29.json)
retains the single reserved attempt at source `3d0c45920`, with the exact frozen
controller distribution, native assets, pack, Node, daemon and sidecar hashes.
The first turn produced the structured question and the board answered Cobalt.
Continuation failed during native `session.open` recovery, before continuation
usage was reported, with an unclassified sidecar rejection. The 72.086-second
case failed; cleanup passed and no retry occurred. This is a recovery/admission
failure, distinct from the earlier literal-marker behavior failure. Neither is
removed from qualification evidence.

One run reports GitHub/unpriced usage: 28,545 input, 13,818 cached input and 525
output tokens. Provider USD and upstream model-request count remain unknown.
The refreshed account counter moved from 5 to 6 of 1,500 included credits;
additional usage remained disabled with a $0 budget and $0 account cash charges.
This account-level delta is not a per-turn USD allocation. The Product aggregate's
zero reported cost with `unpriced`/incomplete coverage is not an authoritative
zero-cost receipt. No additional live attempt is authorized by this result.

A [credential-free native recovery reproduction](../../packages/paperclip-runner/test/fixtures/copilot-runtime-context-recovery-2026-09-29.json)
closes the provider, deletes the prior registered instruction copy, and reproduces
`ENOENT` at `bindAcpxAgentFiles`. Reopening with the current registered copy
succeeds with the same native session. A second explicit fixture turn proves
actual native `session/load` and reaches `end_turn`. The fixture uses exactly two
loopback responses, a synthetic credential and test-only model metadata;
it makes no paid calls and does not qualify authenticated model selection. This
supports the stale durable runtime-context diagnosis; the failed Product run did
not retain the underlying wire error. Cold rotated restoration now takes the
current authenticated runtime context. Live reconnect and pending warm-transition
receipts keep their existing context; replacing that context in an active provider
is a separate lifecycle operation.

### Native instruction delivery

The initial candidate was profile v4. Its declaration binds native personal-file
instruction delivery, including replacement under the provider lifetime lease before native launch. The isolated
`COPILOT_HOME/copilot-instructions.md` is written atomically with mode 0600 under
the protected provider home, and empty instructions replace any stale content.
Concurrent contenders rejected by the lease and unauthenticated admissions do
not mutate the instruction file. The host awaits each write before releasing its
lease, including cancellation, so a late write cannot overwrite a successor.
Profile v3 identities are rejected before native launch; historical evidence
below remains labeled with its original profile and source.

The [native model-request probe](../../packages/paperclip-runner/test/fixtures/copilot-native-instruction-delivery-2026-09-29.json)
retains a separate instruction-delivery failure: Copilot 1.0.88 ignores generic
ACP `_meta.systemPrompt` on new sessions, and ACPX does not include it on load.
Actual loopback model requests contained neither the Paperclip prompt nor the
registered directory guidance. Passing a refreshed descriptor alone is insufficient.

A credential-free follow-up wrote the composed text to the isolated provider
home's `copilot-instructions.md`, using Copilot's native personal-instruction
mechanism. The first request's system message contained the old directory and
original entry. After closing the provider, deleting the old directory and
reopening with fresh instructions, actual `session/load` and a second explicit
turn completed. The second model request contained the current directory and
updated entry, with neither old value in its system message. Both attempts used
two synthetic loopback responses and no paid calls. This probe is not a final
built-production or authenticated qualification result. A follow-up
[source-level v4 probe](../../packages/paperclip-runner/test/fixtures/copilot-v4-native-instruction-delivery-2026-09-29.json)
uses the actual production sandbox writer and confirms the same new/load model
request behavior. The [post-lease source probe](../../packages/paperclip-runner/test/fixtures/copilot-v4-owned-instruction-delivery-2026-09-29.json)
reconfirms this after moving refresh under lifetime ownership, and retains an
earlier zero-call lease-admission failure. The final frozen pack still requires
independent verification.

### Native detached work is explicitly unsupported

The broader 2026-09-29 deterministic probe reproduces early completion for
`bash` with `mode: async` and `detach: true`. After an allowed finite two-second
command, Copilot sends a completed tool update naming a detached shell ID, then
`session.idle` and `end_turn` before the marker file exists. A separate diagnostic
keeps observing for three seconds after terminal and proves the marker appears
late. Both attempts retain their failed settlement assertion.

The preceding standard tool-call notification includes `rawInput.detach: true`,
but the observed permission request carries only the command. The Copilot guard
rejects that update before the SDK can deliver any permission answer, terminates
the provider, and reports `COPILOT_DETACHED_WORK_UNSUPPORTED` with instructions to
run attached or use a managed runtime service. It also rejects detach carried
only in a permission request. Attached asynchronous work retains the normal
permission path. This is policy denial, not completed background settlement.

A native offline probe invokes the exact production TypeScript tool-update
policy, kills the provider before permission dispatch, and observes no marker
through the command's bounded delay. It makes one loopback fixture request and
sends zero permission responses. Separate actual patched-ACPX stream tests prove
the same rejection before SDK delivery. The native probe intentionally tests
only tool admission: its synthetic model does not satisfy full production model
admission. Neither layer's result is misrepresented as final-pack live evidence.

The bounded schema audit finds `detach` on `bash`, absent on `read_bash`,
`stop_bash`, and `task`; `write_bash` and PowerShell variants are not advertised
in this ARM64 catalog. Embedded JavaScript references `write_bash` but delegates
schemas to native Rust. The guard is independent of tool name, but this audit
cannot prove every platform/feature-flag variant or shell-created daemon
lifetime. Comprehensive background qualification remains blocked. Empty native
background-task notices and fixed delays cannot establish settlement.

An isolated exact-integrity 1.0.89 comparison passes the same attached async
scenario and reproduces the detached late marker. Production remains pinned to
1.0.88. As checked on 2026-09-29, upstream #4743 is closed and explicitly concerns
attached async commands, distinguishing deliberate detached services. These
results do not establish that issue remains unfixed. #4537 remains open; the
narrow denied-write/read/recovery probes did not reproduce its permission bypass.
The original detached failures remain recorded as failures of the attempted
runner settlement contract; they are not relabeled as successful settlement.

## Evidence and scope

The audit inspected the exact `@github/copilot@1.0.88` platform archives, the
native executable's embedded `app.js`, `schemas/session-events.schema.json`, CLI
help/config/environment output, and real ACP wire traffic. The embedded schema
SHA-256 is `d8cb713c05d5278a68dde5c5d4482574f836e922ae13aa06f82474c209a7c6e9`.
The [complete event/field inventory](../../packages/paperclip-runner/test/fixtures/copilot-event-inventory-1.0.88.json)
contains all 150 native event types and their data field names, including every
event we do not subscribe to. Fields in that file describe the native schema;
they are not a claim that every event was observed on the wire.

Primary external references: [ACP server documentation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server),
[CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference),
[denial bypass report #4537](https://github.com/github/copilot-cli/issues/4537),
and [background completion report #4743](https://github.com/github/copilot-cli/issues/4743).
The exact pinned implementation takes precedence over moving documentation.
The [harness priorities report](https://pages.paperclip.ing/2026-09-25-harness-priorities/)
defines the requested product outcome. Existing Codex app-server contracts and
conformance tests are the comparison baseline, especially `turn/steer`,
`turn/interrupt`, `thread/read`, file changes, user input, and scoped approvals.

## Distribution and authority

Launch the verified platform `copilot` executable directly with `--acp --stdio`.
Do not execute the mutable `npm-loader.js`, install hooks, or an ambient PATH
binary. `materialize-copilot-binary.mjs` validates exact package/version, executable
mode and bytes, then writes a native-closure manifest. Runtime descriptor leases
must independently verify the trusted closure digest before every launch.

| Platform | Executable SHA-256 | Bytes | Closure SHA-256 |
| --- | --- | ---: | --- |
| macOS ARM64 | `a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3` | 152595280 | `fb3b367a45cd76122fe931521fa2a18adf234ba944fc302db9e10e005e57037e` |
| macOS x64 | `85eb919f6b9b9dd833ce5e326cbf974b3ee2d4a9ac525c59d4ec9c9ec085715b` | 165041200 | `05f3497b336b3efdec347beb2e3b80b02cfa95f811fafddc25d0b029ab95d711` |
| Linux x64 | `0059754cf78c3f3bf2c9d4564dfa7e9e25f3a3f8f411f2f0cdad9363f5662748` | 169544512 | `1a675c5b54ae4d94f08718a318451e0499708ded388b4cfd98acec6b4311ccbd` |

All three archives were verified against the npm SHA-512 integrity value before
hashing the executable. Archive pins are retained in the materializer. The macOS
ARM64 executable has live evidence; Linux x64 now has the initialize-only image
proof described below. macOS x64 remains execution-unverified. The binary contains its JavaScript/native runtime and
extracts it into `COPILOT_PKG_CACHE_HOME`; this must be a fresh per-spawn private
lease directory, never a writable cache shared across executions. The native
distribution verifier supplied by the foundation owns that isolation boundary.

`copilot-profile.ts` supplies private HOME/XDG directories, COPILOT_HOME,
COPILOT_CACHE_HOME and an extraction-cache binding; update disabling; no built-in
MCP servers; no remote/remote-export or shell startup environment; and secret
environment stripping for child shells/MCP. Only explicitly bound
`COPILOT_GITHUB_TOKEN` may authenticate production use. The offline fixture uses
an intentionally separate, credential-free loopback provider, not this production
credential path. Private configuration disables hooks, memory and automatic IDE
attachment and has no trusted folders.

Never set `COPILOT_ALLOW_ALL=true`: this exact string also trusts workspace
hooks, plugins and MCP configuration. Paperclip's full-auto policy answers the
individual permission callback. It must not grant ambient configuration trust.
Mode/config changes, including autopilot and the provider's `allow_all` option,
must not bypass the admitted Paperclip policy. Slash-command discovery includes
commands capable of changing permissions, cwd, remote/export, MCP and schedules;
these are not authority to offer an unrestricted command UI. Adversarial
workspace/config qualification remains required before release.

The pinned ACP handler maps `allow_always` to native `approve-for-session` for
commands, writes, reads, MCP and other supported tools. Path approval is also
session-scoped; URL approval is session-scoped to an origin pattern. Factory
permissions omit that option and reject fabricated permanent approval. This
scope is confirmed in source, not inferred from the option label. Read/write
session grants are broader than one file and must be described accurately.

## Negotiation and event contract

The observed initialize result advertises protocol 1; `loadSession: true`;
HTTP/SSE MCP; image and embedded-context input; no audio input; and session list
and close. It does not advertise steering, forking, goals, or a question/plan
extension responder. The source adapter supports model/reasoning/config changes,
but the offline session only returns `mode` and `allow_all` options. There is no
verified GitHub model ID from the historical offline probe. Require an explicitly selected model
and exact effective-model verification; never silently use the fixture's
`gpt-4.1` or substitute another model. Authenticated discovery on 2026-09-28 subsequently advertised and accepted
`gpt-5.6-luna`; subsequent canonical and Product cases verified inference on that exact model.

The native event extension is real and is negotiated with:

```json
{"clientCapabilities":{"_meta":{"github.com/copilot":{"events":["subagent.started","session.workspace_file_changed","assistant.usage"]}}}}
```

The notifications are:

```json
{"method":"github.com/copilot/sessionEvent","params":{"sessionId":"...","type":"subagent.started","timestamp":"...","data":{},"agentId":"..."}}
```

The source caps subscription names at 128, payloads at 32 KiB, and pending
notification sends at 256. Oversized/unserializable payloads carry `dataOmitted`;
backpressure can drop events. There is no event ID or reliable replay contract.
`skill.context_delivered` and `skill.context_delivered_ref` are explicitly blocked
even when subscribed. These are provider restrictions, not missing runner parsing.

`copilot-events.ts` requests 22 event types and projects only bounded declared
fields after matching the admitted session and an active receiver. The pinned
notification has no originating turn ID; arrival during a later turn cannot
establish attribution. It records source method/type,
provider timestamp and subagent identity. Payloads cannot authorize filesystem
reads, workspace rebinding, permission changes, native-input replies or terminal
settlement. Inline binary assets are content-address verified; only metadata is
forwarded until a provider-session artifact resolver can upload them safely.

`copilot-extension-adapter.ts` retains every safe projected field in bounded,
session-scoped provider notices with method/event/session provenance and an
explicit unknown originating-turn attribution. Typed delegation, compaction and
artifact projections are withheld because they would falsely attribute delayed
session notifications to the receiving turn. Native correlated ACP turn events
remain separate. Follow-up: a versioned provider correlation contract is required
before promoting these notices into typed turn activity. Notices have readable
summaries; secret-shaped string values
are scrubbed without erasing numeric token counters. These display events never
create a usage charge, input-resolution acknowledgment, registered artifact, or
turn terminal event. The provider registry installs this factory and initialize
capability metadata in the provider branch.

## Comparison against Codex app-server

“Source” means verified in the pinned implementation; “wire” means observed in
the real ARM64 executable against the deterministic offline model. Product UI and
Daytona claims require the separate live product qualification.

| Capability / Codex benchmark | Copilot native and ACP exposure | Runner and user-visible surface | Evidence / remaining gap |
| --- | --- | --- | --- |
| Authentication | Initialize advertises `copilot-login`, including terminal-auth command, args and label. | Explicit company-bound `COPILOT_GITHUB_TOKEN`; missing binding fails before executable admission. Terminal login is not launched. | Packaged initialize and host cleanup/retry test; terminal-auth remains intentionally unused because it would introduce ambient interactive identity. |
| Prompt attachments | Initialize advertises images and embedded context, and explicitly denies audio input. | Current runner prompt contract sends text. Image/context input blocks are not forwarded. | Observed initialize; P1 add validated attachment inputs. Audio is confirmed unsupported in this ACP advertisement. |
| Active turn steering (`turn/steer`) | Native SDK steering exists. ACP `session/prompt` unconditionally aborts the active session before sending a new prompt. | Unsupported active steering; do not impersonate it with concurrent prompts. | Source; P1 add a versioned upstream ACP steering method. |
| Ordered follow-ups | Native pending-message controls and `pending_messages.modified`; notification has no queue body. | Lifecycle activity only. Scheduler can start a subsequent completed-turn prompt, but that is not native queue delivery. | Source; P1 require queue acknowledgment and ordering contract. |
| Interruption (`turn/interrupt`) | Standard `session/cancel`, active prompt abort and process shutdown. | Shared cancellation and bounded cleanup. | Source; authenticated cancellation/process-tree test pending. |
| Session recovery/history | `session/load`, list and close; native history and rewind richer. | Exact identity/warm continuation through shared ACPX host; never replay approvals or mutations. | Live Product controller restart preserved the pending interaction and reused the same provider session. Provider-death restoration and history loading remain unqualified. |
| Session list / explicit close | Initialize advertises both methods. | Runner owns its selected-session registry and process cleanup; it does not call Copilot's list or explicit close methods. | Observed initialize; P2 company-scoped history/session management before consuming these interfaces. |
| Fork / history paging | Native CLI/SDK capabilities exist; no ACP fork advertised. | Unsupported. | Confirmed absent from initialize advertisement, not proof native harness lacks it; P2 upstream extension. |
| Tools / correlation | Standard `tool_call`/`tool_call_update`; parent identity in `_meta["github.com/copilot"].agentId`. HTTP/SSE MCP supported. | Shared tool activity, authenticated runner-owned MCP bridge. | Real create/bash/read_bash traffic and canonical authenticated get-task-context pass; Product semantic question and plan calls observed. Full adversarial company-boundary coverage remains pending. |
| MCP transport selection | Both HTTP and SSE are advertised. | The assigned Paperclip gateway uses the controlled HTTP bridge. Arbitrary SSE endpoint configuration is not exposed. | Observed initialize; SSE remains unused, P2 only if a governed connection requires it. |
| Scoped approvals | `session/request_permission`, actual options allow_once/allow_always/reject_once. | Shared durable permissions; only received decisions offered, policy enforced. | Real-service wire ID 0 denied before file creation, with no side effect through cleanup. Durable Product restrictive-mode recovery and wider tool denial remain unqualified. |
| Structured questions | Native `ask_user` callback and `user_input.requested`; current ACP adapter does not wire the responder. | Emits capability-gap notice if native notification arrives; cannot claim answer delivery. | Actual agent-mode tool list omits `ask_user` without a suppression flag. Paperclip semantic questions are available: restart case passes, while the separate question case failed its exact marker. Pinned offline agent/plan catalogs now prove both tools unavailable; the production guard admits agent mode and terminates any unexpected native blocking request. |
| Plan approval | Native `exit_plan_mode` callback; notification contains plan content/actions but lacks qualified ACP responder. | Capability-gap notice only; never synthesize plan acceptance. | Agent-mode tool list omits exit_plan_mode. Paperclip semantic plan/revision approval passes through the UI; Native plan-mode input is confirmed unavailable offline; production mode controls remain disabled. |
| Plan progress | Standard plan from todos SQL; native `session.plan_changed` has operation only. | Existing ACP plan/activity; native operation preserved, `planContentAvailable:false`. | Source; plan document reads require native interface. P1. |
| Models / reasoning / config | Source `session/set_model`, config options for model, reasoning, mode, custom agents, allow_all. | Explicit model admission. Mode/governance changes must remain policy-gated. | Authenticated catalog, exact set_model/config echo and real inference verified for gpt-5.6-luna. Other models and config-mode changes remain unqualified. |
| Native notification attribution | Copilot passthrough identifies the session, optional subagent and timestamp, but no originating turn. | Bounded redacted session notices retain all admitted details; typed delegation/artifact/compaction projection is withheld. | Delayed same-session regression; P1 require a provider-origin turn correlation contract. Arrival time and optional payload IDs cannot establish it. |
| Usage | Standard prompt usage and context usage; native assistant usage, AI-unit checkpoint. | Token/counter metadata with source; multiplier and nano-AI-units distinct from USD. | Real token counters retain GitHub provenance; authoritative per-turn USD is unavailable. External included-credit snapshots are separate, with additional cash billing disabled. CLI requested-cost coverage fails closed when unknown. Never double-count passthrough. |
| Subagent activity | Native started/configured/completed/failed, model and tool IDs, token/call/duration stats. | Bounded structured activity retaining attribution and model-selection details. | Source and unit fixtures; live UI attribution pending. |
| Task file changes / diffs | Standard tools carry locations/diff content for create/edit/str_replace/apply_patch. | Shared ACP tool activity retains bounded `rawOutput`, `inputUpdated` and the first validated relative location. Structured tool `content` diffs/images, `rawInput` and secondary locations are dropped; no complete diff presentation is claimed. | Real denied-create wire contains a diff, but wire presence is not runner/UI preservation. P1 add typed, bounded diff/image content and all validated locations with tool/session provenance; Product file-edit/validation and downloadable-file presentation pass; rich diff rendering remains unqualified. |
| Provider workspace files | `session.workspace_file_changed.path` is relative to provider session workspace files, not task cwd. | Validated reference tagged `provider_session_workspace`, resolution required. | Source + traversal tests; P1 safe file retrieval/upload. |
| Images / binary artifacts | Prompt image input; native content-addressed binary_asset base64. | Hash/length-validated metadata references; bytes not blindly read from disk or emitted in activity. | Source + unit digest tests; P1 durable artifact storage; >32 KiB payload provider omission remains. |
| Background settlement | Standard prompt waits for idle in tested attached async-shell case; lossy native idle/receipt also exist. | ACP terminal result remains authoritative; raw event cannot end turn. | Offline attached and real-service finite detached commands completed before end_turn; marker verified through cleanup. A deterministic detach:true case now reproduces end_turn before the finite command completes; see the 2026-09-29 blocker. Native detach is now rejected before permission delivery; comprehensive background qualification remains blocked pending unproven tool/platform variants. |
| Compaction/context | Native compaction lifecycle/token counts/context git metadata. | Safe bounded counters/status, immutable workspace binding. | Source + projection tests; raw summary/private custom instructions omitted. |
| Goals / remote/schedules | Native autopilot/objectives/remote/schedule facilities; no qualified ACP goal protocol. | Unsupported through this profile; remote disabled. | Source; P2 separate governance review before control exposure. |

## Unused event and field accounting

The inventory is exhaustive for the pinned native event schema: 22 selectively
subscribed events, 15 standard-ACP projection events, 111 native passthrough events
not subscribed, and 2 provider-blocked events. Its `fields` array names every
native data field; `fieldCoverage` records each field's disposition and follow-up.
Preserving one standard ACP projection does not imply all native fields survive.

Reasons and priorities are explicit:

| Group | Reason and follow-up |
| --- | --- |
| Standard text/reasoning/tool/plan/config events | Standard ACP already transports the user-facing content. Additional native metadata is not assumed preserved. P2 compare native field inventory against normalization before adding fields; avoid duplicate output and raw reasoning. |
| Standard ACP parent tool content and locations | Confirmed shared normalization gap: structured `content` diff/image blocks, `rawInput`, and locations after the first safe relative path are not carried into canonical tool events. Only bounded `rawOutput`, `inputUpdated`, tool lifecycle/identity, and that first path survive. P1 introduce validated diff/image artifact schemas and preserve every safe location with attribution; retain secret redaction and workspace containment rather than forwarding raw provider objects. The retained offline diff proves harness exposure only. |
| Native user/plan/elicitation requests and completions | No qualified ACP responder/correlation acknowledgment. The 2026-09-29 agent/plan probes prove these two native tools unavailable on the pinned offline surface; the connection guard fails closed if any native request appears. Add a versioned upstream responder before displaying an answerable UI. |
| Native permission authorization internals, sandbox decisions, recovery | Standard permission callback is the policy decision boundary. P1 collect sanitized denial diagnostics; never let native carried-forward/assent events authorize actions. |
| Native usage diagnostics omitted from subscribed assistant.usage | Quota snapshots, reasoning summaries, fusion/RTE payloads and upstream service/cache diagnostics are not normalized. P2 type/redact useful performance details; quotas and model multipliers cannot substitute for verifiable dollar spend. |
| Native compaction summaries/checkpoint paths/custom instructions | Avoid copying private instruction/summary bodies or treating provider paths as task paths. P2 add explicit safe metadata schema/artifact retrieval where useful. |
| Native model-cache checkpoint data / premium request total | Complex cache state not normalized; premium request totals are not USD. P1 document billing provenance before integration. |
| Native artifact metadata/bytes | Base64 is verified then omitted; arbitrary nested metadata has no current UI contract. P1 safe artifact upload with content type/size/path policy, not a guessed cwd join. |
| Native hook/extension/skill events | Ambient hooks/extensions are disabled and runner-owned skills have their own attribution. P2 typed activity if a verified owned extension needs it. Two context-delivered types are blocked upstream. |
| Native MCP auth, headers, dynamic lists, reconnect and tool events | Only runner-owned bridge is admitted. P1 sanitized bridge availability diagnostics; do not surface OAuth/headers as unrestricted interactions. |
| Native remote/handoff, schedule, canvas, fusion/factory, memory/indexed-search, UI-ephemeral events | No corresponding admitted ACP control/resource or typed product surface. P2 investigate useful artifact/subagent projections separately; disabled remote authority stays disabled. |
| Native raw user/system messages, assistant lifecycle/retries, streaming internals, tool progress | Standard ACP provides primary conversation/tool lifecycle; duplicate/private bodies intentionally not subscribed. P1 audit lost meaningful progress/retry metadata with sanitized bounded samples. |
| Native external-tool/sampling/limits callbacks | No qualified ACP responder. P0 prove no unresolved request on admitted model/tools; otherwise keep release unqualified. |
| Native capability/model/session lifecycle/config notices | Initial handshake and normalized session/config are admission authority. P1 detect capability/model drift and fail closed rather than treat a notice as authorization. |

Subagent subscribed fields are preserved within the declared text bounds;
truncated display strings carry an explicit truncation marker. Empty native
`pending_messages.modified` and `session.background_tasks_changed` events have no
queue/task list to preserve; their projection explicitly says refresh unavailable.
Native context repository/git-root strings, completion receipt finalTool,
compaction summary internals, artifact metadata, nested cache state, and native
question/plan contents are individually marked in the inventory. No exposed
native field should be read as silently supported merely because its event name
appears in the subscription.

## Deterministic verification and retained wire

The reusable `scripts/probe-copilot-acp.py` verifies the pinned executable before
running it with a fresh environment and a deterministic loopback OpenAI-compatible
fixture. `COPILOT_OFFLINE=true`; no credential is inherited. It bounds fake model
calls and process lifetime and removes its owned workspace. The fixture model ID
does not verify any GitHub model's availability.

```sh
python3 packages/paperclip-runner/scripts/probe-copilot-acp.py --package-root /path/to/copilot-darwin-arm64/package --scenario deny-write
python3 packages/paperclip-runner/scripts/probe-copilot-acp.py --package-root /path/to/copilot-darwin-arm64/package --scenario attached-shell
node --test packages/paperclip-runner/scripts/materialize-copilot-binary.test.mjs packages/paperclip-runner/scripts/build-copilot-distribution.test.mjs
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/drivers/acpx/copilot-events.test.ts src/drivers/acpx/copilot-profile.test.ts src/drivers/acpx/copilot-evidence.test.ts
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/drivers/acpx/copilot-extension-adapter.test.ts src/drivers/acpx/copilot-registry.test.ts
```

Retained real-binary evidence:

- [Denial wire](../../packages/paperclip-runner/test/fixtures/copilot-acp-denial-1.0.88.json): request ID 0; reject_once; failed tool update; target file absent after end_turn. This narrow case did not reproduce #4537.
- [Attached-shell settlement wire](../../packages/paperclip-runner/test/fixtures/copilot-acp-settlement-1.0.88.json): two-second async attached command; marker written; output consumed through read_bash; idle followed by end_turn. This narrow case did not reproduce #4743.
- All three materialized platform executables match pinned digests. Only ARM64 wire behavior was exercised.

These are local offline conformance probes, not product E2E or live GitHub
qualification. No screenshots were produced because no product UI was exercised.
The later live sections record explicit authentication, exact-model inference,
file validation, semantic tools, plan approval and controller-restart evidence.
Remaining qualification blockers include the failed standalone question marker,
every native blocking question/plan mode, restrictive permissions across native
tools and configuration, provider-death recovery, active cancellation,
multi-company isolation, rich artifact/diff UI, macOS x64 execution and Linux x64
Daytona E2E. Authoritative per-turn USD remains unavailable; external included-credit
reconciliation is distinct from cost-limit coverage. Retry with
another pinned release if a blocking interaction or settlement/denial case fails;
do not suppress the interaction to obtain a pass.

## Build-owned native distribution

`buildPinnedCopilotDistribution({ outputRoot })` in
`scripts/build-copilot-distribution.mjs` downloads the exact platform npm archive
from `registry.npmjs.org`, verifies its pinned SHA-512 integrity, and admits only
the four expected regular tar members. Traversal, links, PAX overrides, duplicate
entries, bad checksums, hidden trailers, and oversized input fail admission. The
binary is independently checked against the pinned SHA-256 and exact size before
it is materialized; no install script, npm launcher, or downloaded executable runs
during this build. `outputRoot` is the selected pack's exact
`provider-assets/copilot/<platform>-<arch>` directory.

The factory resolves those assets from the runner's verified package authority,
including the descriptor-loaded sidecar path, then the native verifier makes a
private executable lease and fresh extraction cache. Callers cannot choose a
runtime binary or distribution root.

On 2026-09-28 the strict archive reader verified the actual pinned archives for
all three platforms. A fresh macOS ARM64 registry download completed the full
builder, returning the profile digest above and closure
`sha256:fb3b367a45cd76122fe931521fa2a18adf234ba944fc302db9e10e005e57037e`.
The temporary output was removed after verification. This packaging proof used
no model credentials, executed no provider turn, and incurred $0 model spend;
it does not qualify either local product behavior or Daytona execution.

The Copilot branch connects all three closed registries: profile installation
selects the pinned native verifier, profile extensions advertise only the 22
selected native event types and create the Copilot adapter, and candidate packs
select the verified archive builder. Registry conformance checks the complete
subagent field projection through the shared turn binder, attribution, canonical
schema validation, meaningful display details, and stale/cross-session rejection.
Admission error classification distinguishes missing authentication, account or
organization denial, and unavailable explicit models using fixed safe messages;
unrelated runner integrity errors keep their original classification.

## Complete provider-pack proof

The [retained packaged-launch evidence](../../packages/paperclip-runner/test/fixtures/copilot-provider-pack-darwin-arm64-1.0.88.json)
records clean source revision `5272fc6398d42344d1888a3f97ca6909684eefbf`,
provider-pack digest `sha256:4ba17b2455b0ab92cfe6ee223f77708379fe219792ccb66dbdef70060e6e22e1`,
the profile and native closure digests, and the exact protocol-1 initialize response.
The complete pack was built with standalone Node 24.19.0. Its packaged
`verifyAcpxProfileInstallation` registry acquired a private native command lease,
launched Copilot 1.0.88, preserved numeric request ID 0, and observed clean EOF
settlement. The native terminal-login command path is sanitized in the fixture.

The smoke uses `COPILOT_OFFLINE=true` and an explicitly configured loopback
metadata-only provider; that server received zero requests, and no prompt was
sent. This low-level packaging test deliberately does not claim production
authentication or model availability. The real host separately rejects absent,
blank, or NUL-containing explicit credentials before opening a command lease;
ambient `GH_TOKEN` and `GITHUB_TOKEN` cannot satisfy admission. A host regression
verifies that this failure releases ownership and permits a subsequent explicitly
bound retry without spawning a provider during the test. The controller now mints
a provider/session binding from explicit credential names; the sidecar rejects
unbound ambient credentials and removes the binding before native launch.
Caller-supplied binding markers cannot override the controller-generated value.
The final runner spawn allowlist now preserves the selected credential and
binding through local and remote launch specifications; regression tests cover
the complete controller-to-launcher-to-sidecar boundary. Pending direct product
backends reject before driver construction. Qualification remains available
through the existing host-controlled runnerd CLI.

Probe attempts are accounted for: an initial smoke client closed stdin before
initialize completed and was corrected; a bare unauthenticated initialize then
hit the 20-second deadline; a metadata-fixture initialize passed; the final pack
was rebuilt with the authentication preflight and passed again. After rebasing
onto foundation `5aeebb20c`, the complete pack was rebuilt and the fifth initialize
probe passed, with numeric ID 0, clean EOF, and zero fixture HTTP requests. All
five attempts were local with no credentials or inference. After the final
foundation `f80c312cd` and Copilot review fixes, the complete pack was rebuilt
and a sixth initialize probe passed with the same results. After foundation
`7721662f2` fixed the final spawn boundary, the pack was rebuilt from the source
above and a seventh initialize probe passed. All seven probes used $0 model and
infrastructure spend. There was no Daytona
deployment. The candidate remains unqualified.

Final focused checks at the source revision above passed: 200 Copilot/provider-host,
environment, backend-admission and durable-control-plane tests (including four
retained-evidence cases), 12 strict
builder/materializer, candidate-registry and probe-cleanup tests, all six Daytona
image-content tests, and the runner
TypeScript build including generated schema checks and verified sidecar bundles.
The evidence update itself passed the four evidence cases again. The complete
pack remains inspectable at `/tmp/paperclip-copilot-launch-boundary-pack-20260928`
on the build host; the sanitized tracked fixture provides the portable proof.
The exact Docker resolution command, seeded from the tracked lockfile, produced
`650e23d20e967bcfbfced888e131199b9a06e66a1ba4f64cfb68383b59def4a8`, matching
the reviewed image pin; the subsequent frozen runner install passed. Generated
lock changes remain uncommitted. These checks do not substitute for live GitHub
or product/Daytona qualification.

```sh
/path/to/standalone/node packages/paperclip-runner/scripts/build-provider-pack.mjs /absolute/provider-pack --candidate-providers=copilot
/absolute/provider-pack/node_modules/node/bin/node packages/paperclip-runner/scripts/copilot-provider-pack-smoke.mjs /absolute/provider-pack
```

Both Copilot builder scripts are explicit Daytona image hash inputs. The selected
`copilot` candidate also changes image identity, while manifest qualification stays
`pending`. Linux x64 binaries are pinned and buildable; live Linux/Daytona behavior
still requires the qualification cases above.


## Authenticated qualification preparation (2026-09-28)

The [sanitized authenticated discovery](../../packages/paperclip-runner/test/fixtures/copilot-authenticated-discovery-1.0.88.json)
uses the previously verified native pack and a dedicated, short-lived personal
Copilot Requests token, explicitly bound as `COPILOT_GITHUB_TOKEN`. The token has
no repository write authority. No credential, account identifier, provider
session ID, or private path is retained in that fixture.

Three metadata-only sessions were created and closed: catalog discovery,
`session/set_model`, then `session/set_model` plus `session/set_config_option`
with exact `gpt-5.6-luna` echo. The native catalog advertises 21 model IDs and
marks Luna enabled. No `session/prompt` request was sent. This verifies auth and
model selection only. The reproducible metadata probe is
`scripts/discover-copilot-acp.mjs`; it refuses any outbound method outside its
closed initialize/new/select/close list and denies unexpected inbound requests.

The initial paid qualification reservation is $2 within the provider's $25
allocation and shared $100 budget. The account dashboard baseline is 0 of 1,500
included AI credits; additional paid usage is disabled with a $0 cash budget.
Included credit consumption must still be reconciled and reported separately
from cash charges. The [sanitized first live proof](../../packages/paperclip-runner/test/fixtures/copilot-canonical-live-proof-2026-09-28.json)
records one `get-task-context` turn completed in 33.383 seconds: one authenticated
semantic call and successful result, completed terminal, complete transcript and
mock-only boundary all pass the unchanged canonical scorer. The first attempt
failed before prompting because a stale Rust binary omitted credential binding;
the fresh source-built release binary fixed admission. The live attempt's
post-turn package-provenance lookup failed, so the same retained artifact was
scored offline after regenerating the exact source tarball. Both original
failure records remain inspectable; recovery sent no additional model prompt.
The sibling launcher now validates that tarball before paid work.

The receipt reports 24,258 input tokens, 11,781 cached input tokens and 441 output
tokens. Its $0.00326022 catalog estimate is not a GitHub charge. The runner's
`providerRequests: 1` is a terminal receipt count, not an observed count of
upstream HTTP requests. GitHub still displayed 0/1,500 credits after this small
turn; lag or rounding prevents exact credit attribution. Additional paid usage remains disabled with a $0 budget; that billing boundary
does not imply zero consumption of included credits.

The pinned CLI documents `--max-ai-credits` as a soft cap, minimum 30 credits.
Its ACP startup/session implementation does not propagate that option into
`sessionLimits`, unlike the native interactive/server paths; ACP exposes no
budget configuration option. Treat provider-enforced per-session credit limits
as unavailable through this pinned integration (P1 follow-up: upstream ACP limit
support). The 60-second deadline, $0.50 declared envelope and $2 reservation do
not become a per-response hard cap. All profiles remain pending until the full
local and Daytona qualification succeeds.


## First local Product result and accounting defect (2026-09-28)

The [retained local Product proof](../../packages/paperclip-runner/test/fixtures/copilot-product-live-proof-2026-09-28.json)
records `extended-harnesses.runner-acpx-copilot.local.hello-complete` from committed
source `bcc9c638a25b91b84065f12633f083bd4f7a689f`. The first attempt passed all six
behavior matchers in 38.436 seconds, with one provider turn, no automatic retry,
and successful cleanup. Browser evidence shows the exact completion marker once,
the task marked Done, the Copilot agent, and expandable tool activity. The active
turn deadline was 120 seconds within the existing $2 reservation. This is one
basic Product case, not full local or Daytona qualification.

The original result is retained unchanged with digest
`sha256:92c8aff3960e443be0c009c891d49d285476c3d6b67999fe97bb323076c4dc8b`.
It exposed a shared accounting defect: model-family inference labeled the biller
`openai`, while missing provider cost became `costUsd: 0`, `costStatus: reported`
and `billing.complete: true`. Those fields are invalid accounting evidence. The
correct biller is GitHub, provider USD cost is unknown, and the retained behavioral
pass must not be interpreted as accounting qualification. The shared server fix
was incorporated before the following file and question cases. The original
result also lacks source SHA fields; the independent launcher manifest records
the exact committed source above.

After this case, GitHub displayed 1 of 1,500 included AI credits consumed across
the successful protocol and Product turns together. Exact per-run credit use
remains unknown. Additional usage is disabled, with $0 of the $0 cash budget
spent; included-credit consumption is reported separately. The Product receipt
contains 31,332 input, 15,451 cached input and 337 output tokens, without a verified
USD receipt.

The shared eval CLI now preserves completed provider outcomes while returning a
separate nonzero accounting failure when cost coverage is unknown or its bound
is exceeded. The sibling scorer retains semantic assertions under
`accounting_failure`; roster and campaign orchestration stop subsequent queued
cases. External dashboard reconciliation does not override the CLI budget
result. Profiles remain pending until the outstanding qualification matrix passes.

## Merged-source local Product coverage (2026-09-28)

The [retained merged-source proof](../../packages/paperclip-runner/test/fixtures/copilot-product-merged-live-proof-2026-09-28.json)
records both successful behavior and failures without rewriting original results.
The file and question cases used source `ee9536001fbe733b2386dd3379730a4e0be59488`,
an immutable runnerd whose Rust tree matches that source, and verified native
assets. A separate complete compiled pack has digest
`sha256:809ea6bef2fc1122ef214840d119f37854598007ff7449189027294b0802a681`.
Targeted validation passed 67 provider/contract tests, 11 packaging/script tests,
93 Product harness tests, and the TypeScript/verified-sidecar build. The packaged
offline registry launch also passed without a prompt or fixture HTTP request.

| Local case | Retained result | Accounting and remaining limits |
| --- | --- | --- |
| File edit and validation | 7/7 matchers passed in 59.696s. Native shell output proves the file was edited and compared successfully; the downloadable file, exact marker and Done status were visually checked. | Correct GitHub biller, `unpriced`, absent USD field, incomplete billing. Native raw output contains exit code 0, but normalized typed `exitCode` is absent; follow-up P2 is preserving this structured result. |
| Question and continuation | 4/6 matchers passed in 102.939s. Cobalt was selected through the real question card and continuation reused the same provider session. The final output was literally `[terminal marker]`, so the exact-marker checks failed. | Original run-log events and the browser screenshot confirm provider behavior, not public redaction. No retry or grader relaxation. Continuation is GitHub/unpriced. The paused first run incorrectly said `reported` with no cost and zero counters; separate fix `c276496e4` keeps absent cost unpriced and passed 13 accounting tests. |
| Plan approval | Failed after 9.531s during embedded PostgreSQL bootstrap, before any provider call. | Host semaphore exhaustion was independently confirmed. The failed attempt is retained and does not qualify plan behavior. |
| Controller restart | Not executed. | Held before launch because the same host resource exhaustion affected other Product and DB checks. |

The two inference cases each had a 120-second active deadline, a 300-second outer
deadline, a $2 reservation and zero automatic retries. GitHub's displayed included
credits moved from 1 to 2 after the file case and from 2 to 3 after the question
case. Additional paid usage stayed disabled with a $0 budget and $0 cash charge.
Display deltas are not exact per-request credit receipts; provider USD remains
unknown. At that historical checkpoint, five provider turns were observed; the underlying
HTTP model-request count is unavailable. No additional paid attempt is running.
Later plan, restart and native risk-probe results follow below. This checkpoint
remains unchanged as historical evidence; its failed question result is not erased.

## Final shared-source packaging checkpoint

The [final pack proof](../../packages/paperclip-runner/test/fixtures/copilot-provider-pack-final-2026-09-28.json)
uses committed source `8aa867b64d5fc2fd62cff110bd000addf5dc54de` on foundation
`f063fbf2b`, including the paused-cost and bounded native-copy fixes. Pack digest
is `sha256:627992ea80e8be7154d07cbc9925b781519199e25690b02d4a044f44342e6bd8`.
Two clean resolutions from the tracked manifest graph and lock produced identical
dependency bytes, SHA256 `aa97f89ba8a7c63573114dda54895523d316df67956c65eeccbc89d3166bb1b4`;
the frozen filtered install passed and no generated lock is committed. The
packaged registry probe again initialized numeric request 0 and closed cleanly,
with no credential, prompt or fixture HTTP request. TypeScript and sidecar build,
68 provider/contract tests, and 11 builder/script tests passed at this checkpoint.
The refreshed immutable runnerd has the matching Rust tree and digest
`sha256:e6a9fb5170b76a49b8411834b3706e8edf8f1a1ae85ad13b55368158aa7f67a0`.
This packaging proof does not rerun or supersede the live results above. Additional
Product starts are held while host PostgreSQL semaphore capacity is restored.

## Real-service permission and detached-command probes

Two subsequent single-turn probes used exact `gpt-5.6-luna` through the final
pack's verified native command lease, with isolated configuration, no ambient
credentials or MCP servers, and a dedicated explicitly bound token. Probe source
`47eed960b380e8c8054eb19985aaefeabc6336c3` is retained in
`scripts/qualify-copilot-acp.mjs`. Five credential-free probe tests include actual
JSON-RPC framing, numeric request ID 0, native option identity and process reaping.
Each live probe had a $2 reservation, 120-second prompt and 180-second outer
deadline, an awake supervisor, and zero retries.

- [Denied write](../../packages/paperclip-runner/test/fixtures/copilot-live-denial-2026-09-28.json): Copilot requested a native file edit at 7.177s. The client returned its exact `reject_once` option for request ID 0. The turn ended at 7.187s and all 79 filesystem observations through 12.837s remained absent. Native exit and owned process-group cleanup passed.
- [Detached command](../../packages/paperclip-runner/test/fixtures/copilot-live-detached-2026-09-28.json): the native tool call explicitly requested `mode: async`, `detach: true`. Only the exact finite three-second marker command received `allow_once`. Native output confirmed the detached shell exited 0 at 10.083s; the marker was present before the 10.675s terminal response and remained correct through cleanup.

These are actual GitHub-service results, distinct from the earlier loopback
fixtures. They qualify these two narrow file/command oracles only. They do not
prove all tools, an arbitrarily long detached process, governed Product approval
surfaces or Daytona execution. Authoritative USD remains absent. GitHub's display
was still 3/1,500 included credits after denial; display granularity or delay
prevents a zero-use claim. The post-command dashboard also remained at 3/1,500 included credits,
with additional usage disabled and $0 cash charges. Exact per-probe credit use
remains unknown. The overall candidate remains pending.

## Semantic plan after host capacity recovered

A separately authorized [Product plan attempt](../../packages/paperclip-runner/test/fixtures/copilot-product-plan-live-proof-2026-09-28.json)
passed all six matchers in 45.625 seconds at source
`c06fc5fccc88f5816450434493451b9d2d339125`, using the final provider pack and updated
immutable daemon. The original PostgreSQL startup failure is retained separately;
this was one explicit new attempt with no automatic retry. Browser review shows
the complete Plan revision 1, a confirmation targeting that exact revision,
the approval message and the exact terminal marker once.

This is Paperclip semantic planning. It does not enable Copilot's unwired native
`exit_plan_mode` responder. The approved continuation deliberately opened a fresh
session after the adapter configuration changed and `forceFreshSession` was
requested, so this case does not prove warm-session reuse. Both paused and
completed runs now correctly report GitHub and `unpriced` with no USD field,
including the paused run's zero normalized token counters. Cleanup passed and
the retained fixture process audit found no remaining owned processes.

GitHub subsequently displayed 5/1,500 included credits, an aggregate increase of
2 from the snapshot before the denied-write, detached-command and two-turn plan
batch. Display delay and granularity prevent allocation among those calls.
Additional usage stayed disabled with a $0 budget and $0 cash charge. Provider
USD remains unknown; this external reconciliation is not an authoritative
per-turn cost receipt.


## Controller restart and pending question recovery

The [retained restart proof](../../packages/paperclip-runner/test/fixtures/copilot-product-restart-live-proof-2026-09-28.json)
passed all six matchers in 50.875 seconds at source
`19ca0f558d3aebddedc6ff14836ff3e71498e68e`, using the same final pack and immutable
daemon. The exact pending Cobalt/Amber interaction remained visible after server
restart. The board selected Cobalt; the continuation reused the same persisted
provider session and emitted the exact terminal marker once. Screenshots show
the recovered question, selected answer and Done task. This proves controller
reconnect with a preserved session, not reconstruction after provider death.

Both paused and completed receipts are GitHub/unpriced with no USD field. The
continuation reports 49,436 input, 44,075 cached input and 418 output tokens.
Cleanup passed, the bounded supervisor exited successfully and an exact owned-root
process audit found no retained processes. This was one explicit attempt with
two provider turns, no automatic retry, a 120-second active deadline, a 300-second
outer deadline and a $2 reservation. The earlier standalone question's literal
`[terminal marker]` failure remains unchanged and continues to block its cell.

Eleven provider turns have now been observed across the canonical, Product and
native risk probes; the number of upstream HTTP model requests is unavailable.
GitHub displayed 5/1,500 included credits both before and after restart, with
additional usage disabled and $0 cash charge. Display delay and precision mean
that the unchanged counter cannot prove zero included-credit consumption. This
external reconciliation remains separate from unknown provider USD. No further paid prompt is
authorized or running from this branch. The profile remains pending.

Final provider checks after these evidence updates pass 74 focused TypeScript
tests and 24 packaging/discovery/risk-probe tests. The discovery regressions cover
rejecting the mutable `auto` model selector, releasing leases on early setup
failures, and rejecting pending RPC calls immediately after native exit or
malformed output. These probe-script changes do not alter the final runtime pack.

Review tightened the denial probe to require the native `rawInput.fileName` to
resolve to the exact marker target. An unrelated edit or a command merely
mentioning the marker cannot satisfy the oracle. The original paid denial names
that exact target; offline replay of its retained wire and marker observations
passes the corrected oracle. The fixture records the original evidence and oracle
script digests. No additional provider prompt was sent.


## Linux image initialize-only proof

The [Linux x64 pack proof](../../packages/paperclip-runner/test/fixtures/copilot-provider-pack-linux-x64-2026-09-28.json)
uses image `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:5457769683fd310223d3b0d4f1ed9a6cf341bdb16514746b3aaeabca2e888fee`
from the same source `8aa867b64d5fc2fd62cff110bd000addf5dc54de`. Its platform-specific
pack digest is `sha256:b11984fe02bd5d5a36b01ed559d2f4c765663df09a46117d3092b1183be08ba4`.
The verified executable matches the Linux pin, initializes Copilot 1.0.88/ACP 1
with request ID 0, and exits 0 after stdin EOF. The maintained smoke script ran
under network-none, a read-only root and private tmpfs, with no provider
credentials and zero fixture requests or inference. Missing-token production
preflight still rejects. Two earlier operator invocations used the wrong image
repository or Node path and failed before provider launch; both are retained.
This is Linux packaging evidence, not an authenticated Daytona Product run or
model qualification. The profile remains pending.

### Bounded native tool observations and protection evaluations

The sidecar and direct TypeScript driver share one projector under `drivers/acpx`,
which projects an allowlist of active-turn ACP tool/permission fields into
existing `provider.notice.recorded` details and provenance: validated relative target,
request/tool identities, command SHA-256, explicit mode/detach, and linked shell
start/completion with provider-reported exit code. Session passthrough notifications
remain uncorrelated and cannot supply this evidence. Native ACP exposes an execution
kind, not a trustworthy `bash` name in the title. Strings use semantic redaction;
ambiguous identities, exhausted bounds or failed projection make evidence incomplete.
Projection cannot change permission delivery or terminal authority. This is an additive
observation change: Copilot profile v4 is unchanged, while source/pack provenance
changes. Older sessions lacking these notices cannot pass the new evidence oracles.

The manual local `copilot-protection` Product suite registers an exact browser-denial
case with explicit cancellation and a finite attached-command settlement case. Both
remain unqualified until separately built and run. The denial case expects an unfinished
task/cancelled run; full restrictive workflow completion is still a gap because later
MCP permissions must not be auto-approved from provider-controlled titles.

A separate credential-free real-binary fixture on 2026-09-29 exercised Copilot1.0.88
(executable SHA-256 `a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3`)
against a loopback synthetic model. It started an eight-second attached async command;
the model immediately returned terminal text while the process was still live. The
binary itself issued a read-shell update, and process absence plus the marker were
observed before the ACP prompt result. The model never called `read_bash`. The private
`copilot-v4-protection-preparation/adversarial-attached-v2` receipt retains monotonic
ordering and process identity. This verifies one pinned finite attached scenario and
is distinct from detached-policy rejection or comprehensive background qualification.
