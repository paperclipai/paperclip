# @paperclipai/plugin-vault-read-bridge-example

Example plugin: a one-way read-only bridge from a local Obsidian vault
into a project-detail **Vault** tab on the live Paperclip UI. No
write-back, no auto-issue-creation, no outbound HTTP.

## What this example shows

- A `detailTab` slot plus a `projectSidebarItem` slot on the project
  detail page.
- A worker that exposes three `data` callbacks (`vault-project-view`,
  `vault-note-body`, `vault-health`) driven only by persisted vault
  state.
- A pure `vault-read.ts` helper module that owns wikilink resolution,
  frontmatter parsing, relevance scoring, and redaction.
- A read-only `localFolders` declaration plus a contract-level lint
  test that asserts the worker never references `writeTextAtomic`,
  `deleteFile`, or `localFolders.write*`.
- An operator-controlled `showSidebarLink` config flag that gates the
  optional sidebar item.

## Capabilities

```
companies.read
projects.read
issues.read
local.folders             # declared as access: "read" only at configure time
plugin.state.read
plugin.state.write
ui.detailTab.register
ui.sidebar.register
```

The plugin's only writes are to its own `plugin.state` cursor store —
never to Paperclip issues, comments, documents, or activity; never to
the vault.

## Vault folder declaration

```ts
localFolders: [
  {
    folderKey: "vault-root",
    displayName: "Obsidian Vault",
    description: "Local Obsidian vault root; declared access: read-only.",
    access: "read",
    requiredDirectories: [],
    requiredFiles: ["VAULT-MANIFEST.md"],
  },
],
```

## Slot registration

```ts
ui: {
  slots: [
    {
      type: "detailTab",
      id: "vault-tab",
      displayName: "Vault",
      exportName: "VaultTab",
      entityTypes: ["project"],
      order: 30,
    },
    {
      type: "projectSidebarItem",
      id: "vault-link",
      displayName: "Vault",
      exportName: "VaultLink",
      entityTypes: ["project"],
      order: 30,
    },
  ],
}
```

## Local verification

- `pnpm --filter @paperclipai/plugin-vault-read-bridge-example typecheck`
  passes.
- `pnpm --filter @paperclipai/plugin-vault-read-bridge-example test`
  passes and covers vault relevance scoring, redaction detection,
  wikilink resolution, and the contract-level lint that asserts the
  worker and UI never reference vault write APIs.
- `pnpm --filter @paperclipai/plugin-vault-read-bridge-example build`
  produces the manifest, worker, and UI bundles under `dist/`.

## Companion example

See `@paperclipai/plugin-pixel-strip-example` for a second example
that demonstrates the read-only runtime-derived UI surface pattern.
