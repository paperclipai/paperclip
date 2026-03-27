# Plugin Authoring Smoke Example

A Ironworks plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into Ironworks

```bash
pnpm ironworksai plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@ironworksai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
