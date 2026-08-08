---
title: Codex
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. Its default `codex_exec` runtime supports session persistence via `previous_response_id` chaining. The optional app-server goal runtime persists Codex thread IDs instead. Both runtimes support Paperclip skill injection through the effective Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- Either a host Codex login with `~/.codex/auth.json`, or a per-agent
  `OPENAI_API_KEY` configured in adapter env (Paperclip materializes this into
  `$CODEX_HOME/auth.json` for managed homes; Codex CLI reads credentials from
  `auth.json`, not directly from the process environment — for a self-managed
  external `CODEX_HOME`, write `auth.json` there directly instead)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Model to use |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `fastMode` | boolean | No | Enables Codex Fast mode for GPT-5.5, GPT-5.4, and manual model IDs; burns credits faster |
| `runtime` | `codex_exec` \| `app_server_experimental` | No | Execution transport. Defaults to `codex_exec`; app-server is local-only and currently requires `goal.enabled: true` |
| `goal.enabled` | boolean | No | Enables the goal feature when using `app_server_experimental` |
| `goal.tokenBudget` | number | No | Positive goal token budget. Omit it, or use `0` in the UI, for no explicit goal budget |
| `goal.timeoutSec` | number | No | Positive goal-runtime timeout. Falls back to the adapter `timeoutSec`, then 3600 seconds |
| `goal.stopAfterTurn` | boolean | No | Stop waiting after the current model turn instead of waiting for a terminal goal status; defaults to `false` |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

Goal-runtime sessions instead use Codex app-server thread IDs. Paperclip stores them with `protocol: "app_server"` and `features: ["goal"]`, and only resumes a goal thread when its issue ID and objective fingerprint still match.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

## Fast Mode

When `fastMode` is enabled, Paperclip adds Codex config overrides equivalent to:

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

Paperclip applies that for GPT-5.5, GPT-5.4, and manual model IDs. For other known models, the toggle is preserved in config but ignored at execution time to avoid unsupported runs.

## Goal Runtime (Experimental)

The default `codex_exec` transport does not interpret Codex TUI slash commands: text such as `/goal ship the release` would otherwise be sent to the model as ordinary prompt text. Goal support therefore uses Codex's app-server RPC transport and calls the underlying `thread/goal/*` methods directly.

Enable **Goal runtime** in the Codex agent's adapter settings. The toggle writes the equivalent of:

```json
{
  "runtime": "app_server_experimental",
  "goal": {
    "enabled": true,
    "tokenBudget": 500000,
    "timeoutSec": 3600,
    "stopAfterTurn": false
  }
}
```

Only the runtime and `goal.enabled` fields are required. The settings UI currently exposes the runtime toggle and token budget; `goal.timeoutSec` and `goal.stopAfterTurn` can be set in adapter JSON when needed.

Goal mode is local-only. Each run starts a private child process with `codex app-server --listen stdio:// --enable goals`; it is not a daemon, opens no port, and is not shared between agents or runs. Paperclip initializes the experimental API, starts or resumes the issue-bound thread, and exchanges JSON-RPC over the child's standard input and output.

### Issue-thread commands

For a goal-enabled Codex assignee, type these commands as a human-authored issue comment:

| Action | Command | Behavior |
|--------|---------|----------|
| Set or replace | `/goal <objective>` | Sets the exact remaining text as the thread goal using the agent's configured token budget |
| Inspect | `/goal status` | Reads the stored goal and returns its status and token usage without starting a model turn |
| Clear | `/goal clear` | Clears the stored goal and removes the saved goal session from Paperclip |

Typing `/` in the composer advertises `/goal` only when the assignee's adapter configuration supports it. A bare `/goal` returns usage guidance. Only human/board-authored comments dispatch commands; agent-authored `/goal` text remains ordinary comment text.

If a `/goal` comment reaches an incompatible assignee, Paperclip replies that the app-server goal runtime must be enabled instead of silently passing the command into a normal model prompt.

### Budget and stop behavior

