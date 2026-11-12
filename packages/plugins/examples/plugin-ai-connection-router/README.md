# Reference AI connection router

This is an explicitly minimal foundation, not a complete pooling feature. See
[What this deliberately leaves out](#what-this-deliberately-leaves-out).

An open-source reference router for experimental AI connection pools
(`doc/connections/AI-CONNECTION-ROUTERS.md`). It implements
`onRouteAiConnection` and declares only `ai.connections.route`,
`events.subscribe`, `plugin.state.read` and `plugin.state.write`. It needs no
host change.

The host still owns pools, pins, the cursor, authorization and the Connectors
UI. The router only chooses among the candidates the host has already
authorized and offered. It never sees credentials and cannot widen access.

## Policy

- **New task, `round_robin`:** rotate through `memberOrder`, starting after
  `lastMemberId`.
- **New task, `usage_aware`:** also skip a member whose usage is at or above
  `thresholdPercent`. Unknown usage (no probe, a failed probe, or no percentage)
  stays unknown: such members are tried after members with known headroom. It is
  never treated as 0 % or as exhausted.
- **Hard limits, in either mode:** skip a member at a hard limit
  (`limitReached`, `allowed: false` or 100 % used). Only account-wide limits and
  limits scoped to the model the run executes count (the host-resolved
  `runtimeConfig.model`, which includes compatible model overrides, else the
  member profile model). A model-scoped limit is a `model:<id>` scope token, or
  a bare limit ID that the model name contains or whose last `_` segment is a
  word of the model name (the host's legacy weekly windows, such as
  `seven_day_sonnet` and `seven_day_opus`). Limits for other models or
  features are ignored.
- **Pinned task:** keep `pinnedMemberId`. Return `exhausted` only at a hard
  limit or during a learned cool-down, so the host waits on that account. The
  threshold does not apply to pins, and the router never moves a pin.
- **`exhausted.retryAt`:** the earliest time any member is ready again. A
  member is ready when every blocking limit has reset and any cool-down has
  ended. A blocking limit with no known future reset counts as 15 minutes from
  now, so one member with a far reset never delays a member whose reset is
  unknown; a later known cool-down on that same member still holds.
- **Learned cool-downs, per agent** (for accounts without a usage read):
  - Each selection is recorded as `(agent, task key) → account` in plugin state.
  - `agent.run.failed` with `errorCode: "provider_quota"` cools that account
    (connection plus grant) **for the agent whose run failed only**, in every
    pool that holds the account. Other agents' tasks and pins on the same
    account are not affected. The error code is derived from run output, so it
    is not trusted to exclude a shared account: only the host's authenticated
    usage read (the candidate `usage`) excludes an account for every agent. The
    cool-down lasts until a named reset when the event carries one (a
    `retryNotBefore`/`resetsAt` field or an ISO-8601 time in the error text).
    A named reset is kept as given, even beyond 7 days. Otherwise the cool-down
    starts at 1 hour and doubles per strike, capped at 7 days.
  - `agent.run.finished` for that agent and account clears the cool-down.
  - Each terminal event consumes its selection, and a cool-down records the
    run that caused it, so a redelivered event adds no second strike. A
    selection made after a run finished belongs to a later run, so a late or
    redelivered event never consumes or changes it.
- **Fail open:** if plugin state cannot be read, the router routes without
  cool-downs instead of stalling the pool.

## What this deliberately leaves out

- Pinned and in-progress tasks wait on their original account. This is not
  transparent failover: only new tasks move to another account.
- No working proof on a live instance yet; the evidence is unit tests and a
  host integration test with a fake adapter.
- No measured balancing percentages. The router rotates and skips.
- Unknown usage stays unknown. There is no passive usage parsing from run
  output.
- No account-wide cool-down learned from run failures. A `provider_quota`
  failure cools the account only for the agent that reported it; another agent
  still uses that account until the host's usage read shows a limit.

## Limitations
- Run lifecycle events carry the issue and run IDs, not the router task key. The
  router matches a failure to the issue, the run, or the timer heartbeat. A
  retry that reuses an earlier run's task key is not matched, so its failure
  teaches nothing.
- Plugin state has no compare-and-set, so two concurrent quota failures on one
  account can record one strike instead of two.

## Build and test

```sh
pnpm --filter @paperclipai/plugin-ai-connection-router build      # dist/manifest.js, dist/worker.js
pnpm --filter @paperclipai/plugin-ai-connection-router test
pnpm --filter @paperclipai/plugin-ai-connection-router typecheck
```

The host integration test is
`server/src/__tests__/ai-connection-router-reference-plugin.test.ts`. It uses a
fake adapter, so no provider is called and no quota is used.

Installing the plugin does not enable routing. An operator must still set the
`enableAiConnectionRouters` instance flag and enable each pool.
