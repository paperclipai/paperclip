# @paperclipai/plugin-hello-world-example

First-party reference plugin showing the smallest possible UI extension.

## What It Demonstrates

- a manifest with a `dashboardWidget` UI slot
- `entrypoints.ui` wiring for plugin UI bundles
- a minimal React widget rendered in the Paperclip dashboard
- reading host context (`companyId`) from `PluginWidgetProps`
- worker lifecycle hooks (`setup`, `onHealth`) for basic runtime observability

## API Surface

- This example does not add custom HTTP endpoints.
- The widget is discovered/rendered through host-managed plugin APIs (for example `GET /api/plugins/ui-contributions`).

## Notes

This is intentionally simple and is designed as the quickest "hello world" starting point for UI plugin authors.
It is a repo-local example plugin for development, not a plugin that should be assumed to ship in generic production builds.

## Local Install (Dev)

From the repo root, build the plugin and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-hello-world-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-hello-world-example
```

**Local development notes:**

- **Build first.** The host resolves the worker from the manifest `entrypoints.worker` (e.g. `./dist/worker.js`). Run `pnpm build` in the plugin directory before installing so the worker file exists.
- **Dev-only install path.** This local-path install flow assumes a source checkout with this example package present on disk. For deployed installs, publish an npm package instead of relying on the monorepo example path.
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin:  
  `pnpm paperclipai plugin uninstall paperclip.hello-world-example --force` then  
  `pnpm paperclipai plugin install ./packages/plugins/examples/plugin-hello-world-example`.
