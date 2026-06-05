# Virtual Office Startup And Preview Recovery SOP

Use this SOP when Virtual Office does not open after reboot, backend health fails, or the preview page is stuck. The goal is to recover the preview the same way every time, without guessing or deleting local data.

## Check These Two URLs First

1. Office page:
   `http://localhost:5173/AI/office`

2. Backend health:
   `http://127.0.0.1:3100/api/health`

How to read the result:

- Office opens, but backend health fails: the backend or embedded Postgres probably is not healthy.
- Backend health is OK, but Office does not open: the frontend preview probably is not healthy.
- Both fail: recover backend first, then frontend.

## Stable Preview Rules

The preview helper keeps these safety defaults:

- `HEARTBEAT_SCHEDULER_ENABLED=false`
  This prevents unfinished Hermes or local-model employees from waking automatically and creating recovery issues.

- `PAPERCLIP_CONFIG=C:\path\to\paperclip\.paperclip-dev-config.json`
  This keeps embedded Postgres on the expected local port.

If logs mention both `54331` and `54329`, check that `.paperclip-dev-config.json` is still a complete Paperclip config before changing database files.

## Safer Helper Commands

From the repository root, use:

```powershell
pnpm run office:check
```

This checks the preview without starting or restarting services.

If this says Frontend OK but the page is black, blank, or does not show real Office content, run the render smoke check:

```powershell
pnpm run office:render-smoke
```

This opens a clean headless Edge/Chrome instance, loads `http://localhost:5173/AI/office`, and confirms the React root, page text, and Office keywords actually rendered.

```powershell
pnpm run office:start
```

This starts missing preview services.

```powershell
pnpm run office:restart
```

This intentionally stops the existing Paperclip dev service and restarts the preview. Use it only when you are not saving data, creating tasks, or syncing skills.

To run UI typecheck, acceptance sync, documentation checks, preview health, and render smoke together:

```powershell
pnpm run office:verify
```

## Preview Status Report

Each helper run updates:

```text
.virtual-office-preview-status.json
```

This is a local diagnostic report and should not be committed. The most useful fields are:

- `backendOk`: whether the backend is healthy.
- `frontendOk`: whether the Office page opens.
- `embeddedPostgresLockFile.exists`: whether the embedded Postgres lock file exists.
- `stuckBackendProcesses`: suspicious leftover backend processes.
- `portOwnership`: who owns ports `3100`, `5173`, and `54331`.
- `nextAction`: the safest next step.

If you are stuck after reboot, run `pnpm run office:check`, then share a short summary of this report with Codex. Do not paste private paths or full logs into public issues.

## Startup Safety Bundle

In the Office starter console, the `Preview service` section has `Copy startup safety bundle` (`複製開機安全包`).

Use it when:

1. You rebooted.
2. You ran `pnpm run office:check`.
3. The preview is still blocked or confusing.
4. You want to paste one safe status package back to Codex.

Before `office:check` passes, do not create workflows, sync skills, save employees, disable employees, press Run now, enable schedule triggers, or wake Hermes.

## Frontend Blocked But Backend OK

If the helper says:

```text
Backend health: OK
Frontend page:  blocked
Next action: restart the frontend preview only; the backend is ready.
```

Use this order:

1. Do not delete the database.
2. Do not manually delete `postmaster.pid`.
3. Do not wake Hermes or another local model.
4. Run `pnpm run office:restart`.
5. Run `pnpm run office:verify` or `pnpm run office:check` again.
6. Continue only after Backend OK and Frontend OK both appear.

## Browser Tab Stuck On An Error Page

Sometimes the backend and frontend recover, but the in-app browser tab is still on an old `data:` error page. That does not mean the database is broken.

Use this order:

1. Run `pnpm run office:check`.
2. Confirm Backend OK and Frontend OK.
3. Reload `http://localhost:5173/AI/office`.
4. If reload still fails, close that preview tab and open a new one.
5. Until the Office page is normal again, do read-only checks only.

## Backend Blocked

If backend health is blocked:

1. Run `pnpm run office:check`.
2. Read the backend recovery hints.
3. Do not delete the database directory.
4. Do not manually delete `postmaster.pid` unless you intentionally choose database recovery with a clear reason.
5. If the helper reports a stuck embedded Postgres/shared-memory state after reboot, reboot Windows before retrying.

Common ports:

- `3100`: Paperclip backend
- `5173`: frontend preview
- `54331`: this preview's embedded Postgres

## Safe Help Prompt

If you need help, paste something like this:

```text
Please help me check my Virtual Office preview using docs/virtual-office-startup-sop.en.md.
Start with health checks only.
Do not delete the database.
Do not create or modify data.
Do not press Run now.
Do not enable schedule triggers.
Do not wake Hermes or another local model.
```

## Long Stability Check

Use this only after `pnpm run office:verify` is already green and the Office page opens normally.

```powershell
pnpm run office:stability
```

The watcher checks:

- backend health at `http://127.0.0.1:3100/api/health`
- the Office page at `http://localhost:5173/AI/office`
- whether the heartbeat scheduler environment is still `false`

By default it runs for 120 minutes and checks every 60 seconds. It writes `.virtual-office-stability-report.json` for review.

For a quick smoke check while developing, run:

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/watch-virtual-office-preview.ps1 -DurationMinutes 1 -IntervalSeconds 5
```

Passing this tool means the watcher exists and the sampled preview stayed reachable. The open-source manual stability checks have separate evidence: a 60-minute idle run completed on 2026-05-12, and 3/3 Windows reboot validations completed on 2026-05-15.

### Open-Source Stability Evidence Table

Do not create a new flow card for every reboot or long run. Before open-sourcing, keep one evidence table and update the release checklist only after it has enough proof.

| Type | Count / Duration | Started | Finished | `office:restart` | `office:verify` | `office:stability` | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows reboot | 1 / 3 |  |  | PASS / FAIL | PASS / FAIL | n/a | PASS / FAIL |  |
| Windows reboot | 2 / 3 |  |  | PASS / FAIL | PASS / FAIL | n/a | PASS / FAIL |  |
| Windows reboot | 3 / 3 |  |  | PASS / FAIL | PASS / FAIL | n/a | PASS / FAIL |  |
| Idle long run | 60 to 120 minutes |  |  | done / n/a | PASS / FAIL | PASS / FAIL | PASS / FAIL |  |

Pass criteria:

- Backend OK and Frontend OK after every reboot.
- The heartbeat scheduler remains `false`.
- No active Hermes run, no recovery chain, and no production-data task wake-up.
- `.virtual-office-stability-report.json` shows backend/frontend stayed reachable during the long run.
- If any row fails, record the failure and fix; do not mark the stability gate complete.
