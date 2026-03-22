# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|

## User Preferences
- (accumulate as you learn them)

## Patterns That Work
- (approaches that succeeded)

## Patterns That Don't Work
- (approaches that failed and why)

## Domain Notes
- pnpm monorepo: server/ ui/ packages/db packages/shared packages/adapters/ cli/
- heartbeat.ts (~2350 lines) is the orchestration core
- 7 adapter types: claude-local, codex-local, cursor-local, openclaw, openclaw-gateway, opencode-local, pi-local
- Current branch: fix/pi-local-process-lost (spec 001 in specs/)
- Dev: `pnpm dev` → localhost:3100, embedded PGlite
- Verification: `pnpm -r typecheck && pnpm test:run && pnpm build`
