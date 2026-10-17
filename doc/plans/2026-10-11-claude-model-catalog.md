# Fix: load claude-local model catalog from a disk file

Date: 2026-10-11

## Problem

`packages/adapters/claude-local/src/index.ts` (`models`) and
`packages/adapters/claude-local/src/server/models.ts` (`BEDROCK_MODELS`) hardcode
every known Sonnet/Opus/Haiku/Fable model ID, label, and Bedrock mapping. The
reasoning-effort levels per model family are also hardcoded as a regex in
`claudeLocalReasoningEffortsForModel()` (`index.ts`). Adding or updating a model
(e.g. a new Sonnet release, or granting Haiku effort levels) currently requires
editing TypeScript, rebuilding, and redeploying the whole app.

## Goal

Move the *data* (model IDs, labels, Bedrock mapping, effort levels) to a file on
disk under the operator's persistent instance storage, so updating it is
"edit/replace one file," not "redeploy the app." Code (loader, validation, sort
order) still ships normally in the app build — that part almost never changes.

## Design

### 1. Shared schema (`packages/shared`)

New `packages/shared/src/claude-model-catalog.ts`:

```ts
ClaudeModelCatalogEntry = { id: string; label: string; efforts?: EffortLevel[] }
ClaudeModelCatalog = { version: number; direct: ClaudeModelCatalogEntry[]; bedrock: ClaudeModelCatalogEntry[] }
```

Zod-validated, matching the existing `packages/shared` validators convention.
This is the contract both the adapter loader and (optionally) an admin UI read
against.

### 2. Bundled default (ships with code, as today)

Replace the literal arrays in `index.ts` / `server/models.ts` with a single TS
const module, `packages/adapters/claude-local/src/server/model-catalog.default.ts`,
exporting today's list as `ClaudeModelCatalog` data. Keep it as a `.ts` const
(not a `.json` asset) because the adapter package builds with plain `tsc`
(`"build": "tsc"` in `packages/adapters/claude-local/package.json`), which does
not copy loose JSON files into `dist`. This bundled default is the fallback of
last resort, and the thing a normal PR still edits for day-one support of a new
release.

### 3. Runtime override file (the actual fix)

Follow the existing instance-root convention already used in
`packages/shared/src/home-paths.ts` (same pattern as `resolveDefaultStorageDir`,
`resolveDefaultBackupDir`, `resolveDefaultLogsDir`, etc.):

```ts
export function resolveDefaultModelCatalogDir(input) {
  return path.resolve(resolvePaperclipInstanceRoot(input), "config", "model-catalogs");
}
```

Override path: `<instanceRoot>/config/model-catalogs/claude.json`.

`instanceRoot` already resolves to:
- the `paperclip-data:/paperclip` Docker volume in `docker/docker-compose.yml`
- `~/.paperclip/instances/<id>` locally

i.e. the same persistent storage that already survives redeploys today.

Add an escape-hatch env var, `PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE`, for operators
who want a different path — mirrors the existing `PAPERCLIP_STORAGE_LOCAL_DIR`
override pattern in `server/src/config.ts`.

### 4. Loader (`packages/adapters/claude-local/src/server/models.ts`)

Replace `DIRECT_MODELS` / `BEDROCK_MODELS` usage with a `loadModelCatalog()`:

- stat the override file; if present, `JSON.parse` + validate against the
  shared zod schema
- cache by `(path, mtimeMs)` — re-read only when the file actually changes, no
  restart needed, no arbitrary TTL guess
- on missing file → bundled default
- on parse/schema failure → `console.warn(...)` and bundled default (never
  throw, never block a run over a bad manual edit)
- `listClaudeModels()` and the Bedrock branch consume `catalog.direct` /
  `catalog.bedrock` instead of the static arrays

### 5. Effort levels become data, not regex

