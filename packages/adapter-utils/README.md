# @paperclipai/adapter-utils

Shared utilities for Paperclip adapters: process spawning, environment
injection, sandbox/SSH transport, workspace sync, and the round-trip helpers
that move code between the local execution-workspace cwd and wherever the
agent actually runs.

For the adapter-author guide see
[`docs/adapters/creating-an-adapter.md`](../../docs/adapters/creating-an-adapter.md)
and the in-repo notes at [`packages/adapters/AUTHORING.md`](../adapters/AUTHORING.md).

## Sandbox bridge deadlines

Command-managed bridge control operations (queue reads, input delivery, setup,
and cleanup) have a host-enforced deadline of at most 30 seconds per shell
command. A shorter configured timeout still applies. These operations cannot
inherit the agent run's hours-long lifetime or wait forever on a provider that
ignores its timeout. Long-lived agent session commands keep their own limits.

A control timeout reports a transport failure. It does not prove that the
remote command stopped and does not replay an uncertain write. The process
session closes failed input delivery and uses its existing shutdown path;
normal execution settlement must still verify termination.

## Native archive transfer deadlines

Native `syncIn` and `syncOut` calls accept an optional `minimumTimeoutMs` budget. The
server validates this budget and extends the worker RPC deadline. Providers can
honor this field for file transfers without changing their configuration. Daytona
uses the larger of this minimum and its configured timeout. Other providers keep
their existing behavior. The minimum is limited to 30 minutes and does not change
sandbox lifetimes, stored settings or the timeout for other commands.

The remote-workspace archive path uses the verified capture size for downloads
and the local archive size for uploads. Large archives get one second per MiB
plus 60 seconds, capped at 30 minutes. Small archives keep the existing provider
timeout when that calculation is no greater than five minutes. Archive size,
checksum, confinement and host space checks still apply.

An exact retained-sandbox resume keeps its recorded provider timeout and RPC
overhead. It uses the normal one-minute fallback only when no timeout was
recorded. A five-minute cold restore must not be cut off by that fallback.
Resume still targets the recorded allocation and does not acquire a replacement.

## No-remote-git contract

The local execution-workspace cwd is the only persistence boundary across
runs. No adapter may depend on a git remote for cross-run state.

Adapters that run the agent on a different host should use the SSH round-trip
helpers in [`src/ssh.ts`](./src/ssh.ts):

- `prepareWorkspaceForSshExecution({ spec, localDir, remoteDir })` — bundles
  the local cwd (tracked files, dirty edits, untracked additions, and the git
  history needed to reconstruct it) to `remoteDir` before the run starts. Runs
  with no `git remote` configured.
- `restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir, ... })` —
  syncs the remote cwd back into `localDir` after the run, including any new
  commits the agent created. Also runs with no `git remote` configured.

SSH transfers succeed only when every SSH and local tar process exits with
code zero and no signal. A missing exit code or signal termination rejects
the transfer. Errors retain the exit code, signal, and stderr so callers can
distinguish process termination from a remote command or transport failure.
A failed download does not apply its staged files or Git bundle to the
existing local workspace and does not report successful transfer progress.

`prepareRemoteManagedRuntime` in
[`src/remote-managed-runtime.ts`](./src/remote-managed-runtime.ts) wraps both
calls for adapters that want a per-run remote workspace and an automatic
`restoreWorkspace()` finally hook.

The invariant is pinned by the `no-remote-git contract` case in
[`src/ssh-fixture.test.ts`](./src/ssh-fixture.test.ts), which asserts that a
remote-only commit propagates to the local worktree through the
prepare → restore round-trip with no git remote configured at any point. Do
not regress that test.
