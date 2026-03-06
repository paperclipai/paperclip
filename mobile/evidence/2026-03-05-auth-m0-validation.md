# OTTAAA-12 Auth M0 Validation (2026-03-05)

## Checks

- `pnpm --filter @paperclipai/mobile typecheck` -> pass
- `pnpm --filter @paperclipai/mobile test` -> pass
- `pnpm -r typecheck` -> pass
- `python3 scripts/tools/docs-lint.py` -> pass
- `python3 scripts/tools/docs-drift-check.py` -> pass

## Acceptance mapping summary

- Mode-aware auth contract implemented for `local_trusted` and `authenticated`.
- Session persistence policy implemented in `src/sessionStore.ts` (persist in `local_trusted`; memory-only behavior in `authenticated`).
- Session lifecycle UI states surfaced: `signed_out`, `active`, `expired`, `error`.
- Unauthorized responses (`401/403`) invalidate session and force re-auth.

## Relevant files

- `mobile/src/config.ts`
- `mobile/src/sessionStore.ts`
- `mobile/App.tsx`
- `mobile/.env.example`
- `mobile/README.md`
