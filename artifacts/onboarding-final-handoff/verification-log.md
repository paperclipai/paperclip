# pc-uqn onboarding verification log

Date: 2026-08-31 (Asia/Kuala_Lumpur)
Branch: `verify-pc-uqn`
Verified commit before evidence checkpoint: `cf2eb107f24304b2f5bc0bb9b26835e7262d91e1`
Isolated instance: `pc-uqn-onboarding-verification`
Service URL: `http://127.0.0.1:3101`
Embedded database port: `54330`

## Environment isolation

- Created worktree-local `.paperclip` configuration with `paperclipai worktree init --no-seed --name pc-uqn-onboarding-verification`.
- Completed the CLI-required minimal seed into `/Users/gnagano/.paperclip-worktrees/instances/pc-uqn-onboarding-verification`.
- The user's primary Paperclip database was not modified or deleted.
- Listener cwd before and after restart resolved to this worktree's `server/` directory.

## UI verification

Test organization: `PC UQN Verification 20260831 1210`
Test mission: `Verify onboarding persistence without duplicate records`

1. Opened Create new organization and captured the organization step.
2. Entered the organization name and advanced to Define your mission.
3. Entered the mission and clicked Confirm mission.
4. PASS: UI advanced directly to `Create your first agent`.
5. Reloaded the browser page.
6. PASS: UI remained on `Create your first agent`.
7. Stopped the actual dev process with Ctrl-C and verified port 3101 was released.
8. Started `pnpm dev:once` again and observed a new server start timestamp.
9. Reloaded the browser page.
10. PASS: UI remained on `Create your first agent` after service restart.

## Health and process identity

After restart:

```json
{
  "status": "ok",
  "bootstrapStatus": "ready",
  "commit": "b63d9374d",
  "branch": "verify-pc-uqn",
  "processStartedAt": "2026-08-31T04:13:24.942Z"
}
```

Listener PID after restart: `916`

Listener cwd:

```text
/Users/gnagano/nonDropbox/★Curiox/workspace/gastown-pilot-hq-v2/paperclip/polecats/quartz/paperclip/server
```

## API uniqueness verification

After Confirm mission and again after service restart:

```json
{
  "exactCompanyCount": 1,
  "ids": ["4e0b5ca2-ac9a-4edb-87ba-e3b6f46f5d6e"]
}
```

```json
{
  "exactGoalCount": 1,
  "ids": ["8eea8534-923c-4dbf-86bb-09b782c08181"]
}
```

## Focused test note

The focused Vitest command could not start its jsdom worker under both local Node 20.18.1 and Node 22.22.2 because `html-encoding-sniffer` attempted to `require()` the ESM-only `@exodus/bytes/encoding-lite.js`. No test cases ran. The required browser, reload, restart, API persistence, and process-identity acceptance checks all passed independently.
