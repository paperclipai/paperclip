# `@paperclipai/plugin-cloudflare-sandbox`

Published Cloudflare sandbox provider plugin for Paperclip.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. Operators can install it from the Plugins page by package name, and the host will fetch its dependencies at install time without adding lockfile churn to the Paperclip repo.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-cloudflare-sandbox
```

Configure Cloudflare from `Company Settings -> Environments`, not from the plugin's instance settings page.

## Configuration

The environment uses core `driver: "sandbox"` with `provider: "cloudflare"`.

Required fields:

- `bridgeBaseUrl`
- `bridgeAuthToken`

Important validation rules:

- `reuseLease: true` requires `keepAlive: true`
- non-local `bridgeBaseUrl` values must be `https://`
- `sessionId` is required when `sessionStrategy` is `named`

Pasted auth tokens are stored by Paperclip as company secrets because the manifest marks `bridgeAuthToken` as a `secret-ref` field.

## Bridge template

The package includes an operator-facing Cloudflare Worker scaffold under [bridge-template](./bridge-template). That template uses `@cloudflare/sandbox`, a `Sandbox` Durable Object binding, and a small JSON HTTP surface under `/api/paperclip-sandbox/v1`.

## Local development

```bash
cd packages/plugins/sandbox-providers/cloudflare
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@paperclipai/plugin-sdk` workspace package is available to the compiler during development.
