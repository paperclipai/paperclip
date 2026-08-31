# Delegate mode quickstart

Delegate mode keeps Claude Code or Codex as the planning conversation and uses Paperclip for durable tasks, execution, and review.

## Install and run

From a clean clone:

```sh
./setup-delegate
```

Setup requires Node.js 24.11 or newer, pnpm 9 or newer, and at least one signed-in
Codex or Claude Code CLI. Before installing packages, building, or writing instance
files, the command checks those prerequisites. If anything is missing, outdated, or
not signed in, it lists every detected problem and exits.

The setup command installs dependencies, builds Paperclip, and asks which signed-in harness should execute delegated work. It also asks whether to use that harness's default model or a specific model id, plus the name of the personal workspace.

It then starts Paperclip and deterministically creates or reuses one personal company with two agents: a human-facing **Chief of Staff** and a **Generalist** who reports to the Chief. Both use the chosen harness and model, disable timer heartbeats, and run at most one task concurrently. Setup also enables the Conference Room. The company and both agent ids are stored in the instance's `delegate-profile.json`; the Chief of Staff is pinned in both Claude Code and Codex MCP configuration, so the human always works through one agent.

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
- The Chief of Staff owns approved top-level work and delegates concrete child tasks to the Generalist.
- The user talks only to the Chief of Staff through the Conference Room and task review flow.
- Each agent runs at most one task at a time.
- The Generalist attaches the child deliverable and returns it to the Chief of Staff. The Chief reviews it, resolves revisions, and hands the parent task to the responsible user in `in_review`.
- `/today` shows Needs you, Ready to review, Working, Up next, and Done today.
- The user accepts submitted work or requests changes.

Delegate mode can show browser notifications when work is blocked or reaches its review time. Enable them from **Today**. Paperclip must remain open in at least one browser tab; closed-browser delivery, calendar integrations, and external notification channels are not included. Setup and infrastructure selection are deterministic; the LLM is used only to interpret inputs and shape the day plan.
