# Directory-constraint (`bwrap`) findings for the Daytona session path

## Summary

The Daytona provider ran an advisory `bubblewrap` (`bwrap`) wrapper around each
user command. The wrapper gave an agent real-time feedback when the agent wrote
to a directory that the ephemeral sandbox does not keep. The wrapper was
advisory only. It added no security boundary; the ephemeral sandbox is the only
boundary.

The provider now runs each user command plain, both on the persistent-session
path and on the one-shot fallback path. This note records why the provider drops
the directory-constraint goal for now, and what a future re-introduction needs.

## Why the goal is dropped for now

The session model runs one persistent shell per lease and feeds every command
into that shell. The plan aimed to enter the `bwrap` sandbox one time per session
and amortize its cost across every command in the session. A live validation
proved this aim is not reachable with the current Daytona session daemon.

- An `exec`-replace of the session shell with `bwrap` stops the session from
  running any later command. A side-channel file proved the inner shell never
  ran the next command. A repeat without `--new-session` gave the same result,
  so `--new-session` is not the cause. The `exec`-replace itself breaks the
  session daemon's per-command delivery.
- A per-command `bwrap` wrap works inside a session (separated `stdout` and
  `stderr`, correct exit codes, the session stays alive), but it costs about
  1.75 s per command. An un-wrapped session command takes about 0.29 s; a
  `bwrap`-wrapped session command takes about 2.05 s. The wrap adds the full
  cost back on every command, which removes the session model's speed win.

The wrapper was advisory, not a security boundary. The provider already ran a
command plain when the `bwrap` capability probe failed, so the plain path is an
accepted, shipped behavior. Dropping the wrapper drops only the advisory
feedback; it does not change the command's privilege or isolation. The command
runs as the unprivileged sandbox user (`daytona`) in both cases.

## Removal scope

- The session dispatch runs the plain login-shell script, wrapped in a subshell
  so a top-level `exit` cannot end the persistent session shell.
- The one-shot fallback (used when the session model is off) also runs the plain
  login-shell script.
- The provider removed the per-command `bwrap` apply, the `bwrap` capability
  probe, the `bwrap` command builder, and the `bwrapAvailable` /
  `sandboxUsername` lease metadata that only the removed path used.
- The provider keeps the advisory writable-directory set, which a sync operation
  records from each `access: "rw"` mapping. Nothing reads the set today. It stays
  in place so a future isolation wrapper can consume it without a new sync
  change.

## What a future re-introduction needs

- A persistent-namespace approach needs its own spike. Two candidates are:
  - Enter one namespace per session and route each command into it with
    `nsenter`.
  - Feed each command to the namespace shell through a FIFO instead of an
    `exec`-replace.
- Both candidates need a live test against the Daytona session daemon, because
  the `exec`-replace model is proven unreachable and the per-command wrap is too
  slow.
- The re-introduction must keep the session speed win. It must not pay the full
  `bwrap` setup cost on every command.
- The writable-directory set is already tracked per lease, so a new wrapper can
  bind those directories read-write without a sync change.
- The wrapper stays advisory. It must not become a security boundary; the
  ephemeral sandbox stays the only boundary.
