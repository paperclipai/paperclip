# Local Plugin Development

This is the short happy-path guide for developing a Paperclip plugin from a folder on your machine. You will scaffold a plugin, run it in watch mode, install it into a running Paperclip instance from an absolute local path, and edit code with the plugin worker reloading after each rebuild.

For the full alpha surface — manifest fields, capabilities, managed agents/projects/routines/skills, UI slots, scoped API routes — see [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md).

If your plugin has background-like recurring work, model it as managed resources:
declare managed routines plus managed agents/projects/skills, then reconcile those
resources in worker actions. This gives operators visible work items, budgets,
pause controls, and consistent audits instead of hidden daemon behavior.

## Prerequisites

- Node.js 22+ and `pnpm`.
- A local Paperclip checkout you can run from source. Local plugin installs read source from disk, so the running server must be able to see the path you give it.

## The five steps

```bash
# 1. Start Paperclip locally
pnpm paperclipai run

# 2. Scaffold a plugin outside the Paperclip repo
paperclipai plugin init @acme/hello-plugin --output ~/dev/paperclip-plugins

# 3. Install dependencies and start the watch build
cd ~/dev/paperclip-plugins/hello-plugin
pnpm install
pnpm dev

# 4. In another terminal, install the plugin from its absolute path
paperclipai plugin install ~/dev/paperclip-plugins/hello-plugin

# 5. Confirm it loaded
paperclipai plugin list
paperclipai plugin inspect acme.hello-plugin
```

That's the loop. The rest of this page explains what each step does and what to expect when you edit code.

### 1. Start Paperclip

```bash
pnpm paperclipai run
```

Paperclip listens on `http://127.0.0.1:3100` by default. The CLI talks to that server, so leave it running.

