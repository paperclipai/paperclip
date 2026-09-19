---
title: Codex
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

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
| `fastMode` | boolean | No | Enables Codex Fast mode. Currently supported on `gpt-5.4` only and burns credits faster |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

## Fast Mode

When `fastMode` is enabled, Paperclip adds Codex config overrides equivalent to:

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

Paperclip currently applies that only when the selected model is `gpt-5.4`. On other models, the toggle is preserved in config but ignored at execution time to avoid unsupported runs.

## Managed `CODEX_HOME`

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

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

Because the warning touches authentication behavior, its implementation
needs a maintainer security review before merge. Treat this docs section as
the follow-up implementation spec, not as authorization to add the warning in
a docs-only change.

## Shell Snapshot Policy

Codex's shell-snapshot feature writes the provider process's launch
environment — including this run's bound credentials — to
`$CODEX_HOME/shell_snapshots/*.sh` as plaintext `declare -x NAME="value"`
lines. On a single-host install every agent seat runs as the same OS account,
so any seat can read any other seat's snapshot file. Paperclip disables the
feature rather than letting it persist credentials to disk (KEE-192).

- **Which homes are modified:** every effective `CODEX_HOME` an ACPX-engine
  Codex run uses — the engine's managed company home (seeded once from the
  operator's `~/.codex/config.toml`) and any operator-supplied `CODEX_HOME`
  override (which is never seeded, so this is the only place the policy
  reaches it). Enforcement runs on every run, not only at seed time.
- **Enforced setting:** `features.shell_snapshot = false` in `config.toml`,
  merged into an existing `[features]` table or appended as a managed block if
  the file has none. The rewrite is idempotent — re-running it does not
  duplicate the table or the managed comment.
- **Permissions:** `config.toml` is always rewritten owner-only (`0600`),
  whatever mode it had before. A rewrite is treated as the moment to correct a
  group- or world-readable file left by an operator or a seed step, not to
  carry that exposure forward.
- **Fail-closed enforcement:** if the existing config can't be read or
  written, Paperclip refuses to launch Codex at all rather than starting a run
  whose credentials could be snapshotted; the run fails with an explicit
  `CodexShellSnapshotPolicyError`. The same applies when the config declares
  `features` as an inline table (`features = { ... }`) that this rewriter
  cannot safely merge — unless the inline table already sets
  `shell_snapshot = false`, in which case the policy is already in force and
  the launch proceeds. A compliant config an operator locked down by hand
  never blocks a launch.

### Upgrading from builds that persisted credentials

This change stops new credential persistence; it does not scrub what older
builds already wrote. Two on-disk surfaces predate it:

- **Session records** (`<stateDir>/sessions/<acpxRecordId>.json`): builds
  before the credential-safe session store persisted the whole launch
  environment, bound credentials included. A resumed session loads with this
  run's environment injected fresh, so a record that still contains an old
  environment keeps working — and keeps the old values at rest until that
  record is saved again, which strips it. Untouched legacy records and any
  backups taken before the upgrade therefore need a separate cleanup decision
  (delete or re-save them); do not treat a successful resumable session as
  evidence that an old copy was removed.
- **Shell snapshots** (`$CODEX_HOME/shell_snapshots/*.sh`): snapshot files
  written by runs before the policy was enforced are not cleaned up by
  upgrading, and Paperclip's rewrite removes only the config key, not the
  existing files. Check `shell_snapshots/` under each `CODEX_HOME` (the
  managed home and any override) and delete leftovers by hand.

## Manual Local CLI

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
npx paperclipai agent local-cli codexcoder --company-id <company-id>
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
