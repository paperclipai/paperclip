# @paperclipai/create-paperclip-plugin

Scaffolding tool for creating new Paperclip plugins.

```bash
npx @paperclipai/create-paperclip-plugin my-plugin
```

Or with options:

```bash
npx @paperclipai/create-paperclip-plugin @acme/my-plugin \
  --template connector \
  --category connector \
  --display-name "Acme Connector" \
  --description "Syncs Acme data into Paperclip" \
  --author "Acme Inc"
```

Supported templates: `default`, `connector`, `workspace`  
Supported categories: `connector`, `workspace`, `automation`, `ui`

Generates:
- typed manifest + worker entrypoint
- example UI widget using `@paperclipai/plugin-sdk/ui`
- test file using `@paperclipai/plugin-sdk/testing`
- `esbuild` and `rollup` config files using SDK bundler presets
- dev server script for hot-reload (`paperclip-plugin-dev-server`)

## Workflow after scaffolding

```bash
cd my-plugin
pnpm install
pnpm dev       # watch worker + manifest + ui bundles
pnpm dev:ui    # local UI preview server with hot-reload events
pnpm test
```
