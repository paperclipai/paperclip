# Better Search Plugin (Example)

A Paperclip example plugin that provides deep issue search — across titles, descriptions, and comment bodies — with Human vs. AI author filtering and customizable saved presets.

## What it does

- **Deep search**: proxies the `GET /api/companies/:id/issues?q=` endpoint which searches title, identifier, description, and comments server-side.
- **Author-type badges**: each result is badged **Human** or **AI** based on the latest comment author (`authorUserId` vs `authorAgentId`), falling back to the issue creator if there are no comments.
- **Filter chips**: client-side filter by All / Human / AI Agent over the result set.
- **Issue navigation**: clicking a result navigates to the issue detail page using the host client-side router.
- **Filter presets**: save, apply, rename, and delete named search presets that persist across page reloads.

## Filter presets

Presets capture the current query string and author-type filter so you can jump back to a frequent search with a single click.

### Saving a preset

1. Type a search query in the panel. Optionally set an author-type filter.
2. A **"+ Save as preset"** chip appears in the filter row.
3. Click it, enter a name, and press **Save** (or Enter).

The preset is stored in plugin state and appears immediately in the preset row above results.

### Applying a preset

Click any preset button to apply its query + filters atomically and trigger a new search.

### Renaming a preset

Click the **⋮** menu on a preset button and select **Rename**. An inline input replaces the label; press Enter or click away to confirm. Position in the row is preserved.

### Deleting a preset

Click **⋮ → Delete…**, then **Confirm delete** to remove the preset permanently.

### Storage scope

Presets are stored **per-user** via plugin state (`ctx.state`). Each user's presets are isolated under their own key within the company scope — one user's presets are never visible to another. Presets survive page reloads and plugin worker restarts.

Each preset is serialised as:

```json
{
  "id": "<uuid>",
  "name": "My preset",
  "query": "auth bug",
  "filters": { "authorType": "human" }
}
```

The `filters` field is a forward-compatible `Record<string, unknown>`, so adding new filter dimensions in future plugin versions will not break existing saved presets.

## Slots used

| Slot | ID | Purpose |
|------|----|---------|
| `sidebar` | `better-search-sidebar` | Nav entry in the main sidebar |
| `sidebarPanel` | `better-search-panel` | Inline search panel with input + results |

## Capabilities declared

- `ui.sidebar.register`
- `issues.read`
- `issue.comments.read`
- `plugin.state.read`
- `plugin.state.write`

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
