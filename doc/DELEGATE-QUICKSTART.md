# Delegate mode quickstart

Delegate mode keeps Claude Code or Codex as the planning conversation and uses Paperclip for durable tasks, execution, and review.

## Install and run

From a clean clone:

```sh
./setup-delegate
```

The setup command installs dependencies, builds Paperclip, enables the low-resource Delegate experience, configures the local Paperclip MCP server in installed Claude Code and Codex clients, installs the `plan-my-day` skill, and starts Paperclip.

On first run, complete Paperclip's onboarding. Create one generalist agent with Claude Code or Codex. Delegate mode automatically disables timer heartbeats and limits the new agent to one concurrent run.

After onboarding, open Claude Code or Codex and say:

> Plan my day. I will paste my calendar next.

## Run again

```sh
./run-delegate
```

## Stop

Press `Ctrl+C` in the terminal running Paperclip.

## Product flow

- Claude Code or Codex proposes and revises the plan.
- No task starts before explicit approval.
- Paperclip runs one worker task at a time.
- `/today` shows Needs you, Ready to review, Working, Up next, and Done today.
- The user accepts submitted work or requests changes.

Delegate mode does not include notifications or calendar integrations.
