# File Browser Example Plugin

Example Paperclip plugin that demonstrates:

- **projectSidebarItem** — A "Files" link under each project in the sidebar that opens the project detail with this plugin’s tab selected.
- **detailTab** (entityType project) — A project detail tab with a workspace-path selector, a desktop two-column layout (file tree left, editor right), and a mobile one-panel flow with a back button from editor to file tree, including save support.

## Slots

| Slot                | Type                | Description                                      |
|---------------------|---------------------|--------------------------------------------------|
| Files (sidebar)     | `projectSidebarItem`| Link under each project → project detail + tab. |
| Files (tab)         | `detailTab`         | Responsive tree/editor layout with save support.|

## Capabilities

- `ui.sidebar.register` — project sidebar item
- `ui.detailTab.register` — project detail tab
- `projects.read` — resolve project
- `project.workspaces.read` — list workspaces and read paths for file access

## Worker

- **getData `workspaces`** — `ctx.projects.listWorkspaces(projectId, companyId)` (ordered, primary first).
- **getData `fileList`** — `{ projectId, workspaceId, directoryPath? }` → list directory entries for the workspace root or a subdirectory (Node `fs`).
- **getData `fileContent`** — `{ projectId, workspaceId, filePath }` → read file content using workspace-relative paths (Node `fs`).
- **performAction `writeFile`** — `{ projectId, workspaceId, filePath, content }` → write the current editor buffer back to disk.

## Dev workflow

1. `pnpm install` (from repo root).
2. `pnpm build` in this package.
3. Install the plugin in Paperclip (Plugin Manager or local path) pointing at this package.
4. Optional: use `paperclip-plugin-dev-server` for UI hot-reload with `devUiUrl` in plugin config.

## Structure

- `src/manifest.ts` — manifest with `projectSidebarItem` and `detailTab` (entityTypes `["project"]`).
- `src/worker.ts` — data handlers for workspaces, file list, file content.
- `src/ui/index.tsx` — `FilesLink` (sidebar) and `FilesTab` (workspace path selector + two-panel file tree/editor).
