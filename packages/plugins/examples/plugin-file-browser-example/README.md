# Workspace Explorer Plugin

Workspace Explorer turns the original file-browser example into a practical project workspace surface.

- **projectSidebarItem** — An optional "Workspace" link under each project in the sidebar that opens the project detail with this plugin’s tab selected.
- **detailTab** (entityType project) — A project detail tab with workspace selection, file browsing, inline editing, quick creation of files/folders, metadata, and mobile-safe navigation.
- **comment surfaces** — File links mentioned in comments can open the matching file directly in the workspace tab.

The package name remains the same for compatibility with existing installs.

## Slots

| Slot                | Type                | Description                                      |
|---------------------|---------------------|--------------------------------------------------|
| Workspace (sidebar) | `projectSidebarItem`| Optional link under each project → project detail + tab. |
| Workspace (tab)     | `detailTab`         | Responsive tree/editor layout with save and creation flows.|

## Settings

- `Show Workspace in Sidebar` — toggles the project sidebar link on or off. Defaults to off.
- `Comment File Links` — controls whether comment annotations and the comment context-menu action are shown.

## Capabilities

- `ui.sidebar.register` — project sidebar item
- `ui.detailTab.register` — project detail tab
- `projects.read` — resolve project
- `project.workspaces.read` — list workspaces and read paths for file access

## Worker

- **getData `workspaces`** — `ctx.projects.listWorkspaces(projectId, companyId)` (ordered, primary first).
- **getData `fileList`** — `{ projectId, workspaceId, directoryPath? }` → list directory entries plus metadata (type, size, extension, updatedAt).
- **getData `fileContent`** — `{ projectId, workspaceId, filePath }` → read text file content with guards for binary files and oversized files.
- **performAction `writeFile`** — `{ projectId, workspaceId, filePath, content }` → write the current editor buffer back to disk.
- **performAction `createFile`** — create a new file within the selected workspace.
- **performAction `createDirectory`** — create a new folder within the selected workspace.

## Local Install (Dev)

From the repo root, build the plugin and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-file-browser-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-file-browser-example
```

To uninstall:

```bash
pnpm paperclipai plugin uninstall paperclip-file-browser-example --force
```

**Local development notes:**

- **Build first.** The host resolves the worker from the manifest `entrypoints.worker` (e.g. `./dist/worker.js`). Run `pnpm build` in the plugin directory before installing so the worker file exists.
- **Dev-only install path.** This local-path install flow assumes this monorepo checkout is present on disk. For deployed installs, publish an npm package instead of depending on `packages/plugins/examples/...` existing on the host.
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin.
- Optional: use `paperclip-plugin-dev-server` for UI hot-reload with `devUiUrl` in plugin config.

## Structure

- `src/manifest.ts` — manifest with `projectSidebarItem` and `detailTab` (entityTypes `["project"]`).
- `src/worker.ts` — data handlers for workspaces, file list, file content.
- `src/ui/index.tsx` — `FilesLink` (sidebar) and `FilesTab` (workspace path selector + two-panel file tree/editor).

## Maintainer

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## License

Distributed under the repository MIT license. See `/Users/monrars/paperclip/LICENSE`.
