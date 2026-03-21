---
baseline_sha: 49b9511889c839ffb9a2c790d4d18403b8b2eeef
end_sha: 5a9ce1be1bf8b2ade64d366485e306b7bd659d04
test_command: "pnpm test:run"
test_result: pass
test_count: 183
---

<!-- implement:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-21T13:34:43Z -->

# Implementation Receipt

## Changed Files
```
server/src/index.ts
server/src/services/heartbeat.ts
server/src/__tests__/heartbeat-zombie-guard.test.ts
ui/src/components/AgentConfigForm.tsx
pnpm-lock.yaml
```

## Commits
- `df7193c` fix(heartbeat): await startup reap before timer ticks begin
- `875e45c` fix(heartbeat): skip coalescing into zombie runs
- `e9ef436` fix(ui): show pi_local adapter config fields in AgentConfigForm
- `1394bbf` refactor(heartbeat): extract isZombieRun as testable pure function

## Test Output Summary
```
 Test Files  45 passed (45)
      Tests  183 passed | 1 skipped (184)
   Duration  3.00s
```

All 183 tests pass including 5 new `isZombieRun` unit tests. Typecheck and build also pass across all 12 workspace packages.

## Verification Summary
- `pnpm -r typecheck` — all 12 packages clean
- `pnpm test:run` — 183 passed, 1 skipped, 0 failed
- `pnpm build` — all packages build successfully (server, ui, cli, all adapters, db, shared)

## What Was Implemented
1. **Startup reap made synchronous** (`server/src/index.ts`): Changed `void heartbeat.reapOrphanedRuns()` to `await` with retry (max 2 attempts), with logging. Timer `setInterval` now starts AFTER startup reap completes.
2. **Coalescing liveness guards** (`server/src/services/heartbeat.ts`): Added zombie detection on both issue-scoped (~line 1808) and non-issue-scoped (~line 1998-2002) coalescing paths. "Running" runs not in `runningProcesses` are treated as zombies and skip coalescing.
3. **Periodic reaper** — verified no code changes needed. Existing staleness logic works correctly once coalescing stops refreshing `updatedAt` on zombies.
4. **isZombieRun extracted** as pure exported function with 5 unit tests covering: running+untracked=zombie, queued+untracked=not-zombie, running+tracked=not-zombie, failed=not-zombie, completed=not-zombie.
5. **UI fix** (`ui/src/components/AgentConfigForm.tsx`): `pi_local` added to `isLocal` check. Model dropdown, working directory, command placeholder, and thinking effort options all visible.

## Remaining Manual Verification (Phase 5)
- [ ] 5.1 Start `pnpm dev`, trigger pi_local heartbeat, kill server, restart — verify startup reap log and agent recovery
- [ ] 5.2 Verify Groove Jones claude_local agents still function
