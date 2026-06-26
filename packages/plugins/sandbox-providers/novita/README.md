# `@paperclipai/plugin-novita-sandbox`

Published Novita Agent Sandbox provider plugin for Paperclip.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That means operators can install it from the Plugins page by package name, and the host will fetch its transitive dependencies at install time without adding lockfile churn to the Paperclip repo.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-novita-sandbox
```

The host plugin installer runs `npm install` into the managed plugin directory, so package dependencies such as `novita-sandbox` are pulled in during installation.

## Configuration

Configure Novita from `Instance Settings -> Environments`, not from the plugin's plugin page.

- Put the Novita API key on the sandbox environment itself.
- When you save an environment, Paperclip stores pasted API keys as company secrets.
- `NOVITA_API_KEY` remains an optional host-level fallback when an environment omits the key.

### Configuration Fields

When defining a Novita sandbox environment, the following configuration fields are supported:

| Field | Type | Description |
|-------|------|-------------|
| `domain` | string | Optional Novita domain URL. |
| `apiKey` | secret-ref | Optional Novita API key secret reference. If omitted, falls back to `NOVITA_API_KEY` from the environment. |
| `template` | string | Optional sandbox template identifier to run. |
| `requestedCwd` | string | Optional custom working directory inside the sandbox. |
| `timeoutMs` | number | Optional maximum sandbox lifetime in milliseconds. |
| `requestTimeoutMs` | number | Optional API request timeout in milliseconds. |
| `secure` | boolean | Set to `true` to use secure (HTTPS/WSS) connections. |
| `autoPause` | boolean | Set to `true` to pause the sandbox when idle. |
| `reuseLease` | boolean | Set to `true` to reuse an active sandbox lease. |

## Local development

```bash
cd packages/plugins/sandbox-providers/novita
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@paperclipai/plugin-sdk` workspace package is available to the compiler during development.

## Package layout

- `src/manifest.ts` declares the sandbox-provider driver metadata
- `src/plugin.ts` implements the environment lifecycle hooks
- `src/worker.ts` boots the plugin under the host worker runtime
- `paperclipPlugin.manifest` and `paperclipPlugin.worker` point the host at the built plugin entrypoints in `dist/`
