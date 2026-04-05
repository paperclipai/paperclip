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
- example UI widget using the supported `@paperclipai/plugin-sdk/ui` hooks
- test file using `@paperclipai/plugin-sdk/testing`
- `esbuild` and `rollup` config files using SDK bundler presets
- dev server script for hot-reload (`paperclip-plugin-dev-server`)

The scaffold intentionally uses plain React elements rather than host-provided UI kit components, because the current plugin runtime does not ship a stable shared component library yet.

Inside this repo, the generated package uses `@paperclipai/plugin-sdk` via `workspace:*`.

Outside this repo, the scaffold snapshots `@paperclipai/plugin-sdk` from your local Paperclip checkout into a `.paperclip-sdk/` tarball and points the generated package at that local file by default. You can override the SDK source explicitly:

```bash
node packages/plugins/create-paperclip-plugin/dist/index.js @acme/my-plugin \
  --output /absolute/path/to/plugins \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
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

## Publishing to npm

The scaffold includes `scripts/publish.mjs`, a release helper that bumps versions and publishes in one step.

```bash
pnpm release                    # patch bump (0.1.0 → 0.1.1) + publish
pnpm release -- --bump minor    # minor bump (0.1.0 → 0.2.0) + publish
pnpm release -- --bump major    # major bump (0.1.0 → 1.0.0) + publish
pnpm release -- --version 2.0.0 # explicit version + publish
pnpm release -- --dry-run       # preview without publishing
```

The helper:
- Bumps `version` in `package.json` and `src/manifest.ts` atomically so they stay in sync
- Blocks publish if local `file:` SDK dependencies are present (development-only tarballs; not resolvable by npm users)
- Delegates to `npm publish --access public` (`prepublishOnly` runs the build automatically)

Log in to npm before your first release:

```bash
npm login
```

Once published, install into Paperclip by package name:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@acme/my-plugin"}'
```
