# `@paperclipai/plugin-daytona`

Published Daytona sandbox provider plugin for Paperclip.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That lets operators install it from the Plugins page by package name without introducing root lockfile churn for Daytona's SDK dependencies.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-daytona
```

The host plugin installer runs `npm install` into the managed plugin directory, so transitive dependencies such as `@daytonaio/sdk` are pulled in during installation.

## Configuration

Configure Daytona from `Instance Settings -> Environments`, not from the plugin's plugin page.

- Put the Daytona API key on the sandbox environment itself.
- When you save an environment, Paperclip stores pasted API keys as company secrets.
- `DAYTONA_API_KEY` remains an optional host-level fallback when an environment omits the key.
- Optional `apiUrl` and `target` settings map directly to the Daytona SDK/client configuration. If `apiUrl` is omitted, the Daytona SDK uses its default endpoint.

Notes:

- The current published Daytona SDK package is `@daytonaio/sdk`.
- The driver supports both `snapshot`-based and `image`-based sandbox creation. If both are set, validation rejects the config as ambiguous.
- Reusable leases map to Daytona stop/start semantics. Non-reusable leases are deleted on release.

## Advisory bwrap wrapper

The driver prepares an advisory bubblewrap (`bwrap`) wrapper for a sandbox command. The wrapper is advisory and best-effort. The driver does not wrap the command during execution yet. At lease time the driver probes the sandbox for the wrapper capability and records the result on the lease metadata. The command builder exists as a pure function. A later change wires the builder into command execution.

- **The wrapper adds no security.** The ephemeral sandbox stays the only security posture. The wrapper only gives an agent real-time feedback when the agent tries to change a file that the ephemeral sandbox will not keep.
- **The read-only root is a feedback signal.** The wrapper binds the root as read-only (`--ro-bind / /`) and re-binds only the writable directories. A write to a path outside the writable set fails at once, so the agent learns the change is not durable.
- **A capability probe records the wrapper capability.** No configuration field turns it on. At lease time the driver probes the sandbox for the end-to-end `bwrap` capability (`sudo -n bwrap` with a user namespace) and reads the sandbox user's uid and gid. It stores `bwrapAvailable`, `sandboxUid`, and `sandboxGid` on the lease metadata.
- **The probe is best-effort.** A missing `bwrap` binary, a missing passwordless `sudo -n` rule, or a missing user namespace records `bwrapAvailable: false` and never fails the lease.

## Local development

```bash
cd packages/plugins/sandbox-providers/daytona
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
