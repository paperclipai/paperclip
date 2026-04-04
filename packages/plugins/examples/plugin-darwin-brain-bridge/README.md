# @paperclipai/plugin-darwin-brain-bridge

Phase 1 Paperclip plugin that exposes Darwin Brain semantic memory to agents.

It registers four tools:

- `darwin.search`
- `darwin.searchTenant`
- `darwin.store`
- `darwin.info`

It resolves tenant namespace and access policy from plugin instance config and
fails closed when tenant-scoped actions are not configured.

## Build

```sh
pnpm --filter @paperclipai/plugin-darwin-brain-bridge build
```

## Test

```sh
pnpm --filter @paperclipai/plugin-darwin-brain-bridge test
```

## Install

```sh
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-darwin-brain-bridge
```