- `goal.tokenBudget` is passed to Codex when a goal is set. Positive values are rounded down to whole tokens. Missing, zero, negative, or non-finite values mean that Paperclip does not set an explicit goal budget.
- The token budget is a goal-level Codex limit, not Paperclip's company or agent budget. Paperclip's normal budget hard stops still apply independently.
- When Codex reports `budgetLimited`, Paperclip ends the run as a failure with `codex_goal_budget_limited` and preserves the final goal snapshot in the transcript/result.
- Goal runs normally wait for `complete`, `paused`, `cleared`, `blocked`, `usageLimited`, `budgetLimited`, or `error`. With `goal.stopAfterTurn: true`, Paperclip may return after the current turn and pauses an otherwise-active goal before shutting down the child.
- `goal.timeoutSec` controls how long Paperclip waits for goal completion. If omitted, it uses a positive adapter `timeoutSec`, otherwise 3600 seconds.

### Failure codes

| Code | Meaning | Operator action |
|------|---------|-----------------|
| `codex_goal_budget_limited` | Codex exhausted the configured goal token budget | Increase or remove `goal.tokenBudget`, then resume or set the goal again |
| `codex_goal_remote_unsupported` | Goal mode was requested through a remote or sandbox execution target | Use a local `codex_local` execution target; remote goal transport is not supported |
| `codex_goal_unsupported_cli` | The installed Codex CLI does not implement `thread/goal/set` | Upgrade or select a Codex CLI build with the goals app-server RPC, then run the goal probe |

To probe the installed CLI directly:

```sh
pnpm --filter @paperclipai/adapter-codex-local probe:goal
```

Goal statuses `blocked` and `usageLimited` surface as `codex_goal_blocked` and `codex_goal_usage_limited` respectively.

### App-server architecture

App-server is a transport inside the existing `codex_local` adapter, not a separate adapter. The generic transport owns process lifecycle, JSON-RPC framing and correlation, server-to-client request replies, and thread lifecycle. Goal behavior is the first feature module layered on that transport: it calls `thread/goal/set|get|clear`, translates goal notifications, and decides when a run is finished.

Future Codex features should be sibling feature modules rather than additions to goal-specific code. For example, `/review` maps to `review/start`, compaction maps to `thread/compact/start`, and mid-turn guidance maps to `turn/steer`. Those features can reuse the transport without changing authentication, managed-home setup, model configuration, sandbox plumbing, or existing `codex_exec` behavior.

## Managed `CODEX_HOME`

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

The goals feature must be enabled in the managed home's `config.toml`:

```toml
[features]
goals = true
```

Paperclip also launches goal runs with `--enable goals`. Keep the managed-home feature enabled so manual probes and Codex commands using that home see the same capability as Paperclip-managed runs.

### Per-agent isolation and auth seeding

For `codex_local` agents the server isolation guard pins each agent to a per-agent home (`<instance>/companies/<companyId>/agents/<agentId>/codex-home`) and sets `OPENAI_API_KEY=""` so an agent can never spend against the host API key or share another agent's Codex state.

A managed home is created empty, so the adapter must provision auth into it before launching Codex — otherwise the agent runs with zero credentials and the provider returns `401 Missing bearer`. The seeding contract:

- **Managed homes** (the default home and any configured `CODEX_HOME` under the company tree) are always seeded: the ChatGPT-subscription `auth.json` is symlinked from the host Codex home, or, when a per-agent `OPENAI_API_KEY` is configured, an API-key `auth.json` is written instead.
- **Genuine external overrides** (a `CODEX_HOME` outside the Paperclip-managed company tree) are treated as self-managed and are never seeded or overwritten.
- **Fail-fast guard:** if a managed home ends up with no usable `auth.json` and no configured API key, the run fails with an explicit `adapter_failed` ("no Codex credentials provisioned for managed home …") rather than emitting an unauthenticated request.

### Auth ownership and precedence

`codex_local` is host-owns-auth when Paperclip owns the effective
`CODEX_HOME`. The winning credential file is:

1. **Per-agent API key:** when adapter env contains a non-empty
   `OPENAI_API_KEY`, Paperclip writes `$CODEX_HOME/auth.json` with only
   `{ "OPENAI_API_KEY": "..." }`. This overwrites any existing file or symlink
   at that path. Codex CLI versions that Paperclip supports read the key from
   `auth.json`, not directly from the process environment.
