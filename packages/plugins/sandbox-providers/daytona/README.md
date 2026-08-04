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

The driver wraps a sandbox command with an advisory bubblewrap (`bwrap`) wrapper. The wrapper is advisory, best-effort, and automatic. At lease time the driver probes the sandbox for the wrapper capability and records the result on the lease metadata. At execute time the driver wraps the command when the capability is present. The command builder is a pure function.

- **The wrapper adds no security.** The ephemeral sandbox stays the only security posture. The wrapper only gives an agent real-time feedback when the agent tries to change a file that the ephemeral sandbox will not keep.
- **The read-only root is a feedback signal.** The wrapper binds the root as read-only (`--ro-bind / /`) and re-binds only the writable directories. A write to a path outside the writable set fails at once, so the agent learns the change is not durable.
- **A capability probe records the wrapper capability.** No configuration field turns it on. At lease time the driver reads the sandbox username with `id -un`, then probes the end-to-end `bwrap` capability by running `sudo -n bwrap` with a workspace bind and an `su` user switch. It stores `bwrapAvailable` and `sandboxUsername` on the lease metadata.
- **The probe is best-effort.** A missing `bwrap` binary, a missing passwordless `sudo -n` rule, a missing `su` binary, or an inaccessible workspace bind records `bwrapAvailable: false` and never fails the lease.
- **The writable set is the workspace plus the read-write sync destinations.** The wrapper binds the workspace directory read-write as the baseline; the workspace is always durable. It adds the read-write sync destinations that a sync-in recorded for the same lease. The set deduplicates the directories. The baseline keeps a safe result even when the collected set is empty.
- **The wrapper runs at execute time when the capability is present.** The driver wraps the command only when the lease reports `bwrapAvailable: true` and a username is known. It binds the workspace and the read-write sync destinations, keeps the root read-only for feedback, and re-binds the stdin file after the fresh `/tmp`. It runs the plain command when the capability or the username is missing. A wrap without a username would run as root and give the agent's files root ownership, so the driver keeps the plain command in that case.

## Operator enablement (advisory bwrap)

The advisory `bwrap` wrapper needs three run-time prerequisites on the image or
snapshot. The repository does not build the Daytona image or snapshot. It
references an external `image` or `snapshot`. So the three prerequisites are
image facts, not code facts. The runtime only probes for the capability and
degrades when the capability is absent.

The wrapper is advisory, best-effort, and automatic. It adds no security. The
ephemeral sandbox model stays the only security posture. A missing prerequisite
degrades to the plain command. It never fails the lease. So the enablement below
is optional. It gives the agent real-time feedback on a non-durable write. It
does not change the security posture.

The install and the sudoers change are environment provisioning at the image or
snapshot layer. Route them to DevOps through the board. Do not run the steps
from the runtime and do not commit a provisioning script to the repository.

### 1. Install the `bubblewrap` package

The repository does not state the Daytona base distribution. Confirm the
distribution on the referenced image or snapshot first, then run the matching
command:

```bash
# Debian/Ubuntu
apt-get install -y bubblewrap
# Alpine
apk add bubblewrap
# Fedora/RHEL
dnf install -y bubblewrap
```

Confirm the binary path is `/usr/bin/bwrap` after the install.

### 2. Add the passwordless sudoers rule

The wrapper runs `bwrap` as root with `sudo -n`. Add this exact sudoers line.
Use the real sandbox user name and the real `bwrap` path:

```text
<sandbox-user> ALL=(root) NOPASSWD: /usr/bin/bwrap
```

The `<sandbox-user>` is the account name that `id -un` returns inside the
sandbox. Use the account name, not a numeric id, in the sudoers line. The probe
reads the username with `id -un`. The driver resolves the sandbox work directory
first, then the user home directory. It uses `/home/daytona` only as a fallback
default when both are empty. Confirm the real home directory for your image or
snapshot. Install the `sudo` and `util-linux` (for `su`) packages in the image
or snapshot if they are absent.

### 3. Verify the prerequisites

Run this exact command as the sandbox user, replacing `<sandbox-user>` and
`<workspace>` with real values:

```bash
sudo -n bwrap --ro-bind / / --bind-try <workspace> <workspace> -- su -s /bin/sh <sandbox-user> -c true
```

A zero exit code means all prerequisites are met. A non-zero exit code means one
prerequisite is missing. The wrapper then stays off and runs the plain command.

The probe binds the workspace directory and switches to the sandbox user with
`su`. This matches the exact invocation the live wrapper uses, so a passing probe
guarantees that execution commands will also succeed.

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
