# Local Plugin Development

This is the short happy-path guide for developing a Valadrien OS plugin from a folder on your machine. You will scaffold a plugin, run it in watch mode, install it into a running Valadrien OS instance from an absolute local path, and edit code with the plugin worker reloading after each rebuild.

For the full alpha surface — manifest fields, capabilities, managed agents/projects/routines/skills, UI slots, scoped API routes — see [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md).

If your plugin has background-like recurring work, model it as managed resources:
declare managed routines plus managed agents/projects/skills, then reconcile those
resources in worker actions. This gives operators visible work items, budgets,
pause controls, and consistent audits instead of hidden daemon behavior.

## Prerequisites

- Node.js 22+ and `pnpm`.
- A local Valadrien OS checkout you can run from source. Local plugin installs read source from disk, so the running server must be able to see the path you give it.

## The five steps

```bash
# 1. Start Valadrien OS locally
pnpm valadrien-os run

# 2. Scaffold a plugin outside the Valadrien OS repo
valadrien-os plugin init @acme/hello-plugin --output ~/dev/valadrien-os-plugins

# 3. Install dependencies and start the watch build
cd ~/dev/valadrien-os-plugins/hello-plugin
pnpm install
pnpm dev

# 4. In another terminal, install the plugin from its absolute path
valadrien-os plugin install ~/dev/valadrien-os-plugins/hello-plugin

# 5. Confirm it loaded
valadrien-os plugin list
valadrien-os plugin inspect acme.hello-plugin
```

That's the loop. The rest of this page explains what each step does and what to expect when you edit code.

### 1. Start Valadrien OS

```bash
pnpm valadrien-os run
```

Valadrien OS listens on `http://127.0.0.1:3100` by default. The CLI talks to that server, so leave it running.

### 2. Scaffold the plugin

```bash
valadrien-os plugin init @acme/hello-plugin --output ~/dev/valadrien-os-plugins
```

This creates `~/dev/valadrien-os-plugins/hello-plugin/` with `src/manifest.ts`, `src/worker.ts`, `src/ui/index.tsx`, an esbuild watch config, a Vitest config, and a snapshot of `@valadrien-os/plugin-sdk` from your local Valadrien OS checkout. You can run the package and tests without publishing anything to npm.

Useful flags:

- `--template <default|connector|workspace|environment>` — starter shape.
- `--category <connector|workspace|automation|ui|environment>` — manifest category.
- `--display-name`, `--description`, `--author` — manifest metadata.
- `--sdk-path <absolute-path>` — point at a specific `packages/plugins/sdk` checkout if you have more than one.

When `plugin init` finishes, it prints the next four commands literally. You can copy them.

### 3. Install dependencies and run the watch build

```bash
cd ~/dev/valadrien-os-plugins/hello-plugin
pnpm install
pnpm dev
```

`pnpm dev` runs `esbuild --watch` against the plugin source and emits `dist/manifest.js`, `dist/worker.js`, and `dist/ui/`. Leave it running. Every time you save, esbuild rebuilds the affected output file.

If your plugin has UI and you want a browser-side dev server with hot module replacement during local UI iteration, run `pnpm dev:ui` in a second terminal. It serves `dist/ui/` on `http://127.0.0.1:4177`. This is optional; Valadrien OS can load the built UI directly from `dist/ui/` without it.

### 4. Install from the absolute path

```bash
valadrien-os plugin install ~/dev/valadrien-os-plugins/hello-plugin
```

The CLI auto-detects local paths (anything that looks absolute, starts with `./`, `../`, or `~`, or resolves to an existing folder relative to the current directory) and sends `{ isLocalPath: true }` to `POST /api/plugins/install` with the resolved absolute path. If you want to be explicit, pass `--local`.

You will see a confirmation like:

```
Installing plugin from local path: /Users/you/dev/valadrien-os-plugins/hello-plugin
✓ Installed acme.hello-plugin v0.1.0 (ready)
Local plugin installs run trusted local code from your machine.
Keep `pnpm dev` running in /Users/you/dev/valadrien-os-plugins/hello-plugin;
Valadrien OS watches rebuilt dist output and reloads the plugin worker.
```

Relative paths are resolved against the current working directory, so `valadrien-os plugin install .` from inside the plugin folder works too.

### 5. Inspect

