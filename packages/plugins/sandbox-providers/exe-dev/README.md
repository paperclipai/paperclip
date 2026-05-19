# `@paperclipai/plugin-exe-dev`

Published exe.dev sandbox provider plugin for Paperclip.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That lets operators install it from the Plugins page by package name without introducing root lockfile churn.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-exe-dev
```

## Configuration

Configure exe.dev from `Company Settings -> Environments`, not from the plugin's instance settings page.

- Put the exe.dev API token on the sandbox environment itself.
- When you save an environment, Paperclip stores pasted API keys and pasted SSH private keys as company secrets.
- `EXE_API_KEY` remains an optional host-level fallback when an environment omits the API token.
- The current implementation provisions VMs through exe.dev's HTTPS API and runs commands through direct SSH to the created VM.

To use the provider successfully, the environment/host needs all of the following:

- An exe.dev API token that allows the lifecycle commands the provider uses: `new`, `ls`, and `rm`. `whoami` and `help` are recommended for manual debugging. `restart` is only needed if you extend the provider to restart retained VMs.
- SSH access from the Paperclip host to the resulting `*.exe.xyz` VMs.
- An SSH private key that exe.dev already recognizes. You can either:
  - paste the private key into the environment config via `sshPrivateKey`
  - point `sshIdentityFile` at an absolute host path
  - or leave both blank and rely on the host's default SSH agent/keychain
- The matching public key must already be registered with exe.dev before the provider can execute commands inside the VM.

Operational notes:

- If exe.dev replies `Please complete registration by running: ssh exe.dev`, the host key has not finished exe.dev onboarding yet.
- Reusable leases keep the VM alive between runs. exe.dev does not expose a documented "stop and later resume" command in the public CLI docs, so `reuseLease: true` means "retain the VM" rather than "suspend it."
- The provisioning path uses `https://exe.dev/exec`, which exe.dev documents as a command-style HTTPS API with a 30-second request timeout. Typical `new` calls are expected to fit inside that limit; command execution itself does not use `/exec`.
- Probes still create and delete a real exe.dev VM through `/exec`, and so do the `new`/`rm` calls inside the normal acquire/release lifecycle. Treat all of those as real provisioning cost, not just probes.
- exe.dev runs `--setup-script` as the unprivileged `exedev` user, not as root. That user has passwordless `sudo`, so any system-level steps in a custom `setupScript` must invoke `sudo` explicitly (for example `sudo apt-get install -y …`). When you omit `setupScript`, the plugin supplies a default that installs Node 20 via the official nodesource script — Paperclip's sandbox callback bridge is a Node program, so the VM needs `node` on `PATH` before the bridge can launch.

## Local development

```bash
cd packages/plugins/sandbox-providers/exe-dev
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
