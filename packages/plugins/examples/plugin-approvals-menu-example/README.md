# @paperclipai/plugin-approvals-menu-example

Reference plugin that adds an **Approvals** entry to the application sidebar
(beside Inbox) with a pending-count badge, plus a dedicated pending-approvals
list page mounted at `/<companyPrefix>/approvals-menu`.

## What It Demonstrates

- a manifest with `sidebar` and `page` UI slots
- `entrypoints.ui` wiring for plugin UI bundles
- reading host context (`companyId`, `companyPrefix`) from `PluginSidebarProps` / `PluginPageProps`
- worker `setup` handler exposing plugin config through `ctx.data.register`
- reading effective config from the UI side via `usePluginData("plugin-config")`
- same-origin `fetch` against the host approvals API for read-only data

## Configuration

The instance config schema declares three operator-tunable values:

| Key | Default | Effect |
|---|---|---|
| `refreshIntervalSeconds` | `60` | Sidebar badge + list page poll cadence. `0` disables polling. |
| `showBadge` | `true` | Whether to render the pending-count pill on the sidebar. |
| `listLimit` | `50` | Max rows rendered on the list page. The host approvals API does not accept a `limit` query parameter, so the cap is applied client-side after the response. |

## Behaviour Notes

- **Sidebar link target.** The sidebar entry navigates to the plugin's own page
  (`/<companyPrefix>/approvals-menu`), not to the core `/approvals/pending`
  route. The plugin page slot is the canonical destination for this plugin.
- **Non-board user fallback.** If the approvals API responds with `401`, `403`
  or `404` (typical for an authenticated user without board access), the
  sidebar entry hides itself and the page renders a neutral "not available"
  state — never a red error alert.
- **Read-only.** This iteration does not implement inline approve / reject. The
  list deep-links each row to the core approval detail page where the action
  buttons live.

## Local Install (Dev)

From the repo root:

```bash
pnpm --filter @paperclipai/plugin-approvals-menu-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-approvals-menu-example
```

**Local development notes:**

- **Build first.** The host resolves the worker from the manifest's `entrypoints.worker` (`./dist/worker.js`). Run `pnpm build` before installing so the worker file exists.
- **Dev-only install path.** This local-path install flow assumes a source checkout with this example package present on disk. For deployed installs, publish an npm package instead of relying on the monorepo example path.
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin:
  `pnpm paperclipai plugin uninstall paperclip.approvals-menu-example --force` then
  `pnpm paperclipai plugin install ./packages/plugins/examples/plugin-approvals-menu-example`.
