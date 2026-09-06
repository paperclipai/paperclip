# @paperclipai/plugin-pixel-strip-example

Example plugin: a read-only project-detail pixel strip that maps persisted
Paperclip runtime state onto semantic sprite states. No animation that
implies work. No timer-derived activity inference. No write-back.

## What this example shows

- A `detailTab` slot plus a `projectSidebarItem` slot on the project
  detail page.
- A worker that exposes two `data` callbacks (`pixel-strip` and
  `pixel-strip-agent-state`) driven only by persisted runtime state.
- A pure `pixel-state.ts` helper module that owns the state mapping
  and is fully unit-tested.
- A read-only capability surface: no `*.create`, `*.update`,
  `*.write`, or `*.delete` capability is requested.
- An operator-controlled `showSidebarLink` config flag that gates the
  optional sidebar item.

## Sprite states

| State           | Label           | Token        |
| --------------- | --------------- | ------------ |
| `working`       | `WORKING`       | `working`    |
| `waiting`       | `WAITING`       | `waiting`    |
| `blocked`       | `BLOCKED`       | `blocked`    |
| `decision_ready`| `DECISION_READY`| `owner-gate` |
| `idle`          | `IDLE`          | `verified`   |

The mapping is deterministic and depends only on the persisted issue
snapshot — issue lifecycle status, current assignee, agent heartbeat
status, and the existence of pending
`ask_user_questions` / `request_confirmation` interactions. No wall
clock is read.

## Capabilities

```
companies.read
projects.read
issues.read
agents.read
events.subscribe
plugin.state.read
plugin.state.write
ui.detailTab.register
ui.sidebar.register
```

The plugin emits zero writes; this is enforced by capability surface,
not by code review alone.

## Slot registration

```ts
ui: {
  slots: [
    {
      type: "detailTab",
      id: "pixel-strip-tab",
      displayName: "Pixel Strip",
      exportName: "PixelStripTab",
      entityTypes: ["project"],
      order: 20,
    },
    {
      type: "projectSidebarItem",
      id: "pixel-strip-link",
      displayName: "Pixel Strip",
      exportName: "PixelStripLink",
      entityTypes: ["project"],
      order: 20,
    },
  ],
}
```

## Local verification

- `pnpm --filter @paperclipai/plugin-pixel-strip-example typecheck`
  passes.
- `pnpm --filter @paperclipai/plugin-pixel-strip-example test` passes
  and covers sprite-state derivation against fixture runtime state.
- `pnpm --filter @paperclipai/plugin-pixel-strip-example build`
  produces the manifest, worker, and UI bundles under `dist/`.
- The bundled UI renders a single row of pixel sprites that mirror
  the runtime truth; the tests assert the mapping.

## Companion example

See `@paperclipai/plugin-vault-read-bridge-example` for a second
example that demonstrates the `localFolders` read-only bridge pattern.
