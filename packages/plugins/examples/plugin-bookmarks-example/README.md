# @paperclipai/plugin-bookmarks-example

A first-party example plugin that adds a small but real product surface to Paperclip: a
company-scoped bookmark library backed by a plugin database namespace and a local markdown
folder.

The package is a follow-up to the core plugin host surface work and is intended as a
focused reference for plugin authors. The orchestration smoke example remains the
acceptance fixture for the orchestration APIs; this plugin is the user-facing
counterpart that exercises the broader UI + storage surface.

## Surfaces exercised

- **Plugin database namespace.** A migration creates a `bookmarks` table inside the
  plugin's restricted Postgres schema. The worker reads and writes only that
  namespace; the restricted SQL helpers prevent cross-namespace access.
- **Local folders.** A `bookmarks-root` folder declaration is configured by the
  operator and atomically receives one markdown file per bookmark via
  `ctx.localFolders.writeTextAtomic`. The DB row remains the source of truth so
  list and delete operations stay correct even when the folder is unconfigured
  or the disk write fails.
- **Scoped API routes.** Three plugin-owned routes (`list`, `create`, `delete`)
  declare board-or-agent auth and resolve the company from query/body
  parameters before the worker sees them.
- **UI extension slots.** A full plugin page, a sidebar entry, a dashboard
  widget, and a settings page are all wired up to the same worker handlers via
  `usePluginData` / `usePluginAction`.

## Install

```sh
pnpm --filter @paperclipai/plugin-bookmarks-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-bookmarks-example
```

After install, configure the plugin's `bookmarks-root` local folder under the
plugin's Folders settings to enable the markdown sidecar files. The plugin works
without it (rows live in the database namespace), but operators that want
shareable, file-backed snapshots should point the folder at a checked-in
directory.

## Development

```sh
pnpm --filter @paperclipai/plugin-bookmarks-example test
pnpm --filter @paperclipai/plugin-bookmarks-example typecheck
pnpm --filter @paperclipai/plugin-bookmarks-example build
```

The worker code uses module-scoped handler closures populated in `setup()`,
mirroring the orchestration smoke example, so the handlers can be invoked from
both `ctx.data` / `ctx.actions` (UI) and `onApiRequest` (HTTP) without
duplicating logic.
