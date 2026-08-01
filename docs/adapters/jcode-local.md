---
title: JCode
summary: JCode local adapter setup and configuration
---

The `jcode_local` adapter runs the JCode CLI locally. It supports session
persistence through JCode's `--resume` flag, Paperclip skill injection through
JCode's global skills directory, model discovery, and structured transcript
parsing from JCode's NDJSON stream.

## Prerequisites

- JCode CLI installed (`jcode` command available)
- JCode provider authentication configured on the execution target, for example
  with `jcode login --provider <name>` or provider API keys in the adapter env
- A working directory the Paperclip server can access

For sandbox targets, Paperclip advertises a verified install path:

```sh
set -euo pipefail
if command -v brew >/dev/null 2>&1; then
  brew tap 1jehuang/jcode
  brew install jcode
else
  tmpdir="$(mktemp -d)"
  git clone --depth 1 https://github.com/1jehuang/jcode.git "$tmpdir/jcode"
  cd "$tmpdir/jcode"
  cargo build --release
  scripts/install_release.sh
fi
```

This avoids executing an unverified remote shell script and falls back to
building from the official source tree when Homebrew is unavailable.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Default absolute working directory fallback for the agent process; created automatically if missing when permissions allow |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file injected into the system prompt at runtime |
| `model` | string | No | Model override passed to JCode as `--model`; leave empty to use JCode's default |
| `promptTemplate` | string | No | Prompt used for all runs |
| `command` | string | No | CLI command to run; defaults to `jcode` |
| `env` | object | No | Environment variables, including provider API keys or secret refs |
| `timeoutSec` | number | No | Process timeout in seconds |
| `graceSec` | number | No | Grace period before force-kill |

## Invocation

Paperclip invokes JCode as:

```sh
jcode --quiet run --ndjson
```

When a model is configured, Paperclip adds `--model <model>`. When a compatible
session exists for the same working directory and execution target state,
Paperclip adds `--resume <sessionId>`.

JCode reads MCP configuration from `.mcp.json` and Claude Code-compatible
`~/.claude.json` files. Keep any provider secrets in environment variables or
the JCode login store rather than prompt templates.

## Session Persistence

The adapter persists JCode session IDs between heartbeats. On the next wake, it
resumes the existing conversation so the agent can keep context across task
assignment, approval callbacks, manual nudges, and follow-up work.

Session resume is cwd-aware. If the stored session belongs to a different
working directory, or if the current remote execution state is incompatible,
the adapter starts a fresh session instead of reusing stale context.

If JCode reports that a resumed session is unavailable, the adapter retries once
without `--resume` and asks Paperclip to clear the stale persisted session.

## Skills Injection

The adapter materializes Paperclip runtime skills into `~/.jcode/skills`.
Existing user skills are not overwritten. This makes skills such as
`paperclip` discoverable to JCode without writing Paperclip internals into the
agent's project working directory.

## Model Discovery

The adapter discovers configured models with:

```sh
jcode --quiet model list --json
```

If that command cannot return models, Paperclip falls back to JCode runtime
state when available and leaves the UI model field as an optional text override.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It
checks:

- Working directory resolution
- JCode command availability
- Model discovery with `jcode --quiet model list --json`
- A live hello probe using JCode's NDJSON run mode

Authentication failures are reported as actionable environment-test checks so
operators can run `jcode login --provider <name>` or configure provider API keys
before assigning real work.