`claudeLocalReasoningEffortsForModel()` currently hardcodes which families get
`xhigh`/`max` via regex — this is exactly why Haiku has `[]` today and needs a
code change to ever get more. Replace with a catalog lookup: match the resolved
ID against `catalog.direct` / `catalog.bedrock` entries, return that entry's
`efforts`, and default to `["low","medium","high"]` only for an ID the catalog
doesn't recognize at all.

This fixes the Haiku gap as a side effect: ops can grant Haiku `xhigh` by
editing the JSON file, no PR needed.

### 6. Unchanged

- `packages/adapters/claude-local/src/server/model-order.ts` sort logic stays
  in code — it's a generic algorithm, not per-model data, so it already
  handles new IDs without edits.
- UI (`ui/src/components/ai-connections/useConnectionModels.ts`,
  `agentsApi.adapterModels`) needs no changes — it already just renders
  whatever the server returns.

### 7. Docs/tests

- Note the override path + schema in `doc/DEVELOPING.md` or `doc/DOCKER.md`
  (per AGENTS.md rule 4, "keep contracts synchronized" / docs updated when
  behavior changes).
- Tests: override valid / invalid / missing, mtime-triggered reload,
  Bedrock-env + override interaction, effort lookup from catalog including a
  Haiku case.

## Net effect

Adding Sonnet/Haiku N+1 becomes: edit/replace
`config/model-catalogs/claude.json` on the running instance's volume — no
`pnpm build`, no new image, no app restart (mtime cache picks it up on the next
model-list fetch).

## Open questions / assumptions to confirm before implementing

- Exact override file path and env var name (`PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE`
  proposed above) — open to a different convention if one already exists.
- Whether live Anthropic `/v1/models` discovery should still take precedence
  over the catalog file (today it does, merged with the static fallback) —
  current design keeps that behavior and only swaps what the "static fallback"
  side of the merge is sourced from.

**Resolved (2026-10-11):** live Anthropic discovery keeps precedence exactly as
before; `PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE` was accepted as-is.

## Implementation status (2026-10-11)

Implemented on branch `fix/claude-local-disk-model-catalog` (branched from a
freshly pulled `master`, commit `de9ab8e7e`):

- `packages/shared/src/claude-model-catalog.ts` — new zod schema/types
  (`claudeModelCatalogSchema`, `ClaudeModelCatalog`, `ClaudeModelCatalogEntry`).
- `packages/shared/src/home-paths.ts` + `server/src/home-paths.ts` — new
  `resolveDefaultModelCatalogDir()`, following the existing
  `resolveDefaultStorageDir`/`resolveDefaultBackupDir` pattern.
- `packages/adapters/claude-local/src/model-id.ts` — new module: the pure
  `parseClaudeModelId`/`sameClaudeModelRelease` id-parsing logic, extracted
  out of `server/model-order.ts` so it is importable from the browser-bundled
  `index.ts` too (no Node-only imports).
- `packages/adapters/claude-local/src/model-catalog.default.ts` — new bundled
  default catalog (the old hardcoded `models`/`BEDROCK_MODELS` arrays, now
  carrying an explicit `efforts` field per entry).
- `packages/adapters/claude-local/src/index.ts` — `models` and
  `claudeLocalReasoningEffortsForModel()` now derive from the bundled default
  catalog instead of a hardcoded array/regex. **Scope note:** this file runs
  in the UI's browser bundle (`ui/src/lib/agent-setup-fields.ts`,
  `ui/src/components/task-chat/composer-run-settings.ts` call
  `claudeLocalReasoningEffortsForModel` directly, client-side), so it only
  ever sees the bundled catalog, never the on-disk override. The disk
  override's effect is on the **model id/label list** the picker fetches from
  the server (`agentsApi.adapterModels()` → `listClaudeModels()`); an
  operator-added effort level for a new/overridden model won't appear in the
  UI's effort dropdown without a further change to make that client-side
  lookup server-driven too. Flagged as a known limitation, not silently
  dropped.
- `packages/adapters/claude-local/src/server/model-order.ts` — now imports
  `parseClaudeModelId` from `../model-id.js` instead of duplicating it.