2. **Host ChatGPT-subscription login:** when no per-agent key is configured,
   Paperclip symlinks `auth.json` from the shared host Codex home into the
   managed home. The symlink keeps rotating/single-use refresh tokens live
   instead of copying a stale token into the managed home.
3. **External `CODEX_HOME`:** if adapter env points `CODEX_HOME` outside the
   Paperclip-managed company tree, that home is self-managed. Paperclip does
   not seed or overwrite it, so its own `auth.json` wins.

For sandbox or SSH execution, Paperclip uploads the effective managed
`CODEX_HOME` and launches Codex with `CODEX_HOME` pointing at that uploaded
directory. Any `auth.json` already baked into the sandbox image is shadowed in
managed-home mode. If the host has no usable `auth.json` and no per-agent
`OPENAI_API_KEY`, the managed run fails fast instead of falling back to an
in-sandbox login.

Worked example: a worker runs in a sandbox image that already has
`$HOME/.codex/auth.json`, and the Paperclip host is logged in with a ChatGPT
subscription. For a managed `codex_local` agent, Paperclip symlinks the host
`auth.json` into the agent's managed home, uploads that home to the sandbox,
and sets `CODEX_HOME` to the uploaded path. Codex reads the host-owned
uploaded file, so the sandbox image login does not win.

For high-concurrency sandbox fleets, prefer a per-agent `OPENAI_API_KEY` over a
shared ChatGPT-subscription login. API-key mode produces a standalone
`auth.json` for each managed home and avoids many concurrent sandboxes sharing
one rotating subscription credential. The tradeoff is billing: API-key mode is
metered per token through the OpenAI API, while ChatGPT-subscription auth uses
the subscription's flat-plan economics and quota behavior. Pick the mode
deliberately for the fleet's cost and concurrency profile.

### Deferred config-validation warning spec

This section specifies a warning that is not implemented yet. The warning should
help operators notice the host-owns-auth topology before they run a sandbox
fleet with ChatGPT-subscription credentials.

- **Source fields:** resolved Codex auth mode (`api` vs `subscription`) and
  execution target kind (`local`, `remote:ssh`, or `remote:sandbox`). Infer the
  auth mode from the final managed `$CODEX_HOME/auth.json` shape after seeding:
  `{ "OPENAI_API_KEY": ... }` means API-key mode; subscription-token-shaped
  host auth, including the symlinked host file, means ChatGPT-subscription
  mode. Use top-level shape only; do not read credential values into the
  warning. The target kind comes from `AdapterExecutionTarget`.
- **Transformations:** during config preparation or home seeding for a run,
  classify `(subscription auth mode AND remote/sandbox execution target)` as a
  warning condition. This is classification only. Do not read credential values
  into the warning.
- **Sink fields:** emit a warning log line through `onLog("stderr", ...)` and,
  when the config-validation surface supports it, a surfaced validation warning.
  The sink may include only the auth-mode label and target type.
- **Retention:** warning text may appear in ephemeral run logs or validation
  results. Do not persist auth material.
- **Attacker-observable IDs:** none new. The warning must not print token
  values, email addresses, or `auth.json` contents.
- **Hook point:** wire the check at the `codex_local` execute/config-prep path
  around managed-home seeding: `execute.ts` already has `executionTarget` /
  target transport in scope, calls `seedManagedCodexHome`, and calls
  `evaluateCodexCredentialReadiness` before uploading `CODEX_HOME`. If the
  warning is factored into `codex-home.ts`, pass the resolved target
  classification in rather than making `codex-home.ts` inspect execution
  targets on its own.

Because the warning touches authentication behavior, implementation must go
through the security-review gate. Treat this docs section as the follow-up
implementation spec, not as authorization to add the warning in a docs-only
change.

## Manual Local CLI

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

This installs any missing skills, creates an agent API key, and prints shell exports to run as that agent.

## Instructions Resolution

If `instructionsFilePath` is configured, Paperclip reads that file and prepends it to the stdin prompt sent to `codex exec` on every run.

This is separate from any workspace-level instruction discovery that Codex itself performs in the run `cwd`. Paperclip does not disable Codex-native repo instruction files, so a repo-local `AGENTS.md` may still be loaded by Codex in addition to the Paperclip-managed agent instructions.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run
