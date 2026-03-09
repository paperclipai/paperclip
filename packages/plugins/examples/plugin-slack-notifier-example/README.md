# @paperclipai/plugin-slack-notifier-example

First-party reference plugin showing event-driven Slack notifications.

## What It Demonstrates

- subscribing to agent/issue/approval events
- resolving a webhook URL from secrets
- outbound webhook requests to Slack
- metrics + activity logging from plugin workers
- simple config-driven event filtering

## Local Install (Dev)

From the repo root, build the plugin and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-slack-notifier-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-slack-notifier-example
```

**Local development notes:**

- **Build first.** The host resolves the worker from the manifest `entrypoints.worker` (e.g. `./dist/worker.js`). Run `pnpm build` in the plugin directory before installing so the worker file exists.
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin:  
  `pnpm paperclipai plugin uninstall paperclip.slack-notifier --force` then  
  `pnpm paperclipai plugin install ./packages/plugins/examples/plugin-slack-notifier-example`.