- `packages/adapters/claude-local/src/server/models.ts` — new
  `loadModelCatalog()` reads `PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE` (or
  `resolveDefaultModelCatalogDir()/claude.json`), validates against the zod
  schema, caches by `(path, mtimeMs)`, and falls back to the bundled default
  with a `console.warn` on any missing/invalid file. `listClaudeModels()` /
  `refreshClaudeModels()` / the Bedrock branch all read through it. Live
  Anthropic `/v1/models` discovery is unchanged and still takes precedence:
  `mergedWithFallback()` still puts discovery results first in the dedupe,
  so a live-returned id's label wins over the catalog's.
- `packages/adapters/claude-local/src/server/models.test.ts` — new: covers
  missing/valid/invalid override files, mtime-triggered reload, Bedrock-mode
  override, `refreshClaudeModels()`, and live-discovery-takes-precedence.
- `doc/DEVELOPING.md` — documented the new
  `config/model-catalogs/claude.json` override path and env var under "Local
  Instance Layout".

### Verification run in this environment

- `pnpm --filter @paperclipai/shared --filter @paperclipai/adapter-claude-local typecheck` — both Done.
- `pnpm --filter @paperclipai/db typecheck` — Done.
- Targeted vitest: claude-local adapter tests (33 passed), server
  `adapter-models.test.ts` (27 passed), relevant UI tests — `agent-setup-fields`,
  `composer-run-settings`, `useConnectionModels`, `agent-config-patch`,
  `AgentConfigForm.render`, `NewAgent` (170 passed). All green, no regressions.
- `packages/shared` full suite: 905 passed / 5 failed — the 5 failures are in
  `worktree-seed-source.test.ts`, caused by Windows `EPERM` on `fs.symlinkSync`
  in that test file; unrelated to this change (confirmed: that file wasn't
  touched, and the failure is a symlink-permission limitation of this
  Windows checkout, not test logic).
- Repo-wide `pnpm -r typecheck` / `pnpm build` could **not** be completed in
  this environment: `packages/paperclip-runner`'s build requires a Rust
  toolchain and its checked-in generated-artifact hashes/protocol manifest
  are stale on this fresh checkout (`check:protocol-manifest` and
  `check:acpx-profiles` both fail) independent of any file this fix touches;
  `ui` typecheck separately fails because `packages/plugins/sdk` was never
  built (`@paperclipai/plugin-sdk/ui` has no `dist/`), traced to a
  `postinstall` step (`scripts/link-plugin-dev-sdk.mjs`) hitting `EPERM` on
  `symlinkSync` on this Windows machine (no Developer Mode / elevated
  symlink permission). Both are pre-existing environment limitations, not
  caused by this change.
- Nothing was committed — changes sit unstaged on the branch pending review.

## Follow-up (2026-10-11): close the UI/enforcement effort-level gap

The first pass left a documented gap: `claudeLocalReasoningEffortsForModel()`
runs in the browser bundle, so an operator who grants a model a new effort
level only via the on-disk catalog never saw it in the UI's effort picker,
and two server-side validation paths (AI connection pool routing, the public
MCP agent-config surface) still enforced the bundled-only effort list, so a
UI that *did* show the new effort would have gotten a 422 trying to save it.
Closed both ends without adding a new endpoint — the existing adapter-models
endpoint already round-trips whatever shape `AdapterModel` carries, so the
fix was to put `efforts` on that shape and thread it through:

- `packages/adapter-utils/src/types.ts` / `ui/src/api/agents.ts` — `AdapterModel`
  gained an optional `efforts?: readonly string[]` field.
- `packages/adapters/claude-local/src/server/models.ts` — `toAdapterModels()`
  now carries a catalog entry's `efforts` onto the `AdapterModel`; `dedupeModels()`
  now backfills `efforts` from the catalog side of the merge onto a live-discovered
  entry for the same id (live discovery has no effort data of its own), so an
  override-granted effort survives the "live discovery takes precedence" merge.
  Added `resolveClaudeReasoningEfforts(model)`: a synchronous, override-aware
  counterpart to the bundled `claudeLocalReasoningEffortsForModel`, for server
  code that enforces (not just displays) the supported-effort list.
