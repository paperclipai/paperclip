# Delegate mode quickstart

Delegate mode keeps Claude Code or Codex as the planning conversation and uses Paperclip for durable tasks, execution, and review.

## Install and run

From a clean clone:

```sh
./setup-delegate
```

The setup command installs dependencies, builds Paperclip, and asks which signed-in harness should execute delegated work. It also asks whether to use that harness's default model or a specific model id, plus the name of the personal workspace.

It then starts Paperclip and deterministically creates or reuses one personal company and one Generalist agent. The agent uses the chosen harness and model, disables timer heartbeats, and runs at most one task concurrently. Their ids are stored in the instance's `delegate-profile.json` and pinned in both Claude Code and Codex MCP configuration, so the planning agent never guesses among companies.

Re-running setup reuses the stored profile. To deliberately change the harness, model, or workspace name, run with `PAPERCLIP_DELEGATE_RECONFIGURE=true`.

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

Delegate mode does not include notifications or calendar integrations. Setup and infrastructure selection are deterministic; the LLM is used only to interpret inputs and shape the day plan.
