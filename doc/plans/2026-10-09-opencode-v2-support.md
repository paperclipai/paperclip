# OpenCode V2 support

Date: 2026-10-09
Status: Phases 1-3 shipped (direct CLI adapter + runner server driver); Phase 4 (broad qualification) in progress

## Why

OpenCode V2 shipped as a breaking major: the server API, plugin API, and
terminal client configuration changed, and the `run` CLI contract dropped
`--variant` and `models --refresh`. Paperclip's direct `opencode_local` adapter
previously hard-rejected any non-1.x install, so a V2 user could not save or run
an agent. The Paperclip Runner's `opencode_server` driver additionally drove
the V1 HTTP server API (`/session`, `/session/:id/prompt_async`, `/event`,
`/permission`, `/question`), which V2 replaced under `/api/...`.

## Phase 1.1 - headless permission fix (DONE)

A real `opencode_local` run failed with
`permission requested: external_directory (.../instructions/*; .../file-sync/*); auto-rejecting`.
Live reproduction against real V1 (1.18.34) and V2 (2.0.26) binaries, plus
binary/documentation analysis, established the cause and fixes:

- Headless `opencode run` auto-rejects any permission it cannot answer. The
  message is `permission requested: <action> (<resources>); auto-rejecting`;
  `--auto` makes it approve everything not explicitly denied (a `deny` rule or
  policy still wins).
- OpenCode 1.x rejects the V2 `permissions` key outright ("V2 permissions are
  not supported by OpenCode V1"), and 2.x gives native `permissions` precedence
  over the V1 `permission` string. A single shape cannot be written blindly.
- The agent instructions and `file-sync` trees live outside the workspace, so
  any `external_directory` rule that resolves to `ask` (a native `permissions`
  entry, a profile, or 1.x defaults) fails the unattended run.

Fixes (A+B):

- **A:** pass `--auto` to `opencode run` when `dangerouslySkipPermissions` is
  enabled (the default), in both the adapter run and the environment hello
  probe.
- **B:** write the version-native allow shape. Probe the CLI major before
  writing the runtime config, then emit V1 `permission: "allow"` or V2 native
  `permissions: [{action:"*",..allow},{action:"external_directory",..allow}]`
  (and drop the other key).

C (narrow per-directory allow) is intentionally not applied: under
`dangerouslySkipPermissions` the broad allow is the documented intent, and the
adapter can reliably derive the instructions directory but not the
server-managed `file-sync` directory at config time.

### Phase 1.2 - transient non-zero exit recovery

`opencode run` 2.0.24 on the operator instance exited `1` after the agent had
already streamed its final answer, with no `error` event, no failed tool, and
no stderr. Comparing a succeeded run and the failed runs showed an identical
final shape (`step_start` then `text`, no closing `step_finish`), so the exit
code is not a reliable failure signal for that signature.

- Capture a bounded raw stdout tail and recover a late structured error or tool
  error from it (the returned stdout is capped, and the accounting stream's
  compaction drops tool fields).
- Include the last tool error in the failure message.
- When the process exits non-zero with no error event, no failed tool, no
  signal, and the last record is an assistant `text`, treat the run as complete
  and note it. A real failure (provider error, tool error, signal, timeout) is
  never recovered.

## Phase 1 - direct CLI adapter (`opencode_local`) - DONE

Qualified both majors and made the CLI flags version-aware:

- `SUPPORTED_OPENCODE_MAJOR_VERSIONS = [1, 2]`; the version guard accepts 1.x
  and 2.x and only rejects unknown majors (with the documented
  `PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION` bypass).
- V2 `run` args: the variant folds into `--model provider/model#variant` (V2 has
  no `--variant` flag); V1 keeps the separate flag.
- V2 `opencode models` never receives `--refresh` (V2 dropped it).
- The environment test's hello probe uses the same version-aware args.
- Verified empirically against `opencode v2.0.26`:
  - `opencode run --format json` emits compatible JSONL (`text`, `step_finish`,
    `tool_use`, `error`) with a top-level `sessionID`.
  - `--variant` and `models --refresh` are rejected by V2 (usage + exit 1).
  - `--model provider/model#variant` is accepted.
- The managed provider projection still uses the V1-shaped
  `OPENCODE_CONFIG_CONTENT`; V2's compatibility layer normalizes it (confirmed
  by a successful DeepSeek hello probe on V2).

## Phase 2 - V2-native projection (planned)

Emit V2-native provider config when the CLI is V2:
`providers.<id>.package = "@opencode/ai/providers/openai-compatible"`,
`settings.baseURL`/`settings.apiKey`, and `agents.title.model` for the pinned
small/title model, falling back to the V1 shape on 1.x. Add the `mcp.servers`
shape when the runner path lands.

## Phase 3 - runner server driver V2 - DONE

Ported `packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts`
to the V2 HTTP API while preserving the V1 path byte-for-byte.

### What was found (live research)

`opencode serve` 2.0.26 was run locally and its real OpenAPI contract
(`/openapi.json`) plus live SSE stream were captured. Two findings shaped the
design:

