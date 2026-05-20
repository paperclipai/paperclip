# `@paperclipai/plugin-e2b`

Published E2B sandbox provider plugin for Paperclip.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That means operators can install it from the Plugins page by package name, and the host will fetch its transitive dependencies at install time without adding lockfile churn to the Paperclip repo.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-e2b
```

The host plugin installer runs `npm install` into the managed plugin directory, so package dependencies such as `e2b` are pulled in during installation.

## Configuration

Configure E2B from `Company Settings -> Environments`, not from the plugin's instance settings page.

- Put the E2B API key on the sandbox environment itself.
- When you save an environment, Paperclip stores pasted API keys as company secrets.
- `E2B_API_KEY` remains an optional host-level fallback when an environment omits the key.

## Local development

```bash
cd packages/plugins/sandbox-providers/e2b
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@paperclipai/plugin-sdk` workspace package is available to the compiler during development.

## Package layout

- `src/manifest.ts` declares the sandbox-provider driver metadata
- `src/plugin.ts` implements the environment lifecycle hooks
- `paperclipPlugin.manifest` and `paperclipPlugin.worker` point the host at the built plugin entrypoints in `dist/`
