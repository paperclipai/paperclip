# `@paperclipai/plugin-modal`

First-party Modal sandbox provider plugin for Paperclip.

Like the other sandbox-provider packages in this repo, it lives inside the Paperclip monorepo but is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That lets operators install it from the Plugins page by package name without introducing root lockfile churn for Modal's SDK dependencies.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-modal
```

The host plugin installer runs `npm install` into the managed plugin directory, so the `modal` SDK dependency is pulled in during installation.

## Runtime support note

Modal's official JS SDK README pins support to **Node 22 or later**. Paperclip's repo baseline is currently `node >= 20`; empirically `modal@0.7.4` imports and operates against the Modal API under Node 20, so the plugin runs there today, but the vendor support contract is Node 22+. The plugin logs a startup warning when it detects Node `< 22`. Operators who can pin their Paperclip runtime to Node 22+ should do so; treat Node-20 usage as best-effort until the host bumps its baseline.

The empirical Node 20 compatibility check is recorded in [PAPA-352](/PAPA/issues/PAPA-352).

## Configuration

Configure Modal from `Instance Settings -> Environments`, not from the plugin's plugin page.

| Field | Required | Description |
| --- | --- | --- |
| `appName` | yes | Modal App name. The plugin calls `modal.apps.fromName(appName, { createIfMissing: true })`, so the App is created on first acquire if it does not already exist. |
| `image` | yes | Container image passed to `modal.images.fromRegistry()`, e.g. `python:3.13` or `node:20`. |
| `tokenId` / `tokenSecret` | yes | Modal auth tokens. Both must be provided together. Paperclip stores pasted values as company secrets. The plugin worker runs in a child process that does not inherit host env vars, so `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` set on the Paperclip server are **not** read by the plugin — provide the tokens in this form. |
| `environment` | no | Optional Modal environment name. Falls back to the SDK profile default. |
| `workdir` | no | Remote working directory inside the sandbox. Defaults to `/workspace/paperclip`. |
| `sandboxTimeoutMs` | no | Maximum sandbox lifetime in milliseconds. Must be a positive multiple of `1000` between `1000` and `86_400_000` (24 hours). Defaults to `3_600_000` (1 hour). |
| `idleTimeoutMs` | no | Optional idle timeout in milliseconds. Modal terminates the sandbox if no exec is active for this duration. Must be a positive multiple of `1000`. |
| `execTimeoutMs` | no | Default per-exec timeout in milliseconds when the caller does not pass one. Must be a positive multiple of `1000`. Defaults to `300_000` (5 minutes). |
| `blockNetwork` | no | Block all egress network access. |
| `cidrAllowlist` | no | List of CIDRs the sandbox may reach. Cannot be combined with `blockNetwork`. |
| `reuseLease` | no | When `true`, the sandbox is detached (not terminated) on release and reattached by id later. Defaults to `false`. |

### Reuse semantics

Modal does **not** expose a separate pause/resume primitive for sandboxes — there is no equivalent to e2b's `pause()`. The plugin implements `reuseLease` as follows:

- **`reuseLease: false` (default)**: On release the sandbox is `terminate()`d. Subsequent runs create a new sandbox.
- **`reuseLease: true`**: On release the plugin calls `sandbox.detach()`. The sandbox keeps running on Modal until its configured `sandboxTimeoutMs` or `idleTimeoutMs` elapses. The next acquire/resume reconnects via `modal.sandboxes.fromId(providerLeaseId)`. If the sandbox has expired, `fromId` raises `NotFoundError` and the plugin reports the lease as expired so Paperclip reacquires.

Because there is no real pause, **`reuseLease: true` keeps billing running** until the sandbox or idle timeout cuts it off. Tune `idleTimeoutMs` to a value that matches your reuse window.

## Local development

```bash
cd packages/plugins/sandbox-providers/modal
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@paperclipai/plugin-sdk` workspace package is available to the compiler during development.

## Operator verification

1. Provision Modal credentials in your Modal account (`modal token new`) or use a service account.
2. Install the plugin from the Paperclip Plugins page.
3. In `Instance Settings -> Environments`, add a new Modal sandbox environment with at least `appName`, `image`, `tokenId`, and `tokenSecret`.
4. Run the environment **Probe** action. A success result confirms auth, app creation, image pull, and `exec` round-trip.
5. Run at least one Paperclip task with a remote-managed adapter (for example `claude_local`) bound to that environment. The adapter should provision the sandbox, run commands in it, and clean it up.

Full end-to-end manual QA is tracked separately in [PAPA-354](/PAPA/issues/PAPA-354).

## Package layout

- `src/manifest.ts` declares the sandbox-provider driver metadata
- `src/plugin.ts` implements the environment lifecycle hooks
- `src/worker.ts` boots the plugin under the host worker runtime
- `paperclipPlugin.manifest` and `paperclipPlugin.worker` point the host at the built plugin entrypoints in `dist/`
