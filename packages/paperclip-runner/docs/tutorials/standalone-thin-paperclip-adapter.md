# Standalone Standalone Adapter Demo

This tutorial exercises the Standalone tracer entirely inside
`packages/paperclip-runner/`. It does not install the runner into Paperclip,
call a Paperclip API, change an instance flag, edit an agent profile, create a
Paperclip task, or use the repository server/database integration.

## 1. Run the default legacy path

From the repository root:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:standalone
```

The JSON trace must report:

- `resolvedMode: "legacy"`;
- `resolutionReason: "feature_flag_disabled"`;
- `nativeAdapterInvocationCount: 0`;
- `legacyAdapterInvocationCount: 1`;
- complete replay, reducer, and finalization summaries.

## 2. Enable the native standalone path

```sh
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled
```

The trace must report `resolvedMode: "native"`. Both paths execute the same
public `ControlPlanePort` conformance suite and reduce the same canonical PRP
events. The adapter label and invocation counters make the selected path
inspectable.

## 3. Prove the kill switch

```sh
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled --kill-switch enabled
```

The trace must return to `resolvedMode: "legacy"` with
`resolutionReason: "kill_switch_enabled"`. No native adapter invocation is
allowed after the kill switch resolves the path.

## 4. Open the standalone demo page

```sh
pnpm --filter @paperclipai/paperclip-runner demo:standalone
```

Open `http://127.0.0.1:4182/standalone-demo/`. The page starts on the legacy
path. Toggle the native demo flag, inspect contract/reducer/finalization state,
then enable the kill switch and confirm the page returns to legacy. Expand the
trace JSON to inspect replay and idempotency details.

## 5. Run the package-local checks

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/standalone/standalone-demo.test.ts \
  src/conformance/control-plane-port.test.ts
pnpm --filter @paperclipai/paperclip-runner run build:standalone
```

These checks require no running Paperclip service or credentials.

## Human checkpoint

1. Confirm the page defaults to legacy.
2. Enable the native demo flag and compare the contract and reducer panels.
3. Inspect the replay and finalization fields in the JSON trace.
4. Enable the kill switch and confirm native invocations return to zero.
5. Confirm no Paperclip instance or repository path outside
   `packages/paperclip-runner/` was needed.
