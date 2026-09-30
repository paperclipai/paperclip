# Cursor ACP capability inventory

Evidence updated: 2026-09-29. Candidate: `2026.09.26-dd393fe`. This profile is **not live-qualified**. One authorized task-context prompt on the initial free account returned an upgrade requirement, invoked no semantic tools, and supplied no usage receipt. Its cost is unknown; the account dashboard remained unchanged at coarse precision. The user then selected another account, whose exact-model local Runner Eval passed task-context and history tools with clean terminal settlement. Its dashboard attributed 56K rounded tokens to included usage and no incremental charge; ACP still supplied no token or dollar receipt. The local Product hello subsequently passed through the real browser, server, database, native runner, and authenticated completion tool. A second local Product case passed file creation, editing, command validation, an independent exact-byte matcher, and visible workspace artifact presentation. The merged-source local Product question and revision-bound Plan approval also passed browser response and semantic-tool continuation. A serialized follow-up passed pending semantic-question recovery across a server restart. A verified native ACP probe also denied a shell write before any observed side effect. Native Cursor questions/plans and their recovery, durable permission presentation, interruption, and Daytona execution remain required qualification gates.

Current source uses **profile v5**, with native session-mode admission and the instruction correction described below. All prior paid results (including v4) and packaged builds remain historical and cannot qualify v5. The earlier mode-selection limitation below describes the pre-v5 implementation.

The reference is the runner's Codex app-server integration and its closed thread-item inventory in `src/provider-events.ts`. Cursor ACP and its private extension methods are the transport; the legacy Cursor adapter is unchanged.

## Evidence and packaging

