# @valadrien-os/create-valadrien-os-plugin

Scaffolding tool for creating new Valadrien OS plugins.

```bash
npx @valadrien-os/create-valadrien-os-plugin my-plugin
```

Or with options:

```bash
npx @valadrien-os/create-valadrien-os-plugin @acme/my-plugin \
  --template connector \
  --category connector \
  --display-name "Acme Connector" \
  --description "Syncs Acme data into Valadrien OS" \
  --author "Acme Inc"
```

Supported templates: `default`, `connector`, `workspace`  
Supported categories: `connector`, `workspace`, `automation`, `ui`

Generates:
- typed manifest + worker entrypoint
- example UI widget using the supported `@valadrien-os/plugin-sdk/ui` hooks
- test file using `@valadrien-os/plugin-sdk/testing`
- `esbuild` and `rollup` config files using SDK bundler presets
- dev server script for hot-reload (`valadrien-os-plugin-dev-server`)

The scaffold starts with plain React elements so the generated plugin stays minimal. For Valadrien OS-native controls, import shared host components such as `MarkdownEditor`, `FileTree`, `AssigneePicker`, and `ProjectPicker` from `@valadrien-os/plugin-sdk/ui`.

Inside this repo, the generated package uses `@valadrien-os/plugin-sdk` via `workspace:*`.

Outside this repo, the scaffold snapshots `@valadrien-os/plugin-sdk` from your local Valadrien OS checkout into a `.valadrien-os-sdk/` tarball and points the generated package at that local file by default. You can override the SDK source explicitly:

```bash
node packages/plugins/create-valadrien-os-plugin/dist/index.js @acme/my-plugin \
  --output /absolute/path/to/plugins \
  --sdk-path /absolute/path/to/valadrien-os/packages/plugins/sdk
```

That gives you an outside-repo local development path before the SDK is published to npm.

## Workflow after scaffolding

```bash
cd my-plugin
pnpm install
pnpm dev       # watch worker + manifest + ui bundles
pnpm dev:ui    # local UI preview server with hot-reload events
pnpm test
```
