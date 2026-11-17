# Kimi Code native boundary

Research date: 2026-10-28. These are source observations and deterministic
package checks. They are not authenticated Product E2E qualification.

The maintained runtime is **`@moonshot-ai/kimi-code@2.3.3`**, release commit
[`ec495f0`](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.3.3).
It is a Node.js/TypeScript application distributed both as a packaged native
executable and an npm package. The Python
[`MoonshotAI/kimi-cli`](https://github.com/MoonshotAI/kimi-cli) repository was
archived on September 23, 2026. Its Wire 1.10 documentation does not describe
the maintained runtime's public interface. The new npm bundle is inspectable
JavaScript; its internal ACP/core/Klient packages are private workspace packages.

## Selected transport and instruction delivery

[`kimi acp`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/docs/en/reference/kimi-acp.md)
speaks stdio JSON-RPC ACP. The maintained alternative is the REST/WebSocket
[`kimi web`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/docs/en/reference/server-api.md)
server. ACP reuses the existing Runner integration and avoids owning a second
HTTP-server lifecycle.

Native `AcpServer.newSession` accepts the workspace, extra directories and MCP
servers; load/resume accept current ephemeral MCP configuration. It does not
accept system instructions. The ACP CLI only consumes its login/region flags;
ordinary `--agent-file` does not establish ACP instruction admission.

The owned patch in `scripts/patch-kimi-runtime.mjs` verifies the entire official
npm `dist/main.mjs` SHA-256 before matching each unique source anchor. The
materializer verifies the complete patched output hash. The embedded helper
uses a single canonical owned source string so the raw patcher and installed
esbuild provisioner produce identical native bytes. The patch reads one
bounded process-owned `PAPERCLIP_KIMI_INSTRUCTIONS` JSON snapshot, validates its
content digest and byte length, then removes that variable from the environment
inherited by tools. Exact literal bytes are appended after native profile
composition through `AgentProfileService.systemPrompt`.

The native requester uses `getSystemPrompt()` in `captureTurnRequestConfig`
and `createModelRequest`; compaction uses the same getter. A restored or
recomposed profile therefore still receives the current literal suffix.
At the ACP native-runtime binding callback, the live main-agent scope reads
its effective `getSystemPrompt()`. Only that readback produces the session
receipt returned by new/load/resume. The receipt carries the bound-content
digest/length and the effective native prompt digest/length. Runner must match
the response to the active request and connection before sending a prompt.
The receipt proves delivery; an authenticated behavior case remains required.

Relevant source: [`profileService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/agent/profile/profileService.ts),
[`llmRequesterService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts),
[`server.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/server.ts),
[`start.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/start.ts).

## Capability and loss inventory

| Native capability | ACP boundary and release implication |
| --- | --- |
| Model selection | `session/set_config_option` with `configId: model` returns current `configOptions`; `session/set_model` returns `{}` and emits a config update. Require the exact model acknowledgment before a prompt. Model aliases and provider-native model IDs are separate config fields. |
| Thinking | Config option exposes declared effort values or on/off; unsupported values fail. It must be tested for the selected account/model before advertising it. |
| Tools | Start, streaming arguments, full input, result/error and file diffs are projected. Native `tool.progress` only projects status text; stdout/stderr/progress/custom updates are dropped. |
| Reasoning | Thinking deltas become ACP thought chunks. Apply the existing Runner reasoning visibility policy. |
| Assistant messages | Upstream ACP emits text without the native step identity, merging progress and final messages. Patch v5 forwards actual main-agent step UUID/start/end facts with their native finish reason. The provider projection preserves separate messages, clears tool-use progress from final selection, and rejects incomplete provenance. |
| Children | ACP subscribes only to the main agent. Native child activity, identity and usage are not preserved. Disable native delegation for the initial supported release. |
| Questions | `elicitation.form` carries all questions and multi-selection. Permission fallback drops every question after the first, converts multi-selection to single-selection, and cannot represent Other/free text. Do not advertise native questions from fallback parsing; semantic Paperclip questions require their own live continuation proof. |
| Plans | Todos become ACP plan updates. `ExitPlanMode` approvals use the permission channel and plan-specific options. Native plan review, feedback and post-accept behavior need separate qualification. |
| Permission | Native normal mode has auto-approval heuristics and prior approval rules. The managed patch asks Runner for every tool operation, includes the actual `toolInput` as `rawInput`, removes session-wide approval choices, and disables ambient hooks/MCP/profiles. |
| Usage | ACP's `usage_update.used` is current context occupancy and `size` is model capacity. It is not per-turn input/output usage or cost; cost is omitted. Internal Klient has richer token counters, but the selected ACP path does not publish them. Do not turn these context values into charges or a dollar-budget guarantee. |
| Failures | Upstream ACP maps non-auth failed turns to `end_turn`. The managed patch preserves typed auth failure and rejects every other native failed turn on the prompt RPC. |
| Continuity | New/load/resume/list/fork/close/delete are implemented. Load replays history; resume skips replay. A cold restore accepts fresh ephemeral MCP config; loading an already-live session ignores replacement MCP configuration. Reopen after a configuration change requires a new owned process. |
| Stop and shutdown | Native cancel is turn-addressed and handles launch races. ACP close cancels/disposes the session. Connection EOF starts a flush/dispose path. These implementations do not prove bounded process-tree cleanup; test spontaneous child/process loss and forced termination independently. |
| Steering | Native Klient and REST have steering/queued prompts. ACP has no steering method. Sending a second prompt does not prove same-turn steering. |
| Media | ACP advertises image and text embedded-resource support; blob resources are dropped and audio is unsupported. End-to-end Runner forwarding still needs its own proof. |

Source: [`session.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/session.ts),
[`events-map.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/events-map.ts),
[`interaction-bridge.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/interaction-bridge.ts),
[`question.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/question.ts),
[`approval.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/approval.ts).

## Configuration and authority

An empty isolated `KIMI_CODE_HOME` does **not** make an ambient `KIMI_API_KEY`
usable automatically. A provider must explicitly declare `api_key_env`.
Use the selected provider endpoint and a configured model alias whose `model`
is the caller's exact native model ID. `max_context_size` is required by the
native schema; it is configuration metadata, not entitlement evidence.
Strip unselected `KIMI_MODEL_*` variables, which can synthesize a competing
provider/model. Do not import ambient OAuth credentials, MCP grants or hooks.

The managed patch keeps user skills only under the owned Kimi home and drops
project/global skill directories. It empties ambient workspace MCP baseline
while leaving ACP session MCP separate. Root configuration must disable
native delegation, cron/background task tools and automatic backgrounding;
keep-alive-on-exit stays off. Removing TaskList/TaskOutput/TaskStop makes native
`Bash.allowBackground()` false and causes explicit background requests to fail.

Native `HostProcessService.buildEnv()` otherwise inherits the complete provider
environment, including `KIMI_API_KEY`; Bash supplies only noninteractive
overrides. The patch always builds an explicit child environment and removes
`KIMI_API_KEY` and `PAPERCLIP_KIMI_INSTRUCTIONS` after merging overrides. The
native PTY path uses the same filter. Assigned task variables remain available;
the provider process retains its key for model authentication. This is a child
environment boundary, not an operating-system sandbox for arbitrary native
filesystem or shell tools. Read-only work must use the controller's scoped
semantic tools.

Patch v4 also ignores the ACP client's terminal capability. Otherwise native
`AcpProcessService` sends Bash to ACPX's separate terminal process, bypassing
the provider-owned environment filter and dropping configured task variables.
Keeping the existing native local process service makes the filter apply on
the actual Runner execution path. The controlled-peer check requires ACPX to
advertise its normal terminal capability while observing zero `terminal/create`
requests from Kimi.

Native OAuth resolves the access token into the same `{ apiKey }` credential
as an explicit API-key provider. A selected unexpired access token can bound
a finite test, but that explicit binding has no OAuth refresh behavior. Never
copy refresh tokens into qualification homes or describe this as managed
OAuth support.

The setup Test can verify Code metadata without inference through
`probeKimiModels(model, apiKey)`. It sends one GET to the fixed global
`https://api.kimi.ai/coding/v1/models` endpoint, using the explicitly selected
key and pinned `KimiCLI/2.3.3` user agent. Native Kimi uses this endpoint for
both OAuth and API-key providers and treats HTTP 401/402/403 as credential or
membership-access failures. The probe requires a valid model catalog with the
exact caller-selected ID and positive context metadata. It never substitutes a
model or imports an ambient credential. Redirects are rejected, streamed JSON
is capped at 256 KiB, and the eight-second deadline aborts both the request and
response body. Errors contain fixed messages and typed codes, not provider
response text or credential values.

A successful metadata probe establishes catalog authentication and exact model
listing. It does not establish successful inference, remaining quota, usage or
charges. The native ACP catalog alone cannot establish authentication because
it projects local configuration. Normal model and instruction admission still
applies before a task prompt.

Source: [`overrides.md`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/docs/en/configuration/overrides.md),
[`config-files.md`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/docs/en/configuration/config-files.md),
[`credentials.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/human/credentials/credentials.ts),
[`bashTool.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts),
[`hostProcessService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts),
[`hostTerminalService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/os/backends/node-local/hostTerminalService.ts),
[`acpConnection.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/acp-fs/acpConnection.ts),
[`acpTerminalRunner.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/acp-server/src/acp-terminal/acpTerminalRunner.ts),
[`managed-kimi-code.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/oauth/src/managed-kimi-code.ts),
[`refreshProviderModels.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/oauth/src/refreshProviderModels.ts).

## Reproducible boundary check

From a clean verified npm installation, provide its unmodified `dist/main.mjs`
to the package contract cell:

```sh
PAPERCLIP_KIMI_VENDOR_MAIN=/absolute/path/to/dist/main.mjs \
  node --test packages/paperclip-runner/scripts/patch-kimi-runtime.test.mjs
```

This executes the actual pinned getter and ACP lifecycle/error methods with
engine/transport dependencies doubled. It verifies literal Unicode/whitespace,
explicit empty content, native readback, create/load/resume receipts, missing
receipts, ambient-source isolation, host permission delegation, malformed
bindings, child environment filtering, esbuild bundle reproducibility and
terminal failure mapping. It performs no inference and does not
replace installed-package, authenticated semantic-tool, browser persistence,
warm recovery or physical-cleanup acceptance.

## Controlled model-service regression

After installing the fixed runtime assets, a second opt-in cell runs the real
pinned Kimi command through the real ACPX manager against a loopback-only,
scripted OpenAI-compatible service and MCP receiver:

```sh
PAPERCLIP_TEST_KIMI_MODEL_PEER=1 \
  node --test packages/paperclip-runner/scripts/patch-kimi-runtime.test.mjs
```

The test changes only its private native test configuration below the production
boundary. It does not add an endpoint override to production configuration, use
a provider credential, or call an external model. It captures exact instruction
bytes at the native HTTP request, fragmented/interleaved MCP JSON including a
terminal `{}`, accepted tool results in the next model request, Write denial
before any file effect, a native Bash credential fence, typed provider failure,
new/resume admission and bounded owned-process closure. The production patch
keeps Bash in the provider's own local process service even when ACPX advertises
client terminals. ACPX prefers `session/resume` when advertised; the
installed-runtime metadata smoke checks `session/load` separately.

The first controlled-peer attempt against patch v1 failed: the native blocking
approval payload omitted `toolInput`, although a sibling native event carried
it. The ACP callback therefore lost `rawInput`, and the strict host rejected
the operation before the MCP receiver ran. That failure is retained as the
reason for patch v2: add the original arguments at native `approvalRequest`
construction before the interaction kernel, then preserve them at the ACP edge.
An empty object remains a complete valid argument. A passing simulated service
cell remains protocol-boundary evidence and does not qualify model behavior,
account entitlement, browser journeys or Daytona delivery.

The v2 controlled-peer cell passed on 2026-10-28 against the verified
`darwin-arm64` closure through the actual pinned ACPX manager: five simulated
model requests, two accepted MCP receiver calls including `{}`, one denied
Write with independent before/after file-absence checks, typed failed-turn
settlement and two closed native processes. Both initial and resumed native
acknowledgments matched the SHA-256 of the complete system prompt observed at
the HTTP request. Permission response-delivery receipts settled. This cell
uses fake credentials and records zero external model calls.

The v3 Bash regression exposed the ACP client-terminal bypass: native filter
unit checks passed, but normal ACPX terminal execution lost the assigned task
variable and did not exercise that filter. V4 therefore forces the native local process path.
The extended cell checks both key/private-variable absence and task-variable
presence in real Bash, while every native model HTTP request must retain the
fake provider authorization. Earlier v2 evidence remains valid for its narrower
instruction/MCP/denial/error scope; the credential fence requires v4 evidence.

The final v4 native runtime passed the seven-request controlled-peer cell on
2026-10-28. ACPX advertised its normal client-terminal capability, Kimi sent zero
`terminal/create` requests, and native Bash returned its success marker only
after verifying both private variables were absent and an assigned task variable
was retained. All seven model requests still carried the fake provider key.
The exact native SHA-256 was
`cfd11b57b3d75419539bd16f237d73d9ca896d45ae41bbfed8c71beab4daaee9`;
the verified macOS closure was
`c05a0cd0686a4988fed6cb3c69ca1d9845ea233c53b391a84bc442241cef551b`.

Enable the additional pending-work lifecycle checks with:

```sh
PAPERCLIP_TEST_KIMI_MODEL_PEER=1 PAPERCLIP_TEST_KIMI_LIFECYCLE_PEER=1 \
  node --test --test-name-pattern='simulated local model service' \
  packages/paperclip-runner/scripts/patch-kimi-runtime.test.mjs
```

The extended nine-request cell also passed on 2026-10-28. Both cases held a real
native Write approval before any file effect. Stop settled as cancelled. For
spontaneous provider loss, the test observed the unique native worker beneath
its verified command root and revalidated its parent, process start and group
before sending SIGKILL to that worker. It settled as a typed failure. Both cases
aborted the waiting host callback, suppressed a subsequently supplied stale
`allow_once` response on that exact connection, and produced no file or further
model request. The test independently checked file absence after settlement and
cleanup, and observed physical worker retirement within five seconds. Four
owned native processes closed across the complete cell. These remain simulated
service proofs; they do not qualify authenticated behavior, browser journeys or
Daytona delivery.

## Message-boundary regression

The first completed local Product attempt on 2026-10-28 exposed an upstream
ACP framing loss. Campaign `local-2026-10-28T13-43-42-062Z` reached an accepted
completion report and durable Done state, but the displayed final comment
concatenated a pre-tool progress message with the final answer. The attempt
remains failed; completion state alone is insufficient user-facing acceptance.

The engine already emits `TurnStepStarted` and `TurnStepCompleted` with the
real model-step UUID and normalized finish reason. The owned v5 patch registers
those existing events in Klient's agent event hub and subscribes through the
same active-turn dispatch gate as text deltas. Each message ID hashes the
native session, turn and step UUID. Empty start/end chunks carry bounded
provenance; text and reasoning deltas use the same identity. Public interrupted
step events close only the matching active step. No text inspection or tool
notification creates a message boundary. Restored history remains outside the
active prompt event stream.

Source: [`loopService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/agent/loop/loopService.ts),
[`turnEvents.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/agent-core-v2/src/agent/loop/turnEvents.ts),
[`Klient events.ts`](https://github.com/MoonshotAI/kimi-code/blob/ec495f0/packages/klient/src/contract/agent/events.ts).

The v5 nine-request controlled-peer check passed in 13.4 seconds on 2026-10-28
against native SHA-256
`9ea2cf23ed4a7386de7f01147d5f7c83719568d814b9d6e1d5ebb43ca3067d86`
and verified macOS closure
`429433e76fc8889b2262b3d0739bc955e80d958da4a9aa378653d6690030c2ef`.
Each ordinary simulated turn emitted a pre-tool message ending in `tool_use`
and a separate UUID for the final message ending in `end_turn`, even though
the scripted HTTP service deliberately reused its response ID. Actual ACPX
normalization retained every empty boundary. The real provider projection
validated the native provenance and returned canonical `toolUse` and `stop`
boundaries. The same check repeated instruction admission, MCP arguments and
results, the child credential fence, denial without effects, typed failure,
pending permission Stop, exact native-worker loss, stale-answer suppression
and bounded physical cleanup. Four owned native processes retired; there were
zero external model calls. This does not replace the failed Product attempt
or prove its browser journey passed after the fix.