- `packages/shared/src/claude-model-catalog.ts` — hoisted the
  `["low","medium","high"]` default into `DEFAULT_CLAUDE_REASONING_EFFORTS` so
  the bundled lookup, the override-aware lookup, and the schema agree on one
  constant instead of three copies.
- `server/src/services/ai-connection-router.ts` and
  `server/src/services/public-mcp/agent-config.ts` — switched from the
  client-bundled `claudeLocalReasoningEffortsForModel` to
  `resolveClaudeReasoningEfforts` (from `@paperclipai/adapter-claude-local/server`),
  so pool-member effort overrides and MCP `reasoningEffort` validation accept
  an operator-granted effort level instead of rejecting it.
- `ui/src/lib/agent-setup-fields.ts` (`setupEfforts`) and
  `ui/src/components/task-chat/composer-run-settings.ts` (`composerEfforts`)
  both gained an optional `catalogModels` parameter: when the caller already
  has the server-fetched adapter model list in scope, a matching entry's
  `efforts` wins over the bundled lookup. Omitting it keeps the old
  bundled-only behavior, so this is additive — no existing caller broke.
- Threaded that parameter through every production call site that has the
  model list in scope: `ui/src/components/AgentConfigForm.tsx` (both the
  thinking-effort options list and the model-change handler),
  `ui/src/components/new-agent/NewAgentSetup.tsx` (moved the `efforts`
  computation after the `models`/`connectionModels` queries it now reads —
  it had no forward dependency between those lines, so this was a safe
  reorder, verified by `NewAgent.test.tsx`'s claude_local coverage still
  passing), and `ui/src/components/task-chat/ComposerRunSettingsPicker.tsx`
  (now passes the full model objects instead of `.map(item => item.id)`).
- Left the storybook prototype at
  `ui/storybook/prototypes/composer-model-picker/fixtures.ts` untouched — it's
  a standalone demo with its own fixture data, not the production path.

### Verification

- `packages/adapter-claude-local` typecheck and its 3 test files: 37/37 passed
  (confirms `resolveClaudeReasoningEfforts` matches the bundled lookup when no
  override is configured, and picks up an override's `efforts` both directly
  and through the live-discovery merge).
- `server/src/__tests__/adapter-models.test.ts` + `adapter-registry.test.ts`:
  49/49 passed (updated 2 pre-existing assertions that compared merged models
  to a bare `{id,label}` — they now correctly expect the catalog's `efforts`
  to ride along).
- `ui`: `agent-setup-fields.test.ts`, `composer-run-settings.test.ts`,
  `ComposerRunSettingsPicker.test.tsx`, `useConnectionModels.test.tsx`,
  `AgentConfigForm.render.test.tsx`, `NewAgent.test.tsx`: 193/193 passed.
- Could not run `server/src/__tests__/ai-connection-router.test.ts` or
  `public-mcp.test.ts` in this environment — both fail to even load
  (`Error: Failed to resolve entry for package "@paperclipai/plugin-sdk"`),
  the same pre-existing, unrelated `plugin-sdk` build gap noted in the first
  pass (its `postinstall` symlink step hits `EPERM` on this Windows machine).
  Verified by isolated `tsc --noEmit` that neither
  `ai-connection-router.ts` nor `public-mcp/agent-config.ts` produced a new
  type error, and by inspection that `resolveClaudeReasoningEfforts` returns
  the same result as the old `claudeLocalReasoningEffortsForModel` for every
  model id those two test files exercise when no override is configured
  (`claude-sonnet-5`), so no regression is expected once that environment gap
  is fixed and the suite can run.
- Nothing was committed — these changes sit unstaged on top of the first
  pass's unstaged changes, same branch, pending review.
