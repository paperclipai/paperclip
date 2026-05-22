# Refactor openrouter-local → openrouter-agent (standalone npm package)

Refactor the `openrouter-local` adapter in `/Users/marc/Projects/paperclip` to be renamed `openrouter-agent` and extracted as a standalone, externally-loadable npm package.

## Context

This is the Paperclip repo (paperclipai/paperclip), a local clone used as a runtime. The `openrouter-local` adapter lives at `packages/adapters/openrouter-local/` and is currently registered as a built-in adapter. The goal is to extract it so it can be installed and loaded as an external adapter plugin via Paperclip's external adapter mechanism (`~/.paperclip/adapter-plugins/`), without any source changes to the core Paperclip repo.

The adapter's current type string is `openrouter_local` (defined in `packages/adapters/openrouter-local/src/index.ts`). It needs to become `openrouter_agent` with display label `"Agentic OpenRouter"`.

## What distinguishes this adapter

- Native Paperclip API tools (checkoutIssue, completeIssue, etc.) wired into the tool loop
- Dynamic model listing via OpenRouter's `/models` API
- USD cost tracking via OpenRouter's `/generation` endpoint
- Reasoning token surfacing as `kind: "thinking"` entries
- Wall-clock timeout via AbortController

## Tasks

1. **Rename type string**: Change `export const type = "openrouter_local"` → `"openrouter_agent"` in `src/index.ts`. Add `export const label = "Agentic OpenRouter"` on the `ServerAdapterModule`. Update all internal references (`execute.ts`, `skills.ts`, test fixtures, etc).

2. **Update package.json**:
   - Change `name` from `@paperclipai/openrouter-local` to `paperclip-openrouter-agent` (unscoped, for public npm)
   - Set `version` to `0.1.0`
   - Change `peerDependencies` from `workspace:*` to actual semver ranges for `@paperclipai/adapter-utils` and `@paperclipai/shared`
   - Add `"type": "module"`, correct `main`/`exports` pointing to built output
   - Ensure `files` array covers only `dist/` and `README.md`

3. **Deregister from built-in registry**: Remove `openrouter_local` / `openrouter-local` from `server/src/adapters/registry.ts` (the built-in adapter registry). The adapter should no longer ship bundled.

4. **Verify external loading works**: Paperclip's external adapter loader is at `server/src/adapters/plugin-loader.ts` and uses `import(modulePath)` with `localPath` support. Confirm the package's `ServerAdapterModule` export shape matches what the loader expects (check `packages/adapter-utils/src/types.ts` for the `ServerAdapterModule` interface). The module must export `type`, `label`, and `createServerAdapter`.

5. **Rename directory**: Move `packages/adapters/openrouter-local/` → `packages/adapters/openrouter-agent/`. Update `pnpm-workspace.yaml` or any workspace globs if needed.

6. **Update tsconfig / build**: Ensure the package builds to `dist/` with ESM output and the built `dist/index.js` is the correct entry point for external loading.

7. **Document local install**: Update `README.md` with instructions for installing as an external adapter:
   ```
   pnpm --prefix ~/.paperclip/adapter-plugins add paperclip-openrouter-agent
   ```
   (or `npm install --prefix ...`)

8. **Run typecheck**: `cd packages/adapters/openrouter-agent && npx tsc -b --noEmit` — must pass clean.

9. **Run tests**: `cd packages/adapters/openrouter-agent && node_modules/.bin/vitest run` (run from the main project root's node_modules context if needed).

## Dependency on upstream PR

The `label` field on `ServerAdapterModule` (used to display "Agentic OpenRouter" instead of the raw type string) depends on upstream PR #5074 ("Honor custom labels from external adapter modules") which is currently open but not yet merged into `paperclipai/paperclip`.

Until that PR merges and is rebased into `main`, the display name will fall back to a humanized version of the type string in the UI. This is acceptable for now — the `label` export should still be added to the module so it works automatically once the PR lands. Do not work around it by patching the core UI.

## Important constraints

- Do NOT modify the core Paperclip server to add special-case knowledge of `openrouter_agent`. It must load purely through the existing external adapter mechanism.
- The working branch is `feat/openrouter-agent-adapter` on the `fork` remote (`marcpbailey/paperclip`), based on `origin/master` (not `main`). Before starting, rebase it onto the latest upstream:
  ```sh
  git checkout master && git merge --ff-only origin/master
  git checkout feat/openrouter-agent-adapter
  git rebase master
  git push fork feat/openrouter-agent-adapter --force-with-lease
  git checkout main
  ```
- Use `./paperclip-api.sh` (alias `pca`) for any API calls, never raw curl with keys.
- `gh` CLI requires `op run --` prefix to resolve 1Password secrets.
- The Docker container will need a rebuild after these changes — flag this at the end but do not execute it.
