# SSH environment secret transport

## Context

Paperclip previously rendered injected remote environment values into the local
`ssh` process command line. Same-host process inspection and captured diagnostics
could therefore expose run-scoped API keys and service tokens.

## Options considered

1. Keep environment assignments in argv and rely on redaction. This leaves the
   primary exposure in `/proc` and process listings.
2. Copy a mode-0600 environment file to the remote host. This avoids argv but
   introduces remote file lifecycle and crash-cleanup risk.
3. Send an encoded environment prelude over SSH stdin, consume it before launch,
   and leave subsequent stdin bytes for the child process.

## Decision

Use option 3. Environment values are UTF-8 byte encoded as octal and sent through
the existing SSH stdin channel. A POSIX shell bootstrap reads and exports the
values, clears its temporary variables, and then `exec`s the requested command.
Only the fixed bootstrap and requested command remain in the SSH argv.

As defense in depth, command diagnostics and streamed run-log chunks redact both
credential-shaped text and values associated with credential-shaped environment
names.

## Consequences

- SSH launches with injected environment now use a pipe for stdin, even when the
  requested command has no input. The pipe is closed after the environment
  prelude, preserving the prior EOF behavior.
- No remote secret payload file is created, so there is no cleanup residue.
- The remote shell must support POSIX `read -r`, `printf`, `export`, and `unset`.
- Values still exist in the launched process environment, as required by the
  adapter contract; this change specifically removes them from process argv and
  log ingestion.

## Blast radius and rollout

The change affects only SSH remote execution with a non-empty injected
environment. Local adapters, SSH workspace transfer, authentication key files,
and commands without injected environment are unchanged.

Roll out through the normal release pipeline after the adapter-utils typecheck,
SSH fixture tests, and Linux `/proc/<ssh-pid>/cmdline` regression pass. Monitor
remote launch failures and authentication errors by adapter type during the first
release window.

## Rollback

Revert the transport commit and redeploy the previous release if remote shells
cannot consume the stdin prelude. Because rollback restores the argv exposure,
disable SSH remote execution or remove injected credentials from affected SSH
environments until a corrected build is deployed. No data migration or remote
file cleanup is required.
