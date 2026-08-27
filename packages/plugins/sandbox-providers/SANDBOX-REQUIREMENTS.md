# Sandbox Runtime Requirements

This document states the sandbox environment as a contract. The sandbox owner
must meet this contract. The Paperclip runtime does not build the environment at
exec time. The environment is a requirement, not a build step.

This document states requirements. It does not state build steps.

## Security boundary

A sandbox is an untrusted execution environment. Paperclip assumes that a
sandbox process can read or change all accessible data.

Paperclip does not protect sandbox files, processes, credentials, or code from
other code in the same sandbox. Internal sandbox controls are not part of the
Paperclip sandbox-to-host security boundary.

### Provider isolation assumption

The sandbox provider must isolate the sandbox from the host and the provider
control plane. The provider must isolate these items from direct sandbox access:

- Host files
- Host credentials
- Cluster credentials
- Management sockets
- Provider management interfaces

The provider must use isolated sandbox storage for each sandbox path that
synchronization uses. This includes workspace paths and staging paths.
Paperclip cannot verify this requirement for externally supplied sandboxes.

The provider and the operator control general internet access. Paperclip does
not enforce this policy inside the sandbox.

### Sandbox-to-host surfaces

Paperclip gives sandbox code only two controlled methods to write host files or
call the Paperclip API.

1. **Outbound workspace synchronization**

   Paperclip copies sandbox files to host paths that the Paperclip orchestrator
   selects.

   The synchronization implementation must:

   - Accept only source and destination mappings that the orchestrator supplies.
   - Keep sandbox sources in the specified synchronization roots.
   - Keep host destinations in the specified host workspace or asset roots.
   - Reject path traversal and escaping symbolic links.
   - Handle sandbox file contents only as data during synchronization.
   - Validate archive member paths and link targets before extraction on the host.
   - Use atomic replacement for each single-file mapping.
   - Transfer file data with bounded memory.

   Native synchronization hooks and the command fallback must meet the same
   requirements.

2. **Paperclip HTTP bridge**

   The HTTP bridge is the only approved method that sandbox code can use to call
   the Paperclip API.

   The bridge must:

   - Accept only requests that have valid bridge authentication.
   - Limit bridge authentication to bridge access.
   - Use only the run agent's API authority for each request.
   - Permit only approved HTTP methods and routes.
   - Forward only approved request headers.
   - Add the correct run identity to each request.
   - Limit request size, response size, and request time.

   The file-queue transport must limit the queue length. The bidirectional
   channel must limit the number of concurrent requests.

   All other HTTP bridge requirements apply to both transports.

### What is not a separate boundary surface

Paperclip sends commands from the host to the sandbox. Command execution can
return output to the host. This output does not give sandbox code authority to
write host files or call the Paperclip API.

A persistent process session stays in the sandbox. A bidirectional channel is a
transport. Sandbox authority stays limited to outbound workspace synchronization
and the HTTP bridge.

A change creates a new security-boundary surface in either of these conditions:

- The change lets sandbox code write host files outside workspace synchronization.
- The change lets sandbox code call the Paperclip API outside the HTTP bridge.

The developer must update this contract before the change is released. The
change must receive a security review.

If the provider isolation assumption stays true, a change needs a
sandbox-boundary hardening review only if the change modifies one of these
items:

- The transfer of sandbox data to host files
- The API authority of sandbox code

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
