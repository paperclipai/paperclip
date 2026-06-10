# DB-backed agent instruction bundles — implementation spec

**Status:** approved (owner picked "DB-backed bundles"), not yet implemented · **Owner lane:** runtime/engineer · **Date:** 2026-06-10

## Problem
Instruction bundles live as files on the **Railway volume**
(`/valadrien-os/instances/default/companies/{co}/agents/{id}/instructions/`). The UI's
instruction viewer/editor runs on the **Vercel** control plane, which has a different
filesystem and can't see the volume → every agent shows
`Instructions root does not exist: …` and an empty editor. Agents are unaffected (the
executor `fs.readFile`s the bundle on Railway, where it exists) — only UI view/edit is broken.
Same split that forces bundle seeding via `railway ssh`.

## Goal
Make the **database** the source of truth for instruction bundles so both planes read/write the
same place. Eliminates the FS split for instructions: UI view/edit works, no more `railway ssh`
seeding, future agents "just work."

## Design — DB source of truth, FS as a per-run materialization (fallback-by-default)

### Storage
New nullable column on `agents`:
```ts
instructionBundle: jsonb("instruction_bundle").$type<{
  entryFile: string;                          // e.g. "AGENTS.md"
  files: Array<{ path: string; content: string }>;
} | null>()
```
Single column (no new table) = minimal migration, no joins, matches the small multi-file bundles
(AGENTS.md + SOUL/HEARTBEAT/TOOLS). Nullable so it's additive.

### Read path — `agentInstructionsService(db)`
Thread `db` in. Add a `dbBundle(agent)` helper that returns the parsed column or `null`. Then in
each method, **branch DB-first, fall back to the existing FS logic when the column is null**:
- `getBundle`: if `dbBundle.files?.length` → synthesize `BundleState` + `AgentInstructionsFileSummary[]`
  from the in-memory files (compute size/language/markdown/isEntryFile via the existing
  `inferLanguage`/`isMarkdown` helpers; `editable:true`, `virtual:false`); skip all FS stats.
  Else → today's FS path unchanged.
- `readFile`: if `dbBundle` → find the file by path, return detail. Else → FS.

### Write path
- `writeFile` / `deleteFile` / bundle PATCH: operate on the column. Read `dbBundle` (initialize
  from the agent's current FS bundle, or empty, if null), upsert/remove the file, then
  `db.update(agents).set({ instructionBundle }).where(eq(agents.id, …))`. Runs on Vercel → fixes
  the editor.
- Keep `adapterConfig.instructionsFilePath/RootPath/EntryFile` in sync (the executor still keys off
  `instructionsFilePath` for the on-disk materialized copy).

### Runtime materialization (Railway, the safety-critical hook)
In the heartbeat run resolver (`resolveExecutionRunAdapterConfig`, `server/src/services/heartbeat.ts`),
**before execute**: if `agent.instructionBundle?.files`, write each file to `instructionsRootPath`
on the volume (`mkdir -p` + `writeFile`, overwrite). The executor then `fs.readFile`s as today —
**executor untouched.** DB = source, FS = per-run cache. If the column is null, do nothing (today's
behavior). This makes the change a no-op until an agent's column is populated.

### Routes
`server/src/routes/agents.ts`: `agentInstructionsService()` → `agentInstructionsService(db)`.

## Migration
- Drizzle migration: `ALTER TABLE agents ADD COLUMN instruction_bundle jsonb;` (generate via
  `pnpm db:generate` so the snapshot/journal stay consistent; `VALADRIEN_OS_MIGRATION_AUTO_APPLY=false`,
  so apply manually with `pnpm db:migrate` against the session-pooler URL).
- **Backfill** (one-time script): for each existing agent, read its current volume bundle files and
  write them into `instruction_bundle`. Reuses the volume read via the Railway worker.

## Staged, safe rollout (because the change is fallback-by-default)
1. Land the code (PR → Korije review → merge). With the column NULL everywhere, behavior is
   **identical to today** (pure FS) — zero runtime change on deploy.
2. Apply the migration (add column).
3. Backfill **one** agent (e.g. Bati). Verify: (a) UI shows its bundle with no error;
   (b) trigger a run → confirm it still loads instructions (materialized from DB) and `succeeds`.
4. Backfill the rest. Re-verify each loads.
5. From then on, edits go through the UI/DB; volume files are a regenerated cache.

## Verification checklist
- UI `/VAL/agents/<id>/instructions` shows the real files, no "root does not exist", for all agents.
- Each agent runs and reads instructions (spot-check a run per agent → `succeeded`).
- A UI edit persists and is picked up on the next run (materialized to FS).
- Null-column agents (if any) still work via FS fallback.

## Files touched
- `packages/db/src/schema/agents.ts` (+ generated migration)
- `server/src/services/agent-instructions.ts` (db param + DB-first branches)
- `server/src/routes/agents.ts` (pass `db`)
- `server/src/services/heartbeat.ts` (materialize DB→FS in the run resolver)
- `scripts/backfill-instruction-bundles.ts` (one-time)

## Out of scope (deliberately)
- Other adapters' executors: unchanged — they read the materialized FS copy.
- Removing the volume dependency entirely: the FS materialization stays as the executor contract;
  the DB is just the source of truth now.
