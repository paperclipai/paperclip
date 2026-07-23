---
title: Subscription CLI auth
summary: Use local Codex and Claude Code subscription/OAuth sessions without API keys
---

Paperclip can run local CLI adapters with subscription/OAuth logins instead of provider API keys. This is useful for small teams or solo operators who have already authenticated the official CLIs but do not yet want to provision organization API keys.

Supported adapters:

- [`codex_local`](/adapters/codex-local) through Codex CLI's `CODEX_HOME` / `~/.codex` session home.
- [`claude_local`](/adapters/claude-local) through Claude Code's `CLAUDE_CONFIG_DIR` / `~/.claude` session home.

This mode should be treated as a local-operator convenience, not as a multi-tenant production secret-management model.

## When to use this

Use subscription CLI auth when all of these are true:

- Paperclip is running on a trusted local workstation, VM, or private server.
- The operator has already run the vendor CLI login flow (`codex login`, `claude login`, or equivalent).
- You do not want to store `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` values in Paperclip.
- Agents are allowed to consume the same subscription session as the local CLI user.

Use API keys or a managed secret backend instead when you need tenant isolation, audit-grade provider billing, per-agent spend attribution, or revocable service credentials.

## Host setup

Authenticate each CLI outside Paperclip first:

```sh
codex login
claude login
```

Then verify metadata only. Do not print file contents:

```sh
test -s "$HOME/.codex/auth.json" && echo "Codex auth present"
test -s "$HOME/.claude/.credentials.json" && echo "Claude credentials present"
```

## Docker setup

When Paperclip runs in Docker, mount the CLI session homes into the Paperclip container and point the adapters at those mounted homes.

Use the example override file:

```sh
docker compose \
  -f docker/docker-compose.quickstart.yml \
  -f docker/docker-compose.subscription-auth.yml \
  up
```

The override mounts the host homes read-only by default:

```yaml
services:
  paperclip:
    environment:
      CODEX_HOME: /host-cli-auth/codex
      CLAUDE_CONFIG_DIR: /host-cli-auth/claude
    volumes:
      - ${CODEX_HOME:-${HOME}/.codex}:/host-cli-auth/codex:ro
      - ${CLAUDE_CONFIG_DIR:-${HOME}/.claude}:/host-cli-auth/claude:ro
```

Read-only is the safest first posture because the container can use the session but cannot mutate the host's canonical CLI auth state.

If the vendor CLI requires refreshing tokens and fails because the mounted home is read-only, prefer a dedicated Paperclip auth-home copy rather than mounting the operator's canonical CLI home read-write:

```sh
install -d -m 700 "$HOME/.paperclip-cli-auth/codex" "$HOME/.paperclip-cli-auth/claude"
cp -a "$HOME/.codex/." "$HOME/.paperclip-cli-auth/codex/"
cp -a "$HOME/.claude/." "$HOME/.paperclip-cli-auth/claude/"
```

Then start Docker with:

```sh
CODEX_HOME="$HOME/.paperclip-cli-auth/codex" \
CLAUDE_CONFIG_DIR="$HOME/.paperclip-cli-auth/claude" \
docker compose \
  -f docker/docker-compose.quickstart.yml \
  -f docker/docker-compose.subscription-auth.yml \
  up
```

If you intentionally allow writes, update the override locally from `:ro` to `:rw`. Do not make this change casually: a compromised or buggy container process could then mutate or exfiltrate refreshable auth state.

## Agent configuration

### Codex

Do not set `OPENAI_API_KEY`. Let Codex CLI read `CODEX_HOME/auth.json`.

```json
{
  "adapterType": "codex_local",
  "adapterConfig": {
    "command": "codex",
    "model": "gpt-5.5",
    "timeoutSec": 360,
    "graceSec": 15,
    "env": {
      "OPENAI_API_KEY": ""
    }
  }
}
```

Paperclip's `codex_local` adapter creates managed per-agent Codex homes and symlinks `auth.json` from the configured shared `CODEX_HOME` when no API key is configured. That avoids stale copies of refreshable session auth.

### Claude Code

Do not set `ANTHROPIC_API_KEY`. Let Claude Code read `CLAUDE_CONFIG_DIR` / `~/.claude`.

```json
{
  "adapterType": "claude_local",
  "adapterConfig": {
    "command": "claude",
    "model": "claude-sonnet-4-6",
    "timeoutSec": 360,
    "graceSec": 20,
    "env": {
      "ANTHROPIC_API_KEY": ""
    }
  }
}
```

## Verification checklist

1. Confirm the container can see the mounted homes without printing secrets:

   ```sh
   docker compose exec paperclip sh -lc '
     test -s "$CODEX_HOME/auth.json" && echo "Codex auth visible"
     test -s "$CLAUDE_CONFIG_DIR/.credentials.json" && echo "Claude credentials visible"
   '
   ```

2. Use Paperclip's **Test Environment** action for the agent.
3. Dispatch a tiny synthetic task before assigning real work.
4. Confirm no provider API-key secret records were created for the subscription-auth agent.

## Security notes

- Subscription CLI auth gives Paperclip processes access to the same account/session as the local operator.
- Read-only mounts reduce mutation risk but do not prevent session use.
- Avoid logging file contents or environment dumps.
- Prefer dedicated copied auth homes if Paperclip needs writable refresh state.
- For shared or production deployments, use provider API keys or a proper secret backend with revocation and audit controls.
