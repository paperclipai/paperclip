# Fatal Stderr Detection for Adapter Processes

**Date:** 2026-04-02
**Status:** Approved
**Problem:** When a CLI adapter (e.g., Codex) hits a fatal auth error (TokenRefreshFailed), the process hangs indefinitely. The run stays in `running` status, the `executionRunId` lock persists, and all other agents on that issue are blocked. Evidence: run 06ece6b7 on GEN-100 stayed live for ~11 hours.

## Design

### Layer 1 — `runChildProcess` (adapter-utils/server-utils.ts)

Add optional `isFatalStderr` callback to `RunChildProcessOptions`:

```typescript
isFatalStderr?: (accumulatedStderr: string) => boolean;
```

**Behavior:**
- On each `stderr` data chunk, after appending to the accumulated buffer, call `isFatalStderr(stderr)`
- If it returns `true`, set a `fatalStderr` flag and kill the process group:
  - SIGTERM immediately
  - SIGKILL after `graceSec` if still alive
- Clear all timers (timeout, postResultKill)
- Only trigger once (guard with a boolean flag)

**Result changes:**
- Add `fatalStderr: boolean` to the return type of `runChildProcess`
- Callers can inspect this to know the kill was due to a fatal stderr pattern, not a timeout or normal exit

### Layer 2 — Adapter `execute()` functions

Each adapter supplies its own `isFatalStderr` matcher when calling `runChildProcess`.

**codex-local fatal patterns:**
- `TokenRefreshFailed` / `token refresh failed`
- `authentication_error` / `AuthenticationError`
- `invalid_api_key` / `invalid api key`
- `account_deactivated`
- `Could not refresh token`

**claude-local fatal patterns** (from existing `quota.ts` knowledge):
- `token_expired` / `token has expired`
- `authentication_error`
- `invalid_api_key`

**gemini-local, cursor-local, opencode-local, pi-local:**
- No `isFatalStderr` callback initially (undefined = no detection)
- Add patterns as failure modes are discovered

### Layer 3 — Heartbeat (no changes)

The existing heartbeat flow already handles adapter failures correctly:
1. `adapter.execute()` returns with non-zero exit code + error message
2. `setRunStatus(run.id, "failed", ...)` finalizes the run
3. `releaseIssueExecutionAndPromote(finalizedRun)` clears the `executionRunId` lock
4. Run event is appended with error details
5. `finalizeAgentStatus(agent.id, "failed")` updates agent state

The only change is that `execute()` now returns **quickly** instead of hanging for hours.

## Files to modify

1. **`packages/adapter-utils/src/server-utils.ts`**
   - Add `isFatalStderr` to options interface
   - Add `fatalStderr` to return type
   - Add stderr monitoring logic in `child.stderr` handler
   - Kill process group on fatal detection

2. **`packages/adapters/codex-local/src/server/execute.ts`**
   - Add `isFatalStderr` callback to `runChildProcess` call
   - Extract fatal pattern function (testable, exported)

3. **`packages/adapters/claude-local/src/server/execute.ts`**
   - Add `isFatalStderr` callback to `runChildProcess` call
   - Extract fatal pattern function (testable, exported)

## What stays unchanged

- 2-hour hard limit in heartbeat.ts (backstop for unmatched edge cases)
- Post-result process killer in server-utils.ts (happy path cleanup)
- All heartbeat finalization logic (already correct)
- Other adapters (gemini, cursor, opencode, pi) — no `isFatalStderr` until needed

## Testing

- Unit tests for each adapter's `isFatalStderr` function with known error strings
- Verify `runChildProcess` sets `fatalStderr: true` and kills the process when callback returns true
- Existing heartbeat tests should continue passing (no heartbeat changes)
