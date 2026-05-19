# Virtual Office Public Commit Scope

Use this file before publishing Virtual Office or opening a PR. It does not restate every feature. It separates public source artifacts from local-only state and lists the final checks before sharing the project.

## Safe To Commit

These categories are intended for public review after verification:

- Virtual Office UI and related tests.
- Public static assets, such as `ui/public/virtual-office/office-reference.png`.
- Preview and health tooling, such as `office:restart`, `office:check`, `office:verify`, and render smoke.
- Beginner docs, open-source guides, feedback routing, PR review flow, and maintainer SOPs.
- GitHub issue templates, PR template, `CONTRIBUTING.md`, and `SECURITY.md`.
- Hermes / local model safety preflight tools, Sandbox/Test verification tooling, and one-time authorization guardrails.
- Hermes Windows/WSL bridge source files and build scripts.

## Source-First Hermes Bridge

The Hermes Windows/WSL bridge is source-first:

- Commit:
  - `scripts/hermes-wsl-bridge.cs`
  - `scripts/hermes-wsl-query-helper.py`
  - `scripts/hermes-wsl.cmd`
  - `scripts/build-hermes-wsl-bridge.ps1`
- Do not commit:
  - `scripts/hermes-wsl.exe`

Users can build the local executable when needed:

```powershell
pnpm run hermes:wsl-bridge:build
```

Optional settings:

```powershell
$env:HERMES_WSL_DISTRO="Ubuntu"
$env:HERMES_WSL_PATH="hermes"
```

If Hermes is not available in the WSL PATH, `HERMES_WSL_PATH` can point to the user's own WSL executable path, such as `/home/<wsl-user>/.local/bin/hermes`. Do not place real API keys, tokens, full `.env` files, or private paths into examples.

## Do Not Commit

Keep these files and contents local:

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- `.hermes-ollama-bridge-status.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.hermes-ollama-bridge*.log`
- `scripts/hermes-wsl.exe`
- Any `.env`
- API keys, tokens, passwords, full logs, private repository URLs, internal URLs, production data, customer data, or personal data.

## Final Checks

Before publishing:

1. Run:

```powershell
pnpm run office:verify
```

2. Check the worktree:

```powershell
git status --short
git status --ignored --short
```

3. Confirm local status files, logs, `.env`, and `scripts/hermes-wsl.exe` are not committed.
4. Search public files for personal paths, private URLs, API keys, tokens, passwords, or full `.env` contents.
5. Confirm release notes do not describe Sandbox/Test evidence as production Hermes / local model authorization.
6. Confirm the issue template, PR template, `CONTRIBUTING.md`, and `SECURITY.md` still include safety stop lines.
7. Use `docs/virtual-office-pr-submission-plan.zh-TW.md` or `docs/virtual-office-pr-submission-plan.en.md` to prepare the PR body, then use `docs/virtual-office-pr-screenshot-evidence.zh-TW.md` or `docs/virtual-office-pr-screenshot-evidence.en.md` to review screenshots.
8. Use `docs/virtual-office-pr-final-review.zh-TW.md` or `docs/virtual-office-pr-final-review.en.md` for the final human review.

## Safety Stop Lines

Public issues, PRs, documentation feedback, and reading reviews are not authorization to:

- Install Hermes.
- Press Run now.
- Enable schedule triggers.
- Enable the heartbeat scheduler.
- Wake Hermes or a local model.
- Auto-retry, create a recovery issue, or open a continuation.
- Read secrets, a full `.env`, production data, or unauthorized data.

Production Hermes / local model wake-up still requires a specific issue, a specific agent, an explicit allowed scope, and a new verbatim one-time authorization.
