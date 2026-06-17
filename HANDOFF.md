# Handoff

Updated: 2026-06-10

## Current Task

Built the gbrain memory control plane end to end: Paperclip agents now hydrate
remembered context before each run and capture run summaries back into gbrain,
with a company-scoped audit trail, `/api/memory` routes, and AI OS cockpit +
memory page surfaces. LiteLLM routing verified and documented.

Spec: `doc/plans/2026-06-10-gbrain-memory-control-plane.md` (authoritative).

## What Changed

- `packages/db`: new tables `memory_bindings`, `memory_binding_targets`,
  `memory_operations` (migration `0102_memory_control_plane.sql`). Also repaired
  a pre-existing snapshot-chain break: committed `0098_snapshot.json` pointed
  at 0093 as parent (collision from PR #7543); fixed prevId so `db:generate`
  works again.
- `server/src/services/memory/`: memory service (binding resolution with
  company-default auto-bootstrap, pre-run hydrate, post-run capture, operator
  query/note, overview/operations/binding-update) + gbrain provider that shells
  out to `gbrain call <tool> '<json>'` with hard timeouts and typed error
  results. Never throws; every op (success or failure) logs a
  `memory_operations` row.
- `server/src/services/heartbeat.ts`: pre-run hydrate sets
  `context.paperclipMemoryMarkdown` (own key — `paperclipTaskMarkdown` has a
  delete-else branch that would eat a merged value); post-run capture fires for
  succeeded AND failed terminal outcomes after the run-summary comment block.
- Adapters: claude-local and codex-local prompt assembly now include
  `paperclipMemoryMarkdown` after the task context section.
- `server/src/routes/memory.ts` + app.ts: overview / operations / query / note
  / binding PATCH, company-scoped, zod-validated.
- UI: `api/memory.ts`, `queryKeys.memory`, Memory panel card in
  `AiOsCockpit.tsx`, new `MemoryPage.tsx` at `/:companyPrefix/memory`.
- `doc/litellm-routing.md`: LiteLLM routing runbook.

## Verification

- `pnpm --filter @paperclipai/server typecheck`, ui, adapter-codex-local,
  adapter-claude-local: all PASS.
- Vitest battery PASS (130/130): memory-service (13), memory-gbrain-provider
  (14), memory-routes (14), heartbeat-memory-hooks (3), plus regression suites
  codex-local-execute, recovery-classifiers, heartbeat-issue-liveness-
  escalation, issue-comment-reopen-routes, codex parse.
- gbrain machine contract verified live: `call query` ~0.4 s with
  `expand:false`; put/get/delete round-trip OK. Embedding coverage backfilled
  2,062 → 6,370/6,370 chunks (ollama `nomic-embed-text` was missing — pulled).

## NOT yet done (needs operator)

1. **Restart the live instance** so the dev server loads the memory routes and
   auto-applies migration 0099 (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`):
   `launchctl kickstart -k gui/$(id -u)/ai.paperclip.local`
   Then check: `GET /api/companies/<id>/memory/overview` (bootstraps the
   default binding on first call) and the cockpit at `/RAY/ai-os` + `/RAY/memory`.
2. Obsidian vault repo `~/Documents/ObsidianVaultDefault` has an unfinished git
   merge (MERGE_HEAD) — `git merge --abort` or commit it; until then gbrain
   sync skips the pull step (local file indexing still works).
3. Optional: `gbrain sync --install-cron` for continuous brain freshness
   (denied to the agent as unattended persistence).

## Environment notes

- Live instance = LaunchAgent `ai.paperclip.local`, port 3101, runs THIS
  checkout via symlink `~/Documents/New project 2` → `AI Foundation System`,
  dev watch mode, migrations auto-apply on boot.
- TWO LiteLLM instances: legacy host router `com.steve.model-router` on
  127.0.0.1:4000 (LIVE — Hermes/Paperclip agents use it; do not kill) and new
  container `steve-litellm` on 127.0.0.1:4001 (config
  `~/.config/litellm/config.yaml`, shares `steve-litellm-postgres`).
  Consolidation is a deliberate operator decision — see doc/litellm-routing.md.
- Only provider keys on machine: OPENROUTER_API_KEY
  (`~/.local/share/steve-model-router/.env`), GEMINI_API_KEY (`~/.hermes/.env`).

## Prior work on this branch (unchanged, still uncommitted)

Recovery stall hardening + Codex task-context fix + AI OS cockpit — see
`doc/plans/2026-06-09-paperclip-recovery-stall-hardening.md`. All of it plus
the memory plane remains uncommitted on `codex/fix-paperclip-recovery-stalls`.
