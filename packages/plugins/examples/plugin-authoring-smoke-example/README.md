# Plugin Authoring Smoke Example

A Paperclip plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into Paperclip

```bash
pnpm paperclipai plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

## Publishing to npm

Plugins scaffolded with `create-paperclip-plugin` include a `scripts/publish.mjs` release helper that bumps versions and publishes in one step:

```bash
pnpm release                    # patch bump (0.1.0 → 0.1.1) + publish
pnpm release -- --bump minor    # minor bump
pnpm release -- --bump major    # major bump
pnpm release -- --version 2.0.0 # explicit version
pnpm release -- --dry-run       # preview without publishing
```

The helper:
- Bumps `version` in `package.json` and `src/manifest.ts` atomically
- Blocks publish if local `file:` SDK dependencies are present (development-only tarballs; not resolvable by npm users)
- Delegates to `npm publish --access public` (`prepublishOnly` runs the build automatically)

The `package.json` also includes:
- `"files": ["dist/"]` — only built output is included in the published package
- `"prepublishOnly": "pnpm run build"` — builds automatically before every publish

Before publishing your own plugin:

1. Remove `"private": true` from `package.json` (this example keeps it private since it is a reference implementation).
2. Log in to npm: `npm login`
3. Run `pnpm release` (or `pnpm release -- --dry-run` to preview first).

Once published, install into Paperclip by package name:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@acme/my-plugin"}'
```
