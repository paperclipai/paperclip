# Virtual Office Quick Start

This is the short version for non-technical users. For full recovery steps, see `docs/virtual-office-startup-sop.en.md`.

## Daily Start

1. Open the project folder.
2. Double-click `scripts/open-virtual-office.cmd`.
3. Wait for the preview URL.
4. Open `http://localhost:5173/AI/office`.

The launcher keeps `HEARTBEAT_SCHEDULER_ENABLED=false`. It does not wake Hermes, does not run tasks now, and does not enable schedules.

## If It Fails

Paste the window output to Codex and add:

```text
Please follow the Virtual Office startup SOP and check safely. Do not delete the database, do not manually delete lock files, do not Run now, and do not wake Hermes.
```

You can also open PowerShell in the project folder and run:

```powershell
pnpm run office:restart
```

## Before Using The App

Confirm these are visible in the output:

- Backend OK
- Frontend OK
- Heartbeat scheduler: false

Only then test creating records, syncing skills, creating issues, or building workflows.

## Do Not Do This Yet

- Do not delete the database folder.
- Do not manually delete `postmaster.pid`.
- Do not click Run now.
- Do not enable the heartbeat scheduler.
- Do not reuse a Sandbox/Test wake-up authorization for another task.

## Full Verification

Before release or handoff, run:

```powershell
pnpm run office:verify
```

This checks UI types, acceptance sync, documentation links, and preview health.

## Long Stability Check Before Release

After the preview and full verification are green, run:

```powershell
pnpm run office:stability
```

It writes `.virtual-office-stability-report.json`. This is the long-run tool; the final release check still needs manual notes for repeated Windows reboots and a real 1 to 2 hour idle run.
