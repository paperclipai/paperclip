---
name: paperclip-create-plugin
description: >
  Create and develop external Paperclip plugins with the CLI-first workflow.
  Use when scaffolding a new plugin, working on a local plugin against a running
  Paperclip instance, or updating plugin authoring docs. Covers `paperclipai
  plugin init`, the local install loop via `paperclipai plugin install <path>`,
  worker/UI rebuild and reload semantics, and the required success checklist.
---

# Create and develop a Paperclip plugin

Use this skill when the task is to create, scaffold, or iterate on a Paperclip plugin against a local Paperclip instance.

## 1. Default: build the plugin OUTSIDE Paperclip core

Plugins are their own packages. Unless the task **explicitly** asks for a bundled in-repo example, do not add plugin source under `packages/plugins/` in this repo.

- Scaffold the plugin into a directory outside the Paperclip checkout (e.g. `~/dev/paperclip-plugins/<name>`).
- Install it into the running Paperclip instance by local absolute path.
- Edit code in the external package; let Paperclip pick up rebuilt output.

Only edit Paperclip core itself when the user asks to surface a plugin as a bundled example (`server/src/routes/plugins.ts`, in-repo example lists, docs).

## 2. Ground rules

Reference docs when you need detail:

1. `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
2. `packages/plugins/sdk/README.md`
3. `doc/plugins/PLUGIN_SPEC.md` — future-looking context only

Current runtime assumptions:

- plugin workers are trusted code
- plugin UI is trusted same-origin host code
- worker APIs are capability-gated
- plugin UI is not sandboxed by manifest capabilities
- no host-provided shared plugin UI component kit yet
- `ctx.assets` is not supported in the current runtime

## 3. CLI-first scaffold workflow

Use `paperclipai plugin init`. Do not invoke the scaffold package node entrypoint by hand unless the CLI command is unavailable in the environment.

```bash
paperclipai plugin init @acme/my-plugin --output ~/dev/paperclip-plugins
```

Useful flags (all optional):

- `--output <dir>` — parent directory; the command creates `<dir>/<unscoped-name>/`. Defaults to the current directory.
- `--template <default|connector|workspace|environment>` — starter template.
- `--category <connector|workspace|automation|ui|environment>` — manifest category.
- `--display-name <name>`, `--description <text>`, `--author <name>` — manifest metadata.
- `--sdk-path <path>` — snapshot the local SDK from a Paperclip checkout into `.paperclip-sdk/` (useful when developing against an unreleased SDK).

On success the command prints the exact next commands (`cd`, `pnpm install`, `pnpm dev`, `paperclipai plugin install <abs-path>`). Run them in order.

If `paperclipai` is not on PATH in your environment, fall back to:

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js @acme/my-plugin \
  --output /absolute/path \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

## 4. Local install + rebuild loop

In the scaffolded plugin folder:

```bash
pnpm install
pnpm dev            # esbuild --watch: rebuilds dist/manifest.js, dist/worker.js, dist/ui/
paperclipai plugin install /absolute/path/to/my-plugin
```

Notes:

- `paperclipai plugin install` auto-detects local paths (absolute, `./`, `../`, `~`, or an existing relative folder) and forwards `isLocalPath: true` to the server. Pass `--local` to force local mode if the heuristic is ambiguous.
- Paths are resolved to absolute paths before being sent to the server.
- The server watches built outputs (`dist/`) for local-path plugins and restarts the plugin worker on rebuild — you do not need to reinstall after every edit.
- UI hot reload via the SDK dev server (`pnpm dev:ui`, port `4177`) is optional and template-dependent; only mention it if the template wires `devUiUrl` and you verified it works end to end.
- `--version` only applies to npm package installs. Combining it with a local path is an error.

After install, inspect with:

```bash
paperclipai plugin list
paperclipai plugin inspect <plugin-key>
```

## 5. After scaffolding, sanity-check the package

Open and confirm:

- `src/manifest.ts` — declared capabilities and slots
- `src/worker.ts` — worker entry
- `src/ui/index.tsx` — UI entry (if applicable)
- `tests/plugin.spec.ts` — placeholder test
- `package.json` — `paperclipPlugin` block points at `dist/manifest.js`, `dist/worker.js`, `dist/ui/`

Make sure the plugin:

- declares only supported capabilities
- does not use `ctx.assets`
- does not import host UI component stubs
- keeps UI self-contained
- uses `routePath` only on `page` slots

## 6. Verification (run before declaring success)

From the plugin folder:

```bash
pnpm typecheck
pnpm test
pnpm build
```

If the plugin is already running under `pnpm dev`, you can keep the watcher up and run `pnpm typecheck` and `pnpm test` in a separate shell.

If you changed Paperclip SDK/host/plugin runtime code in addition to the plugin, also run the relevant Paperclip workspace checks.

## 7. Success checklist (report this back)

When you finish a local plugin task, report:

- **Scaffold path** — absolute path of the created plugin folder.
- **Commands run** — the exact `paperclipai plugin init`, `pnpm install`, `pnpm dev`, `paperclipai plugin install <path>` invocations (and any verification commands).
- **Install status** — output of `paperclipai plugin list` / `plugin inspect` (plugin key, version, status). Note if `status` is anything other than `ready` and include `lastError`.
- **Tests / build result** — `pnpm typecheck`, `pnpm test`, `pnpm build` pass/fail with the failing output if any.
- **Reload limitations** — call out anything that did not hot-reload (e.g. manifest changes required a reinstall, UI dev server was not wired, etc.).

If any item is missing, mark it as such — do not silently skip.

## 8. When NOT to edit Paperclip core

Do not add the plugin under `packages/plugins/` or update bundled-example wiring unless the user explicitly asks for a bundled example. Local-path installs are the supported development model; npm packages are the production deployment path.

If the user does ask for a bundled example, also update:

- `server/src/routes/plugins.ts` example list
- any docs that enumerate in-repo example plugins

## 9. Documentation expectations

When authoring or updating plugin docs:

- distinguish current implementation from future spec ideas
- be explicit about the trusted-code model
- do not promise host UI components or asset APIs
- prefer local-path development + npm-package deployment guidance over repo-local workflows
