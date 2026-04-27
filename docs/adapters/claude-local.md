---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- `ANTHROPIC_API_KEY` set in the environment or agent config

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Claude model to use (e.g. `claude-opus-4-6`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `300`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (default: `true`); required for headless runs where interactive approval is impossible |
| `git` | object | No | Per-agent Git/GitHub identity (off by default — gated by `PAPERCLIP_ADAPTER_GIT_IDENTITY=true`). See [Per-agent Git identity](#per-agent-git-identity). |

## Per-agent Git identity

When the host feature flag `PAPERCLIP_ADAPTER_GIT_IDENTITY=true` is set on the Paperclip server, `claude_local` agents can carry their own Git/GitHub identity per agent. The adapter writes a per-run `.gitconfig` and exports `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`, `GIT_CONFIG_GLOBAL`, and (if a token resolves) `GH_TOKEN`. The host `~/.gitconfig` is **never** modified.

```jsonc
{
  "adapterType": "claude_local",
  "adapterConfig": {
    "git": {
      "userName": "paperclip-foundingeng",
      "userEmail": "paperclip+foundingeng@openstudio.fr",
      "tokenSecretRef": "env:PAPERCLIP_GH_TOKEN_FOUNDINGENG"
    }
  }
}
```

Supported `tokenSecretRef` schemes:

- `env:VAR_NAME` — read from the Paperclip server process environment.
- `file:/abs/path` — read the token from a chmod-600 file.

CLI helper (preferred for managing identities):

```sh
pnpm paperclipai agent set-git-identity <agentId> \
  --user-name paperclip-foundingeng \
  --user-email paperclip+foundingeng@openstudio.fr \
  --token-ref env:PAPERCLIP_GH_TOKEN_FOUNDINGENG
```

The CLI never persists the token — only the indirection ref. The actual PAT is supplied to the Paperclip server out-of-band (env var or secure file). Recommended PAT scopes (fine-grained): `contents:write`, `pull_requests:write`.

Mandatory operational notes:

- Feature flag `PAPERCLIP_ADAPTER_GIT_IDENTITY` must be `true` on the server. Otherwise the field is ignored and the adapter inherits host Git config (legacy behavior).
- Per-run `.gitconfig` files are written under `os.tmpdir()/paperclip-claude-git-identity/<agentId>/<runId>/.gitconfig` and removed at the end of each `execute()` call.
- The credential helper in the per-run `.gitconfig` references `$GH_TOKEN` — the literal PAT is never embedded in the file.
- PAT values are redacted from logs by Paperclip's redaction layer (regex covers both `ghp_*` classic and `github_pat_*` fine-grained tokens).

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Skills Injection

The adapter creates a temporary directory with symlinks to Paperclip skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

For manual local CLI usage outside heartbeat runs (for example running as `claudecoder` directly), use:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

This installs Paperclip skills in `~/.claude/skills`, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness
