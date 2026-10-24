# Codex quota router

This plugin implements a **10% remaining quota rule** for saved OpenAI Codex
subscriptions using Paperclip's experimental task-pinned AI connection router.
It receives only authorized connection metadata and usage observations from
the host. The plugin never reads credentials or Codex login files.

## Selection

- For each new task, select the next account in pool order with **more than
  10%** remaining in every reported Codex window.
- When neither account meets that threshold, select an account at or below
  10% only after fresh observations confirm every configured account is also
  at or below 10%. Every limiting window on the selected account must have
  positive quota, explicitly allow admission, and reset in **less than five
  hours**. Among those accounts, select the one with the most quota remaining.
- At zero remaining, an explicit provider denial, unknown or stale telemetry,
  or a spend-control block, wait. The host schedules the retry. A missing
  observation is checked again after one minute; a known low window is checked
  at the five-hour boundary or reset.
- Existing task pins remain on their original account. A new run for a pinned
  task waits when that account is low; other tasks can use the second account.
  The host probes only the pinned account for a pinned task, so it cannot verify
  the other account's quota. The five-hour exception is therefore unavailable
  to pinned tasks; they wait for their account's reset. The task never switches
  identity.
  Recovery of the *same* persisted run deliberately retains its original
  credential. Moving an existing task to another account requires a separately
  reviewed session migration; do not reset sessions automatically.

The host caches quota observations for up to 60 seconds. A large run may cross
the threshold before the next observation, so this rule cannot promise zero
quota errors. Provider admission remains authoritative.

## Activation after review

1. Build and test the plugin in CI (`pnpm --filter
   @paperclipai/plugin-codex-quota-router typecheck`, `test`, `build`).
2. Install and enable the plugin on the Paperclip instance, then enable
   `enableAiConnectionRouters`.
3. Create a `usage_aware` pool with `thresholdPercent: 90` and explicit grants
   for the two connected Codex subscriptions. The installing user and each
   responsible user must be authorized to use both grants.
4. Assign the pool to one noncritical `codex_local` agent and test a new task,
   an exhausted account, and a pinned follow-up before broad assignment.
5. Move remaining `codex_local` agents to the pool in batches. Existing live
   sessions may need an intentional reset to adopt it. Inspect old task pins
   and running jobs before changing any binding.

Rollback: stop moving new agents to the pool and restore previous bindings
only for agents without active pool tasks. Leave the pool and both grants
available until its pinned tasks drain or receive a reviewed migration.
Disabling the pool or flag while pins remain can strand those tasks. Do not
delete credentials or change session identity as part of rollback.
