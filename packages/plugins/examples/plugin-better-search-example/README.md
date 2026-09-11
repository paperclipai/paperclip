# Better Search Plugin (Example)

A Paperclip example plugin that provides deep issue search — across titles, descriptions, and comment bodies — with Human vs. AI author filtering.

## What it does

- **Deep search**: proxies the `GET /api/companies/:id/issues?q=` endpoint which searches title, identifier, description, and comments server-side.
- **Author-type badges**: each result is badged **Human** or **AI** based on the latest comment author (`authorUserId` vs `authorAgentId`), falling back to the issue creator if there are no comments.
- **Filter chips**: client-side filter by All / Human / AI Agent over the result set.
- **Issue navigation**: clicking a result navigates to the issue detail page using the host client-side router.

## Slots used

| Slot | ID | Purpose |
|------|----|---------|
| `sidebar` | `better-search-sidebar` | Nav entry in the main sidebar |
| `sidebarPanel` | `better-search-panel` | Inline search panel with input + results |

## Capabilities declared

- `ui.sidebar.register`
- `issues.read`
- `issue.comments.read`

## Build

```bash
pnpm install
pnpm run build
```

Output lands in `dist/`.

## Install in a local Paperclip instance

In the Paperclip admin or plugin settings, load the plugin from the built package:

```
packages/plugins/examples/plugin-better-search-example
```

The `paperclipPlugin` field in `package.json` points to the built manifest, worker, and UI.

## Uninstall

Remove the plugin from the Paperclip plugin settings page. No core changes are needed.

## Notes

The `q` parameter is not currently declared in the plugin SDK's `issues.list` TypeScript protocol, but the underlying service accepts it (via the `as any` passthrough in `plugin-host-services.ts`). The cast in `worker.ts` is intentional — see the inline comment.
