---
"@paperclipai/shared": minor
"@paperclipai/db": minor
"@paperclipai/plugin-sdk": minor
"paperclipai": minor
---

Add plugin system core architecture: plugin registry, lifecycle management, capability validation, manifest schema & validation service, and scoped key-value state storage.

- `PLUGIN_API_VERSION` constant (currently `1`) exported from `@paperclipai/shared` and `@paperclipai/plugin-sdk`; increment on breaking plugin API changes.
- Shared constants for plugin statuses, categories, capabilities, UI slot types, event types, and bridge error codes.
- Shared types for `PaperclipPluginManifestV1` (including required `author` field), `PluginRecord`, `PluginConfig`, `PluginStateRecord`, and all manifest sub-declarations (jobs, webhooks, tools, UI slots).
- Zod validation schemas for manifest validation with field-level constraints (`id` regex, semver, string length limits, enum membership) and cross-field consistency checks (declared features must match capabilities; `entrypoints.ui` required when UI slots are declared; duplicate key rejection).
- Plugin state Zod schemas: `pluginStateScopeKeySchema`, `setPluginStateSchema`, `listPluginStateSchema` for validating `ctx.state` SDK operations.
- `pluginManifestValidator()` service factory: `parse()` for safe result-based validation, `parseOrThrow()` for install-time HTTP-error propagation (400), and `getSupportedVersions()` to expose the accepted API version range.
- Drizzle ORM schemas for `plugins`, `plugin_config`, and `plugin_state` tables with proper indexes and FK cascades.
  - `plugin_state`: scoped key-value store with a five-part composite key `(plugin_id, scope_kind, scope_id, namespace, state_key)`. Uses `NULLS NOT DISTINCT` unique constraint so `instance`-scope entries (where `scope_id IS NULL`) are handled correctly by PostgreSQL 15+ upserts.
- Plugin registry service for CRUD operations on plugins and config.
- Plugin lifecycle manager with state-machine enforcement (installed → ready | error | upgrade_pending | uninstalled) and event emission.
- Plugin capability validator for runtime operation gating and install-time manifest consistency checks.
- **Plugin loader service** (`pluginLoader(db, options?)`): multi-source plugin discovery and installation.
  - Discovers plugins from the local filesystem directory (`~/.paperclip/plugins/`) and installed npm packages matching the `paperclip-plugin-*` naming convention. Scoped `@scope/plugin-*` packages are also recognised.
  - `discoverAll(npmSearchDirs?)` — aggregates results from all enabled sources with path-based deduplication; returns a `PluginDiscoveryResult` with `discovered`, `errors`, and `sources` arrays.
  - `discoverFromLocalFilesystem(dir?)` — scans a directory for plugin packages; returns discovery-only entries (`manifest: null`) for packages with no resolvable manifest entrypoint.
  - `discoverFromNpm(searchDirs?)` — scans `node_modules` directories for plugin packages matching the naming convention.
  - `loadManifest(packagePath)` — resolves and validates a plugin manifest via the `paperclipPlugin.manifest` key in `package.json`, with fallbacks to `dist/manifest.js` and root-level `manifest.js`.
  - `installPlugin(options)` — installs from npm or a local path, validates the manifest (API version + capability consistency), and persists the install record via `pluginRegistryService`. Uses `execFile` (not `exec`) to prevent shell injection.
  - `isPluginPackageName(name)` — exported utility for naming-convention checks.
  - Remote registry discovery is reserved for a future release via the `registryUrl` option.
- Plugin runtime sandbox service:
  - VM-isolated worker module loading
  - operation-level capability-gated host API invoker
  - bare import allow-list + host binding enforcement
  - plugin-root import boundary enforcement
  - explicit CommonJS-only loader behavior with ESM rejection
- **`pluginStateStore(db)`** server service — backs `ctx.state` in the SDK:
  - `get(pluginId, scopeKind, stateKey, opts?)` — read a value; returns `null` if not set
  - `set(pluginId, input)` — upsert (create or replace) with plugin existence check
  - `delete(pluginId, scopeKind, stateKey, opts?)` — idempotent delete
  - `list(pluginId, filter?)` — list all entries with optional scope filters
  - `deleteAll(pluginId)` — bulk delete for uninstall with `removeData=true`
- New `@paperclipai/plugin-sdk` package: stable public API for plugin authors.
  - Worker-side SDK: `PluginContext` with 14 capability-gated client APIs (`config`, `events`, `jobs`, `http`, `secrets`, `assets`, `activity`, `state`, `entities`, `projects`, `data`, `actions`, `tools`, `metrics`, `logger`).
  - `PluginStateClient` interface with `get()`, `set()`, `delete()` backed by the `plugin_state` table. All state is scoped by plugin ID — plugins cannot access each other's state.
  - `ScopeKey` type with 8 scope kinds: `instance`, `company`, `project`, `project_workspace`, `agent`, `issue`, `goal`, `run`.
  - `definePlugin()` factory with typed lifecycle hooks (`setup`, `onHealth`, `onValidateConfig`, `onConfigChanged`, `onShutdown`, `onWebhook`).
  - UI SDK (`/ui` subpath): bridge hooks (`usePluginData`, `usePluginAction`, `useHostContext`), slot component prop interfaces, and shared UI component declarations.
  - Zod re-exported as `z` so plugin authors have a single dependency.
  - All `PLUGIN_*` constants re-exported for runtime use.
- Plugin authoring documentation: `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` and `packages/plugins/sdk/README.md`.
- 608 tests covering validators, manifest schema, manifest validator service, lifecycle, registry, capability validation, plugin state store (37 tests), state validators (35 tests), and the full plugin SDK.
