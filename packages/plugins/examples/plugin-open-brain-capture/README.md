# Open Brain Capture

Automatically captures thoughts to open-brain on issue lifecycle events

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```



## Install Into Paperclip

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"C:/apps/paperclip/packages/plugins/examples/plugin-open-brain-capture","isLocalPath":true}'
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
