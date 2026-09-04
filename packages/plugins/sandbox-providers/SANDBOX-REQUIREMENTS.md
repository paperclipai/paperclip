# Sandbox Runtime Requirements

This document states the sandbox environment as a contract. The sandbox owner
must meet this contract. The Paperclip runtime does not build the environment at
exec time. The environment is a requirement, not a build step.

This document states requirements. It does not state build steps.

## Security boundary

Paperclip runs agent work inside a sandbox. Paperclip protects the host from
the code in that sandbox. This section states the rule for that protection. It
does not state the implementation.

A sandbox is an untrusted execution environment. Paperclip assumes that a
sandbox process can read or change all accessible data.

Paperclip does not protect sandbox files, processes, credentials, or code from
other code in the same sandbox.

This section covers sandbox providers. It does not cover a local run on the
host. A local run has a different boundary.

### What the boundary protects

Paperclip protects two authorities across the boundary:

- The authority to write host files
- The authority to call the Paperclip API

Sandbox code holds each authority through one surface only:

1. **Outbound workspace synchronization.** Paperclip copies sandbox files to
   host paths that the Paperclip orchestrator selects.
2. **The Paperclip HTTP bridge.** Sandbox code calls the Paperclip API through
   the bridge.

A boundary control limits one of these two authorities. A control that only
protects data inside the sandbox is not a boundary control. A control that only
manages resource use is not a boundary control.

### Provider isolation assumption

The rule below depends on this assumption.

The sandbox provider must isolate the sandbox from the host and the provider
control plane. The provider must isolate these items from direct sandbox access:

- Host files
- Host credentials
- Cluster credentials
- Management sockets
- Provider management interfaces

The provider must use isolated sandbox storage for each sandbox path that
synchronization uses. This includes workspace paths and staging paths.

The provider must keep every host path outside a sandbox synchronization path.
A host path inside a synchronization path makes host files available to sandbox
code. Sandbox code can then change host files, and no synchronization control
applies to the change. This removes the boundary.

A transfer and sandbox code must have the same read authority over sandbox
files. More transfer authority can turn a sandbox symbolic link into a way to
read a protected file.

This repository does not enforce these provider rules today, and Paperclip
cannot verify them for an externally supplied sandbox.

The provider and the operator set the policy for general internet access.
Paperclip does not enforce this policy inside the sandbox.

### How to apply this rule

The test is authority, not location. A change is a boundary change only in one
of these two conditions:

- The change modifies one of the two authorities above.
- The change makes the provider isolation assumption false. A change that
  exposes a management socket to the sandbox is an example.

A boundary change needs a boundary review. A reviewer must examine the change
against this contract. This section does not remove any other review of a
change.

The test gives these results:

- Code inside the sandbox can modify these authorities. The in-sandbox part of
  synchronization and the in-sandbox part of the bridge are examples.
- A change that meets neither condition above is not a boundary change. This is
  true when the change removes a control inside the sandbox.
- A developer can remove a control that only protects data inside the sandbox.
  A developer can also change the mechanism of a boundary control. The authority
  of sandbox code must stay the same or decrease.
- A requested control is a boundary security requirement only if the control
  limits one of the two authorities above.

A change creates a new boundary surface in either of these conditions:

- The change lets sandbox code write host files outside workspace
  synchronization.
- The change lets sandbox code call the Paperclip API outside the HTTP bridge.

The developer must update this contract before the change is released. A
reviewer must examine the change against this contract.

### Where a boundary control must run

Paperclip or the provider must enforce each boundary control outside the
sandbox. Sandbox code can change a control that runs inside the sandbox. A
control inside the sandbox can give an early error message, but it gives no
protection at the boundary.

This rule applies to enforcement. It does not apply to the tools that create or
move data. A tool inside the sandbox can create data, and a control outside the
sandbox validates that data. The outbound archive is an example. The sandbox
creates the archive. The host validates each member before extraction.

Each boundary control below must run outside the sandbox.

### Surface 1: outbound workspace synchronization

These boundary controls limit the authority of sandbox code over host files. The
synchronization implementation must:

- Accept only source and destination mappings that the orchestrator supplies.
- Keep host destinations in the specified host workspace or asset roots.
- Reject path traversal and symbolic links that escape a host destination root.
- Validate archive member paths and link targets before extraction on the host.
- Handle sandbox file contents only as data during synchronization.

Native synchronization hooks and the command fallback must meet the same
requirements.

Synchronization also confines each sandbox source path to a synchronization
root. A path check outside the sandbox is lexical, and only a check inside the
sandbox resolves the symbolic links on the path. The check inside the sandbox is
not a boundary control. It gives an early error.

Sandbox source confinement is safe as an early check, because a transfer reads a
sandbox source with the authority of sandbox code. The bytes that cross the
boundary are bytes that sandbox code can already read. The provider isolation
assumption above states this rule for the provider.

These requirements protect host reliability and host resources. They are not
boundary controls:

- Use atomic replacement for each single-file mapping.
- Move file data with bounded memory.

### Surface 2: Paperclip HTTP bridge

Sandbox code must call the Paperclip API only through the HTTP bridge.

These boundary controls limit the API authority of sandbox code. The bridge
must:

- Accept only requests that have valid bridge authentication.
- Limit bridge authentication to bridge access.
- Use only the run agent's API authority for each request.
- Permit only approved HTTP methods and routes.
- Forward only approved request headers.
- Add the correct run identity to each request.

These requirements protect host reliability and host resources. They are not
boundary controls:

- Limit request size, response size, and request time.
- Limit the queue length of the file-queue transport.
- Limit the number of concurrent requests on the bidirectional channel.

All other HTTP bridge requirements apply to both transports.

### What is not a boundary surface

Paperclip sends commands from the host to the sandbox. Command execution can
return output to the host. This output does not give sandbox code authority to
write host files or call the Paperclip API.

The host records this output as run logs and reads it as agent protocol
messages. Neither use gives sandbox code one of the two authorities above.

A persistent process session stays in the sandbox. A bidirectional channel is a
transport. Sandbox authority stays limited to outbound workspace synchronization
and the HTTP bridge.

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