1. **The event API is a full redesign, not a rename.** V2 replaced the V1
   `properties`-carrying `message.part.updated` / `session.idle` family with a
   granular `session.*` family under an `{id, type, data}` envelope:
   `session.execution.started|succeeded|failed|interrupted`,
   `session.step.started|streamed|ended`, `session.text.started|delta|ended`,
   `session.reasoning.*`, `session.tool.input.started|ended`,
   `session.tool.called|succeeded|failed`, `session.usage.updated`,
   `permission.asked|replied`, and `form.created|replied|cancelled`.
2. **V2 ignores `OPENCODE_SERVER_USERNAME`.** Basic auth always uses the
   `opencode` username; only `OPENCODE_SERVER_PASSWORD` is honoured. The driver
   now sets the username to `opencode` for both generations.

### Design

- `packages/paperclip-runner/src/drivers/opencode/api-client.ts` introduces a
  thin `OpenCodeApiClient` transport with `OpenCodeV1Client` and
  `OpenCodeV2Client` implementations selected from the server-info version.
- Version detection probes `GET /api/info` first (V2) and falls back to
  `GET /global/health` (V1) in `waitForServerInfo`. The driver reports the
  protocol version (`http+sse/v1` or `http+sse/v2`) in the session context.
- The V2 client folds each granular `session.*` event back into the exact
  V1-shaped provider event the existing canonical mapper already consumes, so
  turn attribution, semantic-result selection, and workspace handling stay
  single-sourced. Text/reasoning deltas are accumulated per part so the V1
  delta diffing keeps working.
- Requests are versioned: `POST /api/session` (with `model`), `POST
  /api/session/{id}/prompt`, `POST /api/session/{id}/interrupt`, `GET
  /api/event`, `GET /api/permission/request`, `POST /api/session/{id}/permission/{requestID}/reply`
  with a `decision`, and the forms API
  (`GET/POST/DELETE /api/session/{id}/form...`) in place of questions.
- V2 config is native (`providers`, `settings`, `agents.title.model`,
  `agents.paperclip.system`, `permissions` rule list, `mcp.servers` with
  `disabled`/`timeout`). Because the server version is only known after the
  server starts, the driver writes the V1-compatible bootstrap config, detects
  the version, then rewrites the native V2 config and applies it through
  `POST /api/location/reload`. V1 never reloads, so its config is unchanged.

### Version window

`api-client.ts` replaces the exact `1.18.34` equality gate with a tested window:

- `1.18.34 <= v < 2.0.0` (V1)
- `2.0.0 <= v < 2.1.0` (V2)

`PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_RUNNER_VERSION=1` remains as the
documented bypass. `QUALIFIED_OPENCODE_VERSION` stays exported (V1 pin) for the
proxy command; new exports expose the V2 pin and window.

### Verification

- `api-client.test.ts`: version windows, protocol classification, V1/V2 request
  bodies, V2 event folding, and form-answer mapping (runs everywhere).
- `opencode-server-driver.test.ts`: new mocked V2 cases for the native config +
  reload, a full text/usage/terminal turn, form-to-runtime-request, permission,
  and interruption. The shared `fake-opencode-server.mjs` gained a
  `FAKE_OPENCODE_API=v2` mode. Run on Linux (WSL Ubuntu, Node 24): 62 pass, 1
  pre-existing V1 failure (`uses provider structure rather than prose length...`
  also fails on `master`), 0 V2 failures.
- `opencode-server-driver.live.test.ts`: a live V2 smoke gated by
  `PAPERCLIP_OPENCODE_LIVE_BIN` (only runs when the binary is 2.x). Verified
  live against `opencode v2.0.26`:
  - text turn + usage,
  - the Paperclip completion tool called directly (`paperclip_paperclip_finish`)
    -> `run.result.proposed` + `turn.completed`,
  - a `read` permission request surfaced as a runtime request and resolved,
  - interruption -> cancelled turn.

### V2 MCP finding

V2 does **not** auto-connect MCP servers, `/api/mcp` lists only connected
servers, and a location reload registers the server asynchronously. Without a
connected server the model never sees the Paperclip semantic tools, so the
completion tool fails and the turn ends with no structured result. The driver
now sets `codemode: false`, nudges each server with
`POST /api/experimental/mcp/{name}/connect`, and waits until `GET /api/mcp`
reports it connected before the first session.


## Phase 4 - qualification (planned)

Full end-to-end runs on V2 for each harness (direct adapter and runner),
sandbox image pins, and user-facing docs.

## Decisions and open questions

- **Qualified V2 version:** `2.0.26` (verified live here). The user also has
  `2.0.24`; it falls inside the `2.0.x` window but is not the pinned
  qualification. Add it explicitly if an operator needs it.
- **Sandbox/provider pack:** the remote pack still installs the pinned V1 build
  (`opencode-ai@1.18.34`); the runner runtime accepts the V1+V2 window. Putting
  V2 into the sandbox/provider pack is deferred to Phase 4 so the bundled binary
  and its qualification tests move together.
- **V2 forms vs V1 questions:** mapped one-to-one. A V2 `Form.Field` becomes a
  native question (`fieldType`/`type` preserved) and the reply is rebuilt as a
  `Form.Answer` keyed by field `key`.
- **`V2EventEncoded`:** the OpenAPI schema is an opaque JSON string; the real
  event union was taken from a live stream rather than the published schema.
- **`opencode-ai` npm pin:** kept at `1.18.34` (bundled V1) to avoid a lockfile
  and bundled-binary change; the runtime gate and driver support the V2 window.
