# @paperclipai/adapter-bob-shell (reference package)

Paperclip adapter for [IBM Bob Shell](https://bob.ibm.com/) (`bob run --non-interactive`).

## How users get this adapter

`bob_shell` is an **external adapter**. It is not a built-in adapter.
Paperclip does not register it in `server`, `cli`, or `ui`, and no published
Paperclip package depends on it. This follows the external adapter model in
[`docs/adapters/external-adapters.md`](../../../docs/adapters/external-adapters.md).

Users install the adapter at runtime, from the Paperclip UI or API, with the
distributable package in
[ludovic-gasc/paperclip-adapter-bob-shell](https://github.com/ludovic-gasc/paperclip-adapter-bob-shell):

```sh
git clone https://github.com/ludovic-gasc/paperclip-adapter-bob-shell
cd paperclip-adapter-bob-shell
npm install && npm run build

curl -X POST http://localhost:3100/api/adapters/install \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "/absolute/path/to/paperclip-adapter-bob-shell", "isLocalPath": true}'
```

The package root exports `createServerAdapter()`. This is the entry point
that the Paperclip adapter plugin loader calls.

## Why this directory exists

This directory is the in-tree **reference source** for the adapter. It lets
Paperclip CI run the adapter unit tests (`pnpm vitest run --project
@paperclipai/adapter-bob-shell`) and typecheck the code against the current
`@paperclipai/adapter-utils` contract.

Release rules for this directory:

- `"private": true`. Paperclip does not publish this package from the monorepo.
- It has no entry in `scripts/release-package-manifest.json`.
- `server`, `cli`, and `ui` do not list it as a dependency.
- The `Dockerfile` copies its `package.json` only so that pnpm sees the whole
  workspace during the dependency stage.
