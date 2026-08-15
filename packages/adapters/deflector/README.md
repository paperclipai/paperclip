# Deflector (`deflector_local`)

Non-AI pre-check adapter. Deterministic keyword/regex matching against a SQLite KB.
Auto-resolves only high-confidence repeat issues; everything else is released for normal routing.

## Layout

- `src/server/execute.ts` — heartbeat execution
- `src/server/match.ts` — matching engine
- `src/server/kb.ts` — SQLite KB (`better-sqlite3`, Node 20 compatible)
- `src/server/audit.ts` — JSONL audit log
- `scripts/seed-kb.ts` — manual/cron seed (not in live request path)

## Defaults

- KB: `~/.paperclip/instances/default/deflector/kb.sqlite`
- Audit: `~/.paperclip/instances/default/deflector/audit.jsonl`

## Seed

```bash
pnpm --filter @paperclipai/adapter-deflector seed:kb
```
