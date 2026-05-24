# Plugin Authoring Smoke Example

A ValAdrien OS plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into ValAdrien OS

```bash
pnpm valadrien-os plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@valadrien-os/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
