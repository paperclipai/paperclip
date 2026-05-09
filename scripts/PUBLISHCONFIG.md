# publishConfig at pack time — fork-build packaging note (PLA-298)

## Why this exists

Every public workspace under `packages/`, `server/`, `ui/` declares its
`exports`/`main`/`types` to point at TypeScript sources (`./src/index.ts`)
so that local development with `tsx` and `pnpm -r build` works without an
intermediate compile step. The `publishConfig` block on each
`package.json` overrides those fields to point at the compiled
`./dist/index.js` for the published manifest.

**`npm pack` does not apply `publishConfig` — only `npm publish` does.**
`pnpm publish` and `pnpm pack` apply it, but the fork-build flow uses
`npm pack` for some packages (and the historical fork-build pipeline mixed
both packers). Either way: relying on the packer to apply `publishConfig`
is fragile and bit us in fork-build-1.

## What broke (fork-build-1, 2026-05-08 ~16:11Z)

`fork-build-1` shipped tarballs whose inner `package.json` files declared
`exports → ./src/index.ts`. The host imported `@paperclipai/server` from
the installed tarball, Node attempted to load the unbuilt `src/index.ts`,
and the runtime crashed (Bad Gateway). `fork-build-2` was unblocked by
**manually** rewriting each tarball's inner `package.json` post-pack to
apply the `publishConfig` override. That manual rewrite lived nowhere in
source — every fork-build cut had to reproduce the hack.

## The fix (committed)

`scripts/pack-public-packages.mjs` discovers every public workspace
package, applies `publishConfig` deep-merge to a temporary
`package.json`, runs `pnpm pack` (or `npm pack`), and restores the
original `package.json` whether pack succeeds, fails, or is interrupted.

The script intentionally:

- **Skips `paperclipai` (CLI)** — `scripts/build-npm.sh` already
  generates a fully-replaced publishable `cli/package.json` via
  `scripts/generate-npm-package-json.mjs`, so re-applying `publishConfig`
  there would clobber that step.
- **Drops registry-only directives** (`access`, `registry`, `tag`) from
  the published manifest. Those are publish-time directives, not manifest
  fields, and `npm publish` strips them — we mirror that behaviour.
- **Restores `package.json` even on SIGINT** so a Ctrl-C mid-pack does
  not leave the workspace in a broken state.

## Usage

```bash
# Pack every public workspace (CLI excluded by default) into ./out/
node scripts/pack-public-packages.mjs --out ./out

# Pack a single package
node scripts/pack-public-packages.mjs --out ./out --include @paperclipai/server

# Use npm instead of pnpm as the packer
node scripts/pack-public-packages.mjs --out ./out --packer npm
```

## Verification

```bash
# AC2 — packed tarball exports point to compiled paths
tar -xzOf out/paperclipai-server-*.tgz package/package.json | jq '.exports'
# {".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}

# AC3 — sandbox install: import "@paperclipai/server" resolves to dist/index.js
mkdir /tmp/sandbox && cd /tmp/sandbox
npm init -y && npm install /path/to/out/paperclipai-server-*.tgz
node -e "console.log(require('@paperclipai/server/package.json').main)"
# ./dist/index.js
```

The script runs in `node --test` against
`scripts/pack-public-packages.test.mjs` to guard the merge semantics.

## When to update

Any time a public workspace gains a `publishConfig` field with a key not
already covered by `applyPublishConfig`, add a focused test in
`pack-public-packages.test.mjs` so the merge contract stays explicit.