- [Cursor's ACP contract](https://cursor.com/docs/cli/acp) describes stdio JSON-RPC, sessions, permissions and five extensions. The pinned binary reveals additional capabilities and one material documentation discrepancy below.
- `packages/paperclip-runner/cursor-distributions.json` pins vendor archive and complete extracted execution-closure SHA256 digests for macOS ARM64/x64 and Linux x64. All three archives were downloaded and independently inventoried (446 files on macOS, 454 on Linux). A real macOS ARM64 installation passed the materializer's full closure check.
- The archive is a complete runtime: bundled `node`, `index.js`, dynamically loaded numbered JavaScript chunks, native addons, workers, and assets. Pinning only the launcher or one executable does not pin its execution dependencies. The materializer rejects links/special files and overwrites, and verifies every file against the pinned closure digest.
- `test/fixtures/cursor-acp/credential-free-probe.json` records an actual macOS ARM64 initialization and nonbillable method probes. `initialize` reports ACP v1, session load/list, HTTP/SSE MCP, image prompts, and opt-in subagent events. Audio and embedded context are false. `session/fork` and `session/resume` return method-not-found. Creating/listing a session requires authentication.
- Static evidence comes from `5672.index.js` (ACP implementation), `8096.index.js` (ACP SDK protocol schemas), `190.index.js` (hook paths) and `index.js` (CLI/configuration), all bound by the archive and closure pins. SDK schema support alone is not counted as implemented harness capability.

## Capability matrix against Codex app-server

“Implemented” below means a tested Cursor implementation wired through the shared runtime, canonical activity channel and durable interaction path. It is not a claim of authenticated end-to-end qualification.

| Capability | Cursor harness/ACP evidence | Paperclip treatment | Remaining gap or qualification |
|---|---|---|---|
| Streaming assistant/reasoning | `agent_message_chunk`, `agent_thought_chunk` in live and replay presenters | Existing ACP streaming path | Authenticated event capture required |
| Tool lifecycle/input/output | `tool_call` and `tool_call_update`, including raw input/output, locations and content | Canonical lifecycle, bounded output, input-changed indicator and one relative target; Cursor extensions add semantic activity | Raw input body, structured content/diffs/media and additional locations are not projected. See the exact field audit below |
| Permissions | Native `session/request_permission` offers `allow_once`, `allow_always`, and `reject_once` | Shared durable approval mapping preserves supported decisions; indefinite grant is not exposed without proven scope | A live raw ACP write denial preserved request ID `0` and original `reject-once`, with 98 absent-marker samples through cleanup. This does not qualify durable approval presentation or reconnect. The original grader failure and separate offline correlation assessment are retained |
| Human questions | `cursor/ask_question`, native single/multiple selections | `normalizeCursorQuestionRequest`: all questions required; opaque UI IDs round-trip native IDs; forged/duplicate/missing selections rejected | Active-turn adapter maps canonical answers, decline to skipped, and cancellation; durable delivery still requires end-to-end evidence |
| Proposed plans and decisions | `cursor/create_plan` with full Markdown, overview, todos, named phases and project flag | `normalizeCursorPlanRequest`: complete presentation; accept/reject/cancel; revision-derived question ID; rejection feedback | Foundation question descriptions allow 100,000 chars; this boundary also enforces the 196 KiB UTF-8 durable payload cap. Oversize rejects; it is never truncated. No generated `planUri`, since no uploaded plan artifact is fabricated |
| Execution checklist | Standard ACP `plan` and `cursor/update_todos` (`merge`) | Per-turn reducer merges by native ID and emits complete snapshots with increasing revisions | Native cancelled status is visible as “Cancelled” with canonical blocked status, since canonical plan schema has no cancelled enum |
| Child activity | Optional `subagent_spawned`, `subagent_state_update`; metadata has tool-call/agent/model identity | Stateful child normalizer emits canonical delegation and retains role/task across state deltas; active-turn adapter validates parent, known child spawn, and immutable tool/agent origin | Requires client `_meta.subagents: true`. ACPX SDK 1.4.0 lacks these two update variants. A closed opt-in pre-parser intercept binds the parent and declared descendants; child text/reasoning/plan/tool summaries are attributed to their child, never flattened into the parent. Nested media and raw tool details remain partial |
| Completed subagent tasks | `cursor/task`: description, prompt, subtype, model, ID, duration | Canonical delegation with role, model, task and duration in activity summary | Dedicated numeric duration field absent from canonical delegation schema |
| Subagent questions | Pinned ACP subagent handler explicitly rejects interactive questions | No unsupported affordance advertised | Confirmed harness omission; requires upstream support |
| Generated images | `cursor/generate_image`: description, path and reference-image paths | Canonical generated/viewed artifact events; description notice; realpath/regular-file containment checks; `registered:false` | Paths are references, not automatic uploads. Revalidate before artifact ingestion. No image bytes invented |
| Files and diffs | Tool `content` includes `diff` blocks with `path`, `oldText`, `newText`; native edit output and locations | Tool lifecycle plus the runner’s separate workspace-change evidence | Provider-reported before/after blocks are preserved by ACPX but not consumed by the canonical mapper. Additional and absolute locations are dropped; structured provider-diff projection needs implementation and live proof |
| True active-turn steering | No `session/steer`; `handlePrompt` cancels its existing pending prompt before starting another | Advertise steering unsupported | Concurrent prompt is interruption/replacement, not Codex-style in-place steering. Do not mislabel it |
| Queued follow-ups | No harness queue method discovered | Control-plane scheduling can send another prompt after settlement | No native queue-management events; do not send concurrently to emulate queueing |
| Cancellation | `session/cancel` calls the active prompt cancellation callback | Existing interruption path | Process/child cleanup and exact terminal settlement require live qualification |
| Turn settlement | Prompt implementation drains background subagent completion and awaits child publishers | Existing prompt result terminal boundary; explicit owned process cleanup | Native write denial settled without side effects. Background shell/child error settlement remains unverified. Credential-free stdin EOF did not exit within five seconds; do not advertise clean EOF |
| Session continuity | `session/new`, `session/load`; load replays historical messages, reasoning, tools, images and children | Existing session load/recovery boundary with identity fencing | Duplicate replay suppression and provider-death recovery need authenticated proof |
| Session discovery | `session/list` implemented, cwd filter absolute; pagination cursor rejected | Discovered and reported | Currently unused: runner recovers only its exact recorded session; arbitrary history browsing needs company-scoped discovery API |
| Fork/resume methods | `session/fork` and `session/resume` absent in agent implementation and return method-not-found | Unsupported | Session load is available; do not infer fork from SDK schema |
| Modes | `agent`, `plan`, `ask`; `session/set_config_option` returns exact mode; native mode updates are observable | v5 admits an explicit selected mode, binds recovery identity, and gates every prompt against native acknowledgement | Default Agent; mode is independent of permission policy. Plan acceptance does not switch to Agent. Native callback availability and Plan-mode completion remain unqualified |
| Model selection | `session/set_model`, config option `model`, model-parameter options, `config_option_update`; `cursor/list_available_models` extension | Exact requested model must be selected/verified by shared admission | Authenticated listing and exact Luna variant echo passed. Native parameterized picker metadata and separate parameter changes also passed; this richer configuration path is not exposed by the runner. See the authenticated discovery evidence below |
| Available commands | `available_commands_update`, including skills/slash commands | ACPX persists command metadata; runner canonical mapper deliberately emits no display event | Command picker and bounded command-discovery surface are not implemented |
| Session metadata | `session_info_update` title after automatic naming | Capability documented | Runner owns normalized session identity; provider title is currently not surfaced |
| Prompt media | Image=true, audio=false, embeddedContext=false in observed initialize | The shared runner turn contract accepts text only; it does not forward image attachment blocks to ACP | P1: implement bounded, validated attachment-to-ACP conversion with capability checks, then qualify the exact model. Audio/embedded context are explicitly unsupported by this advertisement |
| MCP and semantic tools | Session MCP injection supports stdio/HTTP/SSE; user/project config also loaded | Runner-owned authenticated MCP bridge only; the owned distribution patch never initializes ambient MCP | Exact tool discovery and company/token boundary remain live tests |
| Usage/cost | No `usage_update`/token-usage emission found in pinned ACP implementation; prompt result contains stopReason | Must report usage unavailable, never zero or estimates presented as actual | Dollar accounting unavailable without another explicit measured source. Live spend needs a measurable bound before starting |
| Reviews, compaction, hooks, memory | Native mode changes, hooks present internally; no dedicated ACP counterparts to Codex context/hook/memory lifecycle found | No fabricated event families | Distinguish confirmed absence of ACP event mapping from unverified native internals |
| Goal controls / lineage | No ACP goal or fork lineage protocol found | Unsupported | No equivalent of Codex native goals/thread lineage |

## Wire and isolation findings

The documentation calls todo/task/image methods notifications. The pinned presenter actually calls `connection.extMethod(...).catch(...)`: these messages can carry JSON-RPC IDs. They need immediate acknowledgement plus activity normalization. They must never become human input requests or block awaiting an unnecessary decision.

Question and plan requests lack a session ID. The shared hook binds them to the retained connection, active execution/session/turn and originating request ID; it rejects stale/duplicate answers, cancels on turn termination, persists requests before exposing them, and awaits exact JSON-RPC pipe-write delivery before recording a resolved interaction. This proves transport handoff, not an additional provider application-level acknowledgement. The provider module does not substitute a best-guess session.

Fixed launch arguments are `--disable-project-configs --disable-auto-update acp`, using the verified bundled Node and absolute verified `index.js`. Private HOME/XDG roots are required together with CURSOR_CONFIG_DIR, CURSOR_DATA_DIR, disabled compilation caching, `AGENT_CLI_CREDENTIAL_STORE=memory`, and `NO_OPEN_BROWSER=1`. Only explicitly bound CURSOR_API_KEY or CURSOR_AUTH_TOKEN may enter. The controller creates a provider/session-scoped credential-name binding from the explicit task environment, ignoring inherited or caller-supplied markers. Rust forwards it through the closed sidecar environment boundary. Before host admission, the sidecar rejects missing, stale, wrong-provider or unbound credentials and removes the marker before provider launch. Tests cover this full boundary and preserve legacy credential behavior. Do not use `--force`, `--trust`, or `--approve-mcps` to paper over governance.

`--disable-project-configs` only suppresses `.cursor/cli.json`. It does not suppress project MCP, Cursor/Claude hooks, or installed plugins. `assertCursorWorkspacePolicy` refuses ambient project execution config from the workspace through its nearest Git root, including symlinks and unreadable configuration. Ordinary Claude settings with neither hooks nor plugins remain admissible. Enterprise system hooks are checked too. The host repeats admission checks before native launch. The vendor admission check alone cannot prevent a concurrent file mutation. The current `paperclip-cursor-instructions-v2` distribution patch removes local hook loading, asynchronous team hook synchronization, ambient MCP loader initialization, and ambient-client merging from the ACP source. The retained admission check remains defense in depth. This closes those discovery paths independently of filesystem polling; authenticated validation on the patched final runtime remains required.

Artifact paths are never automatically read or uploaded. References require a present regular file under the physical workspace, reject traversal and symbolic links, and retain `registered:false`. Private/outside paths are omitted and produce a visible warning. This is metadata validation, not durable file ownership or a replacement for artifact registration checks.

## Verification and open work

Passed in the provider worktree:

- 17 Cursor Vitest cases: questions, multi-selection, native ID round-trip, invalid answers, exact plan revisions, outcomes, todo delta merging, delegation metadata, path containment/symlink refusal, child identity retention, private launch defaults and project config gates; active-turn canonical response mapping and immediate acknowledgements; stale/foreign/unknown child identity rejection.
- 5 materializer Node tests: platform pins, entire-tree tampering, linked paths, archive tampering before extraction, and overwrite refusal.
- Targeted strict TypeScript compilation for both provider modules and their imported contracts.
- Credential-free wire initialization and auth/method probes, plus real macOS ARM64 materialization and archive/closure inventories for the other two platforms.

The generic native-distribution lease now snapshots the pinned closure, launches Cursor through its verified bundled Node with a closed-module guard, and uses the existing lifetime guardian. A real nonbillable Cursor initialization passed through that lease. Its six focused tests passed, including argument fencing, external module rejection, and native child ownership/exit proof. The existing snapshot suite also passed. The foundation’s later master integration refreshes the common Claude/Codex pins; the candidate pack below was built against that synchronized graph.

Priority follow-ups before advertising support: (1) per-attempt cost attribution despite missing native usage receipts; (2) durable restrictive-approval and interruption proof; (3) remaining local and Daytona files/artifacts, questions/plans, recovery and settlement proof; (4) parent tool content/diff projection and richer nested child presentation; (5) authenticated trace audit for additional unconsumed native fields. Shared receipt/recovery coverage now proves pipe delivery, provider-loss expiry, exact lifecycle IDs and no approval replay.

Remaining rich capabilities intentionally unused: session discovery, generic mode/config-option UI, provider session titles, command/skill picker metadata, full nested child transcripts beyond bounded delegation summaries, native numeric task duration, and optional planUri. They are listed above with reasons; neither “unsupported” nor “complete” should be inferred for unverified live behaviors. The final combined report must update this inventory with integration evidence and include any further events observed during authenticated qualification.

Shared display-channel verification additionally covers exact rich-event schema validation, terminal/semantic/source injection rejection, active-turn fences, complete Unicode plan preservation through durable outbox persistence, secret redaction disclosure, and oversized UTF-8 rejection. The 4 KiB diagnostic preview cap remains active for diagnostics, never full approval documents.

## Child transcript boundary and remaining fields

Pinned source creates a separate session-update presenter for every child and can use another child as the immediate parent. Enabling `_meta.subagents` therefore requires handling both lifecycle and ordinary child session updates. The Cursor-specific ACPX compatibility path tracks declared descendants per stream and active prompt, forwards them only under the retained root parent authority, and suppresses unknown child sessions. It leaves the SDK's standard parent update schema closed. Known child updates never become parent assistant messages. Old-stream, foreign-parent, pre-turn, settled, aborted, oversized, unknown-child and duplicate-spawn cases are covered.

Child assistant/reasoning text, plan steps and tool lifecycle are displayed in each child's activity summary. The 4,000-character activity surface retains a clearly marked tail when it fills; this is a summary, not a complete nested transcript. Child tool raw input/output, locations, diffs, media content and other child update fields are not rendered by this summary surface and produce explicit partial-detail notices. Adding canonical child transcript/tool surfaces is the next priority for these meaningful exposed fields. Native `capabilities:{}` currently carries no populated child capability fields; `_meta.cursor.agentId` and `toolCallId` are retained internally for immutable origin checks. Nested parent identity is represented in activity metadata because canonical delegation has no parent-child relation field. Native `disconnected` now yields a failed child with a visible explanation, never a successful completion.

Three real ACP stream tests prove child lifecycle/transcript preservation before SDK parsing, nested parent attribution, standard parent parsing, and old-stream/turn/connection fences. Shared extension, reply-delivery and Pi receipt package cases pass against the resulting patched package; the current totals are recorded below. Three native factory cases verify all platform pins, exact profiles, and rejection of unsupported distributions; native assets resolve only from the runner-owned package authority.

## Integrated pack and offline launch evidence

The full `build-provider-pack.mjs --candidate-providers=cursor` path passed on source `25fb1b5b317e52a8ad50208d7681a1ee34bd939c` (foundation includes upstream master `18e8c121d`). It used standalone Node, pnpm 9.15.4, a fresh production deployment and the pinned vendor archive. The build checked portable Node relocation, fresh ACPX import and complete Cursor materialization. The retained manifest is `packages/paperclip-runner/test/fixtures/cursor-acp/provider-pack-darwin-arm64.json`; it contains only relative paths and digests.

- Pack digest: `sha256:38bc6dd39c13b0f5478a1018e26deb61b0333ab0242f3d857e3c79d3a34b7682`.
- Cursor declaration: `sha256:c91aa592ec867071ec4457b9b7230399ce42ad918787ceed99b4b651ea5607e2`.
- macOS ARM64 closure: `sha256:77394184a89b0e7384971181da19c3c82d83a399b04e7944b3f94fe3d7e62b25`.
- Resolved dependency lock: `sha256:9eea60187c6c808efb4d936a234a8d8000beac45253091abd4c5348132bd1408`, also the reviewed Daytona build digest for this branch. This digest was resolved from the clean tracked lock with the exact Docker resolution-only command. A second resolution from the clean tracked lock produced the identical digest; the frozen install applied the Cursor/Grok combined patch successfully. The image consumes the reviewed resolved-lock artifact without registry resolution. Image creation rejects a different digest before execution.

`provider-pack-offline-proof.json` records a real launch through the generic profile installation registry from the pack’s verified native closure and retained snapshot, using private directories and no credentials. ACP v1 initialize succeeds. The correct `cursor/list_available_models`, `session/list` and `session/new` methods return authentication-required; `session/fork` and `session/resume` return method-not-found. The process produced no stderr, was explicitly terminated after these probes, and its lease closed. The earlier discovery fixture’s `_cursor/list_available_models` probe used an incorrect method prefix; this later probe corrects that uncertainty without changing the original evidence.

A separate credential-free macOS probe on the same final pack initialized with JSON-RPC request ID `0`, then closed stdin at 20:56:57.776 UTC. The native process did not exit within five seconds and produced no stderr. The probe then sent the owned process group SIGTERM and closed its native lease. `provider-pack-offline-proof.json` retains `eofSettled:false`. This is a native lifecycle limitation: no clean-EOF guarantee is claimed. Production cleanup uses explicit process ownership and termination; Linux image qualification must separately record EOF behavior and verify bounded explicit cleanup. This probe sent no credentials or model prompts.

At the prior foundation checkpoint `7721662f2`, the TypeScript/verified-sidecar build and all 177 targeted cases passed: Cursor normalization/policy/artifacts, credential bindings, the durable launcher's actual process specification, candidate backend admission, and sidecar behavior. The actual process-launch regressions verify explicit candidate credentials and their marker survive the final closed allowlist; ambient credentials and caller-supplied markers cannot select themselves. The prior source `f09a9a3f8` passed all 47 CI jobs after one retry for runner shutdown and a wall-clock rate-limit case, plus Greptile 5/5; it also passed 29 installed ACPX/materializer Node cases and 6 Daytona image-content cases. These prior results remain historical, distinct from the final source proof.

The current pack/probe binds foundation `f063fbf2b`, including candidate admission, biller attribution, explicit unavailable usage, actual-spawn credential binding, and preservation of usage receipts on terminal provider failure. The verified TypeScript build, 56 Cursor/sidecar/eval-provider tests, 67 shared live/eval tests, and 25 mixed-usage contract tests passed during these qualification fixes. Earlier pack evidence remains in Git history. Its explicit offline factory model sentinel is not an authenticated model selection; no ACP prompt was sent. Daytona content identity includes the candidate selection, Cursor materializer and distribution manifest. This is local macOS ARM64 packaging/initialization evidence only. It does not qualify Linux execution, a Daytona image build/run, authenticated model work, permissions, or dollar accounting. No screenshot is claimed for these headless tests. That offline probe submitted no prompts and incurred no model usage. Subsequent authenticated attempts are recorded separately below.

The final pack passed 31 installed-package/materializer contract tests, 82 Cursor/integrity profile tests (six platform-specific skips), and 12 candidate/image-content tests. TypeScript and verified-sidecar compilation passed. Its generic installation registry probe initialized the pinned native executable without credentials or prompts, then shut down cleanly. A fresh release daemon was built from source `78360fa55adff11da9f200b228467eca782b81e1`, Rust tree `17d327094be5759d80ef5bd02e15c59e78548ea2` (identical to foundation `f063fbf2b`), SHA256 `e6a9fb5170b76a49b8411834b3706e8edf8f1a1ae85ad13b55368158aa7f67a0`. This source includes bounded snapshot copying and public Grok packaging. Earlier paid attempts retain their original sources, package identities, and daemon digests; refreshing packaging does not rerun or extend their qualification.

The locally built Linux x64 image also passed credential-free native initialization through the generic installation registry and immutable lease, with Docker networking disabled. Image ID is `sha256:5fa7951d1d6dd99305555fe00a5baf2bf5b834d16f021053737301975b93986f`, built from provider source `25fb1b5b317e52a8ad50208d7681a1ee34bd939c`. The Linux pack digest is `sha256:5fab4bc1f0633561b7d7e858a535ebd23faeccedb5f86044df071a3206d949ba`; the runner daemon SHA256 is `5eb3031aed118112caf0b80ea67a6cd01283098e2b4e526ef02d1416d125a1fb`. The pinned Cursor closure is `sha256:bf04ef8ea6a63191067a6b3e15139aa2c793d8419daab246aa3f0a012e1bbcd9`. ACP initialize request ID `0` returned protocol version 1. Linux also reported `eofSettled:false`; bounded explicit process-group termination and lease cleanup passed. `linux-image-offline-proof.json` retains the identities and limits. This local container proof sent no credentials or model prompts and is not a paid Daytona run or authenticated Linux qualification.

## Authenticated discovery evidence

`test/fixtures/cursor-acp/authenticated-capability-probe.json` records the user-authorized follow-up on 2026-09-28. The pinned verified distribution returned 41 model entries, created a session, accepted `gpt-5.6-luna[context=272k,reasoning=medium,fast=false]` through both `session/set_model` and `session/set_config_option`, and returned that exact value. No model prompt was sent. These facts establish authentication and model selection, not inference entitlement or full runner qualification.

The native picker has two materially different interfaces. Ordinary ACP advertises fixed variant IDs. It rejected `grok-4.7[context=256k,reasoning_effort=low,fast=false]`, although each individual parameter value is advertised by the separate catalog. Advertising client `_meta.parameterizedModelPicker:true` enables base model `grok-4.7` and separate `session/set_config_option` calls; context `256k`, `reasoning_effort:low`, and `fast:false` all succeeded and were echoed. The runner does not yet negotiate or project this parameterized configuration path. Follow-up P2: bind the model plus complete verified parameter map to profile/recovery identity and expose supported options without silently choosing a default. In particular, this account's Grok and Composer catalog defaults enable the more expensive Fast option.

Credential setup uses [Cursor's documented browser login](https://cursor.com/docs/cli/reference/authentication), with an isolated task-owned home and the pinned file credential store. Only the access token was explicitly saved in the operator's private secret file; credentials and refresh tokens are absent from retained public fixtures. The [official usage guide](https://cursor.com/help/account-and-billing/overages) distinguishes included usage from on-demand charges and warns that spend-limit enforcement is delayed. The first prompt therefore requires a separately reserved budget and attribution from the account usage records; missing ACP usage remains unknown, never zero-cost inference.

## Authenticated qualification attempts

`test/fixtures/cursor-acp/authenticated-qualification-attempts.json` retains sanitized per-attempt source, package, daemon, model, timing, cleanup, and cost evidence. The first canonical `get-task-context` attempt used pack source `e5159fb67ad28bf6a691bfa64ffddb332d96f8be`, exact Luna selection, one turn, a 60-second limit, a $0.50 declared envelope inside a $2 reservation, and zero retries. This is a Runner Eval against the mock control plane, not Product E2E or restrictive-permission qualification.

The provider returned only an upgrade requirement and then normal completion. Source inspection of pinned `5672.index.js` confirms that actionable authentication/entitlement errors are rendered as ordinary assistant text and lose their typed failure before ACP settlement. No text-matching terminal heuristic is used. This was a native-wrapper gap in that unmodified candidate. The owned distribution patch described below preserves those typed errors as failed ACP RPC responses; the historical attempt is unchanged. The semantic oracle must still fail a response that did not invoke the required tool.

The replacement-account attempt passed all four canonical `get-task-context` checks at source `01959b8a602683f13706807983f02c3cba9d36a0`, using newly rebuilt daemon source `f77ae83aeb6d802c73f1c955760017ae272eba29`. Both `get_task_context` and `get_task_history` returned successful authenticated semantic results. It took 29.291 seconds and exited cleanly. The Usage page showed a new `gpt-5.6-luna-medium` row at 19:28:55 UTC with 56K tokens, marked Included. Incremental cash was zero for that row; metered dollars remain unavailable. A conservative $0.07 list-price bound assumes at most 57K rounded tokens at the maximum listed $1.20/M rate and is not an invoice amount. There was no retry.

The local Product hello first stopped at agent creation with HTTP 422 before any provider prompt. Foundation `26dde3cfe` fixed exact host-owned candidate/model admission at the public agent API. The separately authorized replacement passed at source `edf538e61e712dddb6b4d59045c3dcfd445686c7`, from 19:41:56.376 to 19:42:38.761 UTC. All six independent matchers passed: one exact completion marker, task Done, run succeeded, native mode, and local execution. The retained run confirms the 120-second configured deadline, no timeout, committed finalization, and clean cleanup. The final screenshot was inspected and shows the Cursor assignee, tool activity, one completion marker, and Done status. Native usage is null. The account Usage page attributes a new 19:42:25 UTC Luna row with 41.7K tokens, Included in Pro Plus, and zero incremental cash. Metered dollars remain unavailable; a conservative $0.06 list-price bound uses at most 42K rounded tokens at $1.20/M and is not a billing receipt. This proves the local completion-tool product path, not native question/plan, permission, file, recovery, or Daytona qualification. Both attempts remain in the sanitized evidence fixture.

The local file-edit Product case passed at source `fe132224c2b30a8d9ce7b46cea38b8760af233fc`, from 19:44:43.582 to 19:45:24.406 UTC. All seven matchers passed, including an independent exact-byte read of the 24-byte final file. A native shell command created then rewrote the file and asserted the expected bytes; tool lifecycle and output were retained. The inspected browser screenshot shows the file, a downloadable workspace artifact card, edited-file activity, the completion marker, and Done. Cleanup passed. This is workspace artifact discovery and presentation evidence, not provider-reported diff projection. The account Usage page attributes a 19:44:59 UTC Luna row with 84.1K tokens, Included in Pro Plus, and zero incremental cash. Metered dollars remain unknown; the conservative list-price bound is $0.102, not an invoice. The trace also confirms a meaningful remaining field gap: native command `rawOutput.exitCode:0` survives in serialized output, while canonical `exitCode` remains null; extracting only validated command results is a P2 follow-up.

The merged-source local question Product case passed at `a7e01a0cec397dd5048f5d5b5825658dc6e91450`, from 20:04:44.147 to 20:05:52.691 UTC. Its two expected provider runs submitted at 20:05:00.738 and 20:05:30.525 UTC, with no retry. The real `request_human_input` semantic tool produced a pending single-choice question, the browser selected Cobalt through the public response endpoint, the answered interaction woke the assignee, and the task completed with one final marker. Both pending and final screenshots were inspected; all six terminal matchers, lifecycle invariants, and cleanup passed. Bounds were 120 seconds per turn, 300 seconds overall, and a $2 reservation. Native usage is unavailable. The dashboard attributes Included Luna rows at 20:05:01 UTC (35.5K tokens) and 20:05:35 UTC (42K tokens), with zero incremental cash; metered dollars remain unavailable. A conservative $0.10 list-price allowance is not an invoice. This is semantic interaction and continuation evidence, explicitly not qualification of native `cursor/ask_question`, server restart recovery, or plan decisions.

The local Product Plan case also passed on the same frozen source `a7e01a0cec`: 20:09:56.429–20:10:49.114 UTC, two expected turns, six passing terminal matchers and no invariant failures. The inspected UI displayed the complete two-step Plan at revision 1. The pending confirmation's `target.revisionId` exactly equaled the displayed document's `latestRevisionId`; it was accepted before continuation and successful completion. Both account Usage rows (48.5K and 43.7K) were Included with zero incremental cash; native metered dollars remain unavailable. This covers semantic `write_document` plus `request_human_input` confirmation, not native `cursor/create_plan`.

The first subsequent server-restart attempt **failed**; the later authorized retry is recorded below. Its first launcher attempt failed before any provider call because the task's temporary Unix socket path exceeded the macOS limit; the zero-prompt failure remains recorded. An explicitly authorized infrastructure replacement used a short canonical private path and produced the required pending question. During the requested restart, embedded PostgreSQL failed `semget` because the host semaphore limit was exhausted. No answer or continuation occurred. The original result remains failed (`transient_infrastructure`), including failed API cleanup verification; a separate process inspection found no surviving task-owned server, PostgreSQL, runner, or provider process. The dashboard attributes one 20:13:38 UTC Luna row with 23.7K tokens, Included in Pro Plus, zero incremental cash, and no continuation row; native metered dollars remain unavailable. Exact submission time was not recoverable from the post-failure API snapshot, so attribution uses the retained case window. No automatic retry was made.

The explicitly authorized serialized restart retry passed on source `d35b83074a018537f5475568d7410e3b1d676789`, using the final pack and matching release daemon, from 20:42:13.120 to 20:43:10.985 UTC. All six matchers passed, no invariant failed, and cleanup passed; a separate process inspection confirmed no remaining task-owned processes. The real pending semantic question survived the server restart, was answered Cobalt through the browser, and produced one successful continuation and Done. Both screenshots were inspected. This establishes semantic interaction persistence and wake-assignee recovery, not restoration of a blocked native `cursor/ask_question` request. The dashboard attributes two Luna rows at 20:42:26 UTC (23.8K tokens) and 20:42:57 UTC (41.7K), both Included with zero incremental cash; the displayed current-account total is 458.1K across eleven requests. Native metered dollars remain unknown. Original launcher and PostgreSQL failures remain retained.

A separate native AskQuestion sidecar probe on final pack source `25fb1b5b317e52a8ad50208d7681a1ee34bd939c` sent one prompt at 20:39:47.990 UTC, with no Paperclip semantic tools. It requested single and multiple selection through Cursor's native question tool. The provider instead replied “The native AskQuestion tool is unavailable in this session,” emitted zero native input requests, and ended normally. The qualification oracle correctly failed; session close passed. The dashboard attributes a 20:39:48 UTC row with 17.4K tokens as Included, with zero incremental cash and unknown native metered dollars. This is observed default-mode tool unavailability, not proof of absence in every Cursor mode. The pinned source implements `session/set_mode` for agent/plan/ask and native question/plan handlers; the runner currently has no explicit mode-selection command. Retained native initialization exposes modes and model settings but no native tool inventory or question/plan availability bit. The bundled `ask_question_all_modes:true` default does not prove the server-selected tool catalog. No native Plan prompt was attempted, and no native interaction pass is claimed.

The restrictive native denial probe used the final verified pack and exact Luna model, with one prompt submitted at 20:52:07.462 UTC. Cursor emitted numeric request ID `0` for the shell write. Its offered IDs were `allow-once`, `allow-always`, and `reject-once`; the client selected the unchanged `reject-once` and acknowledged the pipe write at 20:52:10.919 UTC. The provider ended at 20:52:11.980 UTC. The forbidden marker was absent in all 98 independent samples, including before launch, at the terminal, five seconds later, and after process-group and lease cleanup at 20:52:16.996 UTC. This establishes the native harness denial behavior, not sidecar normalization, Rust durability, or Product approval UI.

The original probe grader failed because it expected `rawInput` on the permission frame. That frame omits the arguments, while the preceding same-session `tool_call` carries the exact command under the identical native `toolCallId`. The original failed result remains immutable. A separate offline assessment correlates that exact command, session, tool identity, actual response and delivery acknowledgment with the original marker samples; it passes without another model call. Tests reject missing binding, a different tool ID, a different command, wrong kind, or a title alone. `native-denial-proof.json` retains this distinction and sanitized wire frames. The account Usage page attributes 24.4K tokens at 20:52:07 UTC, Included in Pro Plus, bringing the displayed total to 482.5K across twelve requests with zero on-demand charge. Native metered usage remains unavailable. The conservative $0.03 list-price allowance is not an invoice.

The first attempt also exposed the shared live-eval layer's rejection of missing usage. The foundation now retains explicit unavailable-usage records for diagnostic candidates, leaves the numeric receipt ledger empty, preserves the response for grading, and keeps unknown aggregate costs unknown across mixed turns. This fix does not retroactively turn the retained failed attempt into a pass.

[Cursor's Grok Bot billing documentation](https://cursor.com/help/grok-bot/plans) says linking SuperGrok grants Grok Bot usage while leaving the Cursor plan unchanged. [Cursor's pricing page](https://cursor.com/pricing) lists Composer for free Hobby and frontier models for paid plans. These documents and model-list presence do not establish entitlement for a particular CLI prompt. The operator selected a replacement Pro+ account; its exact Luna configuration was echoed successfully, with no automatic model substitution.

## Exact remaining field audit

This source audit follows pinned native update → ACPX runtime → `canonicalProviderEventsFromAcpxRuntimeEvent` → Paperclip activity. It supplements the higher-level capability matrix and does not claim an authenticated trace was captured.

| Native field/interface | Preserved boundary | Current projection / reason for partial use | Follow-up |
|---|---|---|---|
| Prompt image blocks | Pinned native initialize advertises image input | Shared `AcpxRuntimeTurnInput` has only `text`; `codex-runtime-adapter.ts` passes that text to ACPX, so no image blocks reach the wrapper from a runner turn | P1: add validated, bounded attachment inputs through the runner/ACPX contract, then prove exact-model behavior; native advertisement alone is not implementation evidence |
| Parent tool `rawInput` | ACPX forwards the body | Canonical tool schema exposes only `inputUpdated`; full native arguments are not displayed | P1: bounded/redacted tool-argument presentation with company and path checks |
| Parent tool `content[]` diff `path`, `oldText`, `newText` | ACPX forwards structured content; native permission requests also use it for proposed changes | Canonical tool mapper uses `rawOutput`, so completed provider-reported diff blocks have no dedicated output surface; separate workspace evidence is not equivalent | P1: validate physical workspace locations and expose attributed diff artifacts |
| Parent tool `content[]` images/resource blocks | ACPX forwards blocks and produces a summary | Structured media is unused by canonical tool output; safe registration/location semantics must precede ingestion | P1: validated artifact reference projection with explicit provenance |
| Parent tool `locations[]` | ACPX forwards bounded locations | Only first relative location becomes `target`; absolute paths and additional locations are discarded | P1: workspace-aware multi-file attribution; never strip arbitrary absolute prefixes |
| Parent tool `rawOutput` | ACPX forwards raw value | Canonical output is bounded serialized text, not lossless structured data; truncation is marked by output metadata | P2: typed tool-result detail viewer when useful |
| Plan step priority/native extras | ACPX plan entries | Display uses body/status and fixed ordinal step IDs; priority and unknown metadata have no canonical fields | P2: add explicit bounded fields if native traces show product value |
| Commands, config options, session title | ACPX persists/normalizes `available_commands_update`, `config_option_update`, `session_info_update` | Canonical display mapper explicitly skips these tags; exact model admission remains separate | P2: company-scoped command/config/title surfaces |
| Child tool raw arguments/results, locations, diffs and media | Cursor child intercept retains validated update for its adapter | Child activity keeps bounded attributed summaries, with visible partial-detail notices; there is no nested transcript/tool detail surface | P1: canonical child transcript and tool/artifact relation model |
| Child `_meta.cursor.agentId` / tool origin / parent ID | Retained for immutable-origin and descendant checks | Internal identity guards; parent relationship is textual metadata because canonical delegation lacks an edge field | P2: typed delegation lineage |
| Task numeric `durationMs`, optional accepted `planUri` | Native task/plan extensions | Duration is visible in summary; no numeric delegation field. No plan URI is returned because no plan artifact is registered | P2: typed duration; only return an actually registered plan URI |
| Session list, model parameters, generic mode control | Confirmed native ACP methods | No operator UI or cross-session discovery API in this integration; recovery loads only the runner-owned exact session | P2: explicit company-scoped controls; authenticated model catalog first |

True steering, native queueing, fork/resume, native usage receipts and interactive child questions are absent from this pinned ACP implementation as described above. Their absence is distinct from the implemented-but-unused fields in this table. Remote team hooks, provider-native artifact traces, interruption settlement and authenticated Linux/Daytona behavior remain unverified, not confirmed absent.

## Initial isolation patch, profile v3 (2026-09-29)

The initial profile v3 materialized `paperclip-cursor-isolation-v1` on top of the
unchanged vendor `2026.09.26-dd393fe` archives. The materializer first verifies
the archive and **vendor** execution closure, requires exact single-occurrence
source anchors in an input-digest-pinned ACP chunk, applies the owned patch,
then verifies a separately pinned **patched** execution closure. Both identities
remain in the distribution manifest. Unknown, changed, already-patched, or
ambiguously matched source fails closed. The patch does not change the legacy
Cursor adapter or the vendor interactive CLI.

The ACP shared-services initializer no longer initializes or loads its ambient
MCP loader. Each ACP session starts with an empty client lease and adds only the
explicit session MCP definitions, preserving native last-definition-wins behavior.
It never borrows an earlier or ambient lease, including when the session MCP list
is empty or invalid. Local hook config is an empty snapshot, and the remote team
hook fetch/install/update path cannot start. Newly created project config during
a session therefore cannot enter either removed discovery path. This is source
isolation, not an operating-system sandbox: explicitly allowed native shell
commands still have their granted filesystem/network powers.

Typed `ActionRequiredError` instances now produce a failed JSON-RPC response
with data schema `paperclip.cursor.provider-error.v1`, kind `action_required`,
and the closed action enum `login`, `upgrade`, `payment`, `config`, or `unknown`.
Login and native `ConnectError` with the Unauthenticated code use ACP error
`-32000`; other action requirements use `-32603`. Provider-private error detail
is not copied into these responses. Ordinary assistant text is never examined to
infer an entitlement failure. Generic provider exceptions outside these typed
branches retain the vendor behavior and remain an upstream audit item.

`qualify-cursor-runtime-patch.mjs` executes expressions extracted from each actual
input-digest-verified platform chunk. Its poisoned ambient loaders prove no
ambient access while owned MCP, empty sessions, and duplicate definitions work;
it also executes all typed error branches and ignores entitlement-shaped ordinary
errors. The entire patched chunks compile for macOS ARM64/x64 and Linux x64.
`runtime-patch-offline-proof.json` records these checks with zero provider calls.
All three authentic archives separately passed materialization and post-patch
closure verification. Seven materializer tests cover drift, ambiguous anchors,
closure tampering, links, archive tampering, identity consistency, and overwrites.
Both patched macOS binaries also returned ACP v1 from credential-free real-process
initialization and exited after explicit SIGTERM; x64 ran through the ARM host
compatibility layer. `runtime-patch-initialization.json` retains this distinction.
These are offline checks, not authenticated macOS x64 or Linux/Daytona qualification.

Prior Product/Runner results above measured the earlier unpatched runtime. The
profile must retain pending qualification until the rebuilt final foundation
runtime passes the remaining native interaction, durable approval, cancellation,
recovery, accounting, and authenticated target-platform gates.

### Frozen profile v3 build

[The retained build record](../../packages/paperclip-runner/test/fixtures/cursor-acp/production-v3-offline-build.json)
identifies exact runtime source `526081b9d6c905de5e2da680e3a37c620899b380`,
profile v3, the ARM64 portable package and matching release daemon, both lock
hashes, the committed ACPX patch hash, and credential-free launch results.
Dependencies were installed into a fresh private store with copied files to
avoid borrowing mutable package bytes from another worktree. The initial frozen
install failed because the committed lock's patch configuration differed; that
failure is retained. A private derived staging lock then passed frozen install.
The repository lock was not changed.

The package's real immutable lease passed ACP initialization, required
authentication for model/session discovery and creation, rejected unsupported
fork/resume methods, and closed with no stderr. The TypeScript and release daemon
builds passed. Twenty-six installed-package contracts passed. Another 184 control
tests passed, including two Cursor-specific tests using the real installed ACP
SDK stream: sessionless native single/multi-selection and complete revision-bound
plan replies preserve request ID zero, await response pipe delivery, reject stale
plan revisions, and suppress late answers after cancellation. The surrounding
suite covers mocked admission, permission identity, provider-loss expiry,
recovery fences, and cleanup ownership. These are deterministic tests, not live
native interaction, durable browser approval, or provider-death qualification.

The new `cursor-runtime-patch.mjs` is present in the Docker build context. It is
also a required Daytona content-identity input: changing patch source must change
the image identity even when another declared input is unchanged. Publishing or
qualification must use an image whose content hash includes that script.


## Profile v4: instruction delivery and admission (2026-09-29)

The pinned native ACP implementation ignores `_meta.systemPrompt` on session
creation, and ACPX does not send it on load. Native workspace rules do not read
Paperclip's registered `AGENT_HOME`. The hidden `--system-prompt` option is an
internal-team-gated interactive CLI feature and is not used by this integration.
Those facts invalidate any assumption that prior transport success alone proved
canonical governance or custom entry instructions reached Cursor.

The owned `paperclip-cursor-instructions-v2` patch preserves the v3 isolation and
typed-error changes and adds the composed instructions through Cursor's native
`LocalResourceProvider.additionalRules` path. The sandbox supplies an ephemeral,
controller-owned `PAPERCLIP_CURSOR_INSTRUCTIONS` payload. Ambient environment
cannot select or replace it, and it is not persisted in ACPX's launch environment
record. The payload binds exact UTF-8 content (maximum 32 KiB, no NUL) to SHA-256;
it includes the already-composed governance, custom entry content and registered
agent-home context, without discovering another workspace instruction file.
Explicit empty content has an empty rules list and the SHA-256 of empty bytes.

Native session creation and load both use this process-owned snapshot and return
`_meta.paperclipCursorInstructions` with schema, exact digest, and byte length.
The additional rule uses the native global-rule representation and retains
native ordering: additional rules precede the ordinarily discovered project
rules in `RequestContext.rules`. It is not prepended to the user's message and
does not replace Cursor's built-in system prompt. The synthetic rule identifier
is `paperclip://runtime/instructions`; no generated instruction file is exposed
to workspace discovery.

A synchronous ACPX `protocolGuardFactory` checks each connection independently.
It correlates the acknowledgement with the exact new/load request and session,
rejects missing or mismatched acknowledgements before SDK dispatch, and blocks
outbound prompts until that session is admitted. Provider death and automatic
reload reset authority. The adapter also asserts admission immediately after
`ensureSession`. A best-effort observer cannot authorize a prompt. The shared
patch retains upstream terminal-failure diagnostics, rich interaction callbacks,
response-delivery receipts, and Cursor child-event handling.

[The v4 declaration](../../packages/paperclip-runner/test/fixtures/cursor-acp/profile-v4-identity.json)
binds profile digest `sha256:b1440d559ebc4eef5c7a582f1c81fc153270cfbafa1731a8ee76d83713bdf61b`
to all platform closures and ACPX patch SHA-256
`64180c194ab841d6f4bba7e6eca5ead621c6222c9a8057e4bb2bb6f007d8bb3c`.
Vendor archive and vendor closure hashes are unchanged. All three pinned archives
passed fresh materialization and the new patched closure check:

| Platform | Patched closure SHA-256 |
|---|---|
| macOS ARM64 | `912a37edb67fd7737809c24049dce2db20b1330f98b15a6e43809f0e0943cb6c` |
| macOS x64 | `322f54c7bd533b202a311ce8e2c8916bfe0202790ef8a40fbb36bb89cbd506cb` |
| Linux x64 | `a375fc771dfe86b9b24532f95956ec4b02c5f4f24d80f5db06565160eb3b672c` |

`qualify-cursor-instructions.mjs`, called by the existing patch qualifier, executes
all three digest-verified native resource constructors and bounded payload logic.
On ARM64 it additionally executes the exact patched new/load methods and native
cache/RequestContext construction with explicit dependency doubles, proving the
composed bytes and native ordering at that boundary. This is an offline source
execution proof, not a claim that an authenticated model obeyed the instructions.
[The retained proof](../../packages/paperclip-runner/test/fixtures/cursor-acp/instructions-v4-offline-proof.json)
and `runtime-patch-offline-proof.json` record the limits.

Nine new deterministic tests cover exact UTF-8 and empty instructions, ambient
injection exclusion, recovery refresh, request/session/connection authority,
actual SDK new/load admission, and actual runtime automatic reload after provider
death. Valid acknowledgements permit the prompt; missing or wrong digests fail
before prompt bytes. Another 113 adapter/sandbox/identity tests, 25 fresh isolated
ACPX contracts, seven materializer cases, and the runner TypeScript compile pass.
No paid calls or billing mutations were made. A new final-source provider pack
and daemon, authenticated instruction semantics, and the remaining live gates
are still required before qualification.

## Cursor profile v5: admitted native session modes (2026-09-29)

The explicit `acpxSessionMode` configuration selects `agent` (the default),
`plan`, or `ask` for Cursor. The provider/sidecar field is `cursorMode`; it is
separate from ACPX's persistent/oneshot session lifecycle. Other providers reject
this field. Mode is included in the immutable session key and recovery identity;
a missing or changed mode cannot reopen an existing v5 session.

Admission checks the pinned native `session/new` or `session/load` response's
mode configuration and mode state. If necessary, it sets the selected mode using
`session/set_config_option` and requires its exact echoed configuration before
admitting a prompt. A bare `session/set_mode` response or asynchronous
`current_mode_update` alone is not acknowledgement. Every new native connection
gets a fresh guard: a mismatched automatic reload blocks prompt delivery, and an
unsolicited active mode change fails closed. Explicit startup/reopen admission
can reassert the selected mode within the existing admission deadline and renews
the consumed launch lease after each temporary control connection.

The pinned CLI maps Agent to native `default`, Plan to `plan`, and Ask to
`search`, and carries that metadata into the native UserMessage mode. The
inspectable `mode-v5-offline-proof.json` executes the pinned native methods with
storage, transport, and enum-converter doubles. Real ACPX fixture tests separately
prove cold-manager load/control ordering and automatic reconnect rejection before
prompt bytes. Neither is paid model/tool qualification.

Native mode does not change Paperclip permission policy, company governance, or
filesystem isolation. The native descriptions say Plan is read-only planning and
Ask has no edits or command execution; these descriptions are not an OS sandbox
claim. Native ACP CreatePlan acceptance does not itself mutate session mode in
the pinned handler. An approved plan therefore stays in the selected Plan mode;
there is no implicit promotion to Agent mode. Actual native question/plan callback
availability, Plan-mode governed completion, and accepted/revised artifact flows
remain pending Product qualification. Existing v4 paid results and macOS x64
Rosetta build evidence remain historical and do not qualify v5.

[The v5 declaration](../../packages/paperclip-runner/test/fixtures/cursor-acp/profile-v5-identity.json)
binds digest `sha256:aa8c0b2b84786982bcd06b7634bf95be6f2bc42bb8def48a8751dc50cf739b6b`.
Profile v5 retains the native distribution closures and instruction patch. Its
canonical declaration adds the admitted mode policy and binds ACPX patch
`79aad2d688b03362e8cfcbf7a08f78a8383869f6882a9c9ed66f1d18efb94f2b`, which preserves
identified empty rich-input chunks at the native parser boundary.
