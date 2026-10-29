# Standalone Standalone Adapter Demo

Standalone currently proves the thin adapter boundary as a standalone package demo.
It does not install or enable the runner in a Paperclip instance. All active
implementation, documentation, tutorial, and evidence work remains under
`packages/paperclip-runner/`.

## Selection and rollback

The standalone resolver has two inputs:

- the native demo feature flag, which defaults off;
- the kill switch, which always resolves to legacy.

The default path is legacy. Native mode is selected only when the demo flag is
enabled and the kill switch is disabled. Both paths use the public
`ControlPlanePort` contract and the canonical PRP reducer.

```sh
# Default legacy path
pnpm --filter @paperclipai/paperclip-runner trace:standalone

# Native standalone path
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled

# Kill-switch rollback
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled --kill-switch enabled
```

## Standalone page

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner demo:standalone
```

Then open `http://127.0.0.1:4182/standalone-demo/`. The page exposes mode
selection, contract conformance, reducer projection, replay, finalization, and
native/legacy invocation counters. It makes no network call to Paperclip.

## Verified boundary

The package-local tracer verifies:

- identical public-port conformance for the selected demo adapter;
- ordered replay with duplicate idempotency and mutation rejection;
- canonical reducer projection through terminal success;
- idempotent result and terminal finalization;
- legacy default behavior and deterministic kill-switch rollback.

Company auth, budgets, approvals, audit, workspaces, and product persistence are
not claimed by this standalone checkpoint. Testing those concerns in a real
Paperclip instance remains outside this package and requires a separately
reviewed integration.

See the [runnable tutorial](tutorials/standalone-thin-paperclip-adapter.md).
