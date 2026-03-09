# @paperclipai/plugin-custom-agent-adapter-example

First-party reference plugin that complements the custom adapter extension point.

## Important Distinction

Per `doc/plugins/PLUGIN_SPEC.md`, **agent adapters are platform modules**, not runtime plugins.
This package demonstrates how a plugin can integrate with a custom adapter service by:

- forwarding run lifecycle events to adapter-side infrastructure
- exposing a tool for on-demand adapter health checks
- storing per-run adapter forwarding state

Use this together with `docs/adapters/creating-an-adapter.md` for the full adapter package flow.

## Local Install (Dev)

From the repo root, build the plugin and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-custom-agent-adapter-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-custom-agent-adapter-example
```

**Local development notes:**

- **Build first.** The host resolves the worker from the manifest `entrypoints.worker` (e.g. `./dist/worker.js`). Run `pnpm build` in the plugin directory before installing so the worker file exists.
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin:  
  `pnpm paperclipai plugin uninstall paperclip.custom-agent-adapter-reference --force` then  
  `pnpm paperclipai plugin install ./packages/plugins/examples/plugin-custom-agent-adapter-example`.
