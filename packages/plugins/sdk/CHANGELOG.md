# @paperclipai/plugin-sdk

## Unreleased

### Minor Changes

- feat: new optional plugin hook `onBeforeAdapterExecute`.

  Invoked by the host immediately before an agent's adapter is executed.
  Plugins use it to observe pending runs and optionally modify the adapter's
  runtime configuration — the canonical use case is injecting environment
  variables that reroute egress traffic through a proxy (PII-proxy,
  observability-gateway, etc.).

  Return value shape:
  - Omit or return `undefined` to leave the run unchanged.
  - Return `{ env }` to merge env vars into the adapter subprocess (highest-priority override).
  - Return `{ runtimeConfig }` for broader config overrides (use sparingly).
  - Return `{ block }` to abort the run before the adapter is called. The host marks the run failed with the provided reason and skips subsequent plugins' hooks.

  The host invokes registered hooks in insertion order across all installed
  plugins. Results are merged shallow — later plugins override earlier ones
  for identical env keys. The first `block` wins.

  Plugins MUST NOT log or persist the input payload verbatim: it contains
  fully resolved secrets and internal identifiers. Treat it as sensitive.

- New public types exported from `@paperclipai/plugin-sdk`:
  - `BeforeAdapterExecuteParams`
  - `BeforeAdapterExecuteResult`

- New RPC method `beforeAdapterExecute` added to `HostToWorkerMethods` and
  `HOST_TO_WORKER_OPTIONAL_METHODS`. Workers that implement the hook will
  report `beforeAdapterExecute` in their `initialize` response's
  `supportedMethods` so the host can broadcast accordingly.

## 1.0.0

Initial stable release.