```bash
valadrien-os plugin list
valadrien-os plugin inspect acme.hello-plugin
```

`list` shows plugin key, status, version, and short error. `inspect` prints the same record with the full last error if there is one. Both accept `--json` if you want to script against them.

## Reload semantics, honestly

Valadrien OS watches the on-disk plugin package after a local install. The watcher targets the runtime entrypoints declared in the package's `valadrienOsPlugin` field (`dist/manifest.js`, `dist/worker.js`, `dist/ui/`).

What that means in practice:

- **Worker code:** save a `.ts` file → esbuild rewrites `dist/worker.js` → Valadrien OS debounces ~500ms and restarts the plugin worker. The next worker call uses the new code. There is no in-process hot module replacement for worker code; it is a worker restart.
- **Manifest:** save `src/manifest.ts` → `dist/manifest.js` rewrites → the worker restarts and the host re-reads the manifest.
- **Plugin UI:** save a `.tsx` file → esbuild rewrites `dist/ui/` → Valadrien OS reloads the UI bundle on its next mount. To get HMR during UI iteration, run `pnpm dev:ui` and point at the dev server with `devUiUrl` in your manifest while developing.
- **Without `pnpm dev`:** the watcher only fires on `dist/*` changes. If you stop the watch build, source edits do not reach Valadrien OS. Restart `pnpm dev` (or run `pnpm build` once) before expecting changes.
- **`node_modules`, `.git`, `.valadrien-os-sdk`, and other dotfolders are ignored.** Adding a dependency requires the new code to actually be imported and rebuilt before the worker sees it.

The server never compiles plugin source for you. The package's own build scripts own that step.

## Local path plugins vs npm packages

Both go through the same install endpoint, but they mean different things:

- **Local path plugins are trusted local code.** Valadrien OS executes worker code from disk under the same trust boundary as the rest of the running instance. This is meant for developing or operating a plugin against a checkout you control. There is no signature check, no sandboxing of worker code, and no provenance metadata beyond the path. Do not install local-path plugins you did not write.
- **npm packages are the deployable artifact.** `valadrien-os plugin install @acme/plugin-foo` (optionally `--version 1.2.3`) installs from your configured npm registry, version-pins, and produces an install record that other operators can reproduce. Ship plugins this way.

When you are done iterating locally, publish the package and reinstall the npm-package form so the install reflects what you will ship.

## Common things to do next

- **Restart cleanly:** `valadrien-os plugin disable <key>` pauses the plugin without removing it. `valadrien-os plugin enable <key>` brings it back. `valadrien-os plugin uninstall <key>` removes the install record; add `--force` to also purge plugin state and settings.
- **Browse examples:** `valadrien-os plugin examples` lists the bundled example plugins that ship with the repo, each with a ready-to-run `valadrien-os plugin install <path>` line.
- **Go deeper:** [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md) covers worker capabilities, managed agents/projects/routines/skills, plugin database namespaces, scoped API routes, and the shared UI components in `@valadrien-os/plugin-sdk/ui`. [`PLUGIN_SPEC.md`](./PLUGIN_SPEC.md) is the longer-form specification, including future ideas that are not yet implemented.
- **Routine-first automation:** If your plugin should produce periodic issue work, prefer managed routines and `ctx.routines.managed` reconciliation over custom process loops or unobserved cron code.

## Troubleshooting

- **`Plugin install returned no plugin record` or `error` status.** Run `valadrien-os plugin inspect <key>` for the last error. The most common causes are (1) the plugin has not built yet — run `pnpm dev` or `pnpm build` first, (2) the `valadrienOsPlugin` entries in `package.json` point at files that do not exist on disk, or (3) the manifest failed validation. The Valadrien OS server log has the full validation error.
- **Edits do not seem to reload.** Confirm `pnpm dev` is still running and writing to `dist/`. If you renamed entry files, update the `valadrienOsPlugin.manifest` / `valadrienOsPlugin.worker` / `valadrienOsPlugin.ui` fields in `package.json` so the watcher targets them.
- **Worker restarts but UI is stale.** Hard-reload the page. If you want HMR, run `pnpm dev:ui` and set `devUiUrl` in your manifest to `http://127.0.0.1:4177` during development.
- **Path arguments fail on Windows.** Quote paths that contain spaces, and prefer absolute paths over `~`-prefixed paths in non-bash shells.
