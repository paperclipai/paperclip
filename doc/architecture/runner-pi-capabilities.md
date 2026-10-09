# Pi rich ACP runtime

## Current integration — 2026-10-08

The experimental Runner admits **Pi profile 22** (`sha256:e92078bee3c23bec4100aa589013a44613d054cd686826534025d8019e9f39a9`) and
**Cursor profile 15**. Copilot remains pending at **profile 17**. Legacy
`pi_local` is unchanged. Pi accepts any explicit caller-selected provider/model
ID and requires native acknowledgement; qualification models are examples, not
an allowlist or a fallback.

The requested task execution and human-control paths have seven passing cloud
cases on profile 19 with the accepted Sonnet 4.6/low fixture. Profile 22 retains
that wrapper, helper and extension, incorporates master's environment changes,
patches brace-expansion to the official 5.0.12 payload, and excludes general AWS
IAM credentials from Pi's environment. Bedrock's provider-scoped bearer key is
supported. Those paid results retain their original profile-19 identity;
current integration is verified separately by source, package and CI checks.
Accounting and the wider platform/provider matrix remain deferred. See the
[readiness plan](../plans/2026-10-02-pi-production-readiness.md#current-delivery-scope--2026-10-08)
for the exact source/image evidence and merge status.

All dated checkpoints below describe historical qualification attempts. Their
failures and profile numbers are retained; they are not current release gates.

## Historical Pi 1.0 candidate (2026-10-02, profile v13)

Pi remains pinned to **`@earendil-works/pi-coding-agent@1.0.0`**, with
`pi-acp@0.0.33`, ACPX `0.13.1`, and Node `24.21.0`. Profile 13 adds explicit
reasoning-mode selection and rejects previous profile identities. It is a new
qualification candidate; profile-12 results below remain historical evidence.

Pi's new field also changes four shared files covered by Copilot's source
identity. Copilot therefore advances to a still-unqualified profile v13 without
changing its executable or model. Pi's profile-13 identity and native closure
remain unchanged. Final artifacts must bind the corrected source; the initial
ARM startup and 61 contract passes alone do not establish production readiness.

The normal Pi configuration records `piThinkingLevel` as `off`, `low`, `high`,
or `max`. New configurations and qualification cases explicitly select `low`.
The runner binds that setting to the session identity and requires native
confirmation of the effective level before sending the prompt, including after
session restoration. An unsupported level, absent acknowledgement, or effective
level different from the requested value must fail admission. Changing the
level requires a new compatible session; a warm session cannot silently retain
its previous setting.

The wrapper obtains available levels from Pi's native
`get_available_thinking_levels` RPC, exposes them through ACP session modes and
the `thought_level` configuration option, and confirms changes with native
`get_state`. This avoids advertising the static `minimal`, `medium`, or `xhigh`
aliases when the selected model does not support them. For the pinned DeepSeek
model, Pi 1.0 supports `off`, `low`, `high`, and `max`. Pi's implicit `medium`
default resolves to `high`; Pi 0.84.2 also resolved that default to `high`, so
this is a configuration gap rather than evidence of a new Pi 1.0 default.

The [provider-free wire proof](../../packages/paperclip-runner/test-fixtures/pi-acp/thinking-modes.v13.darwin-arm64.json)
records actual Pi 1.0 request bodies changing from `high` to `low` through ACP,
truthful `max` restoration, blocked non-loopback connections, and owned-process
retirement. Synthetic responses establish propagation, not paid qualification.

The paid profile-12 hello passed in the actual installed application. Its first
question continuation failed at the unchanged 120-second native deadline after
1,019 reasoning deltas and no emitted tool call or question. The required tool
was present with its exact schema. This establishes model activity without the
required interaction; it does not prove the reasoning setting caused the timeout.
The test remains failed. Profile-13 deterministic, local paid, Runner, native
control, and Daytona results must be established independently.

| Capability | Native / ACP surface | Paperclip surface | Remaining boundary |
| --- | --- | --- | --- |
| Supported thinking levels | `get_available_thinking_levels`; ACP available session modes and `thought_level` choices | Pi reasoning-level configuration | Model selection is explicit and unrestricted; historical qualification used the recorded model and level. |
| Set and verify thinking level | Native `set_thinking_level`, then `get_state`; ACP `session/set_mode` / config option | Saved agent setting, typed runner input, effective-mode admission | Live setting changes during an active turn are not exposed; a new compatible session is required. |
| Recover selected level | Native restored state plus explicit effective-level verification | Mode-bound durable session identity | Old profiles and missing or mismatched mode identity cannot reuse a warm session. |
| Provider notice severity and pricing provenance | `paperclip/pi_notice` and canonical `provider.notice.recorded` | Retained run event, usage metadata, and safe summary with severity in the activity row | Summary/severity rendering has deterministic coverage; paid visual verification of the rebuilt UI remains pending. Pricing estimates remain distinct from provider billing receipts. |

## Historical profile-13 qualification checkpoint (2026-10-02)

The installed candidate from source `eac50643213d0902a93a5384bae2f1d6c065c9f2`
uses Pi 1.0.0, the explicit OpenRouter DeepSeek model above, and verified `low`
reasoning. Paid local Product E2E passes cover hello, semantic question/answer
continuation, all four native question forms, and human permission denial with
no file side effect. The paid extended Runner `get-task-context` case also
passes through the packaged runner against its authenticated, seeded test
control plane. Runner protocol evidence does not qualify the Product UI.

Three local attempts remain failed: file-edit validation, pending-input
controller restart, and three-turn warm continuation. The first two exposed
assertion gaps: streamed command output supplies the exit receipt, and a
pre-start submission may precede assignment of the native turn ID. Narrow
fixture repairs have positive and negative coverage; neither failed attempt
has been regraded and both require fresh live runs.

The warm attempt completed its first turn and edited files on its second, but
its final semantic tool stayed pending until the existing deadline. OpenRouter
metadata joins the exact native session and records the final response as
cancelled with no finish reason. This supports an unfinished upstream response
at cancellation; it does not establish why the response stopped progressing.
A real pinned SDK/wrapper replay proves both restored-session completion with
the new agent home and completion contract, and safe cancellation when complete
tool JSON arrives without the provider's stream finish marker. The latter
executes no semantic mutation. No timeout or runtime policy was changed to make
that replay pass.

Fresh builds must incorporate the subsequent launch, UI, and fixture fixes.
macOS Intel startup, the remaining local and Runner cases, Linux/Daytona, and
final source-wide checks remain qualification gates. The provider remains
unqualified until that evidence is complete. API-key usage observations cover
the capped qualification campaign; native pricing estimates are not bills.

## Historical Pi 1.0 profile-v12 checkpoint (2026-10-02)

The candidate now pins **`@earendil-works/pi-coding-agent@1.0.0`** with
`pi-acp@0.0.33`, ACPX `0.13.1`, and portable Node `24.21.0`. Pi v11 and older
sessions must reopen. Cursor v10, Copilot v12, and legacy adapters are unchanged.
This is a new runtime candidate: historical Pi 0.84.2 passes do not qualify it.
Local Product, Runner protocol, and Daytona paid qualification remain pending.

The [official release](https://github.com/earendil-works/pi/releases/tag/v1.0.0)
points to commit `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`. The npm archive
is verified against published SHA-512 integrity
`/FtbxoSQU/mEv1QnichJjRjqteqaIaMWxmhB4G367+MwZfX7/DI5B9YAg5lqbN7nztFskBEtUSZ+FlmMBECtMw==`
and has SHA-256 `638ed3abbe54ef70cbf8673ae4bc531e791613756aac04644cfcdcc4af0fafaf`.
The isolated npm lock preserves the complete upstream shrinkwrap, supplementing
seven Pi-family entries' omitted integrities from their exact npm 1.0.0 records.
Upstream now pins Undici 8.10.2 itself; the previous 8.9.0 replacement is removed.

Profile v11's first local hello failed on its first streamed update: Pi 1 RPC
removes `message` and `partial` from deltas, while the wrapper required the old
shape. The run stopped and the task became blocked; this was a runtime
compatibility failure, not a successful hello. V12 binds deltas to the original
message occurrence, tracks indexed tool fragments, and checks completed text,
thinking, tool identity, and arguments against native final receipts. Real Pi 1
RPC/owned-extension tests reproduce the failure and pass the repaired local-only
get-context → finish path, interleaved tools, and a sanitized provider error.
These synthetic loopback responses establish compatibility, not paid qualification.
Pi may also send a native final message without streamed blocks. That receipt
is preserved without inventing deltas; only observed completed stream blocks
are checked against its indexed content. Error or aborted receipts may retire
incomplete blocks, but cannot contradict blocks already completed.

Runtime failures now emit bounded known reasons before prompt rejection. Raw
exception bodies, credentials, paths, and unknown text stay withheld. Actual
provider token usage still comes from native completed receipts; fixture usage
is not live billing evidence. New wrapper/helper closure pins and Rust admission
constants require fresh platform packs and daemons. Historical v11 artifacts
must not be relabeled as v12.

Compatibility changes preserve the existing rich runtime surface:

- Native steering and follow-up acknowledgements now carry `disposition`.
  Only `queued` is accepted as delivery; `handled`, missing, or malformed
  dispositions fail visibly. Settlement still waits for `agent_settled`.
- Pi defaults streaming cache warming to enabled. The owned extension overrides
  every `cache_warming_decision` with `stop`; no background model refresh is
  authorized by an active or completed Runner turn.
- Pi's new built-in extensions are disabled by the existing `--no-extensions`.
  The explicitly loaded Paperclip extension still supplies assigned MCP tools,
  native questions, permission decisions, instructions, and registered agent files.
- Structural `system` message boundaries carry prompt/tool declaration changes.
  They pass through without assistant IDs or final-answer authority; malformed
  structural frames and overlap with an active assistant still fail closed.
- Pi's transcript-context API replaces the old provider `context.tools` view.
  Provider-free SDK tests read current declarations through Pi's canonical helper;
  production RPC parsing keeps message/tool boundaries and usage intact.

The upstream [changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md)
and [RPC interface](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/rpc.md)
add capabilities which must not be confused with wrapper support:

| Priority | Native Pi 1 capability | Runner status and reason |
| --- | --- | --- |
| P1 | Codemode, nested calls (`parentToolCallId`, `nestedCalls`), deferred tool search, exposure/annotations/output schema | Available upstream; built-in extensions remain disabled until nested provenance, permission checks, and output projection are qualified. Assigned semantic MCP tools retain direct exposure. |
| P1 | Native MCP OAuth, provider-auth HTTP MCP, OAuth issuer/scope hardening | Available upstream; arbitrary MCP/auth discovery is outside the closed assigned bridge. Paperclip owns credential and company scope. |
| P1 | Image generation and classifier calls through `ModelRuntime`/codemode | Available upstream; not exposed because separate model calls need budget attribution and artifact admission. Text/image tool-result transport remains supported. |
| P1 | `clear_queue`, per-input queued/handled disposition | Disposition is checked now. Queue clearing still needs a durable Runner cancellation contract; Stop continues to abort the owned active process/turn. |
| P2 | Append-only context edits, actionable `turn_end`/`agent_before_settle`, `context_with_system` | Available upstream; only existing observation hooks are installed. Host-directed edits need durable recovery semantics before exposure. |
| P2 | Provider stream hooks, virtual models, per-model compaction/image sizing | Available upstream; no arbitrary provider extensions or virtual routing are admitted. Native compaction and existing model configuration remain supported. |
| P2 | UI prompt lifecycle events and richer startup/fullscreen TUI | Native UI exists; Runner uses RPC and its existing question/wait states. No terminal TUI is advertised. |
| P2 | Fork/clone/history export | Native RPC capabilities remain available upstream; durable branch lineage and contained exported-artifact handling remain required before Runner controls expose them. |

Pi's published CLI mode union is `text | json | rpc`; no native ACP mode is
present in this release. The reviewed `pi-acp` wrapper remains necessary.


## Explicit Linux companion setup for a Mac controller

A Mac controller needs independently verified Linux runner bytes for Daytona.
Its host Pi installation is not a Linux provider pack. The operator imports a
release companion once, before launching agents:

```sh
paperclipai runtime import-remote /path/to/release/linux-x64 --sha256 MANIFEST_SHA256
```

Obtain `MANIFEST_SHA256` from the trusted release channel, separately from the
copied directory. The directory contains `companion.json`,
`bin/paperclip-runnerd`, and the complete `provider-pack/`. Import verifies the
installed server's exact build commit, qualified Pi profile, Linux x64 ELF,
manifest digest, and every file, mode, directory and contained symbolic link.
External hardlinks, escaping links, extra or modified files, and unsafe modes
are rejected. This command performs no network requests or model calls and does
not run the Linux executable on the Mac.

The destination is the private `remote-companions/linux-x64` directory beneath
the actual installed `@paperclipai/server` package. It must be writable by the
operator, outside the task workspace, and protected with the same host access
controls as the server installation. It is not an agent workspace or a remote
image's self-reported authority. An existing different or damaged installation
is never replaced automatically. Stop all runs before an operator removes or
upgrades that cache. Verification and copying use asynchronous 1 MiB chunks,
yield between chunks, and enforce the same full inventory and ten-minute bound.
Directory entries must retain owner read/write/search permissions so failed imports
can drain their owned cleanup. SIGINT/SIGTERM are deferred through owned filesystem
phases and drain cleanup;
an uncatchable kill or host failure leaves the import unadmitted until the
operator resolves its retained lock or incomplete directory. Do not move the
cache into a task workspace to work around permissions.

Normal remote Pi resolves this authority without binary or pack environment
overrides. The controller re-verifies its complete inventory and uses the exact
Linux daemon identity. Existing remote verification compares image bytes against
that local authority; a mismatch takes the existing verified upload path.
Controller restart and warm-session recovery retain the original Runner artifact
identity checks. Cursor, Copilot and explicit operator overrides keep their
existing admission rules.

For release maintainers, assemble the Linux daemon and default provider pack
for the **same final commit** as the public server/CLI packages. A reused daemon
requires complete native source/config/protocol input equality and retains its
original compiler/build provenance; the manifest does not claim recompilation. In a fresh
release directory place those outputs at `bin/paperclip-runnerd` and
`provider-pack/`, preserving the pack's relative links and modes. Then run the
source-owned manifest generator after building the matching server:

```sh
node scripts/create-runner-remote-companion.mjs /path/to/release/linux-x64 FINAL_SOURCE_SHA
```

Publish the complete companion directory (or distribute it through the normal
trusted release channel) together with the printed manifest SHA256 and the
source/profile/platform provenance. The import command accepts an already
extracted directory, not an archive or URL. The release companion must remain
available with that release; a short-lived qualification artifact is not a
release distribution. No release publication is implied by the tests here.

Build/publish the Daytona image from those same daemon/pack outputs and configure
its immutable OCI digest through the ordinary Daytona environment `image` field.
The image digest and companion manifest are output metadata, not new source
constants, so publication does not require another source commit. The final live
proof must use the installed public CLI, this import command, and ordinary image
configuration without E2E remote binary/provider-pack overrides. That installed
and paid proof remains pending.


Historical v10 qualification checkpoint (2026-09-30): **Pi profile v10 remains unqualified.** The capped-key/login prerequisite remains blocked. Native USD is unknown. The optional private budget helper is not integrated; Cursor's account-cycle cap does not establish Pi's provider spending bound. V10 keeps the native wrapper and closures unchanged, binds the shared ACPX patch under a new digest, and rejects v9 sessions. Fresh exact-runtime admission and final controller verification remain pending.

Historical v9 checkpoint (2026-09-30): **Pi profile v9 remains unqualified**. Current runtime source is `5b8e4454ef0bf12d0bb068c2e41d8c9df9356a1c`; controller/Product harness source is `40064d28522de25fea85c1297f35b41bb8a8897a`. Runtime builds for macOS ARM64/x64 and Linux x64 are complete. No paid profile-v9 pass is claimed. A credential with a verifiable spend limit is still needed for the remaining paid qualification. The optional transport-budget candidate is frozen on a separate branch and is not integrated or a live spending guarantee. See the [comparative capability report](runner-rich-acp-capabilities.md) for current qualification gates and the field audit. The dated observations below retain their original profile identities.

Historical implementation candidate, 2026-09-29: profile version 8 repairs
native assistant-message attribution. Real SDK `message_start` and `message_end`
boundaries, including empty messages, carry occurrence IDs through ACPX, the
sidecar and both terminal reducers. Tool-use, error and aborted messages remain
progress but cannot become a final answer. Missing or conflicting boundaries
fail closed. Loaded history has a separate display-only identity. Retry,
compaction, extension and command notices retain bounded, redacted severity and
metadata on `paperclip/pi_notice`; they are never assistant final content.
The [v8 declaration](../../packages/paperclip-runner/test-fixtures/pi-acp/profile-v8-identity.json)
also pins the shared ACPX parser and Pi host projections. Previous sessions must
be reopened. No paid profile-v8 qualification has run.

The retained profile-v7 campaign passed native questions (15/15), then failed
question continuation (5/6): the model emitted the exact final marker, but the
old terminal reducer combined it with pre-tool narration. That failed Product
result remains a failure; the remaining five cells were not launched. The v8
credential-free regressions reproduce this boundary through the actual pinned
SDK (fresh, warm and loaded sessions), patched wrapper, ACPX transport, sidecar,
TypeScript driver and Rust reducer. This is deterministic repair evidence, not
a replacement for the failed paid journey.

Historical profile version 7 repairs
MCP tool-name admission and native question labels. MCP names containing colons
or periods, or exceeding model name limits, receive deterministic collision-checked
aliases of at most 64 characters; authenticated calls retain the exact original
name. Titles and select labels admit at most 1,000 UTF-16 code units, matching
the canonical question contract. Invalid owned arguments fail before a UI promise;
unsupported external UI requests emit an explicit error notice and stop the session.
The editor draft requires the shared `initialText` normalization and editable UI
roundtrip. Blank initial drafts are valid, but accepted empty or whitespace-only
input/editor answers are not currently representable: the canonical required-text
form prevents submission with a required-answer message, and its response
validator rejects blank text. Making
Pi fields optional alone would still drop those answers; no adapter fallback
invents an empty response. The transport distinguishes empty accept from cancel,
but that direct bridge property is not full Product support. A future explicit
canonical empty-text opt-in would need matching persisted-response and UI checks.
These repairs change the native closure and require fresh qualification. Profile
v7 has paid Product hello passes on local source `807feaecf` and Daytona source
`bd4cc29c3`; the latter passed all six matchers with complete owned cleanup.
The [qualification checkpoint](runner-rich-acp-qualification-2026-09-29.json)
retains exact profile, runtime, image and billing identities. Remaining Product
journeys, native interactions and platform coverage are still unqualified; the
`bd4cc29c3` local campaign passed hello and stopped at native questions: all
15 behavioral checks passed, but the required API evidence snapshot was absent.
The failed result is retained and the six later cells did not launch. A committed
harness-only fix captures the complete final API evidence; its paid retry passed
all 15 native-question checks. The following question-continuation case reached
Done but failed the exact final-message assertion: earlier pre-tool narration
was aggregated into the final item. Three runs settled across these two cells,
all owned processes exited, and five later cells did not launch. The native
message attribution defect is repaired in v8; authenticated v8 qualification
remains pending. The canonical
[v7 declaration](../../packages/paperclip-runner/test-fixtures/pi-acp/profile-v7-identity.json)
binds the exact wrapper, helper, extension and three target closures.

Credential-free regressions run the pinned SDK with synthetic model streams to
verify all four question methods and original MCP call names behind aliases. The
actual patched wrapper proves visible unsupported-dialog failure; the real form
normalizer verifies the 1,000-unit ASCII, CJK and surrogate-pair boundaries. The
closed snapshot admission test exercises the candidate assets without inference.

Profile version 6 added the native
question tool, the authenticated agent-files root, and matching SDK path
normalization. Its authenticated Product and Runner qualification is pending.
The later v6 Product hello on source `97217c531` passed with one observed attempt
and an exclusive-key cost delta of $0.00065884. Its launcher omitted the explicit
zero-retry CLI flag, so it is retained as `passed_with_retry_policy_gap`, never
as v7 qualification.
The first frozen v6 Product hello attempt fails before provider startup because
the shared native-execution parser still admits only profile versions 1–5.
Both assignment and automatic recovery runs reject the same input; no usage
receipt exists. The early exclusive-key billing delta is $0 and cleanup passes.
The [retained failure](../../packages/paperclip-runner/test-fixtures/pi-acp/product-hello-profile-rejection.v6.darwin-arm64.json)
includes the actual local sidecar, Node, daemon, closure and pack identities.
The parser repair is included in frozen source `edf14a067`. Its second hello
attempt passes that boundary but fails at the 30-second `session.open` deadline.
No terminal usage exists; both immediate and delayed exclusive-key deltas are $0,
and all 40 owned process identities are gone. The
[v6 startup proof](../../packages/paperclip-runner/test-fixtures/pi-acp/startup-diagnostic.v6.darwin-arm64.json)
retains that failure and the credential-free diagnosis. Bounded 32-worker file
hashing and snapshot copying preserve all integrity checks, canonical ordering,
the 32 MiB snapshot batch ceiling, and fully drained failure cleanup. A diagnostic
build completes the full no-key Runner rejection in 9.8 seconds; its repeatable
protocol regression settles in 10.7 seconds and closes cleanly. A separate actual
ACP test asserts the precise missing-credential error. Timings vary with filesystem
cache and load; these are admission diagnostics, not authenticated qualification.
No timeout or provider-closure identity changes in this repair.

The opt-in regression is `node --test test/pi-closed-startup.test.mjs` from the
Runner package, with `PAPERCLIP_TEST_PI_STARTUP_PACKAGE_ROOT` pointing at a built
Runner package containing Pi assets and `PAPERCLIP_TEST_PI_STARTUP_RUNNER_BINARY`
pointing at its compatible daemon. It spawns a clean environment, submits no
prompt, asserts terminal admission rejection within the unchanged 30-second
deadline, and verifies the daemon closes. It does not inherit provider credentials.

Historical profile version 5 repairs the
Undici dependency and bundled Node runtime affected by GHSA-3wwx-pv8p-q78v.
Full authenticated v5 qualification is pending; its bounded native controls probe passes. Historical version 4 repairs native
tool ID reuse across model iterations and warm prompts; its native steering,
queued follow-up and denied-write probe passes. Historical version 3 passes cover local Product file
delivery, typed question continuation and native steering, queued follow-up and
denied-write controls. Its semantic plan journey exposed two defects: the shared
MCP display projection, now repaired, followed by a resumed-turn ID collision,
addressed by v4. Version 2 hello completion and every failure remain retained.
The wider local and Linux x64 Daytona matrix remains pending; this document does
not promote the candidate to a qualified production runtime.

At this historical pre-1.0 checkpoint, the runner pinned `pi-acp@0.0.33` and
`@earendil-works/pi-coding-agent@0.84.2`. The candidate model was
`openrouter/deepseek/deepseek-v4-flash-0731`; only an explicitly bound OpenRouter
credential may reach this profile. `patches/pi-acp@0.0.33.patch` repairs the ACP
wrapper. `pi-runtime-extension.ts` supplies the runner-owned semantic bridge and
pre-execution native tool policy. This keeps the upstream session, model,
streaming, diff, retry, and compaction implementation while making its missing
boundaries explicit.

## Capabilities and differences from Codex app-server

| Surface | Pi implementation and boundary |
| --- | --- |
| Sessions | Native Pi JSONL create/load; resume is confined to the execution's private session home and original workspace. Cold `prompt` cannot implicitly load an arbitrary session. |
| Text and reasoning | Native start/end provenance and occurrence IDs separate pre-tool narration from the last completed assistant message; empty or tool-use terminal messages cannot promote stale text. Loaded history is display-only. The common runner's private reasoning policy still applies. |
| Native tools | `read`, `grep`, `find`, `ls`, `write`, `edit`, and `bash` pass the immutable extension gate before execution. File roots and read-only mode are checked before and after a permission wait. The host sandbox remains authoritative for shell commands and races. |
| Permissions | Native tool approval uses ACP `session/request_permission`, with allow once, allow for the session, and deny. Only offered options are accepted. Session grants cover an identical operation and still revalidate paths. Questions never become approvals. |
| Questions | The owned `paperclip_native_question` tool exposes Pi `select`, `confirm`, `input`, and `editor` through ACP form elicitation. Select is single-choice with stable option IDs. Pi returns `false` for both No and dismissal of confirm, so the tool reports `negative_or_cancelled`; it never invents a confirmed answer. Other methods return explicit cancellation. Permissions and semantic Plan approval remain separate. |
| Agent files | Only the authenticated execution's registered `agent_files` working copy can become `AGENT_HOME`. The Pi wrapper takes `PAPERCLIP_PI_AGENT_HOME` from the runner's bound launch, ignores ambient `AGENT_HOME`, and admits that canonical directory alongside the task workspace. Protected overlap, directory replacement and symlink escape fail closed. Read-only policy still forbids writes. `PI_CODING_AGENT_DIR` remains private provider state. |
| Semantic tools | Runner-bound HTTP MCP catalogs (numeric loopback HTTP or assigned HTTPS gateways) register under exact `mcp__<server>__<tool>` names. Calls use an occurrence-scoped delivery ID and preserve the bounded native ID as private ACP-wire provenance, together with the cancellation signal. Common normalized events currently drop that metadata. Authenticated PRP tool handling owns semantic authorization and durable interactions. Only the exact session-assigned gateway URL and credential are used, with redirects disabled. Ambient and unassigned MCP servers are not admitted. |
| Plans and artifacts | Pi has no native structured plan or artifact channel. Paperclip plan and artifact semantic tools remain available through the MCP bridge; native file edits retain bounded, workspace-confined ACP diff projection. Tool text/image results are preserved, and resource blocks are recorded without following URLs. |
| Steering | Capability-negotiated `pi/steer` issues native RPC `steer` during an active turn. `pi/follow_up` explicitly queues native RPC `follow_up`. Neither is inferred from a second ACP prompt. Each takes `{sessionId, message}` and returns `{accepted: true, sessionId, kind}` with the matching control kind. |
| Usage | Prompt results sum actual assistant message usage receipts across continuations. Input, output, cache reads/writes, total tokens and Pi-reported pricing estimates have provenance. Context-window occupancy is not billed usage. No receipt means no usage assertion; absent cache or cost fields remain unknown. Pi calculates cost from its model catalog rates, so this is not an authoritative provider bill. |
| Retry and compaction | The pinned session notice extension preserves bounded, redacted summaries, severity and known native counters/flags separately from assistant text. `agent_settled`, rather than a transient `agent_end`, settles a prompt. A final provider error remains a failed prompt. |
| Images | The upstream ACP wrapper accepts image blocks, but `AcpxRuntimeTurnInput` and the common adapter currently forward text only. P1: implement typed image content through the common converter and then qualify the exact model; live testing alone cannot close this implementation gap. |
| Cancellation and death | Cancellation expires live UI waits and calls native abort. Pi process exit rejects pending RPC requests and all active/queued turns. Partial RPC frames, oversized frames, and malformed JSON fail closed. |
| Fork and clone | Native Pi RPC exposes `fork(entryId)`, `clone`, and `get_fork_messages`; the ACP wrapper and Paperclip controls do not map them. P2: add explicit admitted session operations and verified lineage before exposing controls. |
| HTML export | Native `export_html` is available but unused by this integration. P2: add a bounded workspace artifact export with publication policy before exposing it. |
| Durable goal and native plan | No mapped native surface. Paperclip semantic tools remain the plan path; no Codex parity is claimed. |

`initialize` advertises `_meta.paperclipPi.version = 1`, `steering`,
`queuedFollowUp`, the four question methods, `nativePermissions`, `promptUsage`,
`nativePlan: false`, and `pendingRequestRecovery: "live-process-only"`. The common
host must inspect this advertisement before sending provider extension requests.

## Native model instruction delivery (profile version 6)

The [fresh/load model-request proof](../../packages/paperclip-runner/test-fixtures/pi-acp/prompt-delivery.v6.darwin-arm64.json)
uses the actual pinned wrapper launch helper, owned extension, and Pi SDK
`AgentSession.prompt` with a synthetic model stream. Captured model requests
contain the exact composed Paperclip execution prompt, custom instruction-entry
content, and current `AGENT_HOME` guidance. A disk-loaded session retains its
prior reply while receiving changed entry content and a new agent-files root in
its current system prompt and latest task constraints. The old root is absent
from the current system prompt; historical user messages still retain prior
root text, which the current guidance explicitly supersedes.

Pi uses `PAPERCLIP_PI_SYSTEM_INSTRUCTIONS` in its runner-owned launch
configuration and appends it through `before_agent_start`. Generic ACP
`_meta.systemPrompt` is ignored, so that metadata alone is insufficient. This
proof captures the native model-request boundary, beyond host options or wire
metadata. It uses no real credentials or network inference and does not exercise
a complete ACPX/PRP process or qualify an authenticated Product journey.

## Occurrence identity (profile version 4)

Pi can reuse a native ID such as `call_0` in a later model iteration, including
within one ACP prompt. The wrapper and immutable extension now derive one live
ID from a private per-child launch namespace, a monotonic model-iteration ordinal,
and the native ID. The native `turn_start` event advances the ordinal; the SDK's
relative `turnIndex` is not authority because it resets on each warm prompt.
Permission requests, streamed tools, lifecycle updates and semantic MCP requests
share that ID. Bounded private ACP-wire provenance retains the original native
ID and iteration. Common ACPX/sidecar normalization drops this `_meta`; these raw
IDs and iteration fields are not currently UI-visible. The normalized delivery ID
itself survives the common tool and permission paths. P2: add an allowlisted
diagnostic provenance projection and UI coverage without granting the raw ID
execution authority. Historical message-index/scope metadata has the same
private-wire-only disposition.

An exact HTTP retry reuses the delivery ID and shared cached result. Reusing a
native ID for a second invocation in the same iteration, changing its arguments,
or receiving ambiguous iteration boundaries poisons identity state and fails
closed. Shared Runner bridge deduplication and Rust call tombstones are unchanged.
This avoids both replaying a mutation and mistaking a new corrected invocation for
an old cached error. Historical session replay uses a separate stable
`pi-history-` identity from session/message occurrence, explicitly marked
`history-display-only`; it never grants execution authority.

The maintained `test/pi-native-package-contract.test.mjs` regression exercises
actual pinned Pi Agent/AgentSession dispatch with an in-memory model stream,
empty authentication storage and model networking disabled. Across two warm
prompts it verifies six native iterations, relative indices `[0,1,2,0,1,2]`,
four reused `call_0` executions, extension-before-wrapper ordering, and four
matching distinct delivery/display IDs. The authenticated loopback test in
`pi-runtime-extension.test.ts` uses the real Runner semantic bridge to prove
cached validation errors, concurrent exact retries, changed-payload rejection,
and a corrected invocation in the next iteration. Installed-wrapper tests verify
lifecycle correlation and stable, disjoint historical replay identities.

The historical v5 command digest is
`sha256:020d96ccbd3c45c3f62680814776394ed5a56d9572a1a4dccda56a74d16c7803`.
Versions 1–4 cannot reopen under this identity. Paid and image proofs below remain
evidence of their recorded versions, not v7 qualification. The historical v4
digest is `sha256:2324d9b47650c12b16f8e2c44dc33637d52f1b22ba8e914623eac4049e7e1991`.

## Lifetime and recovery

A provider UI request is a live Pi RPC promise. Paperclip's durable interaction
can survive a control-plane connection loss while the runner, wrapper, and Pi
process remain alive. A response is forwarded once to that exact pending request.
If Pi or the wrapper dies, the interaction must expire; neither a new process nor
a loaded JSONL session has the original promise. Do not replay an approval into a
replacement process. Normal conversation continuation can load the private JSONL
session after a separately admitted restart.

The wrapper attaches a per-turn generation to settlement work, fails queued
turns on provider death, and bounds RPC request waits. This does not constitute a
claim of generic provider-process handoff or exactly-once external side effects.

## Version 6 native boundaries

The native file gate now applies Pi 0.84.2's path interpretation before checking
roots: `@` prefix removal, home expansion, file URLs and Unicode spaces. Native
read also tries macOS screenshot spacing, decomposed Unicode and curly-quote
filenames. Every possible fallback is checked, including its physical symlink
target, both before and after approval. The prior raw-path check could authorize
a workspace-relative spelling that the SDK subsequently interpreted outside the
workspace. The actual pinned SDK regression verifies the interpreted path and
rejects aliases to private state.

The native question tool accepts `{method,title}` plus the method's own fields:
`options: [{id,label}]` for select, `message` for confirm, `placeholder` for input,
and `prefill` for editor. There are at most 128 unique IDs and unique labels;
titles, input fields and answers have UTF-8 bounds. Unsupported fields, unoffered
answers and the reserved permission-title prefix are rejected. Exact retries of
one native occurrence reuse its pending or completed result. This tool cannot
approve a native operation or a Paperclip Plan. Durable semantic questions and
revision-bound Plan approval continue to use assigned Paperclip tools.

Credential-free tests exercise all four methods through the actual pinned Pi
AgentSession tool dispatcher and separately through the installed ACP wrapper's
form transport. They do not establish browser persistence, reconnect delivery,
provider-death expiry, or live model behavior. Those remain distinct Product
qualification requirements for version 7.

## Verified launch and packaging contract

The wrapper rejects ambient launch unless `PAPERCLIP_ACPX_ISOLATED_CONTEXT=1`.
It executes an absolute bound Node executable with an absolute bound Pi CLI path,
without a shell or PATH lookup. The common command lease must supply:

- `PAPERCLIP_PI_NODE_EXECUTABLE`, `PAPERCLIP_PI_ENTRYPOINT`, and
  `PAPERCLIP_PI_EXTENSION_PATH`: files in the immutable private provider snapshot.
- `PI_CODING_AGENT_DIR`: isolated persisted session/auth/settings home.
- `PAPERCLIP_PI_READ_ONLY`: exactly `0` or `1`.
- `PAPERCLIP_PI_READ_ROOTS` and `PAPERCLIP_PI_PROTECTED_ROOTS`: JSON arrays of
  absolute allowed skill/read roots and protected runtime/config roots. Assigned
  skills must use a separate immutable lease outside the protected runtime and
  executable roots; overlapping roots fail admission. Skill roots are always
  immutable, even when nested inside a writable workspace.
- `PAPERCLIP_PI_SYSTEM_INSTRUCTIONS`: admitted instructions, bounded to 32 KiB.

The wrapper synthesizes `PAPERCLIP_PI_RUNTIME_CONFIGURATION` for its child,
including only session-bound MCP servers. The owned extension captures and deletes
this configuration environment variable before model shell execution. Credentials
remain accessible only through the deliberately admitted runtime mechanisms.

Pi starts with `--no-extensions --no-skills --no-prompt-templates --no-themes
--no-approve --offline`, followed by the explicit immutable extension and admitted
skill paths. Project trust is denied; user-bash RPC and terminal login are disabled.
Only the controlled `/compact`, `/session`, and `/autocompact` slash commands are
accepted. Startup package update checks are disabled.

The wrapper must not infer complete extension registration from process startup.
It therefore probes
`get_commands` and requires the exact readiness sentinel
`paperclip-runtime-ready-v1` / `Paperclip runtime gate v1`. The extension registers
this command only after gates and every MCP catalog finish initialization. A
missing sentinel kills the subprocess before the first model prompt.

`pi-verified-runtime.ts` inventories and checks the complete graph, including
Node, wrapper helper, extension, package metadata, native libraries, WASM and
resources. The manifest schema is `paperclip.pi-runtime-files.v1`, with relative
`node`, `piEntrypoint`, `extension`, `wrapperEntrypoint` fields and a complete
`files` array of SHA-256-bound regular files or contained relative symlinks.
Hardlinked files, escaping links, changed files, and undeclared files fail
admission. Its verifier returns the three launch environment bindings and a
manifest digest. Admission verification alone is not a command lease: the shared
host must retain its immutable snapshot and process guardian through termination.

The published Pi package has a shrinkwrap and a nested dependency graph. Provider
pack creation must copy the complete installed graph and use the same pinned Pi
family dependencies, rather than reconstructing the graph from `cli.js` imports.
The emitted owned extension must be included in every macOS arm64/x64 and Linux
x64 pack; the candidate materializer emits it at `runtime/extensions/paperclip.js`. The wrapper's `dist/paperclip-runtime.js` is
part of its verified package and must never be omitted from a copy or hash.

## Verification and maintenance

The [v5 offline pack proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.v5.darwin-arm64.json)
binds runtime source `aec26ad83f1d082f0d0a5eaffbd615a9e2e26155`, combined macOS
pack `sha256:cf7d0998bbc2bed7b893c726c2b6455ba8a683d9cff7d92afedbff2d5900d500`,
and immutable daemon `sha256:fe03a5f5e7b7d51aafb398aa435e4a200ca6e0206c46b84ba0baa15aa0be5f31`.
Recursive workspace typecheck and full build pass. Focused checks pass 43
TypeScript tests including actual installation launch, 19 installed-wrapper/native
SDK tests, eight materializer tests and 13 Rust backend tests. Independent review
recomputed the v5 digest and verified all 13,827 installed files. The
[security closure proof](../../packages/paperclip-runner/test-fixtures/pi-acp/security-closure-proof.v5.json)
retains npm's vulnerable pre-replacement result, the fixed installed version,
unchanged upstream metadata, target pins and exact runtime file changes.

Both Pi's private interpreter and the separately manifest-bound outer macOS pack
interpreter are official Node 24.21.0 with bundled Undici 7.29.1. Sibling provider
closure/profile declarations are unchanged. The actual Pi registry initializes
ACP1 under a network-denying sandbox, exits EOF0 and releases its process group.
Full Runner startup with no credential rejects in 8.558 seconds, below the
unchanged 30-second deadline; this is a typed admission failure, not authenticated
success. Linux packaging uses the later Docker-only source `94ef513f8`; its
runtime source trees remain identical to `aec26ad83`. Linux execution is recorded
separately. The two clean lock resolutions match `9eea6018…`; tracked lock bytes
remain unchanged.

The [v4 offline proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.v4.darwin-arm64.json)
binds frozen source `f556110d588a9de9fefe676a9a62bf09e98afb85`, combined pack
`sha256:4df7e9fa164929c7ae7d8e8711f0bf7d587d9fa6a246d0a8340f318f57168855`,
and release Runner SHA-256
`373848d2d7287b2c47b2cee422cb7bd25073a594a620a9ad574f2d3d51cd1670`.
Recursive workspace typecheck and full build pass at that source. Full pack and
all three closure inventories verify; the actual Pi registry launch initializes
under a network-denying sandbox and exits cleanly on EOF. A separate full Runner
startup rejects missing credentials in 11.083 seconds without a prompt. That is
a timely admission rejection, not an authenticated success. The proof includes
execution-tree identities and two matching clean dependency resolutions.

The v4 focused verification passes 49 TypeScript tests plus the separately enabled
actual-distribution installation test (all five installation cases), 24 installed
wrapper/native-SDK/materializer cases, and 13 Rust native-provider backend tests.
The new macOS arm64 closure was independently reproduced by a fresh locked
public-registry installation. The helper tests cover poisoned malformed inputs,
iteration overflow and the 4,096-entry limit; installed tests cover cancellation
followed by warm native-ID reuse. These checks make no provider inference calls.


The four colocated Vitest suites exercise questions, permissions, timeouts,
framing, usage, file policies, MCP behavior, and graph verification. The Node test
`test/pi-acp-package-contract.test.mjs` launches the actual patched npm wrapper
against a deterministic RPC fixture. It proves initialization, streaming,
terminal usage, question versus permission routing, explicit steering, provider
exit, required sentinel, and typed failure settlement. It requires the exact
installed pinned package; an absent or unpatched dependency is a failure.
`PAPERCLIP_TEST_PI_ACP_PACKAGE` can select a separately installed pinned fixture.
These fixtures invoke no model or paid API.

At source `f58cfa1cbf4503b93a0be4480f51b492d8203b7c`, all 30 tests in those
four Vitest files passed, including the optional actual-distribution installation
test. The patched-wrapper, real-Pi, and distribution-builder Node suites passed
all 17 tests using the fresh provider-pack packages. TypeScript and the full
candidate pack build passed. Retry cases cover successful, failed, and missing
outcomes; the failed and missing cases were observed failing against the prior
wrapper before the repair. These focused checks do not establish a full
repository check or current-head CI pass.

`test/pi-native-package-contract.test.mjs` runs the real Pi 0.84.2 CLI without
credentials. It loads the compiled owned extension, initializes a loopback MCP
catalog, and returns the exact readiness command. An invalid catalog exits Pi
before RPC admission. This checks the extension ABI and explicit loading path. It does not prove authenticated inference, native tool
execution, MCP model invocation, credential renewal, or remote sandbox behavior.
Those remain required local and Daytona qualification evidence under the shared
live-spend cap. No live inference spend was incurred by these deterministic tests.

The helper in `patches/pi-acp@0.0.33.patch` is generated from
`src/drivers/acpx/pi-acp-runtime.ts` with Node `stripTypeScriptTypes`, trimming
trailing whitespace. The package contract checks that these bytes match. When
updating the upstream version, rebase the wrapper patch and rerun the actual
package tests; do not preserve an old qualified command hash after changing bytes.

Primary references reviewed:

- [Harness priorities report](https://pages.paperclip.ing/2026-09-25-harness-priorities/report.md)
- [pi-acp source](https://github.com/svkozak/pi-acp)
- [Pi RPC protocol](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [ACP protocol and SDK](https://github.com/agentclientprotocol/typescript-sdk)

## Candidate distribution build

Run `node packages/paperclip-runner/scripts/materialize-pi-distribution.mjs
/absolute/new-output` on the target build host. Supported targets are macOS arm64,
macOS x64 and Linux x64; no cross-platform qualification is inferred. The builder
uses exact official Node 24.21.0, pinned archive SHA-256 and executable SHA-256
for each target. `--node=/absolute/portable-node` reuses a matching binary; without
it the builder downloads the pinned official archive. It rejects non-system
dynamic-library dependencies and executes the copied interpreter after relocation.
The initial Homebrew Node discovery failed this portability check and is not an
admitted pack interpreter.

The isolated `scripts/pi-distribution/package-lock.json` pins all 143 dependency
packages and registry integrity, without changing the workspace pnpm graph. It
preserves Pi's upstream nested shrinkwrap, and adds npm registry SHA-512 integrity
for the six exact 0.84.2 Pi family packages whose published shrinkwrap omitted it.
Installation uses `npm ci --ignore-scripts`, public registry access, private npm
configuration and an environment without npm or provider credentials. The builder
checks every locked installed version and upstream shrinkwrap entry (with the
exact security exception below), applies the
owned ACP patch, verifies the helper matches its TypeScript source, and compiles
the owned extension to `runtime/extensions/paperclip.js`.

Profile v5 replaces only the nested `undici@8.9.0` with `8.10.2`. Both an
existing-lock resolution and a fresh resolution ignore npm's scoped override
inside Pi's published shrinkwrap; `npm ci` also installs 8.9.0 despite the fixed
outer lock. The materializer therefore checks the exact original nested path,
version, registry URL and SHA-512, plus the installed vulnerable package identity,
before fetching the exact fixed tarball. It verifies the pinned SHA-512 before
extraction, bounds both gzip and inflated tar bytes to 4 MiB, rejects traversal,
links and unexpected entry types, and requires the 214 regular-file payload.
The published Pi package metadata and shrinkwrap remain unchanged; only this exact
old-to-new tuple is an exception. Every other package retains its previous lock
entry. Installed version checks and the complete source-pinned closure then make
it impossible for npm's old copy to survive admission.

Node 24.21.0 also replaces bundled Undici 7.29.0 with 7.29.1, covering the global
WebSocket implementation as well as the nested npm copy. The materializer checks
`process.versions.undici` explicitly. Sources: [official advisory](https://github.com/advisories/GHSA-3wwx-pv8p-q78v),
[fixed Undici release](https://github.com/nodejs/undici/releases/tag/v8.10.2),
[Node 24.21.0 release](https://nodejs.org/en/blog/release/v24.21.0) and
[official archive checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt).
Only Pi's declarations and three closure pins change; sibling provider pins
remain unchanged. The containing provider pack must be rebuilt with the patched
portable interpreter and retains its own manifest identity.

The result contains `runtime/` and a sibling `pi-distribution.json`. Keeping the
manifest outside its inventoried root avoids a self-referential file digest. The
returned environment bindings point into `runtime/`; callers must retain a verified
immutable lease on that entire root. Additional native libraries, package files,
WASM, data, and templates are all included in the inventory. Only npm-generated
`.bin` symlinks and its hidden installation lock are omitted; launch always uses
verified explicit files. The regular-file `native-closure.json` is independently
bound to a trusted per-target source constant. Its `pi-entry.cjs` bootstrap derives
snapshot-relative Node, Pi, extension and module-guard bindings; the Pi subprocess
loads the same verified module guard.

The common provider-pack integration uses an explicit `--candidate-providers=pi`
flag. It invokes exported `materializePiDistribution` into
`provider-assets/pi/<platform-arch>`, records the returned manifest digest and metadata path
in the outer pack payload, and includes the entire distribution in the outer
pack's integrity proof. The flag prepares an inspectable candidate; it must not
change its qualification status or enable admission without required live proof.
The default provider pack remains independent of this isolated graph.

On 2026-09-28 the builder completed a real public-registry installation on macOS
arm64 with official Node 24.19.0. The resulting complete distribution passed all twelve patched
wrapper and real Pi admission tests; those tests never submit a model prompt to a
provider. Five builder tests cover the full dependency lock, missing/changed
packages, missing shrinkwrap entries, resource mutation, escaping links and unsafe
output paths. Linux x64/Daytona and macOS x64 execution remain pending.

Official Node archive and executable pins are recorded in `pi-node-pins.ts`;
archive hashes were checked against the [official Node release checksums](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt).
The x64 closure pins combine the identical locked package/resource graph with each
verified official x64 interpreter. They are candidate artifact identity, not proof
that those targets have executed successfully.

### Installation authority and token semantics

`verifyPiInstallation(profile)` admits only the current declared profile version and the source-owned
Pi identity. It resolves `provider-assets/pi/<platform>-<arch>` inside the verified
Runner package, checks the complete runtime against source-pinned closure hashes,
and opens a guarded immutable native snapshot. The snapshot bootstrap binds Node,
Pi, and the extension relative to itself, overriding inherited launch paths.
Unconfigured installations return an explicit bound-credential error and expose
no terminal login option. The materializer returns the runtime `version`,
`profileDigest`, and complete `closureDigest` for the provider-pack manifest.

For the exact OpenRouter qualification model, Pi AI 0.84.2's
`dist/providers/data/openrouter.json` selects `openai-completions`. Its
`dist/api/openai-completions.js` assigns `usage.output` from `completion_tokens`,
which already includes reasoning tokens; `usage.reasoning` is a subset. PRP must
therefore use zero additional thought tokens for this pinned profile, rather than
counting that subset twice. Missing cache categories remain unknown at the wrapper
receipt boundary. `usage.cost` is a Pi catalog pricing estimate, never an invoice.

The closed snapshot has been exercised against actual pinned Pi through ACP
initialization and the missing-credential admission path without a model call.
The first authenticated local Runner snapshot verified the exact configured
model ID. It did not settle or produce a terminal usage receipt; complete local
and Linux/Daytona receipt qualification remains outstanding.

Historical profile version 3 declaration digest: `sha256:72cb225288376f733b9ed3afa5e13565eb4152f0de509bc1181382fa44bee472`. Each profile digest hashes its versioned
profile domain, patched wrapper source and platform closure pins. Every native
closure remains independently checked at launch. Version 1 through 5 warm sessions cannot
be reused with this integration.

Pi 0.84.2 emits `compaction_start`/`compaction_end`; the wrapper maps those
events, includes terminal `result.usage` receipts once, and retains bounded
summarization retry progress. Manual compaction requires an idle session and has
a 120-second RPC deadline; deadline expiry terminates Pi so a timed-out operation
cannot continue invisibly. Successful compaction reports
`assistant_message_and_compaction_receipts` provenance. Pi's summarization retry
helper discards failed-attempt usage, so any retry or missing compaction receipt
invalidates complete-turn token/cost totals instead of inventing complete coverage.

The retained [macOS ARM64 provider-pack admission proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.darwin-arm64.json)
records source `7710736ca3924c655c5b0efd172cfd3c0173766a`, with version 3
runtime source `06cf356a8bc94f709fcd15606fe05e17933fe3b2`. The latter differs only
by the capability report and Pi evidence JSON; all execution tree hashes match.
Its manifest digest is
`sha256:eb31cadae93805b901d2565912121fca6e79024c0120b1bd7982e05215b5aa5a`.
Two independent clean dependency resolutions match
`2c46a68811ba1d504a41b6f4d3f642bc93f4a1c615097754c9c6486881dba8e6`.
The generic installation registry and immutable snapshot passed initialization
and rejected the exact missing-bound-credential error before any model prompt.
Full Runner session.open terminated with typed rejection in 12.111 seconds,
below the unchanged 30-second deadline; this is not authenticated success.

Version 3 verification passes TypeScript and release Runner builds, 95 focused
Vitest cases in seven files including actual-distribution launch, 25 installed
package/receipt/materializer checks, and 16 native-provider Rust tests. These
checks do not constitute full repository verification or paid qualification.
The [version 2 dd78 proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.darwin-arm64.dd78df1e.json)
retains the earlier pack used for hello, model admission and restrictive denial.
Its 107 Vitest checks and 22 installed checks remain tied to that source.

The [9f2d0420e proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.darwin-arm64.9f2d0420e.json)
retains the earlier source and pack that reproduced the startup timeout. Its 97
Vitest checks and 22 package checks, including the corrected explicit package-path
invocation, remain historical evidence.

The [a6167ce3a proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.darwin-arm64.a6167ce3a.json)
and [58511d79d proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.darwin-arm64.58511d79d.json)
remain historical observations. The 128 targeted checks, 31 installation checks
and 17 package checks remain pinned to `58511d79d`; the full Runner suite
(2,202 passed, 11 skipped) and 13 native-provider Rust tests remain pinned to
`2e65b64d5`. They are not relabeled as checks of the latest source.

The [pre-launch-boundary proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.2e65b64d5.darwin-arm64.json)
retains source `2e65b64d5a2148583109b8157d6e72f54f5ad29b` and manifest
`sha256:7300b9c449c02b61d2f93ef765f371c277e39a58d04739c6c24dcf7939500701`,
including the full runner suite and native-provider Rust results. It predates the
final runner environment allowlist and direct candidate-admission fixes.

The [pre-policy proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.d039e1b7b.darwin-arm64.json)
retains source `d039e1b7b072862b4c326ba7194dc42617fa5984` and manifest
`sha256:5a47fc67b886c1e05d0f630ed89c1b9f5324610b649d1db020a3e036e36fc85d`,
including its cleanup-timeout retry history. It predates the Node engine metadata
and corresponding manifest/closure identities.

The [previous integrated proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.f58cfa1cb.darwin-arm64.json)
retains source `f58cfa1cbf4503b93a0be4480f51b492d8203b7c` and manifest
`sha256:3de76fb7d3902d29285e3da51e36d2ba4654c29bab0c867a6209fadea77c2181`.
It covers the retry-status repair before the HTTPS and shared runtime fixes.
The [earlier integrated proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-provider-pack-proof.1e0d11c48.darwin-arm64.json)
retains source `1e0d11c482f8ef50b6afc1430cb736579114b266` and manifest
`sha256:f859e30e51326ff875d616e2bb3fd4c0246ce1f58a5988968b91bae176a68281`
with its narrower capability assertions. These files are historical evidence,
not proof of the current executable bytes. Later runtime or foundation changes
require a new pack build and source-pinned admission record.

## Remaining event and qualification work

The candidate preserves the core request/response paths. It does not preserve
every field in Pi's native event stream. These are explicit follow-ups:

- **P1 — retry/compaction field completeness and end-to-end evidence.** At source
  `41503eb38f03c436b1569f9f0204625bb4d58782`, the wrapper emits bounded
  `paperclip/pi_notice` activity instead of assistant text. The adapter preserves
  source provenance, `attempt`, `maxAttempts`, `delayMs`, `success`, `aborted`,
  `willRetry`, `enabled`, and bounded `reason`/`errorMessage` fields when supplied.
  The UI renders the notice details. `finalError` is not forwarded, and
  summarization retry currently has summary-only data. Package regressions cover
  retry success/failure/unknown and compaction usage; adapter tests cover bounded
  metadata and redaction. Extend field-by-field wrapper/canonical/browser parity
  without giving notices terminal authority or treating deterministic tests as
  paid qualification. See the [wrapper patch](https://github.com/paperclipai/paperclip/blob/41503eb38f03c436b1569f9f0204625bb4d58782/patches/pi-acp%400.0.33.patch#L381),
  [notice adapter](https://github.com/paperclipai/paperclip/blob/41503eb38f03c436b1569f9f0204625bb4d58782/packages/paperclip-runner/src/drivers/acpx/pi-extension-adapter.ts#L22),
  [package regressions](https://github.com/paperclipai/paperclip/blob/41503eb38f03c436b1569f9f0204625bb4d58782/packages/paperclip-runner/test/pi-acp-package-contract.test.mjs#L225),
  [adapter regressions](https://github.com/paperclipai/paperclip/blob/41503eb38f03c436b1569f9f0204625bb4d58782/packages/paperclip-runner/src/drivers/acpx/pi-extension-adapter.test.ts#L5),
  and [UI details](https://github.com/paperclipai/paperclip/blob/41503eb38f03c436b1569f9f0204625bb4d58782/ui/src/components/task-chat/TaskChatProtocolActivityRow.tsx#L283).
- **P1 — native queue state.** `queue_update` contains steering and follow-up queues. Extension calls
  acknowledge RPC acceptance, but the wrapper does not project that event into
  durable queued/delivered state. Do not treat `{accepted: true}` as proof that
  a later model turn consumed a message. Queue contents are also user content,
  so any added projection needs explicit retention rules. Next: emit bounded,
  occurrence-bound queued/delivered notices and distinguish acceptance from actual
  consumption; preserve queue content only under the existing content policy.
- **P2 — extension UI and configuration.** `setStatus`, `setWidget`, `setTitle`,
  and `set_editor_text` messages
  have no Paperclip UI projection. The admitted extension does not use them.
  `notify` retains a bounded message and severity, while interactive `select`,
  `confirm`, `input`, and `editor` have the explicit response bridge. Native
  session-name and thinking-level change events also lack a separate event
  projection. The wrapper advertises ACP thinking-level configuration, but the
  current Runner host does not expose `set_mode` or `set_config_option`; no
  reasoning-level override was applied during qualification. Next: define bounded
  status/widget/title dispositions and explicit typed configuration controls;
  require a provider acknowledgement before claiming a setting changed.
- **P2 — files and artifacts; P1 — image input.** File diffs are bounded text snapshots, not complete binary changes or durable
  artifact publication. Semantic artifact tools remain the supported publication
  path. Image prompting, model-triggered tools, approvals, typed questions,
  explicit steering, warm recovery, and live usage need authenticated local and
  Linux x64 Daytona proof for the exact declared model. The reported model ID
  must be checked, rather than inferred from the configuration. Next: implement
  image content through the shared text-only converter, qualify actual model
  content handling, and separately test diff/artifact publication boundaries.

## Authenticated local qualification progress

The [v5 native controls proof](../../packages/paperclip-runner/test-fixtures/pi-acp/native-controls-proof.v5.darwin-arm64.json)
passes the unchanged probe on frozen `aec26ad83` / pack `cf7d0998…` in 19.199 seconds.
The original write invocation `pi-849b369266c920633abffa988509e4ba61fcdf464f62c73900fd5ddd6d477402`
correlates with the denied failed-tool update. The decision is fsynced before either control request; both control
acknowledgements precede sending the original denial response. Visible output is exactly
`STEERED_CURRENTQUEUED_NEXT`, stale steering rejects, the forbidden file remains
absent, and the turn settles `end_turn`. Child, verified lease and temporary
workspace cleanup complete; an independent process check finds no remaining
probe or Pi process. No database is started. Actual usage is 3,727 input, 140
output and 1,792 cached-read tokens. Delayed exclusive-key billing settles at
$0.000151739; the separate Pi catalog estimate is $0.000611156. Initial unchanged
reads are retained, not interpreted as free inference. This proves direct native
controls and denial on the patched profile; it does not qualify Product recovery
or remote execution.


The [v4 native controls proof](../../packages/paperclip-runner/test-fixtures/pi-acp/native-controls-proof.v4.darwin-arm64.json)
passes on frozen `f556110d5` / pack `4df7e9fa…`: one native write request uses the
same normalized invocation ID in its persisted decision and failed tool update;
the original deny option is written only after both control acknowledgements.
Visible output is exactly `STEERED_CURRENTQUEUED_NEXT`, stale steering is rejected,
the forbidden file remains absent, and the prompt settles `end_turn`. Cleanup
completes without a database. The terminal receipt contains 2,030 input, 1,293
output and 5,632 cached-read tokens. A later billing observation settles this
attempt at $0.000546502; Pi's separate catalog estimate is $0.000803936. Initial
unchanged billing reads are retained and were not treated as free inference.

A newly indexed [Undici advisory](https://github.com/advisories/GHSA-3wwx-pv8p-q78v)
affects the historical v4 isolated npm Undici 8.9.0 and Node 24.19.0's bundled
Undici 7.29.0. Profile v5 fixes both copies as described above. The separately authorized v5
control proof uses that repaired closure; no further paid case is authorized.
This paid v4 proof remains bound to its original bytes.

The first [v4 plan attempt](../../packages/paperclip-runner/test-fixtures/pi-acp/product-plan-infrastructure-failure.v4.darwin-arm64.json)
failed before provider startup: embedded PostgreSQL could not initialize the
Product fixture. Canonical classification is `transient_infrastructure`, with
zero provider prompts and two unchanged post-attempt key-billing observations.
The fixture directory is gone and no matching process remains. A later read-only
host snapshot shows 87,263 of 87,381 SysV semaphores in use, supporting a resource
constraint. A separate disposable diagnostic then reproduces the cause with the
same pinned PostgreSQL binary: `semget(..., 17, 03600)` fails with `No space left
on device` when only 16 semaphores are free. It exits in 0.557 seconds, removes
its temporary directory, leaves no child process, and leaves IPC totals unchanged.
The original Product bootstrap stderr remains unavailable. No unrelated database
or IPC object was changed during that diagnosis. The later user-approved
fixed-snapshot host cleanup removed 4,892 stale semaphore sets and skipped 11
whose recorded creator PID was present. Startup and graceful shutdown now pass;
the current checkpoint above supersedes this historical qualification hold.


The [sanitized attempt ledger](../../packages/paperclip-runner/test-fixtures/pi-acp/paid-qualification-progress.darwin-arm64.json)
retains all twenty attempts, including eight failures before a model prompt. One
Runner protocol turn reached the exact model and successfully called `get_task_context`, `get_task_history`,
`list_documents`, and `read_document`. The canonical case permits those extra
orientation reads, but also requires a completed turn; it timed out after 120s
without terminal usage. The later Product hello journey passes; the canonical
Runner protocol case has not yet passed.

Exclusive OpenRouter key billing increased by **$0.028858372**, including
$0.000351509 from the sleep-interrupted Product attempt and $0.000654767
from the successful hello journey, plus $0.010995043 across the restrictive-denial
and file-edit batch. A delayed charge crossed the latter attempt baselines, so
that batch is accounted as an aggregate without per-generation attribution.
Version 3 file, question and failed plan cases add $0.007828938. The version 3
native controls probe adds $0.000140985 after a later key reading resolves its
initially unchanged observations; those early reads did not prove free inference.
The seven pre-prompt failures had two post-attempt
observations with zero delta. This is measured provider spend, separate from
Pi's stale catalog pricing estimate. A missing terminal receipt remains unknown, not free execution. Each
attempt had no automatic retries, a $2 reservation and a $0.50 billing watchdog;
the Product supervisor also imposed a 300s outer deadline.

The paid trace exposed a shared projection defect: canonical `item.delta` events
with `kind: reasoning` were relabeled as assistant messages by the TypeScript
facade. Shared commit `a978d1bc5` preserves summary/detail reasoning channels,
including mixed coalesced batches, so the existing private-reasoning redactor
applies. Three regressions failed before the fix; 20 focused checks, 8 additional
Codex event checks and source typecheck passed afterward. Hidden reasoning is
excluded from this report and the published ledger. The provider timeout remains
a separate unresolved result.

Product hello first failed before startup because the local PostgreSQL package's
symlink hydration had not run. Its bundled setup script repaired the installation
and a fresh database initialization passed. The deliberate repeat reached the
real browser/server, then candidate agent creation returned 422 because the
provider-profile validator still rejected candidates before the host's explicit
qualification admission boundary. Shared commit `26dde3cfe` corrected that gate. The next attempt created the agent
and task, then found a dormant Pi-only rejection in the verified runnerd backend
factory (`transportDriverIdentity`); it again submitted no model prompt and
incurred zero measured billing delta. The shared identity correction is included
in foundation `c3b7e9ecd`. The next attempt passed those guards but stopped at
`PRP command session.open timed out` after 36.5 seconds of run startup; cleanup
passed and the measured key billing delta remained zero. It produced no terminal
usage receipt or matcher success.

The canonical live-eval completion contract had a separate defect: fresh sessions
omitted native `paperclip_finish`/`paperclip_block` schemas, their callback rejected
otherwise valid native reports, and ACP model instructions lacked the literal
contract revision. Shared commits `dc58afb28` and `aa4b88b16` expose and validate
those advisory reports and send the exact contract on fresh/resumed sessions.
They cannot mutate mock tasks, grant semantic permissions or settle the provider
turn early. Two declaration/acceptance regressions and one instruction-delivery
regression failed before repair; 45 live-session tests and three focused follow-up
checks passed, with source typecheck. This is a confirmed protocol defect, but
its causal contribution to the earlier model timeout is not proven.

The [startup diagnostic](../../packages/paperclip-runner/test-fixtures/pi-acp/startup-diagnostic.darwin-arm64.json)
reproduces that failure without credentials through the deployed Runner transport.
Its `run.prepare` command completes, while `session.open` remains pending at the
unchanged 30-second deadline. Separately timing the same 13,827-file, 234 MB
closure measured 5.168 seconds of verification and 37.423 seconds to construct
its immutable snapshot, before any Pi process starts. Shared fix `2a30219f1`
copies at most eight files and 32 MiB per batch, with larger admitted files alone.
It retains every file identity, digest and confinement check and drains all copy
promises before cleanup. The same tree then copied in 5.851 seconds; ten security
and concurrency tests and both Runner TypeScript checks passed. The rebuilt
`dd78df1e` pack then settled the full credential-free Runner
`session.open` request in 10.087 seconds (10.198 including close), within the
unchanged deadline. It returned terminal `session_ensure_failed`; the outer PRP
response omits the underlying credential error. The independent immutable ACP
probe from the same pack asserted the missing-credential error directly. This
is timely rejection, not authenticated session success. The earlier timeout
attempt retains its original source identity.

The next Product attempt (`hello05`, source `dd78df1e`) reached an authenticated
session in 11.631 seconds, submitted a turn and received `turn.accepted`. It then
crossed a confirmed macOS Maintenance Sleep of 888 seconds. The retained browser
trace ends without a semantic-tool or terminal event; completion and usage are
unknown. The canonical result remains failed/`secret_leak`: the evidence scanner
could not inspect an incomplete ZIP (`unzip` exit 9), rather than detecting a
credential-value match. Browser cleanup also failed after wake; a later process
check found no remaining process from this exact attempt. Both the canonical
921.632-second wall duration and supervisor 72.168-second monotonic duration are
retained. This result proves startup admission, not a completed Product journey.
The explicit retry adds an idle-sleep assertion and a wall-clock supervisor bound
without changing the provider timeout, canonical oracle or evidence scanner.

The explicit [hello06 Product proof](../../packages/paperclip-runner/test-fixtures/pi-acp/product-hello-proof.darwin-arm64.json)
passes all six canonical matchers, including the exact response once, task `done`,
run `succeeded`, native runtime and local environment. Pi executes
`mcp__paperclip__paperclip_finish`, then reports a completed turn and succeeded run.
The case took 32.668 seconds; cleanup and evidence inspection passed. Its receipt
contains 26,867 input tokens, 283 output tokens and zero cached input tokens.
The catalog notice estimates $0.00384062; measured key billing is $0.000654767.
Product correctly marks dollar coverage `unpriced` and incomplete. These values
are not interchangeable.

The separate [authenticated model-selection proof](../../packages/paperclip-runner/test-fixtures/pi-acp/model-admission-proof.darwin-arm64.json)
sends no prompt and measures zero key billing delta. It reads the actual ACP
model response, selects the declared model, and observes
`openrouter/deepseek/deepseek-v4-flash-0731` after Pi's native RPC state refresh.
The Product path enforces this comparison before prompting, but its retained
`session.started` model metadata says `unknown`; final usage carries the configured
identity. The separate proof closes model-selection evidence without pretending
it came from that Product transcript.

The historical version 2 pack, model and hello proof JSON files retain Git tree hashes for
Runner source, scripts, Rust, protocol, patches, server source and Product E2E.
Those version 2 observations stay pinned to `dd78df1e` when later commits change only these
reports and fixtures; an execution-source change requires a fresh build.

| Execution source path | Git tree at `dd78df1e` |
| --- | --- |
| `packages/paperclip-runner/src` | `a8123cb4396c77ce0127d5ccf49d3584b63a9a58` |
| `packages/paperclip-runner/scripts` | `9ede97769bb3f2bbfa8e02be220b5ce06e438a99` |
| `packages/paperclip-runner/runner` | `2cc84e150aecbd5faf2c8bcecc4b6352c24dbca8` |
| `packages/paperclip-runner/protocol` | `1d50458fb572d0c75f9a398f419209c52c23ba6f` |
| `patches` | `1e2f846b8b2dda202b79ee83baeb0860a3b9ab64` |
| `server/src` | `b267adc1e0ad36955b68314829cfd4256ab88d37` |
| `tests/runner-e2e` | `5ff4b8a85a14e3e005e3e240c145899c0bc742b5` |


Production admission remains qualification-pending until the live matrix and
spend receipt checks pass.


## Version 3: retain failed tool validation and Bash results

The version 2 file-edit Product attempt exposed an owned bridge defect: five
`paperclip_finish` calls returned failed MCP results, but the extension replaced
all authenticated validation text with a generic rejection. Version 3 keeps
valid text and structured error details within an 8 KiB UTF-8 bound, redacts
bound credentials and labelled secrets, and still raises a failed tool result.
Malformed or oversized errors remain explicit failures. The original five call
arguments were not retained across the privacy boundary, and the fixture's
workspace was removed during cleanup, so this report does not reconstruct their
contents or assert that the file oracle passed.

A separate Bash projection gap discarded native result fields because upstream
sent them only as private terminal metadata. The wrapper now also emits standard
ACP `rawInput` and `rawOutput`, preserving each structured value whole up to
64 KiB and marking larger values omitted. Installed-process fixtures cover
success, failure, partial output and the size boundary. Canonical `exitCode`
remains unknown: the shared projection does not yet map the native structured
field, and this patch does not infer it from text or success status.

These changes alter the immutable wrapper and owned extension. All three target
closure pins and the versioned profile digest change; version 2 warm snapshots
are rejected. Earlier local hello, restrictive-denial and Linux initialization
proofs remain tied to their version 2 execution source. Version 3 must complete
fresh paid qualification before those behaviors can be claimed for its bytes;
the new immutable-pack checks above pass.


The [restrictive-denial proof](../../packages/paperclip-runner/test-fixtures/pi-acp/native-denial-proof.darwin-arm64.json)
retains the version 2 real native write rejection: the original offered decision
was durably recorded before responding, the matching tool failed, the prompt
settled, and an independent filesystem check found no forbidden marker. This is
direct ACP delivery proof; it does not exercise PRP restart replay.

The [file-edit failure](../../packages/paperclip-runner/test-fixtures/pi-acp/product-file-failure.darwin-arm64.json)
retains the candidate timeout, five generic finish errors, missing file oracle,
unknown terminal usage and successful process cleanup. These failures are kept
alongside the version 3 corrections rather than overwritten by a future retry.
## Version 3 live evidence

The [file delivery proof](../../packages/paperclip-runner/test-fixtures/pi-acp/product-file-proof.darwin-arm64.json)
passes all seven canonical matchers. The independent oracle reads the exact
24-byte workspace file before cleanup. The first finish request fails because a
workspace-only file is not downloadable; the retained validation message tells
Pi to register the deliverable. Pi does so and then finishes successfully. The
browser shows the download card and Done status. All five Bash results are
non-null; canonical exit code remains unknown. The case measured $0.003324737.
No separate raw copy of the workspace file was retained.

The [typed question proof](../../packages/paperclip-runner/test-fixtures/pi-acp/product-question-proof.darwin-arm64.json)
passes all six matchers. The browser submits option ID `cobalt` for question ID
`verification-word`; the same durable interaction becomes answered and a distinct
warm continuation completes. The pending form and final answer were visually
inspected. This is continuation without server restart. The waiting run has no
usage receipt, while the continuation has one; total token coverage remains
partial. The measured key delta is $0.001413697.

The [plan failure](../../packages/paperclip-runner/test-fixtures/pi-acp/product-plan-failure.darwin-arm64.json)
retains a complete two-step Plan at revision 1 and an unanswered confirmation
bound to that exact revision. The provider run succeeds and the task remains in
review. The real browser trace shows `task-chat-plan-preview-fallback` inside a
settled turn. Rust had retained `mcp__paperclip__write_document` as a builtin tool
with no namespace, so the UI could not embed the Plan at its `write_document`
boundary. The meaningful canonical matcher remains unchanged. No approval was
submitted, terminal usage is unavailable, and the measured key delta is
$0.003090504. Shared repair `5aa02662b` restores MCP name/namespace/transport while preserving
operation authority. Its negative fixture retains the observed fallback, and the
positive settled-turn UI regression passes. A fresh daemon and new source-pinned
live run are still required.

The [native controls proof](../../packages/paperclip-runner/test-fixtures/pi-acp/native-controls-proof.darwin-arm64.json)
submits one ACP prompt to the actual selected model. While its native write waits
for permission, both explicit controls acknowledge the same active session. The
original offered denial ID is persisted and fsynced before the pipe response.
Visible output is exactly `STEERED_CURRENT` followed by `QUEUED_NEXT`; a matching
failed tool update and independent absent-file check prove the denied write.
The prompt settles and a later steering request is rejected as stale. The native
receipt reports 1,941 input, 134 output and 3,584 cache-read tokens. Its
$0.000409612 catalog estimate differs from the later measured $0.000140985 key
delta. This proves consumed
controls on a live process, not durable queue replay after process replacement.

All four observations use immutable pack `eb31cada…` at source `7710736ca…`,
with runtime source `06cf356a8…`; they predate the combined provider integration
`7ab463697…`. Execution tree hashes are retained in the Product proofs. The
[Linux x64 proof](../../packages/paperclip-runner/test-fixtures/pi-acp/offline-native-proof.linux-x64.v3.json)
uses profile version 3 at source `06cf356a8…`, image
`sha256:c5fa7976bba92a186a2f70dc8b8ddc58ab86606b80a819c89bf550d2d057c832`.
It launches the verified native wrapper, initializes ACP protocol 1 and exits
cleanly on EOF with network disabled and no credentials or model prompts. This
proves Linux executable admission; authenticated Daytona behavior remains pending.

The explicit [plan02 follow-up](../../packages/paperclip-runner/test-fixtures/pi-acp/product-plan-resume-failure.darwin-arm64.json)
uses combined pack `0800f101…` from source `7ab463697…` and fresh daemon
`955d0714…` from `e35b11db2…`. It passes the repaired Plan presentation boundary
and accepts the exact revision. The resumed run then fails after 120 seconds.
Its first finish request receives a precise completion-criterion correction, but
the next finish and context read fail with duplicate call identity conflicts.
All three distinct operations reuse native ID `call_0`; the extension forwards
that ID unchanged into the shared MCP dedupe boundary. This is a further
integration defect. The shared dedupe guard and canonical grader remain intact.
Both runs lack terminal usage; measured billing is $0.002440082 and cleanup
passes. Restart and refreshed hello are held until this defect is repaired.

## Explicit host installation

For a published local Paperclip installation, run `paperclipai runtime setup pi`
with the same installed CLI and account that owns the server package. This is an
explicit download and verification step; npm installation and agent launch never
perform it automatically. It installs only this host's supported platform
(macOS ARM64, macOS x64, or Linux x64), using the source-pinned Node archive, npm
lock, wrapper patch and complete Pi closure. Node 24, npm, git, tar and the normal
platform dependency inspector (`otool` or `ldd`) must be available. The server
package must be writable by the installing account. Explicit setup preserves
`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, their lowercase equivalents,
`SSL_CERT_FILE`, `SSL_CERT_DIR` and
`NODE_EXTRA_CA_CERTS` for public downloads, and enables Node's environment proxy
handling. The provisioner keeps the same closed allowlist. Instance settings,
provider credentials, user npm configuration, `HOME`, `NODE_OPTIONS` and
`NODE_PATH` are excluded; TLS certificate validation stays enabled.

The public server carries a self-contained setup tool and small pinned inputs in
`dist/vendor/paperclip-runner/cli`; the installed host closure lives in that
server package's `provider-assets/pi/<platform>`. Setup validates an existing
closure again before accepting it. A corrupt existing installation is left
untouched and rejected; reinstall the same Paperclip release into a clean package
location and repeat setup. Concurrent setup is rejected. Cancellation drains the
current bounded download/build command before removing its private staging tree;
allow that cleanup to complete before trying again.

Then select Pi with an explicit provider/model ID and bind its provider credential
through the normal agent environment configuration. Setup itself makes no model request.
A missing host closure produces explicit setup guidance. Daytona uses the
separately built and verified Linux provider pack in its runner image; running
local setup does not install or qualify a remote image. Published-tar local and
Daytona startup evidence must bind the final installation candidate, with no
candidate qualification flags, before a production-readiness claim.
