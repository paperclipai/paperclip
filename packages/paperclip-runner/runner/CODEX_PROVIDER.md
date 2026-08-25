# Codex provider boundary

`paperclip-runnerd` supports one provider in this layer: Codex app-server as a
local supervised process. The Paperclip server selects this path only for the
default-off `paperclip_runner` adapter. Every direct adapter keeps its existing
execution and finalization path.

## Command lifecycle

- `run.prepare` accepts a `provider` object containing `provider: "codex"`,
  `driver: "codex_app_server"`, `providerVersion`, `command`, bounded `args`, an
  existing absolute `cwd`, optional `model`, `instructions`, and
  `approvalPolicy: "never"`.
- The server also binds the immutable completion-contract revision and criterion
  identifiers. A completed Codex turn emits one `run.result.proposed` followed
  by one `run.terminal`; server finalization accepts only that bound pair.
- `session.open` initializes Codex and starts a thread. A recovered runner
  resumes the recorded thread and reads it before accepting another turn.
- `turn.start` requires bounded non-empty `payload.text`. `turn.steer`,
  `turn.interrupt`, `turn.stop`, and `run.cancel` use Codex's native turn IDs,
  while PRP continues to use its own stable run and turn identities.
- `request.resolve` translates a validated `paperclip.question_response.v1`
  response back to Codex's user-input response shape.
- `session.close` and `session.destroy` explicitly terminate the provider
  process group. Runner suspend and shutdown also stop the process without
  deleting the resumable thread identity.

## Recovery and duplicate safety

The provider descriptor, Codex thread ID, account session ID, active Codex turn
ID, and unacknowledged normalized-event prefix are written to a private,
bounded, atomically replaced sidecar in the runner state directory. On restart,
runnerd resumes that exact thread and reconciles the active turn from
`thread/read`. An unexpected provider exit retains the last active turn until
that reconciliation proves whether it is still running, so cancellation and a
later turn cannot diverge from Codex's native state.

PRP journals every command before the provider effect. Exact command replay
returns the durable result without invoking Codex again. A crash in the effect
window remains indeterminate and is not retried. Codex JSON-RPC notifications
received before a synchronous response are buffered rather than lost. Reusing
a pending structured-input request ID with different content fails closed.
Normalized events remain in the provider sidecar until the durable PRP outbox
has committed and acknowledged them. The server persists the native binding
before process launch and reuses it after restart, including when the rollout
flag has since been disabled.

## Normalization and authorization

Codex-native envelopes do not cross PRP. The provider backend emits bounded,
redacted session, turn, item, plan, usage, tool-execution, notice, and structured
input events. Unknown notifications are ignored.

Codex starts with an empty dynamic-tool inventory. Catalog presence is not
authorization. The coordinator projects only the already landed, same-task
read bindings for the exact company and native run.
