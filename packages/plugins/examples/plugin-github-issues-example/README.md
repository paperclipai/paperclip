# @paperclipai/plugin-github-issues-example

First-party reference plugin showing how to sync Paperclip issues with GitHub Issues.

## What It Demonstrates

- event subscriptions (`issue.created`, `issue.updated`)
- scheduled sync/backfill jobs
- secret resolution + outbound HTTP calls
- plugin state for per-issue sync markers
- agent tool registration for integration lookups

## Notes

This is a reference implementation and intentionally keeps mutation behavior conservative.

## Local Install (Dev)

From the repo root, build the plugin and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-github-issues-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-github-issues-example
```

**Local development notes:**

- **Build first.** The host resolves the worker from the manifest `entrypoints.worker` (e.g. `./dist/worker.js`). Run `pnpm build` in the plugin directory before installing so the worker file exists.
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin:  
  `pnpm paperclipai plugin uninstall paperclip.github-issues --force` then  
  `pnpm paperclipai plugin install ./packages/plugins/examples/plugin-github-issues-example`.
