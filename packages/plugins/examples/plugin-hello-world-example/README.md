# @paperclipai/plugin-hello-world-example

Company Pulse is a lightweight operational widget for the Paperclip dashboard.

The package name is kept for compatibility with existing installs, but the plugin now behaves like a real dashboard surface instead of a scaffold-only example.

## What It Adds

- a `dashboardWidget` that summarizes company workload
- worker-backed data loading for projects, issues, goals, and agents
- company-scoped operational counts directly inside the dashboard
- a compact widget suitable for daily operator use

## API Surface

- `getData company-pulse` loads current company totals for:
  - projects
  - issues and open issues
  - goals and active goals
  - agents and active agents
- The widget is discovered/rendered through host-managed plugin APIs such as `GET /api/plugins/ui-contributions`.

## Notes

This remains a repo-local plugin package, but it is now a useful operational surface rather than a placeholder. It works best as a simple dashboard summary for operators who want company health at a glance.

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

## Maintainer

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## License

Distributed under the repository MIT license. See `/Users/monrars/paperclip/LICENSE`.
