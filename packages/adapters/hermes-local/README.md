# @paperclipai/adapter-hermes-local

Paperclip adapter that runs the Hermes Agent CLI (`hermes`) as the agent
runtime. Mirrors the structure of `opencode_local` and `claude_local`.

## Status

V1 (2026-05-01) — minimal-but-functional.

- prompt -> response one-shot via `hermes chat -q ... -Q`
- session id capture + `-r <id>` resume on subsequent heartbeats
- post-run cost/usage fetched via `hermes sessions export`
- working-dir + env passthrough
- model passed via `-m provider/model`

Out of scope for V1 (planned for V2):

- skill injection (Hermes has its own skill registry)
- streaming output / per-step tool-call breakdown
- remote (SSH/sandbox) execution targets
- model auto-discovery from `~/.hermes/models_dev_cache.json`

See `DESIGN.md` for the full design rationale.

## Adapter config

```jsonc
{
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4.6",     // required
    "provider": "openrouter",                    // optional override
    "command": "hermes",                         // optional, default "hermes"
    "cwd": "/abs/path",                          // optional
    "instructionsFilePath": "/abs/SOUL.md",      // optional
    "promptTemplate": "...",                     // optional
    "extraArgs": [],                             // optional
    "env": {},                                   // optional
    "ignoreRules": false,                        // optional, default false
    "ignoreUserConfig": false,                   // optional, default false
    "acceptHooks": true,                         // optional, default true
    "yolo": true,                                // optional, default true
    "maxTurns": 0,                               // optional, default unset
    "toolsets": "",                              // optional, e.g. "fs,web"
    "skills": "",                                // optional, e.g. "obsidian,arxiv"
    "timeoutSec": 600,                           // optional
    "graceSec": 20                               // optional
  }
}
```

## Registration

Add to `~/.paperclip/adapter-plugins.json` (run from a host that has the
koenig-ai-org repo cloned):

```jsonc
{
  "plugins": [
    {
      "name": "hermes-local",
      "type": "hermes_local",
      "path": "/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/packages/adapters/hermes-local"
    }
  ]
}
```

## Switching an existing agent

Once registered, flip an existing agent from another adapter (e.g.
`opencode_local`) with a single SQL update:

```sql
UPDATE agents
SET adapter_type   = 'hermes_local',
    adapter_config = jsonb_build_object(
      'model',    'anthropic/claude-sonnet-4.6',
      'provider', 'openrouter',
      'cwd',      adapter_config->>'cwd'
    )
WHERE id = '<agent-uuid>';
```

## Development

```sh
pnpm -C packages/adapters/hermes-local typecheck
pnpm -C packages/adapters/hermes-local test
```