> **Verifying branch behavior?** If you are testing a plugin against routes or
> data shapes that only exist on a feature branch, the server you install into
> must be the one running that branch's code. A long-lived control-plane host
> may be on older code and silently return `API route not found` for routes the
> branch added, which makes the plugin look broken when the real problem is the
> test target. See [Targeting a branch / issue-workspace runtime](#targeting-a-branch--issue-workspace-runtime)
> before you install.

### 2. Scaffold the plugin

```bash
paperclipai plugin init @acme/hello-plugin --output ~/dev/paperclip-plugins
```

This creates `~/dev/paperclip-plugins/hello-plugin/` with `src/manifest.ts`, `src/worker.ts`, `src/ui/index.tsx`, an esbuild watch config, a Vitest config, and a snapshot of `@paperclipai/plugin-sdk` from your local Paperclip checkout. You can run the package and tests without publishing anything to npm.

Useful flags:

- `--template <default|connector|workspace|environment>` — starter shape.
- `--category <connector|workspace|automation|ui|environment>` — manifest category.
- `--display-name`, `--description`, `--author` — manifest metadata.
- `--sdk-path <absolute-path>` — point at a specific `packages/plugins/sdk` checkout if you have more than one.

When `plugin init` finishes, it prints the next four commands literally. You can copy them.

### 3. Install dependencies and run the watch build

```bash
cd ~/dev/paperclip-plugins/hello-plugin
pnpm install
pnpm dev
```

`pnpm dev` runs `esbuild --watch` against the plugin source and emits `dist/manifest.js`, `dist/worker.js`, and `dist/ui/`. Leave it running. Every time you save, esbuild rebuilds the affected output file.

If your plugin has UI and you want a browser-side dev server with hot module replacement during local UI iteration, run `pnpm dev:ui` in a second terminal. It serves `dist/ui/` on `http://127.0.0.1:4177`. This is optional; Paperclip can load the built UI directly from `dist/ui/` without it.

### 4. Install from the absolute path

```bash
paperclipai plugin install ~/dev/paperclip-plugins/hello-plugin
```

The CLI auto-detects local paths (anything that looks absolute, starts with `./`, `../`, or `~`, or resolves to an existing folder relative to the current directory) and sends `{ isLocalPath: true }` to `POST /api/plugins/install` with the resolved absolute path. If you want to be explicit, pass `--local`.

Before it installs, the CLI probes `GET /api/health` on the instance it is configured to talk to and prints the **target diagnostics** so you can confirm *which* Paperclip you are installing into. You will see a confirmation like:

```
Target Paperclip: http://127.0.0.1:3100
  health: status=ok  version=0.1.0  mode=local_trusted  exposure=private
Installing plugin from local path: /Users/you/dev/paperclip-plugins/hello-plugin
✓ Installed acme.hello-plugin v0.1.0 (ready)
Local plugin installs run trusted local code from your machine.
Keep `pnpm dev` running in /Users/you/dev/paperclip-plugins/hello-plugin;
Paperclip watches rebuilt dist output and reloads the plugin worker.
```

Read that first line. If the API URL, version, or mode is not the instance you expect, stop and re-point the CLI (see [Targeting a branch / issue-workspace runtime](#targeting-a-branch--issue-workspace-runtime)) before trusting the result. Pass `--no-verify-target` to skip the probe, or run `paperclipai plugin target` to see the same diagnostics without installing anything.

Relative paths are resolved against the current working directory, so `paperclipai plugin install .` from inside the plugin folder works too.

### 5. Inspect

```bash
paperclipai plugin list
paperclipai plugin inspect acme.hello-plugin
```

`list` shows plugin key, status, version, and short error. `inspect` prints the same record with the full last error if there is one. Both accept `--json` if you want to script against them.

## Targeting a branch / issue-workspace runtime

The five-step loop above assumes one Paperclip on `http://127.0.0.1:3100`. That breaks down the moment your plugin depends on **server code that only exists on a branch**. Examples:

- a new scoped API route the plugin calls (e.g. a `GET /api/companies/:companyId/...` endpoint the branch adds),
- a new field in an existing response the plugin reads,
- a new managed-resource capability the worker reconciles.

If you install the plugin into a long-lived control-plane host that is still on older code, the route or field is missing there. The plugin falls back or errors, and it *looks* like a plugin bug when the real problem is that you tested against the wrong runtime. To verify "what the published plugin will actually do," install into a Paperclip service that is **serving your branch**.

### How the CLI chooses its target

The CLI resolves the API base URL in this order (highest priority first):

1. `--api-base <url>` flag on the command,
2. `PAPERCLIP_API_URL` environment variable,
3. the active CLI context profile's `apiBase`,
4. inferred default `http://<PAPERCLIP_SERVER_HOST|localhost>:<PAPERCLIP_SERVER_PORT|config.server.port|3100>`.

So the API URL is explicit and overridable — the gap was never that you *couldn't* point at a branch server, it was that nothing told you which server you ended up on. `paperclipai plugin target` and the pre-install probe close that gap.

### Run the branch service and install into it

```bash
# 1. From the branch checkout (e.g. an issue worktree), run that branch's server.
#    Pick a port that does not collide with any control-plane instance.
PAPERCLIP_SERVER_PORT=3120 pnpm dev          # or: pnpm paperclipai run

# 2. Confirm the CLI will talk to that exact branch service before installing.
paperclipai plugin target --api-base http://127.0.0.1:3120
# Target Paperclip: http://127.0.0.1:3120
#   health: status=ok  version=<branch-version>  mode=local_trusted  exposure=private

# 3. Install the local-path plugin into that service (not the default host).
paperclipai plugin install ~/dev/paperclip-plugins/hello-plugin \
  --api-base http://127.0.0.1:3120

# Prefer setting it once for the shell instead of repeating --api-base:
export PAPERCLIP_API_URL=http://127.0.0.1:3120
paperclipai plugin target
paperclipai plugin install ~/dev/paperclip-plugins/hello-plugin
```

`plugin target` and the install-time probe both read `GET /api/health`, which returns the server `version`, `deploymentMode`, and `deploymentExposure`. Compare that `version` against the branch you expect to be running. If the diagnostics show a different URL, an unexpected version, or `health: unreachable`, you are about to test against the wrong instance — fix the target before reading anything into the plugin's behavior.

### End-to-end check that the branch route is actually served

When the behavior you care about is a branch-only route, hit it directly against the same target you installed into, so you prove the route exists there rather than inferring it from plugin output:

```bash
# Same base URL you installed into; expect JSON, not "API route not found".
curl -s "http://127.0.0.1:3120/api/companies/<companyId>/<branch-route>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | head
```

If that returns the route's JSON, the branch runtime is serving the route and the plugin is exercising real published behavior. If it returns `API route not found`, the service on that port is not running your branch code — restart the branch server (step 1) and re-check `plugin target` before continuing.

### Why not just patch the control-plane host?

You can, but you usually should not. The control-plane host is shared and may be deliberately pinned to a released version. Spinning up the branch service on its own port and pointing the CLI at it keeps your in-progress plugin work isolated, reproducible, and honest about which code it ran against. When you are done, publish the plugin as an npm package and install that form against the host you will actually ship on.

## Reload semantics, honestly

Paperclip watches the on-disk plugin package after a local install. The watcher targets the runtime entrypoints declared in the package's `paperclipPlugin` field (`dist/manifest.js`, `dist/worker.js`, `dist/ui/`).

What that means in practice:

- **Worker code:** save a `.ts` file → esbuild rewrites `dist/worker.js` → Paperclip debounces ~500ms and restarts the plugin worker. The next worker call uses the new code. There is no in-process hot module replacement for worker code; it is a worker restart.
- **Manifest:** save `src/manifest.ts` → `dist/manifest.js` rewrites → the worker restarts and the host re-reads the manifest.
- **Plugin UI:** save a `.tsx` file → esbuild rewrites `dist/ui/` → Paperclip reloads the UI bundle on its next mount. To get HMR during UI iteration, run `pnpm dev:ui` and point at the dev server with `devUiUrl` in your manifest while developing.
- **Without `pnpm dev`:** the watcher only fires on `dist/*` changes. If you stop the watch build, source edits do not reach Paperclip. Restart `pnpm dev` (or run `pnpm build` once) before expecting changes.
- **`node_modules`, `.git`, `.paperclip-sdk`, and other dotfolders are ignored.** Adding a dependency requires the new code to actually be imported and rebuilt before the worker sees it.

The package's own build scripts still own compilation. Paperclip does not compile arbitrary local-path plugins for you. The exceptions are bundled plugins inside the Paperclip repo under `packages/plugins/`: workspace packages auto-build once with `pnpm --filter <package> build`, and standalone sandbox-provider packages under `packages/plugins/sandbox-providers/` first bootstrap package-local dependencies with `pnpm install --ignore-workspace ...` and then run `pnpm build` in place. Set `PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD=1` in the server environment to disable those fallbacks.

## Local path plugins vs npm packages

Both go through the same install endpoint, but they mean different things:

- **Local path plugins are trusted local code.** Paperclip executes worker code from disk under the same trust boundary as the rest of the running instance. This is meant for developing or operating a plugin against a checkout you control. There is no signature check, no sandboxing of worker code, and no provenance metadata beyond the path. Do not install local-path plugins you did not write.
- **npm packages are the deployable artifact.** `paperclipai plugin install @acme/plugin-foo` (optionally `--version 1.2.3`) installs from your configured npm registry, version-pins, and produces an install record that other operators can reproduce. Ship plugins this way.

When you are done iterating locally, publish the package and reinstall the npm-package form so the install reflects what you will ship.

## Common things to do next

- **Restart cleanly:** `paperclipai plugin disable <key>` pauses the plugin without removing it. `paperclipai plugin enable <key>` brings it back. `paperclipai plugin uninstall <key>` removes the install record; add `--force` to also purge plugin state and settings.
- **Browse examples:** `paperclipai plugin examples` lists the bundled example plugins that ship with the repo, each with a ready-to-run `paperclipai plugin install <path>` line.
- **Go deeper:** [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md) covers worker capabilities, managed agents/projects/routines/skills, plugin database namespaces, scoped API routes, and the shared UI components in `@paperclipai/plugin-sdk/ui`. [`PLUGIN_SPEC.md`](./PLUGIN_SPEC.md) is the longer-form specification, including future ideas that are not yet implemented.
- **Routine-first automation:** If your plugin should produce periodic issue work, prefer managed routines and `ctx.routines.managed` reconciliation over custom process loops or unobserved cron code.

## Troubleshooting

- **`Plugin install returned no plugin record` or `error` status.** Run `paperclipai plugin inspect <key>` for the last error. The most common causes are (1) the plugin has not built yet — run `pnpm dev` or `pnpm build` first, (2) the `paperclipPlugin` entries in `package.json` point at files that do not exist on disk, or (3) the manifest failed validation. Bundled repo plugins may auto-build once during install, but external local-path plugins still require you to build them yourself. The Paperclip server log has the full validation error.
- **Edits do not seem to reload.** Confirm `pnpm dev` is still running and writing to `dist/`. If you renamed entry files, update the `paperclipPlugin.manifest` / `paperclipPlugin.worker` / `paperclipPlugin.ui` fields in `package.json` so the watcher targets them.
- **Worker restarts but UI is stale.** Hard-reload the page. If you want HMR, run `pnpm dev:ui` and set `devUiUrl` in your manifest to `http://127.0.0.1:4177` during development.
- **Path arguments fail on Windows.** Quote paths that contain spaces, and prefer absolute paths over `~`-prefixed paths in non-bash shells.
- **Plugin behaves as if a route or field is missing (e.g. `API route not found`, empty data, or a fallback path triggering unexpectedly).** You are probably installed into a Paperclip instance that does not run your branch code. Run `paperclipai plugin target` and compare the reported API URL and `version` against the branch service you meant to test. See [Targeting a branch / issue-workspace runtime](#targeting-a-branch--issue-workspace-runtime) to run the branch server and point the CLI at it explicitly.
