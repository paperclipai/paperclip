# Codex Fleet Failover

Use this when Claude subscription automation is degraded or unavailable and the
Paperclip fleet must run through Codex immediately.

The switch is reversible and does not rewrite agent rows. It changes the
instance-wide master-runtime routing setting so every `claude_local` and
`codex_local` heartbeat execution resolves to `codex_local`. Agent ownership,
task assignment, sessions, comments, and audit records stay attached to the
source agent.

## Preconditions

- Paperclip server is running and reachable.
- The operator is an instance admin, or has a stored board CLI login with
  instance-admin access.
- `codex_local` is logged in on the host and has enough quota for the expected
  heartbeat load.
- Keep a single active writer per `CODEX_HOME`. Do not point multiple concurrent
  Codex runtimes at one subscription OAuth token store unless that token store is
  designed for concurrent refresh.

## Status

```sh
pnpm paperclipai runtime status
```

Equivalent packaged CLI:

```sh
paperclipai runtime status
```

## Switch All Master-Runtime Agents To Codex

```sh
pnpm paperclipai runtime force-codex --clear-limits
```

`--clear-limits` removes stale stored Claude/Codex cooldown windows at the same
time. That avoids the known trap where a previous `claudeLimitedUntil` or
`codexLimitedUntil` timestamp keeps affecting automatic routing after account
state has changed.

Expected setting:

```json
{
  "mode": "force_codex",
  "activeRuntime": "codex",
  "reason": "manual_force_codex_clear_limits"
}
```

## Roll Back

Return to automatic failover:

```sh
pnpm paperclipai runtime auto --clear-limits
```

Expected setting:

```json
{
  "mode": "auto",
  "activeRuntime": null,
  "reason": "manual_auto_clear_limits"
}
```

Use `force-claude` only when you intentionally want both master runtime adapters
to execute through Claude:

```sh
pnpm paperclipai runtime force-claude --clear-limits
```

## Verify

1. Run `pnpm paperclipai runtime status` and confirm `mode=force_codex`.
2. Wake one non-critical `claude_local` agent.
3. Inspect the heartbeat run. The source agent remains `claude_local`, while
   run context/result metadata includes:

```json
{
  "paperclipMasterRuntime": {
    "sourceAdapterType": "claude_local",
    "executionAdapterType": "codex_local",
    "reason": "forced_codex_override"
  }
}
```

## Notes

- This is a fleet execution switch, not a data migration. Do not bulk-edit
  `agents.adapter_type` for this incident response path.
- `force_codex` bypasses automatic Claude/Codex limit protection by design. If
  Codex itself hard-limits while force mode is active, runs fail instead of
  silently downgrading to another adapter.
- Automatic mode still keeps the old rate-limit failover behavior:
  `claude_local` fails over to `codex_local` when Claude is limited, and vice
  versa. If both master runtimes are marked limited, Paperclip blocks the issue
  with `master_runtime_all_limited`.
