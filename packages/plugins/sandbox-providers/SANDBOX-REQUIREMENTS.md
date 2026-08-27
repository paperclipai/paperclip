# Sandbox Runtime Requirements

This document states the sandbox environment as a contract. The sandbox owner
must meet this contract. The Paperclip runtime does not build the environment at
exec time. The environment is a requirement, not a build step.

This document states requirements. It does not state build steps.

## Security boundary

The sandbox is the security boundary. One run owns one sandbox. Code inside a
sandbox can change any file inside that sandbox. Paperclip protects the host,
the cluster, and the network. Paperclip does not protect sandbox code from
other sandbox code that shares the same sandbox.

This section states the controls for two paths that cross the boundary
between a sandbox and the host:

- Outbound workspace synchronization copies files from the sandbox to the
  host.
- The application programming interface bridge carries requests from the
  sandbox to the host.

Other paths also cross the boundary. These paths include command execution,
an optional bidirectional session channel, and a persistent process session.
This section does not state the controls for those other paths.

Both boundary-crossing paths named above must keep every applicable host,
cluster, mount, network, and host-import control that they have today. Later
changes must not weaken or remove those controls.

A sandbox provider must keep every host, cluster, mount, network, and
host-import control that it has today.

**Mount duty.** A provider must not map a host path into a sandbox
synchronization path. This is a duty of the provider. No code in this
repository enforces the duty today.

## Required on PATH

- `node` must be installed and on the PATH.
- Each agent CLI that the run uses must be installed and on the PATH. The set of
  agent CLIs includes `claude`, `codex`, `gemini`, and similar CLIs.
- The owner installs only the CLIs that the run uses. The owner does not need to
  install a CLI that no run uses.

## Runtime dependencies

The sandbox execution and synchronization paths need more than `node` and the
agent CLIs. The owner must also supply these:

- A POSIX shell as `sh`, normally `/bin/sh`. The runtime runs each command with
  `sh -c <script>`. The runtime uses `bash` only when the adapter sets the shell
  to `bash`.
- `tar`. The synchronization path extracts and creates archives with `tar`. A
  sandbox without `tar` cannot receive or return workspace files.
- A writable workspace directory. The runtime extracts the workspace archive
  into this directory.
- A writable home directory. The agent CLIs write state and credentials under
  the home directory.
- A writable cache directory and a writable temporary directory. The runtime and
  the agent CLIs write intermediate files to these locations.

## Detection contract

Paperclip probes each CLI before launch. Paperclip uses the same detection
pattern that the runtime Dockerfiles use:

```bash
command -v <cmd> || exit 1
```

Paperclip probes each CLI with `command -v <cmd>`. Paperclip fails loudly when
the CLI is absent and no install command is configured for the CLI.

## Optional CLI installation

An adapter can configure an install command for a CLI. When an install command
is configured, the runtime obeys this flow:

1. The runtime probes the CLI with `command -v <cmd>`.
2. If the CLI is already on the PATH, the runtime skips the install.
3. If the CLI is absent, the runtime runs the configured install command one
   time.
4. A failed install is not fatal. The runtime writes a log line and continues.
   The launch-time probe still reports a missing CLI and fails loudly.

An owner who relies on a configured install command must also supply the network
access, the filesystem write access, and the package tooling that the install
command needs. When no install command is configured, the runtime does not
install the CLI. The owner must supply the CLI on the PATH.

## Firm rule

- The Paperclip runtime never modifies the login profile. The runtime never
  writes a profile file. The runtime never writes an rc file.
- The Paperclip runtime never sources `nvm` on the exec path.
- The sandbox owner supplies a ready PATH. The PATH must resolve `node` and each
  used agent CLI without any action from the runtime, except for a configured
  install command.
